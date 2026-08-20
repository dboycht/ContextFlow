import * as vscode from 'vscode';
import type { Core } from '../core/bootstrap';

/**
 * 侧边栏 WebviewViewProvider。
 *
 * 本里程碑只渲染空面板占位页；会话列表 / 模型切换 / 缓存状态条在 P1 接入
 * （见 docs/04-VSCode插件面板.md）。
 */
export class PanelProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly core: Core,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: false };
    webviewView.webview.html = this.renderHtml();
  }

  private renderHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 12px;
  }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 8px; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.6; }
  .badge {
    display: inline-block;
    margin-top: 12px;
    padding: 3px 10px;
    border-radius: 10px;
    font-size: 11px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
</style>
</head>
<body>
  <h1>ContextFlow</h1>
  <div class="muted">
    统一编排多家 AI 编程引擎（DeepSeek / Claude / Codex），
    并在引擎之上加一层前缀缓存，让重复上下文不再重复计费。
  </div>
  <div class="badge">骨架 v1.0.1 · 缓存层已就绪</div>
  <div class="muted" style="margin-top:8px">
    会话列表 / 模型切换 / 缓存状态条将在 P1 里程碑呈现。
  </div>
</body>
</html>`;
  }
}
