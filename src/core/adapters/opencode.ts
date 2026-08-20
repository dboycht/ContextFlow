import type { Capabilities } from './types';
import type { CliParseResult } from './cliTransport';
import { CliAdapterBase } from './cliAdapter';

/**
 * opencode Adapter（P1 落地）：`opencode run <prompt> --format json`。
 * NDJSON 事件流（2026-08-20 实测 opencode 1.18.18）：
 *   {"type":"text","part":{"type":"text","text":"..."}}            ← 回复文本
 *   {"type":"step_finish","part":{"tokens":{"input","output","cache":{"write","read"}}}} ← 用量
 * 缓存命中在 step_finish.part.tokens.cache.read。
 * 模型：-m provider/model（'default' = 用 opencode 配置的默认 provider/model）。
 */
export class OpencodeAdapter extends CliAdapterBase {
  readonly capabilities: Capabilities = {
    engineId: 'opencode',
    label: 'opencode',
    maxContextTokens: 200_000,
    supportsCache: true,
    models: ['default'],
    // 参考单价（元/百万 token，参考值；以实际 provider 定价为准，可配置覆写）
    pricing: { input: 2, cachedInput: 0.2, output: 8 },
  };

  protected readonly command = 'opencode';

  protected buildArgs(prompt: string, model?: string): string[] {
    const args = ['run', prompt, '--format', 'json'];
    if (model && model !== 'default') {
      args.push('-m', model);
    }
    return args;
  }

  protected parseOutput(stdout: string): CliParseResult {
    const texts: string[] = [];
    let tokens:
      | { input?: number; output?: number; cache?: { read?: number; write?: number } }
      | undefined;
    for (const line of stdout.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const event = JSON.parse(line) as {
        type?: string;
        error?: string;
        part?: {
          type?: string;
          text?: string;
          tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
        };
      };
      if (event.type === 'error') {
        throw new Error(event.error ?? 'opencode error event');
      }
      if (event.type === 'text' && event.part?.type === 'text' && typeof event.part.text === 'string') {
        texts.push(event.part.text);
      }
      if (event.type === 'step_finish' && event.part?.tokens) {
        tokens = event.part.tokens;
      }
    }
    return {
      content: texts.join('\n'),
      inputTokens: tokens?.input ?? 0,
      outputTokens: tokens?.output ?? 0,
      cacheHitTokens: tokens?.cache?.read,
      raw: { eventCount: texts.length, hasTokens: Boolean(tokens) },
    };
  }
}
