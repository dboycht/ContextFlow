import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CacheMetrics } from '../src/core/cache/metrics';

test('空指标：hitRate 为 0', () => {
  const m = new CacheMetrics();
  const s = m.snapshot();
  assert.equal(s.totalRequests, 0);
  assert.equal(s.cacheHits, 0);
  assert.equal(s.hitRate, 0);
  assert.equal(s.prefixTokensSaved, 0);
});

test('recordHit：命中数、请求数、节省 token 同步累加', () => {
  const m = new CacheMetrics();
  m.recordHit(100);
  m.recordHit(50);
  const s = m.snapshot();
  assert.equal(s.totalRequests, 2);
  assert.equal(s.cacheHits, 2);
  assert.equal(s.hitRate, 1);
  assert.equal(s.prefixTokensSaved, 150);
});

test('recordMiss：只增加请求数', () => {
  const m = new CacheMetrics();
  m.recordMiss();
  m.recordHit(80);
  const s = m.snapshot();
  assert.equal(s.totalRequests, 2);
  assert.equal(s.cacheHits, 1);
  assert.equal(s.hitRate, 0.5);
  assert.equal(s.prefixTokensSaved, 80);
});

test('recordInputTokens 累加实际输入', () => {
  const m = new CacheMetrics();
  m.recordInputTokens(1000);
  m.recordInputTokens(500);
  assert.equal(m.snapshot().inputTokensTotal, 1500);
});
