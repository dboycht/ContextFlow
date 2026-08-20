import type { Capabilities, SendInput, SendResult, StreamHandlers } from './types';
import type { CliParseResult } from './cliTransport';
import { CliAdapterBase } from './cliAdapter';

/**
 * Claude Code Adapter（P1 落地）：`claude -p <prompt>` headless。
 *
 * 非流式：`--output-format json`（JSON：result + usage，含 cache_read_input_tokens）。
 * 流式：`--output-format stream-json --verbose`（逐行事件，2026-08-20 实测 claude 2.1.233）：
 *   {"type":"assistant","message":{"content":[{"type":"thinking","thinking":"..."},
 *     {"type":"text","text":"..."},{"type":"tool_use","name":...,"input":...}]}}   ← 对话/思考/工具流
 *   {"type":"result","result":"...","usage":{"input_tokens","cache_read_input_tokens","output_tokens"}}
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
    // 推理强度（--effort <level>，2026-08-20 实测 high/low 均合法；default = 不传）
    efforts: ['default', 'low', 'medium', 'high'],
    // 参考单价（元/百万 token，参考值；以 Anthropic 定价页为准，可配置覆写）
    pricing: { input: 3, cachedInput: 0.3, output: 15 },
  };

  protected readonly command = 'claude';

  protected buildArgs(prompt: string, model?: string, effort?: string): string[] {
    const args = ['-p', prompt, '--output-format', 'json'];
    if (model && model !== 'default') {
      args.push('--model', model);
    }
    if (effort && effort !== 'default') {
      args.push('--effort', effort);
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

  /** 流式发送：逐行解析 stream-json 事件，实时转发思考/文本/工具流 */
  async sendStream(input: SendInput, handlers: StreamHandlers): Promise<SendResult> {
    const model = typeof input.options?.model === 'string' ? input.options.model : undefined;
    const effort = typeof input.options?.effort === 'string' ? input.options.effort : undefined;
    const args = ['-p', input.prompt, '--output-format', 'stream-json', '--verbose'];
    if (model && model !== 'default') {
      args.push('--model', model);
    }
    if (effort && effort !== 'default') {
      args.push('--effort', effort);
    }

    let finalContent = '';
    let finalUsage: SendResult['usage'] = { inputTokens: 0, outputTokens: 0 };
    let sawResult = false;
    const events: unknown[] = [];

    await this.transport.runStream({ command: this.getCommand(), args }, (line) => {
      const event = JSON.parse(line) as {
        type?: string;
        is_error?: boolean;
        error?: { message?: string };
        result?: unknown;
        usage?: {
          input_tokens?: number;
          cache_read_input_tokens?: number;
          output_tokens?: number;
        };
        message?: {
          content?: Array<{
            type?: string;
            thinking?: string;
            text?: string;
            name?: string;
            input?: unknown;
          }>;
        };
      };
      events.push(event);

      if (event.type === 'assistant') {
        for (const block of event.message?.content ?? []) {
          if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
            handlers.onThinking?.(block.thinking);
          } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            handlers.onText?.(block.text);
          } else if (block.type === 'tool_use') {
            handlers.onTool?.(`${block.name ?? 'tool'}: ${JSON.stringify(block.input ?? {})}`);
          }
        }
      } else if (event.type === 'result') {
        if (event.is_error) {
          throw new Error(event.error?.message ?? JSON.stringify(event).slice(0, 300));
        }
        finalContent = typeof event.result === 'string' ? event.result : '';
        const u = event.usage ?? {};
        finalUsage = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheHitTokens: u.cache_read_input_tokens,
          costEstimate: this.estimateCost({
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheHitTokens: u.cache_read_input_tokens,
          }),
        };
        handlers.onUsage?.(finalUsage);
        sawResult = true;
      }
    });

    if (!sawResult) {
      throw new Error('claude stream: no result event');
    }
    return { content: finalContent, raw: events, usage: finalUsage };
  }
}
