import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterRegistry } from '../../src/core/adapters/registry';
import type { AgentAdapter, SendInput, SendResult } from '../../src/core/adapters/types';

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

test('register/get：按 engineId 存取', () => {
  const r = new AdapterRegistry();
  const deepseek = fakeAdapter('deepseek', true);
  r.register(deepseek);
  assert.equal(r.get('deepseek'), deepseek);
  assert.equal(r.get('claude'), undefined);
});

test('list：返回注册顺序', () => {
  const r = new AdapterRegistry();
  r.register(fakeAdapter('deepseek', true));
  r.register(fakeAdapter('claude', true));
  assert.deepEqual(
    r.list().map((a) => a.capabilities.engineId),
    ['deepseek', 'claude'],
  );
});

test('healthMap：healthCheck 失败被标记 false（故障转移依据）', async () => {
  const r = new AdapterRegistry();
  r.register(fakeAdapter('deepseek', true));
  r.register(fakeAdapter('claude', false));
  const health = await r.healthMap();
  assert.deepEqual(health, { deepseek: true, claude: false });
});
