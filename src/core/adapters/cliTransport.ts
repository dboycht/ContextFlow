import { spawn } from 'node:child_process';

/**
 * 通用 CLI headless transport（docs/02 §4.1 调研结论：成熟终端 Harness 走 CLI headless）。
 *
 * 支持 Claude Code（claude -p --output-format json）、opencode（run --format json）、
 * codex（exec --json）等一次性无状态调用：spawn → 收集 stdout/stderr → 超时/退出码检查 → 解析。
 * 会话记忆由 ContextFlow 自己的 sessionStore 管理（每次带完整上下文），CLI 无状态执行。
 */

/** 一次 CLI 调用的启动规格（由 adapter 构造完整参数） */
export interface CliLaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** 超时（ms），默认 180_000 */
  timeoutMs?: number;
}

/** 解析结果（各 adapter 提供解析器，把厂商输出归一化） */
export interface CliParseResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens?: number;
  /** 归一化后的原始载荷（诊断/度量用） */
  raw?: unknown;
}

export interface CliRunResult extends CliParseResult {
  /** 原始 stdout（诊断用，可能很大） */
  rawStdout: string;
}

export interface CliTransportOptions {
  /** 注入 spawn（默认 node:child_process.spawn），便于单测 */
  spawnFn?: typeof spawn;
  /** stderr 诊断回调（stdout 由 parse 消费） */
  stderrSink?: (chunk: string) => void;
  /** 输出解析器：stdout → 归一化结果（各 adapter 定制） */
  parse: (stdout: string, stderr: string) => CliParseResult;
}

export class CliTransport {
  private readonly spawnFn: typeof spawn;
  private readonly stderrSink?: (chunk: string) => void;
  private readonly parse: (stdout: string, stderr: string) => CliParseResult;

  constructor(options: CliTransportOptions) {
    this.spawnFn = options.spawnFn ?? spawn;
    this.stderrSink = options.stderrSink;
    this.parse = options.parse;
  }

  /** 跑一次 CLI headless 调用；非 0 退出/超时/解析失败 → reject */
  run(spec: CliLaunchSpec): Promise<CliRunResult> {
    const timeoutMs = spec.timeoutMs ?? 180_000;
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(spec.command, spec.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...spec.env },
        cwd: spec.cwd,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString('utf8');
        stderr += text;
        this.stderrSink?.(text);
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`cli timeout after ${timeoutMs}ms: ${spec.command} ${spec.args.join(' ')}`));
      }, timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const tail = stderr.trim().slice(-400) || stdout.trim().slice(-400);
          reject(new Error(`cli exited ${code ?? 'unknown'}: ${tail}`));
          return;
        }
        try {
          const parsed = this.parse(stdout, stderr);
          resolve({ ...parsed, rawStdout: stdout });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  /**
   * 流式运行：spawn 后**逐行**回调（厂商 NDJSON/JSONL 事件流），边读边推。
   * 非 0 退出/超时 → reject；正常结束（exit 0）→ resolve。
   * @param onLine 每收到一行完整 JSON 事件时调用（adapter 负责解析与转发）
   */
  runStream(
    spec: CliLaunchSpec,
    onLine: (line: string) => void,
  ): Promise<void> {
    const timeoutMs = spec.timeoutMs ?? 180_000;
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(spec.command, spec.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...spec.env },
        cwd: spec.cwd,
        windowsHide: true,
      });
      let stderr = '';
      let buffer = '';
      child.stdout.on('data', (chunk: Buffer | string) => {
        buffer += chunk.toString('utf8');
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) {
            try {
              onLine(line);
            } catch (err) {
              child.kill('SIGKILL');
              reject(err instanceof Error ? err : new Error(String(err)));
              return;
            }
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString('utf8');
        this.stderrSink?.(chunk.toString('utf8'));
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`cli timeout after ${timeoutMs}ms: ${spec.command} ${spec.args.join(' ')}`));
      }, timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const tail = stderr.trim().slice(-400);
          reject(new Error(`cli exited ${code ?? 'unknown'}: ${tail}`));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * 健康检查：spawn `command --version`，只看退出码（不 parse 输出）。
   * 用于 CLI 类引擎的故障转移判断。
   */
  checkExecutable(command: string, timeoutMs = 15_000): Promise<boolean> {
    return new Promise((resolve) => {
      const child = this.spawnFn(command, ['--version'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(false);
      }, timeoutMs);
      child.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  }
}
