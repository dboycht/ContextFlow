import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * 驱动 DeepSeek Harness 的传输层（docs/02 §4.1 调研结论：SDK JSON-RPC 通道）。
 *
 * 协议依据 deepseek-harness `packages/sdk/protocol`（v0.1.0-rc.5，本地 fork 源码）：
 * - 传输：newline-delimited JSON-RPC 2.0 over stdio（一行一帧）
 * - client→server：initialize / session/prompt / shutdown
 * - server→client 通知：session.event / session.status / subagent.started / subagent.finished
 *
 * 分两层：
 * 1. JsonRpcLineTransport —— 纯帧层（与进程无关，可独立单测）
 * 2. DshJsonRpcTransport —— 业务层（spawn dsh 进程 + 协议流程）
 */

/** 一条 JSON-RPC 请求/响应/通知的通用形态 */
export interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorLike {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcResponseError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcResponseError';
  }
}

export interface JsonRpcLineTransportOptions {
  /** 服务端推送通知的回调（session.event / session.status 等） */
  onNotification?: (notification: JsonRpcNotification) => void;
}

/**
 * newline-delimited JSON-RPC 2.0 帧层。
 * 单测可用双端流（Readable/Writable）模拟 stdio，不依赖真实进程。
 */
export class JsonRpcLineTransport {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private closed = false;
  private buffer = '';

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    private readonly options: JsonRpcLineTransportOptions = {},
  ) {
    input.on('data', (chunk: Buffer | string) => this.handleChunk(chunk));
    // 流关闭/EOF：对端进程退出时拒绝所有 pending，避免请求永久挂起
    input.on('end', () => this.close());
    input.on('close', () => this.close());
    input.on('error', () => this.close());
  }

  /** 发请求并等待响应 */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('JsonRpcLineTransport closed'));
    }
    const id = this.nextId++;
    const frame: JsonRpcRequest = { id, method };
    if (params !== undefined) {
      frame.params = params;
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.output.write(`${JSON.stringify(frame)}\n`);
    });
  }

  /** 发通知（本协议当前未使用 client→server 通知，保留对称性） */
  notify(method: string, params?: unknown): void {
    if (this.closed) {
      return;
    }
    const frame: JsonRpcNotification = { method };
    if (params !== undefined) {
      frame.params = params;
    }
    this.output.write(`${JSON.stringify(frame)}\n`);
  }

  close(): void {
    this.closed = true;
    for (const { reject } of this.pending.values()) {
      reject(new Error('JsonRpcLineTransport closed'));
    }
    this.pending.clear();
  }

  private handleChunk(chunk: Buffer | string): void {
    this.buffer += chunk.toString('utf8');
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // 协议约定：畸形 JSON 行直接忽略
      return;
    }
    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      // 服务端发来的请求：本协议为 dead capability，回 -32601
      this.output.write(
        `${JSON.stringify({ id: msg.id, error: { code: -32601, message: 'method not found' } })}\n`,
      );
      return;
    }
    if (typeof msg.id === 'number') {
      // 响应
      const entry = this.pending.get(msg.id);
      if (!entry) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new JsonRpcResponseError(msg.error.code, msg.error.message, msg.error.data));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === 'string') {
      // 通知
      this.options.onNotification?.({ method: msg.method, params: msg.params });
    }
  }
}

/** 驱动一次发送的输入 */
export interface DshSendInput {
  prompt: string;
  sessionId: string;
  /** 单轮超时（ms），默认 120s */
  timeoutMs?: number;
}

/** 一次发送的结果（已归一化的用量） */
export interface DshSendResult {
  content: string;
  raw: unknown;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens?: number;
}

/** 传输层抽象：适配器只依赖本接口，真实实现与 mock 可互换 */
export interface DshTransport {
  start(): Promise<void>;
  send(input: DshSendInput): Promise<DshSendResult>;
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}

