/**
 * Webview 面板 UI（原生 HTML/CSS/JS，docs/04）。
 * 三大区块：① 会话列表 ② 对话流 + 输入（或终端型会话的 xterm）③ 缓存状态条。
 * 所有字符串经 escapeHtml 转义（回复文本来自引擎，视为不可信输入）。
 */

export interface PanelHtmlOptions {
  /** webview CSP 源（vscode-webview://...），用于允许 xterm 资源 */
  cspSource: string;
  /** CSP nonce（内联脚本用，VS Code 官方方案） */
  nonce: string;
  /** xterm.js 的 webview 资源 URI */
  xtermJsUri: string;
  xtermCssUri: string;
  /** 面板前端脚本（media/panel.js）URI */
  panelJsUri: string;
}

export function renderPanelHtml(options: PanelHtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${options.cspSource} data:; style-src ${options.cspSource} 'unsafe-inline'; font-src ${options.cspSource}; script-src 'nonce-${options.nonce}' ${options.cspSource};">
<link rel="stylesheet" href="${options.xtermCssUri}">
<style>
  :root {
    --border: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
    --muted: var(--vscode-descriptionForeground);
    --bg: var(--vscode-sideBar-background);
    --fg: var(--vscode-foreground);
    --accent: var(--vscode-button-background);
    --accent-fg: var(--vscode-button-foreground);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg);
         background: var(--bg); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  .layout { display: flex; flex: 1; min-height: 0; }
  /* ① 会话列表 */
  .sessions { width: 210px; min-width: 150px; border-right: 1px solid var(--border);
              display: flex; flex-direction: column; }
  .sessions header { display: flex; justify-content: space-between; align-items: center;
                     padding: 8px 10px; border-bottom: 1px solid var(--border); }
  .sessions header span { font-weight: 600; }
  .sessions ul { list-style: none; overflow-y: auto; flex: 1; }
  .sessions li { display: flex; align-items: center; gap: 6px; padding: 7px 10px;
                 cursor: pointer; border-bottom: 1px solid transparent; }
  .sessions li:hover { background: var(--vscode-list-hoverBackground); }
  .sessions li.active { background: var(--vscode-list-activeSelectionBackground);
                        color: var(--vscode-list-activeSelectionForeground); }
  .sessions .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sessions .del { visibility: hidden; border: none; background: none; color: var(--muted);
                   cursor: pointer; font-size: 12px; padding: 0 2px; }
  .sessions li:hover .del { visibility: visible; }
  /* 主区 */
  .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .messages { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex;
              flex-direction: column; gap: 8px; }
  .msg { max-width: 92%; padding: 8px 11px; border-radius: 8px; white-space: pre-wrap;
         word-break: break-word; line-height: 1.55; }
  .msg.user { align-self: flex-end; background: var(--accent); color: var(--accent-fg); }
  .msg.assistant { align-self: flex-start; background: var(--vscode-editor-background);
                   border: 1px solid var(--border); }
  .msg .meta { display: block; font-size: 10px; opacity: .75; margin-top: 4px; }
  .msg .thinking { font-size: 11px; color: var(--muted); border-left: 2px solid var(--border);
                   padding-left: 8px; margin-bottom: 6px; white-space: pre-wrap; }
  .msg .tools { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
  .msg .tools .tool-line { font-family: var(--vscode-editor-font-family, monospace); margin: 2px 0; }
  .msg .stream-text { white-space: pre-wrap; }
  .empty { text-align: center; color: var(--muted); margin-top: 40px; }
  /* 输入区 */
  .composer { border-top: 1px solid var(--border); padding: 8px 10px; display: flex; gap: 6px; }
  .composer select { flex: 0 0 auto; background: var(--vscode-dropdown-background);
                     color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border);
                     border-radius: 4px; padding: 4px 6px; max-width: 130px; }
  .composer textarea { flex: 1; resize: none; min-height: 38px; max-height: 120px;
                       background: var(--vscode-input-background); color: var(--vscode-input-foreground);
                       border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 7px 9px;
                       font-family: inherit; font-size: 13px; }
  .composer button { background: var(--accent); color: var(--accent-fg); border: none;
                     border-radius: 4px; padding: 0 14px; cursor: pointer; font-weight: 500; }
  .composer button:disabled { opacity: .5; cursor: default; }
  .btn { background: transparent; color: var(--accent); border: 1px solid var(--accent);
         border-radius: 4px; padding: 1px 8px; cursor: pointer; font-size: 12px; }
  /* 创建面板：选择 Harness 创建对话 */
  .create-panel { border: 1px solid var(--border); border-radius: 8px; margin: 10px 12px 0;
                  padding: 12px; background: var(--vscode-editor-background); }
  .cp-title { font-size: 13px; font-weight: 600; margin-bottom: 10px; }
  .cp-engines { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
  .cp-engine { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
               border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-size: 13px; }
  .cp-engine:hover { background: var(--vscode-list-hoverBackground); }
  .cp-engine.active { border-color: var(--accent); background: var(--vscode-list-activeSelectionBackground);
                      color: var(--vscode-list-activeSelectionForeground); }
  .cp-engine input { accent-color: var(--accent); }
  .cp-engine .cp-status { margin-left: auto; font-size: 11px; opacity: .7; }
  .cp-engine .cp-term { margin-left: auto; background: transparent; color: var(--accent);
                        border: 1px solid var(--accent); border-radius: 4px; padding: 2px 8px;
                        font-size: 11px; cursor: pointer; white-space: nowrap; }
  .cp-engine .cp-term:hover { background: var(--accent); color: var(--accent-fg); }
  .cp-row { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
  .cp-row select { flex: 1; background: var(--vscode-dropdown-background);
                   color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border);
                   border-radius: 4px; padding: 4px 6px; }
  .cp-create { background: var(--accent); color: var(--accent-fg); border: none;
               border-radius: 4px; padding: 5px 16px; cursor: pointer; font-weight: 500; }
  .cp-create:disabled { opacity: .5; cursor: default; }
  /* 内置终端（xterm） */
  .terminal-header { padding: 6px 12px; font-size: 12px; font-weight: 600;
                     border-bottom: 1px solid var(--border); color: var(--muted); }
  .terminal { flex: 1; min-height: 0; padding: 6px 4px; background: #000; }
  .terminal .xterm { height: 100%; }
  /* ③ 缓存状态条 */
  .statusbar { border-top: 1px solid var(--border); padding: 5px 12px; font-size: 11px;
               color: var(--muted); display: flex; gap: 14px; flex-wrap: wrap;
               align-items: center; min-height: 26px; }
  .statusbar .hit-ok { color: #4caf50; font-weight: 600; }
  .statusbar .busy { display: inline-flex; align-items: center; gap: 6px;
                     color: var(--vscode-charts-yellow); font-weight: 500; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
  .statusbar .busy .spinner { animation: pulse 1.1s ease-in-out infinite; font-size: 13px; }
  /* 通用 */
  .notice { padding: 6px 12px; font-size: 12px; color: var(--vscode-charts-yellow); }
  .error { padding: 6px 12px; font-size: 12px; color: var(--vscode-errorForeground); }
  .hidden { display: none; }
</style>
</head>
<body>
  <div class="layout">
    <aside class="sessions">
      <header><span>会话</span><button class="btn" id="new-session">＋ 新建</button></header>
      <ul id="session-list"></ul>
    </aside>
    <section class="main">
      <div id="create-panel" class="create-panel hidden">
        <div class="cp-title">选择 Harness 创建对话</div>
        <div id="cp-engines" class="cp-engines"></div>
        <div class="cp-row">
          <select id="cp-model" title="模型"></select>
          <select id="cp-effort" title="推理强度"></select>
        </div>
        <div class="cp-row">
          <button id="cp-create" class="cp-create">创建终端会话</button>
          <button id="cp-cancel" class="btn">取消</button>
        </div>
      </div>
      <div id="terminal-header" class="terminal-header hidden"></div>
      <div id="terminal-container" class="terminal hidden"></div>
      <div class="messages" id="messages">
        <div class="empty">点击「＋ 新建」选择 Harness 开始对话</div>
      </div>
      <div id="notice" class="notice hidden"></div>
      <div id="error" class="error hidden"></div>
      <div class="composer" id="composer">
        <select id="engine-select" title="当前会话绑定的 Harness"></select>
        <select id="model-select" title="模型"></select>
        <select id="effort-select" title="推理强度"></select>
        <textarea id="input" placeholder="输入问题，Enter 发送（Shift+Enter 换行）"></textarea>
        <button id="send" disabled>发送</button>
      </div>
      <div class="statusbar" id="statusbar"></div>
    </section>
  </div>
<script src="${options.xtermJsUri}" nonce="${options.nonce}"></script>
<script src="${options.panelJsUri}" nonce="${options.nonce}"></script>
</body>
</html>`;
}
