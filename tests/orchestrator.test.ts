import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../src/core/orchestrator';
import { CacheStore } from '../src/core/cache/cacheStore';
import { CacheMetrics } from '../src/core/cache/metrics';
import { PrefixCache } from '../src/core/cache/prefixCache';
import { SessionStore } from '../src/core/session/sessionStore';
import { Router } from '../src/core/session/router';
import { AdapterRegistry } from '../src/core/adapters/registry';
import { ConfigStore } from '../src/core/config/configStore';
import type { AgentAdapter, SendInput, SendResult } from '../src/core/adapters/types';

/**
 * 可编程 fake adapter：模拟 DeepSeek 自动缓存语义——
 * cacheId 恒为空，命中与否体现在 usage.cacheHitTokens（按调用次序编程）。
 */
class FakeAdapter implements AgentAdapter {
  calls: SendInput[] = [];
  cacheHitTokensByCall: number[] = [];
  cacheIdByCall?: Array<string | undefined>;
  content = '模拟回复';
  readonly capabilities: AgentAdapter['capabilities'];

  constructor(public readonly engineId: string) {
    this.capabilities = {
      engineId,
      label: engineId,
      maxContextTokens: 1000,
      supportsCache: true,
      pricing: { input: 2, cachedInput: 0.2, output: 8 },
    };
  }

  async send(input: SendInput): Promise<SendResult> {
    this.calls.push(input);
    const i = this.calls.length - 1;
    return {
      content: this.content,
      raw: {},
      usage: {
        inputTokens: 1000,
        outputTokens: 50,
        cacheHitTokens: this.cacheHitTokensByCall[i] ?? 0,
      },
      cacheId: this.cacheIdByCall?.[i],
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  estimateCost(usage: SendResult['usage']): number {
    return usage.inputTokens;
  }
}

function makeCore() {
  const cacheStore = new CacheStore(':memory:');
  const sessionStore = new SessionStore(':memory:');
  const metrics = new CacheMetrics();
  const prefixCache = new PrefixCache(cacheStore, { minTokens: 1 });
  const config = new ConfigStore();
  const registry = new AdapterRegistry();
  const deepseek = new FakeAdapter('deepseek');
  const claude = new FakeAdapter('claude');
  registry.register(deepseek);
  registry.register(claude);
  const router = new Router(registry, config);
  const orchestrator = new Orchestrator({
    router,
    sessionStore,
    prefixCache,
    cacheStore,
    registry,
    metrics,
  });
  return { orchestrator, sessionStore, metrics, deepseek, claude, cacheStore };
}

test('关键闭环：同一会话第二次提问命中缓存（usage.cacheHitTokens > 0）', async () => {
  const { orchestrator, deepseek, metrics } = makeCore();
  const session = await orchestrator.newSession('deepseek');
  deepseek.cacheHitTokensByCall = [0, 700]; // 第一次未命中，第二次命中 700

  const first = await orchestrator.send(session.id, '问题一');
  assert.equal(first.assistantMessage.usage?.cacheHitTokens ?? 0, 0);
  assert.equal(first.decision.reason, 'affinity');

  const second = await orchestrator.send(session.id, '问题二');
  assert.equal(second.assistantMessage.usage?.cacheHitTokens, 700);
  // 第二次请求携带的历史前缀应包含第一轮消息
  assert.ok(deepseek.calls[1]!.prompt.includes('[user] 问题一'));
  // metrics：一次 miss + 一次 hit
  const snap = metrics.snapshot();
  assert.equal(snap.totalRequests, 2);
  assert.equal(snap.cacheHits, 1);
  assert.equal(snap.hitRate, 0.5);
});

test('send 后消息回写：user + assistant 进会话历史，溯源引擎', async () => {
  const { orchestrator, sessionStore } = makeCore();
  const session = await orchestrator.newSession('deepseek');
  await orchestrator.send(session.id, '背景是什么？');
  const loaded = sessionStore.get(session.id)!;
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[0]!.role, 'user');
  assert.equal(loaded.messages[1]!.role, 'assistant');
  assert.equal(loaded.messages[1]!.engineId, 'deepseek');
  // 首条用户消息生成标题
  assert.notEqual(loaded.title, '新会话');
});

test('手动切换引擎：migrated=true、归属更新、消息溯源新引擎', async () => {
  const { orchestrator, sessionStore } = makeCore();
  const session = await orchestrator.newSession('deepseek');
  const outcome = await orchestrator.send(session.id, '问题', 'claude');
  assert.equal(outcome.decision.reason, 'manual');
  assert.equal(outcome.decision.migrated, true);
  assert.equal(outcome.decision.engineId, 'claude');
  assert.equal(sessionStore.get(session.id)!.engineId, 'claude');
  assert.equal(outcome.assistantMessage.engineId, 'claude');
});

test('显式缓存厂商：SendResult.cacheId 回填到缓存层 entry', async () => {
  const { orchestrator, deepseek, cacheStore } = makeCore();
  const session = await orchestrator.newSession('deepseek');
  // 首次 send 无历史 → 前缀为空 → 跳过缓存；第二次才有历史前缀参与缓存
  deepseek.cacheIdByCall = [undefined, 'cache-x'];
  await orchestrator.send(session.id, '问题一');
  await orchestrator.send(session.id, '问题二');
  const entries = cacheStore.listByEngine('deepseek');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.cacheId, 'cache-x');
});

test('新建会话默认引擎（router 记忆/默认）', async () => {
  const { orchestrator } = makeCore();
  const session = await orchestrator.newSession();
  assert.equal(session.engineId, 'deepseek'); // ConfigStore 默认
});

test('switchEngine：记忆选择 + 更新归属（后续新会话走记忆）', async () => {
  const { orchestrator, sessionStore } = makeCore();
  const session = await orchestrator.newSession('deepseek');
  orchestrator.switchEngine(session.id, 'claude');
  assert.equal(sessionStore.get(session.id)!.engineId, 'claude');
  // 记忆生效：新建会话默认 claude
  const next = await orchestrator.newSession();
  assert.equal(next.engineId, 'claude');
});

test('不存在的会话 send → 抛错', async () => {
  const { orchestrator } = makeCore();
  await assert.rejects(orchestrator.send('no-such-session', 'hi'), /session not found/);
});