/** dsh 进程启动规格（ContextFlow 不负责安装 Harness，只负责按配置拉起） */
export interface DshLaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** 会话事件提取器：把服务端通知累积成一轮回复（真实事件结构联调时校准） */
export interface TurnAccumulator {
  texts: string[];
  usage?: { inputTokens: number; outputTokens: number; cacheHitTokens?: number };
}

export type TurnExtractor = (
  notification: JsonRpcNotification,
  acc: TurnAccumulator,
) => void;

/**
 * 默认提取器：解析真实 dsh SessionEvent（2026-08-20 联调校准）。
 * 结构（packages/session 事件载荷）：session.event 通知的 params={sessionId, event}，
 * event = { type: 'assistant/message', data: { message: { content: ContentBlock[] }, usage: TokenUsage } }。
 * TokenUsage 为 disjoint 语义（packages/llm types.ts）：inputTokens=未命中输入、
 * cacheReadTokens=缓存命中读取、cacheWriteTokens=缓存写入（计费输入=三者之和）。
 * 映射到 ContextFlow 口径：inputTokens(总输入)=input+cacheRead+cacheWrite，cacheHitTokens=cacheRead。
 */
export const defaultTurnExtractor: TurnExtractor = (notification, acc) => {
  if (notification.method !== 'session.event') {
    return;
  }
  const params = notification.params as Record<string, unknown> | undefined;
  const event = params?.['event'] as Record<string, unknown> | undefined;
  if (!event || event['type'] !== 'assistant/message') {
    return;
  }
  const data = event['data'] as Record<string, unknown> | undefined;
  const message = data?.['message'] as Record<string, unknown> | undefined;
  const content = message?.['content'];
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b?.['type'] === 'text' && typeof b['text'] === 'string' && b['text'].length > 0) {
        acc.texts.push(b['text']);
      }
    }
  }
  const usage = data?.['usage'] as Record<string, unknown> | undefined;
  if (usage) {
    const input = num(usage['inputTokens']) ?? 0;
    const cacheRead = num(usage['cacheReadTokens']) ?? 0;
    const cacheWrite = num(usage['cacheWriteTokens']) ?? 0;
    acc.usage = {
      inputTokens: input + cacheRead + cacheWrite,
      outputTokens: num(usage['outputTokens']) ?? 0,
      cacheHitTokens: cacheRead > 0 || cacheWrite > 0 ? cacheRead : undefined,
    };
  }
};

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export interface DshJsonRpcTransportOptions {
  /** 注入 spawn（默认 node:child_process.spawn），便于单测 */
  spawnFn?: typeof spawn;
  /** 通知累积提取器，默认 defaultTurnExtractor */
  extractor?: TurnExtractor;
  /** 一轮等待 idle 的超时（ms），默认 120_000 */
  idleTimeoutMs?: number;
  /** shutdown 后等待进程退出的超时（ms），默认 5_000 */
  exitTimeoutMs?: number;
  /** dsh 进程 stderr 诊断回调（联调/排坑用；stdout 只走协议帧） */
  stderrSink?: (chunk: string) => void;
}

const IDLE_STATUS = 'idle';

/**
 * 驱动 DeepSeek Harness 的 SDK JSON-RPC 客户端（stdio）。
 * 生命周期：start()（惰性 spawn + initialize）→ send() 任意次 → close()（shutdown + 回收进程）。
 */
export class DshJsonRpcTransport implements DshTransport {
  private child: ChildProcess | null = null;
  private rpc: JsonRpcLineTransport | null = null;
  private started = false;
  private readonly spawnFn: typeof spawn;
  private readonly extractor: TurnExtractor;
  private readonly idleTimeoutMs: number;
  private readonly exitTimeoutMs: number;
  private readonly stderrSink?: (chunk: string) => void;

  constructor(
    private readonly launch: DshLaunchSpec,
    options: DshJsonRpcTransportOptions = {},
  ) {
    this.spawnFn = options.spawnFn ?? spawn;
    this.extractor = options.extractor ?? defaultTurnExtractor;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
    this.exitTimeoutMs = options.exitTimeoutMs ?? 5_000;
    this.stderrSink = options.stderrSink;
  }

