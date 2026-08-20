import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../../src/core/session/router';
import { AdapterRegistry } from '../../src/core/adapters/registry';
import { ConfigStore } from '../../src/core/config/configStore';
import type { AgentAdapter, SendInput, SendResult } from '../../src/core/adapters/types';
import type { Session } from '../../src/core/session/session';

function fakeAdapter(engineId: string, healthy: boolean): AgentAdapter {
  return {
    capabilities: {
      engineId,
      label: engineId,
      maxContextTokens: 1000,
      supportsCache: true,
    },
    async send(_input: SendInput): Promise<SendResult> {
      return { content: '', raw: {}, usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async healthCheck(): Promise<boolean> {
      return healthy;
    },
    estimateCost(): number {
      return 0;
    },
  };
}

function makeRouter(health: Record<string, boolean>) {
  const registry = new AdapterRegistry();
  registry.register(fakeAdapter('deepseek', health['deepseek'] ?? true));
  registry.register(fakeAdapter('claude', health['claude'] ?? true));
  const config = new ConfigStore();
  return { router: new Router(registry, config), registry, config };
}

function sessionWith(engineId: string): Session {
  return {
    id: 's1',
    title: '会话',
    engineId,
    createdAt: 0,
    updatedAt: 0,
    messages: [],
  };
}

test('未手动选、会话有归属 → 返回 session.engineId，reason=affinity', async () => {
  const { router } = makeRouter({});
  const d = await router.decide(sessionWith('deepseek'));
  assert.equal(d.engineId, 'deepseek');
  assert.equal(d.reason, 'affinity');
  assert.equal(d.migrated, false);
});

test('手动选不同引擎 → reason=manual，migrated=true', async () => {
  const { router } = makeRouter({});
  const d = await router.decide(sessionWith('deepseek'), 'claude');
  assert.equal(d.engineId, 'claude');
  assert.equal(d.reason, 'manual');
  assert.equal(d.migrated, true);
});

test('手动选同一引擎 → migrated=false', async () => {
  const { router } = makeRouter({});
  const d = await router.decide(sessionWith('deepseek'), 'deepseek');
  assert.equal(d.reason, 'manual');
  assert.equal(d.migrated, false);
});

test('新建会话无归属 → 返回 config 默认引擎，reason=default', async () => {
  const { router } = makeRouter({});
  const d = await router.decide(undefined);
  assert.equal(d.engineId, 'deepseek'); // config 默认
  assert.equal(d.reason, 'default');
  assert.equal(d.migrated, false);
});

test('remember：写入 config（memory 策略，供下次新建会话使用）', async () => {
  const { router, config } = makeRouter({});
  router.remember('claude');
  assert.equal(config.getDefaultModel(), 'claude');
  const d = await router.decide(undefined);
  assert.equal(d.engineId, 'claude');
});

test('目标引擎 healthCheck 失败 → failover 降级到第一个健康引擎，migrated=true', async () => {
  const { router } = makeRouter({ deepseek: false, claude: true });
  const d = await router.decide(sessionWith('deepseek'), undefined, { preferHealthy: true });
  assert.equal(d.engineId, 'claude');
  assert.equal(d.reason, 'failover');
  assert.equal(d.migrated, true);
});

test('目标引擎健康 → preferHealthy 不改变决策', async () => {
  const { router } = makeRouter({ deepseek: true });
  const d = await router.decide(sessionWith('deepseek'), undefined, { preferHealthy: true });
  assert.equal(d.engineId, 'deepseek');
  assert.equal(d.reason, 'affinity');
  assert.equal(d.migrated, false);
});

test('不存在的 requestedEngineId → 忽略手动选择，走亲和性', async () => {
  const { router } = makeRouter({});
  const d = await router.decide(sessionWith('deepseek'), 'openai'); // openai 未注册
  assert.equal(d.engineId, 'deepseek');
  assert.equal(d.reason, 'affinity');
});
