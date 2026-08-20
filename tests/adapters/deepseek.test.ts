import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekAdapter } from '../../src/core/adapters/deepseek';
import type { DshSendInput, DshSendResult, DshTransport } from '../../src/core/adapters/dshTransport';
import type { DeepSeekConfig } from '../../src/core/config/configStore';
import type { ContextRef } from '../../src/core/cache/types';

const CONFIG: DeepSeekConfig = {
  command: 'node',
  args: [],
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  maxContextTokens: 128_000,
  minCacheTokens: 1024,
  pricing: { input: 2, cachedInput: 0.2, output: 8 },
};

const CONTEXT_REF: ContextRef = {
  cacheEntry: null,
  prefixText: '前缀',
  newText: '问题',
};

/** 可编程 mock 传输：单测不真联网、不真 spawn */
class MockDshTransport implements DshTransport {
  calls: DshSendInput[] = [];
  healthy = true;
  result: DshSendResult = {
    content: 'mock 回复',
    raw: { ok: true },
    inputTokens: 1000,
    outputTokens: 200,
  };

  async start(): Promise<void> {}

  async send(input: DshSendInput): Promise<DshSendResult> {
    this.calls.push(input);
    return { ...this.result };
  }

  async healthCheck(): Promise<boolean> {
    return this.healthy;
  }

  async close(): Promise<void> {}
}

function makeAdapter(overrides?: Partial<MockDshTransport>) {
  const transport = new MockDshTransport();
  if (overrides) {
    Object.assign(transport, overrides);
  }
  const adapter = new DeepSeekAdapter(transport, CONFIG);
  return { transport, adapter };
}

test('capabilities：engineId/label/缓存与定价声明', () => {
  const { adapter } = makeAdapter();
  assert.equal(adapter.capabilities.engineId, 'deepseek');
  assert.equal(adapter.capabilities.label, 'DeepSeek Harness');
  assert.equal(adapter.capabilities.supportsCache, true);
  assert.deepEqual(adapter.capabilities.pricing, CONFIG.pricing);
});

test('首次发送（未命中缓存）：prompt/sessionId 透传，usage 归一化', async () => {
  const { transport, adapter } = makeAdapter();
  const result = await adapter.send({
    prompt: '前缀\n问题',
    contextRef: CONTEXT_REF,
    sessionId: 's1',
  });
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]!.prompt, '前缀\n问题');
  assert.equal(transport.calls[0]!.sessionId, 's1');
  assert.equal(result.content, 'mock 回复');
  assert.equal(result.usage.inputTokens, 1000);
  assert.equal(result.usage.outputTokens, 200);
  assert.equal(result.usage.cacheHitTokens, undefined);
});

test('二次发送（命中）：transport 回传 cacheHitTokens → usage.cacheHitTokens > 0', async () => {
  const { transport, adapter } = makeAdapter();
  transport.result = {
    content: '命中回复',
    raw: {},
    inputTokens: 1000,
    outputTokens: 150,
    cacheHitTokens: 800,
  };
  const result = await adapter.send({
    prompt: '前缀\n新问题',
    contextRef: CONTEXT_REF,
    sessionId: 's1',
  });
  assert.equal(result.usage.cacheHitTokens, 800);
  assert.equal(result.usage.inputTokens, 1000);
});

test('healthCheck：传输健康 → true；传输故障 → false', async () => {
  const { adapter } = makeAdapter();
  assert.equal(await adapter.healthCheck(), true);

  const { adapter: bad } = makeAdapter({ healthy: false });
  assert.equal(await bad.healthCheck(), false);
});

test('estimateCost：命中 cachedInput 价、新增 input 价、输出 output 价', () => {
  const { adapter } = makeAdapter();
  // 1000 输入 = 800 命中 + 200 新增；200 输出
  // cost = (200*2 + 800*0.2 + 200*8) / 1e6 = (400+160+1600)/1e6 = 0.00216
  const cost = adapter.estimateCost({
    inputTokens: 1000,
    outputTokens: 200,
    cacheHitTokens: 800,
  });
  assert.ok(Math.abs(cost - 0.00216) < 1e-12, `cost=${cost}`);
});

test('estimateCost：无 cacheHitTokens 视为 0（全部按 input 价）', () => {
  const { adapter } = makeAdapter();
  const cost = adapter.estimateCost({ inputTokens: 1000, outputTokens: 0 });
  assert.ok(Math.abs(cost - (1000 * 2) / 1e6) < 1e-12);
});
