import type { Capabilities } from './types';
import type { CliParseResult } from './cliTransport';
import { CliAdapterBase } from './cliAdapter';

/**
 * Claude Code Adapter（P1 落地）：`claude -p <prompt> --output-format json`。
 * JSON 输出（2026-08-20 实测 claude 2.1.233）：
 *   { result, is_error, usage: { input_tokens, cache_read_input_tokens, cache_creation_input_tokens,
 *                                output_tokens }, session_id, total_cost_usd, ... }
 * 缓存命中在 usage.cache_read_input_tokens（Anthropic Prompt Caching 读取）。
 * 模型：--model（用户 Claude Code 配置的默认模型也可直接使用；'default' = 用 CLI 默认）。
 */
export class ClaudeCodeAdapter extends CliAdapterBase {
  readonly capabilities: Capabilities = {
    engineId: 'claude',
    label: 'Claude Code',
    maxContextTokens: 200_000,
    supportsCache: true,
    models: ['default'],
    // 参考单价（元/百万 token，参考值；以 Anthropic 定价页为准，可配置覆写）
    pricing: { input: 3, cachedInput: 0.3, output: 15 },
  };

  protected readonly command = 'claude';

  protected buildArgs(prompt: string, model?: string): string[] {
    const args = ['-p', prompt, '--output-format', 'json'];
    if (model && model !== 'default') {
      args.push('--model', model);
    }
    return args;
  }

  protected parseOutput(stdout: string): CliParseResult {
    const json = JSON.parse(stdout.trim()) as {
      result?: unknown;
      is_error?: boolean;
      type?: string;
      error?: { message?: string };
      usage?: {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        output_tokens?: number;
      };
    };
    if (json.is_error || json.type === 'error') {
      throw new Error(json.error?.message ?? JSON.stringify(json).slice(0, 300));
    }
    const usage = json.usage ?? {};
    return {
      content: typeof json.result === 'string' ? json.result : '',
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheHitTokens: usage.cache_read_input_tokens,
      raw: json,
    };
  }
}
