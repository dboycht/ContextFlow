import type { AgentAdapter, Capabilities, SendInput, SendResult } from './types';
import type { DshTransport } from './dshTransport';
import type { DeepSeekConfig } from '../config/configStore';

/**
 * DeepSeekAdapter（P0）：驱动 DeepSeek Harness（docs/02 §4.1 推荐 SDK JSON-RPC 通道）。
 *
 * 缓存语义（2026-08-20 官方文档核对，api-docs.deepseek.com/guides/kv_cache/）：
 * - DeepSeek 上下文缓存**默认开启、自动前缀匹配**，无显式 cache_id 回传
 *   （与 Anthropic cache_control 不同；SendResult.cacheId 不适用）。
 * - 命中信息在直连 API 的 usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens；
 *   驱动 Harness 时 wire 不携带 usage（docs/02 §4.1 坑），命中统计走
 *   extractor 提取或会话日志/直连对照，见 DEVELOPMENT.md。
 * - 缓存 TTL：数小时到数天（自动清除）；命中要求「完整匹配缓存前缀单元」，
 *   因此 ContextFlow 的固定前缀组装（docs/01）是命中的前提。
 */
export class DeepSeekAdapter implements AgentAdapter {
  readonly capabilities: Capabilities;

  constructor(
    private readonly transport: DshTransport,
    config: DeepSeekConfig,
  ) {
    this.capabilities = {
      engineId: 'deepseek',
      label: 'DeepSeek Harness',
      maxContextTokens: config.maxContextTokens,
      supportsCache: true,
      pricing: config.pricing,
    };
  }

  async send(input: SendInput): Promise<SendResult> {
    const result = await this.transport.send({
      prompt: input.prompt,
      sessionId: input.sessionId,
      ...(input.options?.timeoutMs !== undefined
        ? { timeoutMs: input.options.timeoutMs as number }
        : {}),
    });
    const usage: SendResult['usage'] = {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheHitTokens: result.cacheHitTokens,
      costEstimate: this.estimateCost(result),
    };
    return { content: result.content, raw: result.raw, usage };
  }

  async healthCheck(): Promise<boolean> {
    return this.transport.healthCheck();
  }

  /** 命中 token 用 cachedInput 价，新增用 input 价，输出用 output 价（docs/02 §8） */
  estimateCost(usage: SendResult['usage']): number {
    const pricing = this.capabilities.pricing;
    if (!pricing) {
      return 0;
    }
    const cached = usage.cacheHitTokens ?? 0;
    const fresh = Math.max(0, usage.inputTokens - cached);
    return (
      (fresh * pricing.input + cached * pricing.cachedInput + usage.outputTokens * pricing.output) /
      1_000_000
    );
  }
}
