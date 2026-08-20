import * as vscode from 'vscode';
import type { Orchestrator } from '../core/orchestrator';
import type { CacheMetricsSnapshot } from '../core/cache/metrics';
import type { Message, Session } from '../core/session/session';
import { PtyManager } from '../core/pty/ptyManager';
import { renderPanelHtml, type PanelHtmlOptions } from './ui/panelHtml';

/** 面板列表摘要 */
export interface SessionSummary {
  id: string;
  title: string;
  engineId: string;
  updatedAt: number;
}

export interface EngineSummary {
  engineId: string;
  label: string;
  /** 可用模型（面板模型下拉数据源） */
  models?: string[];
  /** 可用推理强度（面板推理强度下拉数据源） */
  efforts?: string[];
}

/** webview → extension（docs/04 第 4 节） */
export type UiRequest =
  | { type: 'init' }
  | { type: 'createSession'; title?: string; engineId?: string }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'selectEngine'; engineId: string; sessionId: string }
  | { type: 'openTerminal'; engineId: string }
  | { type: 'ptyInput'; sessionId: string; data: string }
  | { type: 'ptyResize'; sessionId: string; cols: number; rows: number }
  | { type: 'send'; sessionId?: string; text: string; engineId?: string; model?: string; effort?: string };

/** extension → webview */
export type UiState =
  | { type: 'sessions'; sessions: SessionSummary[]; currentSessionId?: string }
  | { type: 'engines'; engines: EngineSummary[]; currentEngineId?: string }
  | { type: 'metrics'; metrics: CacheMetricsSnapshot }
  | { type: 'messages'; sessionId: string; messages: Message[] }
  | { type: 'message'; message: Message }
  | { type: 'streamStart' }
  | { type: 'streamText'; delta: string }
  | { type: 'streamThinking'; delta: string }
  | { type: 'streamTool'; label: string }
  | { type: 'terminalStart'; sessionId: string; command: string }
  | { type: 'ptyData'; sessionId: string; data: string }
  | { type: 'ptyExit'; sessionId: string; exitCode: number }
  | { type: 'busy'; busy: boolean; hint?: string }
  | { type: 'notice'; text: string }
  | { type: 'error'; text: string };

/** 有终端形式的引擎（创建对话 → 对话窗口直接变终端）；无终端（如 dsh）走消息流 */
function terminalCommandFor(engineId: string): string | undefined {
  switch (engineId) {
    case 'claude':
      return 'claude';
    case 'opencode':
      return 'opencode';
    case 'openai':
      return 'codex';
    default:
      return undefined;
  }
}

/**
 * 侧边栏面板 Provider（docs/04）。
 * 后端持有最新状态，前端被动渲染（状态单向流）。
 * 终端型会话：PTY（node-pty）spawn 原生 CLI，输出/输入经 webview xterm.js 桥接。
 */
