import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CacheStore } from '../src/core/cache/cacheStore';
import { PrefixCache } from '../src/core/cache/prefixCache';
import { CacheMetrics } from '../src/core/cache/metrics';

const FIXED = ['系统提示：你是 AI 编程助手', '项目背景：ContextFlow'];
const ENGINE = 'deepseek';

function makeCache(opts: { minTokens?: number; ttlMs?: number; metrics?: CacheMetrics } = {}) {
  const store = new CacheStore(':memory:');
  return { store, cache: new PrefixCache(store, { minTokens: 1, ...opts }) };
}

test('相同前缀第二次 prepare → 命中，同一 entry，hitCount 递增', async () => {
  const { store, cache } = makeCache();
  const r1 = await cache.prepare(FIXED, [], '问题1', ENGINE);
  assert.ok(r1.cacheEntry);
  assert.equal(r1.cacheEntry.cacheId, null); // 首次未命中

  // 首次发送后回填厂商 cache id（模拟 adapter 行为）
  store.attachCacheId(r1.cacheEntry.id, 'cache-1', 120);

  const r2 = await cache.prepare(FIXED, [], '问题2', ENGINE);
  assert.ok(r2.cacheEntry);
  assert.equal(r2.cacheEntry.id, r1.cacheEntry.id); // 同一 entry
  assert.equal(r2.cacheEntry.cacheId, 'cache-1'); // 命中
  assert.equal(r2.cacheEntry.hitCount, 1); // 递增
});

test('前缀哪怕一个字符不同 → 视为未命中，生成新 entry', async () => {
  const { cache } = makeCache();
  const r1 = await cache.prepare(['背景A'], [], '问题1', ENGINE);
  const r2 = await cache.prepare(['背景B'], [], '问题2', ENGINE);
  assert.ok(r1.cacheEntry && r2.cacheEntry);
  assert.notEqual(r1.cacheEntry.id, r2.cacheEntry.id);
  assert.equal(r1.cacheEntry.cacheId, null);
  assert.equal(r2.cacheEntry.cacheId, null);
});

test('cacheId==null 时未命中；attachCacheId 后下次才命中', async () => {
  const { store, cache } = makeCache();
  const r1 = await cache.prepare(FIXED, [], '问题1', ENGINE);
  assert.ok(r1.cacheEntry);
  assert.equal(r1.cacheEntry.cacheId, null); // 未命中 ref

  // 回填前再次 prepare 仍是未命中
  const r2 = await cache.prepare(FIXED, [], '问题2', ENGINE);
  assert.equal(r2.cacheEntry?.cacheId, null);

  // 回填后命中
  store.attachCacheId(r1.cacheEntry.id, 'cache-9', 100);
  const r3 = await cache.prepare(FIXED, [], '问题3', ENGINE);
  assert.equal(r3.cacheEntry?.cacheId, 'cache-9');
});

test('前缀 token 低于 minTokens → cacheEntry=null，跳过缓存', async () => {
  const { cache } = makeCache({ minTokens: 1000 });
  const r = await cache.prepare(['短前缀'], [], '问题', ENGINE);
  assert.equal(r.cacheEntry, null);
  assert.equal(r.prefixText, '短前缀');
  assert.equal(r.newText, '问题');
});

test('prune 过期 → 旧 entry 被清理，再 prepare 视为未命中', async () => {
  const { store, cache } = makeCache({ ttlMs: 10 });
  const r1 = await cache.prepare(FIXED, [], '问题1', ENGINE);
  assert.ok(r1.cacheEntry);
  store.attachCacheId(r1.cacheEntry.id, 'cache-x', 80);

  // 等 last_hit_at 过期（ttl 10ms）
  await new Promise((r) => setTimeout(r, 30));
  const removed = await cache.prune();
  assert.equal(removed, 1);

  const r2 = await cache.prepare(FIXED, [], '问题2', ENGINE);
  assert.ok(r2.cacheEntry);
  assert.notEqual(r2.cacheEntry.id, r1.cacheEntry.id); // 全新 entry
  assert.equal(r2.cacheEntry.cacheId, null); // 旧缓存已失效
});

test('命中/未命中写入 metrics（命中率与节省 token）', async () => {
  const metrics = new CacheMetrics();
  const { store, cache } = makeCache({ metrics });
  const r1 = await cache.prepare(FIXED, [], '问题1', ENGINE);
  assert.ok(r1.cacheEntry);
  store.attachCacheId(r1.cacheEntry.id, 'cache-m', 100);

  await cache.prepare(FIXED, [], '问题2', ENGINE);

  const s = metrics.snapshot();
  assert.equal(s.totalRequests, 2);
  assert.equal(s.cacheHits, 1);
  assert.equal(s.hitRate, 0.5);
  assert.equal(s.prefixTokensSaved, 100);
});

test('跳过缓存（短前缀）不计入 metrics 请求数', async () => {
  const metrics = new CacheMetrics();
  const { cache } = makeCache({ minTokens: 1000, metrics });
  await cache.prepare(['短'], [], '问题', ENGINE);
  assert.equal(metrics.snapshot().totalRequests, 0);
});
