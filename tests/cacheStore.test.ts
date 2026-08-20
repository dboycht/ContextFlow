import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CacheStore } from '../src/core/cache/cacheStore';

function makeStore(): CacheStore {
  return new CacheStore(':memory:');
}

test('getOrCreate：同前缀同引擎返回同一记录', () => {
  const store = makeStore();
  const a = store.getOrCreate('背景', 'deepseek');
  const b = store.getOrCreate('背景', 'deepseek');
  assert.equal(a.id, b.id);
  assert.equal(a.prefixHash, b.prefixHash);
});

test('getOrCreate：不同引擎各自独立记录', () => {
  const store = makeStore();
  const a = store.getOrCreate('背景', 'deepseek');
  const b = store.getOrCreate('背景', 'claude');
  assert.notEqual(a.id, b.id);
});

test('attachCacheId：回填后记录携带 cache 标识', () => {
  const store = makeStore();
  const entry = store.getOrCreate('背景', 'deepseek');
  assert.equal(entry.cacheId, null);
  store.attachCacheId(entry.id, 'cache-abc', 128);
  const again = store.getOrCreate('背景', 'deepseek');
  assert.equal(again.cacheId, 'cache-abc');
  assert.equal(again.prefixTokens, 128);
});

test('touch：命中次数递增', () => {
  const store = makeStore();
  const entry = store.getOrCreate('背景', 'deepseek');
  store.touch(entry.id);
  store.touch(entry.id);
  const again = store.getOrCreate('背景', 'deepseek');
  assert.equal(again.hitCount, 2);
});

test('listByEngine：按引擎过滤', () => {
  const store = makeStore();
  store.getOrCreate('背景1', 'deepseek');
  store.getOrCreate('背景2', 'deepseek');
  store.getOrCreate('背景3', 'claude');
  assert.equal(store.listByEngine('deepseek').length, 2);
  assert.equal(store.listByEngine('claude').length, 1);
});

test('prune：过期记录被清理，返回删除条数', async () => {
  const store = makeStore();
  store.getOrCreate('旧记录', 'deepseek');
  // 等 10ms 让 last_hit_at 落后于新的截止时间
  await new Promise((r) => setTimeout(r, 10));
  const removed = store.prune(0);
  assert.equal(removed, 1);
  assert.equal(store.listByEngine('deepseek').length, 0);
});
