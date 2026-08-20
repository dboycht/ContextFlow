import { resolveCliExecutable } from '../adapters/cliAdapter';

type PtyModule = typeof import('node-pty');
type IPty = ReturnType<PtyModule['spawn']>;

/**
 * 终端会话管理器（插件内置终端，docs 最终样式：创建对话 → Harness 有终端形式 →
 * 对话窗口直接变为终端类窗口，跑原生 CLI TUI）。
 *
 * 底层 node-pty（Windows ConPTY/winpty）：扩展宿主侧创建 PTY spawn 目标 CLI，
 * 输出经 onData 转发 webview（xterm.js 渲染），键盘输入由 webview 回传 write。
 * ⚠️ node-pty 是 native 模块：node（测试）/electron（扩展宿主）ABI 需分别安装，
 * 见 scripts/switch-native.ps1。
 */

export interface PtySession {
  readonly id: string;
  readonly command: string;
  readonly pid: number;
  readonly exited: boolean;
  write(data: string): void;
  kill(): void;
}

export interface PtyManagerOptions {
  /** PTY 输出（ANSI 流）→ webview */
  onData: (sessionId: string, data: string) => void;
  /** 进程退出 */
  onExit: (sessionId: string, exitCode: number) => void;
  /** 默认工作目录 */
  cwd?: string;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export class PtyManager {
  private readonly sessions = new Map<string, PtySessionInternal>();

  constructor(private readonly options: PtyManagerOptions) {}

  /** 启动一个终端会话（spawn 解析后的真实可执行文件） */
  spawn(sessionId: string, command: string, args: string[] = [], cwd?: string): PtySession {
    // 惰性加载 native（node/electron ABI 问题不拖垮扩展启动；加载失败时终端功能报错）
    const pty = require('node-pty') as PtyModule;
    const exe = resolveCliExecutable(command);
    const p = pty.spawn(exe, args, {
      name: 'xterm-color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: cwd ?? this.options.cwd ?? process.cwd(),
    });
    let exited = false;
    const session: PtySessionInternal = {
      id: sessionId,
      command,
      pid: p.pid,
      pty: p,
      get exited() {
        return exited;
      },
      write: (data) => {
        if (!exited) {
          p.write(data);
        }
      },
      kill: () => {
        if (!exited) {
          exited = true;
          p.kill();
        }
      },
    };
    p.onData((data) => {
      if (!exited) {
        this.options.onData(sessionId, data);
      }
    });
    p.onExit(({ exitCode }) => {
      exited = true;
      this.options.onExit(sessionId, exitCode ?? 0);
    });
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): PtySession | undefined {
    return this.sessions.get(sessionId);
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.exited) {
      return;
    }
    session.pty.resize(cols, rows);
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.kill();
      this.sessions.delete(sessionId);
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.kill(id);
    }
  }
}

interface PtySessionInternal extends PtySession {
  pty: IPty;
}