  /** 幂等：spawn 进程并完成 initialize 握手 */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    const child = this.spawnFn(this.launch.command, this.launch.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.launch.env },
      cwd: this.launch.cwd,
      windowsHide: true,
    });
    this.child = child;
    if (this.stderrSink) {
      child.stderr?.on('data', (chunk: Buffer | string) =>
        this.stderrSink?.(chunk.toString('utf8')),
      );
    }
    // 子进程 spawn 失败或提前退出：关闭传输 → 拒绝 pending 请求，避免调用方永久挂起
    child.on('error', () => {
      this.rpc?.close();
    });
    child.on('exit', () => {
      this.rpc?.close();
    });
    const rpc = new JsonRpcLineTransport(child.stdout, child.stdin, {
      onNotification: (n) => this.notificationHandler?.(n),
    });
    this.rpc = rpc;
    // InitializeParams.cwd 为必填（协议类型），须为绝对路径——dsh 记录到会话头
    await rpc.request('initialize', {
      cwd: resolve(this.launch.cwd ?? process.cwd()),
      provider: this.launch.env?.['DSH_ADAPTER_PROVIDER'] ?? 'deepseek-official',
      model: this.launch.env?.['DSH_ADAPTER_MODEL'] ?? 'deepseek-v4-flash',
    });
    this.started = true;
  }

  /**
   * 发一轮 prompt 并等到目标会话 idle（收集回复）。
   * 返回归一化结果；usage 提取依赖 extractor，真实字段联调校准。
   * ⚠️ send 需串行调用（通知桥为单槽设计；适配器/编排层负责串行化）。
   */
  async send(input: DshSendInput): Promise<DshSendResult> {
    await this.start();
    const rpc = this.rpc;
    if (!rpc) {
      throw new Error('DshJsonRpcTransport not started');
    }
    const sessionId = input.sessionId;
    const acc: TurnAccumulator = { texts: [] };

    const idleSeen = new Promise<boolean>((resolve) => {
      // 通知处理器由构造时注入：这里无法替换，改为在发送前挂一个临时桥
      this.notificationHandler = (notification) => {
        this.extractor(notification, acc);
        if (notification.method === 'session.status') {
          const params = notification.params as Record<string, unknown> | undefined;
          if (params?.['sessionId'] === sessionId && params['status'] === IDLE_STATUS) {
            resolve(true);
          }
        }
      };
    });

    const result = (await rpc.request('session/prompt', {
      sessionId,
      contentBlocks: [{ type: 'text', text: input.prompt }],
    })) as { messageId: string };

    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`dsh prompt timeout after ${input.timeoutMs ?? this.idleTimeoutMs}ms`)),
        input.timeoutMs ?? this.idleTimeoutMs,
      );
      // 防止定时器悬挂
      (idleSeen as Promise<boolean>).finally(() => clearTimeout(timer));
    });

    await Promise.race([idleSeen, timeout]);

    return {
      content: acc.texts.join('\n'),
      raw: result,
      inputTokens: acc.usage?.inputTokens ?? 0,
      outputTokens: acc.usage?.outputTokens ?? 0,
      cacheHitTokens: acc.usage?.cacheHitTokens,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.start();
      return true;
    } catch {
      return false;
    }
  }

  /** shutdown 协议 + 进程回收（EOF → SIGTERM → SIGKILL 简化实现） */
  async close(): Promise<void> {
    const rpc = this.rpc;
    const child = this.child;
    if (rpc) {
      try {
        await rpc.request('shutdown');
      } catch {
        // 忽略：进程可能已退出
      }
    }
    rpc?.close();
    if (child && child.exitCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            if (child.exitCode === null) {
              child.kill('SIGKILL');
            }
            resolve();
          }, this.exitTimeoutMs),
        ),
      ]);
    }
    this.child = null;
    this.rpc = null;
    this.started = false;
  }

  // 内部通知桥：由 send 挂载，避免构造时耦合会话上下文
  private notificationHandler: ((n: JsonRpcNotification) => void) | null = null;
}