export class PanelProvider implements vscode.WebviewViewProvider {
  private currentSessionId: string | undefined;
  private currentView: vscode.WebviewView | undefined;
  private readonly ptyManager: PtyManager;

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.ptyManager = new PtyManager({
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      onData: (sessionId, data) => this.currentView && this.post(this.currentView, { type: 'ptyData', sessionId, data }),
      onExit: (sessionId, exitCode) =>
        this.currentView && this.post(this.currentView, { type: 'ptyExit', sessionId, exitCode }),
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.currentView = webviewView;
    webviewView.webview.options = { enableScripts: true };
    const nonce = getNonce();
    const htmlOptions: PanelHtmlOptions = {
      cspSource: webviewView.webview.cspSource,
      nonce,
      xtermJsUri: webviewView.webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, 'media', 'xterm', 'xterm.js'),
      ).toString(),
      xtermCssUri: webviewView.webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, 'media', 'xterm', 'xterm.css'),
      ).toString(),
    };
    webviewView.webview.html = renderPanelHtml(htmlOptions);
    webviewView.webview.onDidReceiveMessage((msg) => {
      void this.handleMessage(webviewView, msg as UiRequest);
    });
    webviewView.onDidDispose(() => {
      if (this.currentView === webviewView) {
        this.currentView = undefined;
      }
    });
  }

  /**
   * 在集成终端中打开对应 Harness 的原生 CLI（如 claude / opencode）。
   * 终端是 shell，能解析 npm 的 .cmd 包装；原生 TUI 提供完整交互。
   */
  private openTerminal(engineId: string): void {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const label =
      engineId === 'claude' ? 'Claude Code'
      : engineId === 'opencode' ? 'opencode'
      : engineId === 'openai' ? 'Codex'
      : engineId;
    const terminal = vscode.window.createTerminal({ name: `ContextFlow: ${label}`, cwd });
    terminal.show();
    terminal.sendText(engineId);
  }

  private post(view: vscode.WebviewView, state: UiState): void {
    void view.webview.postMessage(state);
  }

  private async handleMessage(view: vscode.WebviewView, msg: UiRequest): Promise<void> {
    const orch = this.orchestrator;
    try {
      switch (msg.type) {
        case 'init': {
          // 立即推声明值（不阻塞 init）；真实模型列表后台刷新
          const engines = this.orchestrator.enginesSync();
          this.post(view, {
            type: 'engines',
            engines,
            currentEngineId: engines[0]?.engineId,
          });
          void this.refreshEngines(view);
          this.post(view, {
            type: 'sessions',
            sessions: toSummaries(orch.listSessions()),
            currentSessionId: this.currentSessionId,
          });
          this.post(view, { type: 'metrics', metrics: orch.metricsSnapshot() });
          if (this.currentSessionId) {
            this.pushSessionView(view, this.currentSessionId);
          }
          break;
        }
        case 'createSession': {
          // 创建时选定 Harness（绑定，后续不可更改）；模型/推理强度对话中可切
          const session = await orch.newSession(msg.engineId);
          this.currentSessionId = session.id;
          this.post(view, {
            type: 'sessions',
            sessions: toSummaries(orch.listSessions()),
            currentSessionId: session.id,
          });
          this.post(view, {
            type: 'engines',
            engines: orch.enginesSync(),
            currentEngineId: session.engineId,
          });
          // 引擎有终端形式 → 对话窗口直接变为终端类窗口（内置 xterm）
          const termCommand = terminalCommandFor(session.engineId);
          if (termCommand) {
            this.ptyManager.spawn(session.id, termCommand, [], this.workspaceCwd());
            this.post(view, { type: 'terminalStart', sessionId: session.id, command: termCommand });
          } else {
            this.post(view, { type: 'messages', sessionId: session.id, messages: [] });
          }
          break;
        }
        case 'selectSession': {
          this.currentSessionId = msg.sessionId;
          this.post(view, {
            type: 'sessions',
            sessions: toSummaries(orch.listSessions()),
            currentSessionId: msg.sessionId,
          });
          this.pushSessionView(view, msg.sessionId);
          const session = orch.getSession(msg.sessionId);
          if (session) {
            this.post(view, {
              type: 'engines',
              engines: orch.enginesSync(),
              currentEngineId: session.engineId,
            });
          }
          break;
        }
        case 'deleteSession': {
          this.ptyManager.kill(msg.sessionId);
          orch.deleteSession(msg.sessionId);
          if (this.currentSessionId === msg.sessionId) {
            this.currentSessionId = undefined;
          }
          this.post(view, {
            type: 'sessions',
            sessions: toSummaries(orch.listSessions()),
            currentSessionId: this.currentSessionId,
          });
          this.post(view, { type: 'messages', sessionId: msg.sessionId, messages: [] });
          break;
        }
        case 'selectEngine': {
          orch.switchEngine(msg.sessionId, msg.engineId);
          this.post(view, {
            type: 'engines',
            engines: orch.enginesSync(),
            currentEngineId: msg.engineId,
          });
          this.post(view, { type: 'notice', text: '正在目标引擎重建缓存…' });
          break;
        }
        case 'openTerminal': {
          this.openTerminal(msg.engineId);
          break;
        }
        case 'ptyInput': {
          this.ptyManager.write(msg.sessionId, msg.data);
          break;
        }
        case 'ptyResize': {
          this.ptyManager.resize(msg.sessionId, msg.cols, msg.rows);
          break;
        }
        case 'send': {
          // 发送进度提示（首次会启动 Harness/CLI 进程，可能数秒~数十秒）
          this.post(view, { type: 'busy', busy: true, hint: '正在连接引擎并发送…' });
          try {
            let sessionId = msg.sessionId;
            if (!sessionId) {
              // 面板未选会话时自动新建
              const session = await orch.newSession(msg.engineId);
              sessionId = session.id;
              this.currentSessionId = session.id;
              this.post(view, {
                type: 'sessions',
                sessions: toSummaries(orch.listSessions()),
                currentSessionId: session.id,
              });
            }
            // 流式：先建流式气泡，增量实时推送；完成后推完整消息替换
            this.post(view, { type: 'streamStart' });
            const outcome = await orch.sendStream(
              sessionId,
              msg.text,
              {
                onText: (delta) => this.post(view, { type: 'streamText', delta }),
                onThinking: (delta) => this.post(view, { type: 'streamThinking', delta }),
                onTool: (label) => this.post(view, { type: 'streamTool', label }),
              },
              msg.engineId,
              msg.model,
              msg.effort,
            );
            this.post(view, { type: 'message', message: outcome.userMessage });
            this.post(view, { type: 'message', message: outcome.assistantMessage });
            this.post(view, { type: 'metrics', metrics: orch.metricsSnapshot() });
            this.post(view, {
              type: 'engines',
              engines: orch.enginesSync(),
              currentEngineId: outcome.decision.engineId,
            });
            // 首条消息可能生成标题，刷新列表
            this.post(view, {
              type: 'sessions',
              sessions: toSummaries(orch.listSessions()),
              currentSessionId: sessionId,
            });
          } finally {
            this.post(view, { type: 'busy', busy: false });
          }
          break;
        }
      }
    } catch (err) {
      this.post(view, {
        type: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 后台刷新引擎真实模型列表（opencode 等），完成后更新面板下拉 */
  private async refreshEngines(view: vscode.WebviewView): Promise<void> {
    try {
      const engines = await this.orchestrator.engines();
      if (this.currentView !== view) {
        return;
      }
      this.post(view, {
        type: 'engines',
        engines,
        currentEngineId: this.currentSessionId
          ? this.orchestrator.getSession(this.currentSessionId)?.engineId
          : engines[0]?.engineId,
      });
    } catch {
      /* 刷新失败保持声明值 */
    }
  }

  /** 推送会话主区视图：终端型 → terminalStart（前端切 xterm）；否则消息流 */
  private pushSessionView(view: vscode.WebviewView, sessionId: string): void {
    const pty = this.ptyManager.get(sessionId);
    if (pty) {
      this.post(view, { type: 'terminalStart', sessionId, command: pty.command });
    } else {
      this.post(view, {
        type: 'messages',
        sessionId,
        messages: this.orchestrator.getSession(sessionId)?.messages ?? [],
      });
    }
  }

  private workspaceCwd(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }
}

function toSummaries(sessions: Session[]): SessionSummary[] {
  return sessions.map((s) => ({
    id: s.id,
    title: s.title,
    engineId: s.engineId,
    updatedAt: s.updatedAt,
  }));
}

/** 生成 webview CSP nonce（VS Code 官方推荐的内联脚本方案） */
function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
