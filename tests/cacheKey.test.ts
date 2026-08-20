import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePrefixKey,
  estimateTokens,
  FIXED_PREFIX_VERSION,
} from '../src/core/cache/cacheKey';

test('哈希确定可复现：同输入两次结果一致', () => {
  assert.equal(computePrefixKey('背景文本'), computePrefixKey('背景文本'));
});

test('固定版本号变更 → 哈希不同（旧缓存失效）', () => {
  const h1 = computePrefixKey('背景文本', 1);
  const h2 = computePrefixKey('背景文本', 2);
  assert.notEqual(h1, h2);
  // 默认版本与 FIXED_PREFIX_VERSION 一致
  assert.equal(
    computePrefixKey('背景文本'),
    computePrefixKey('背景文本', FIXED_PREFIX_VERSION),
  );
});

test('前缀哪怕一个字符不同 → 哈希不同', () => {
  assert.notEqual(
    computePrefixKey('项目背景 A'),
    computePrefixKey('项目背景 B'),
  );
});

test('estimateTokens：空串为 0，非空至少为 1', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('hello world') >= 1);
});
