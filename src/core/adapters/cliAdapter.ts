import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentAdapter, Capabilities, SendInput, SendResult } from './types';
import type { CliParseResult } from './cliTransport';
import { CliTransport } from './cliTransport';
import type { spawn } from 'node:child_process';

/**
 * 解析 CLI 可执行文件路径。
 * Windows 上 npm 全局安装的是 .cmd 包装（CreateProcess 不执行 .cmd），
 * 需读取包装内容提取真实 .exe 路径（如 %dp0%\node_modules\...\bin\claude.exe）。
 * 非 Windows 或解析失败时原样返回命令名（依赖 PATH）。
 * （pty 终端也复用本函数解析命令。）
 */
export function resolveCliExecutable(command: string): string {
  if (command.includes('/') || command.includes('\\')) {
    return command; // 已是显式路径
  }
  if (process.platform !== 'win32') {
    return command;
  }
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (!dir.trim()) {
      continue;
    }
    const cmdFile = path.join(dir, `${command}.cmd`);
    if (!fs.existsSync(cmdFile)) {
      continue;
    }
    const content = fs.readFileSync(cmdFile, 'utf8');
    const m = content.match(/"([^"]*node_modules[^"]*\.exe)"/);
    if (!m?.[1]) {
      continue;
    }
    const relative = m[1].replace(/^%dp0%\\?/i, '');
    const resolved = path.join(dir, relative);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }
  return command;
}

/**
 * CLI 类引擎适配器基类：复用 CliTransport（spawn → 收集 → 解析），
 * 子类只需提供 command、buildArgs、parseOutput、capabilities。
 * 会话记忆由 ContextFlow 的 sessionStore 管理（每次带完整上下文），CLI 无状态执行。
 */
export interface CliAdapterOptions {
  /** 注入 spawn（默认 node:child_process.spawn），便于单测 */
  spawnFn?: typeof spawn;
  /** CLI stderr 诊断回调 */
  stderrSink?: (chunk: string) => void;
}

export abstract class CliAdapterBase implements AgentAdapter {
  abstract readonly capabilities: Capabilities;
  /** 可执行名（PATH 中的命令名或显式路径） */
  protected abstract readonly command: string;
  protected readonly transport: CliTransport;
  private resolvedCommand: string | undefined;

  constructor(options: CliAdapterOptions = {}) {
    this.transport = new CliTransport({
      spawnFn: options.spawnFn,
      stderrSink: options.stderrSink,
      // parse 由各子类的 parseOutput 提供（this 在调用时已就绪）
      parse: (stdout, stderr) => this.parseOutput(stdout, stderr),
    });
  }

  /** 惰性解析真实可执行路径（Windows npm .cmd 包装） */
  protected getCommand(): string {
    if (!this.resolvedCommand) {
      this.resolvedCommand = resolveCliExecutable(this.command);
    }
    return this.resolvedCommand;
  }

  /** 由子类构造完整 CLI 参数（prompt + 模型 + 推理强度） */
  protected abstract buildArgs(prompt: string, model?: string, effort?: string): string[];

  /** 由子类解析厂商输出为归一化结果 */
  protected abstract parseOutput(stdout: string, stderr: string): CliParseResult;

  async send(input: SendInput): Promise<SendResult> {
    const result = await this.transport.run({
      command: this.getCommand(),
      args: this.buildArgs(
        input.prompt,
        typeof input.options?.model === 'string' ? input.options.model : undefined,
        typeof input.options?.effort === 'string' ? input.options.effort : undefined,
      ),
    });
    const usage: SendResult['usage'] = {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheHitTokens: result.cacheHitTokens,
      costEstimate: this.estimateCost(result),
    };
    return {
      content: result.content,
      raw: result.raw ?? result.rawStdout,
      usage,
    };
  }

  async healthCheck(): Promise<boolean> {
    return this.transport.checkExecutable(this.getCommand());
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
