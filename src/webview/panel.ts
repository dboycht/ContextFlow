import * as vscode from 'vscode';
import type { Orchestrator } from '../core/orchestrator';
import type { CacheMetricsSnapshot } from '../core/cache/metrics';
import type { Message, Session } from '../core/session/session';
import { renderPanelHtml } from './ui/panelHtml';

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
}

/** webview → extension（docs/04 第 4 节） */
export type UiRequest =
  | { type: 'init' }
  | { type: 'createSession'; title?: string }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'selectEngine'; engineId: string; sessionId: string }
  | { type: 'send'; sessionId?: string; text: string; engineId?: string; model?: string };

/** extension → webview */
export type UiState =
  | { type: 'sessions'; sessions: SessionSummary[]; currentSessionId?: string }
  | { type: 'engines'; engines: EngineSummary[]; currentEngineId?: string }
  | { type: 'metrics'; metrics: CacheMetricsSnapshot }
  | { type: 'messages'; sessionId: string; messages: Message[] }
  | { type: 'message'; message: Message }
  | { type: 'busy'; busy: boolean; hint?: string }
  | { type: 'notice'; text: string }
  | { type: 'error'; text: string };

/**
 * 侧边栏面板 Provider（docs/04）。
 * 后端持有最新状态，前端被动渲染（状态单向流）。
 */
export class PanelProvider implements vscode.WebviewViewProvider {
  private currentSessionId: string | undefined;

  constructor(private readonly orchestrator: Orchestrator) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = renderPanelHtml();
    webviewView.webview.onDidReceiveMessage((msg) => {
      void this.handleMessage(webviewView, msg as UiRequest);
    });
  }

  private post(view: vscode.WebviewView, state: UiState): void {
    void view.webview.postMessage(state);
  }

  private async handleMessage(view: vscode.WebviewView, msg: UiRequest): Promise<void> {
    const orch = this.orchestrator;
    try {
      switch (msg.type) {
        case 'init': {
          this.post(view, {
            type: 'engines',
            engines: orch.engines(),
            currentEngineId: orch.engines()[0]?.engineId,
          });
          this.post(view, {
            type: 'sessions',
            sessions: toSummaries(orch.listSessions()),
            currentSessionId: this.currentSessionId,
          });
          this.post(view, { type: 'metrics', metrics: orch.metricsSnapshot() });
          if (this.currentSessionId) {
            this.post(view, {
              type: 'messages',
              sessionId: this.currentSessionId,
              messages: orch.getSession(this.currentSessionId)?.messages ?? [],
            });
          }
          break;
        }
        case 'createSession': {
          const session = await orch.newSession();
          this.currentSessionId = session.id;
          this.post(view, {
            type: 'sessions',
            sessions: toSummaries(orch.listSessions()),
            currentSessionId: session.id,
          });
          this.post(view, { type: 'messages', sessionId: session.id, messages: [] });
          break;
        }
        case 'selectSession': {
          this.currentSessionId = msg.sessionId;
          const session = orch.getSession(msg.sessionId);
          this.post(view, {
            type: 'messages',
            sessionId: msg.sessionId,
            messages: session?.messages ?? [],
          });
          if (session) {
            this.post(view, {
              type: 'engines',
              engines: orch.engines(),
              currentEngineId: session.engineId,
            });
          }
          break;
        }
        case 'deleteSession': {
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
            engines: orch.engines(),
            currentEngineId: msg.engineId,
          });
          this.post(view, { type: 'notice', text: '正在目标引擎重建缓存…' });
          break;
        }
        case 'send': {
          // 发送进度提示（首次会连接/启动 Harness 进程，可能数秒~数十秒）
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
            const outcome = await orch.send(sessionId, msg.text, msg.engineId, msg.model);
            this.post(view, { type: 'message', message: outcome.userMessage });
            this.post(view, { type: 'message', message: outcome.assistantMessage });
            this.post(view, { type: 'metrics', metrics: orch.metricsSnapshot() });
            this.post(view, {
              type: 'engines',
              engines: orch.engines(),
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
}

function toSummaries(sessions: Session[]): SessionSummary[] {
  return sessions.map((s) => ({
    id: s.id,
    title: s.title,
    engineId: s.engineId,
    updatedAt: s.updatedAt,
  }));
}
