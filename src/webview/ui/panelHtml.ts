/**
 * Webview 面板 UI（原生 HTML/CSS/JS，docs/04）。
 * 三大区块：① 会话列表 ② 对话流 + 输入（或终端型会话的 xterm）③ 缓存状态条。
 * 所有字符串经 escapeHtml 转义（回复文本来自引擎，视为不可信输入）。
 */

export interface PanelHtmlOptions {
  /** webview CSP 源（vscode-webview://...），用于允许 xterm 资源与内联脚本 */
  cspSource: string;
  /** xterm.js 的 webview 资源 URI */
  xtermJsUri: string;
  xtermCssUri: string;
}

export function renderPanelHtml(options: PanelHtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${options.cspSource} data:; style-src ${options.cspSource} 'unsafe-inline'; font-src ${options.cspSource}; script-src ${options.cspSource} 'unsafe-inline';">
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
          <button id="cp-create" class="cp-create">创建并对话</button>
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
<script src="${options.xtermJsUri}"></script>
<script>
(function () {
  const vscode = acquireVsCodeApi();
  const state = {
    sessions: [], currentSessionId: undefined,
    engines: [], currentEngineId: undefined,
    currentModel: undefined, currentEffort: undefined,
    messages: [], metrics: null,
    busy: false, busyHint: '',
    creating: false,
    terminalSessionId: undefined,
    streaming: null, // 流式气泡：{ wrap, thinking, tools, textEl }
  };

  const $ = (id) => document.getElementById(id);

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function renderSessions() {
    const ul = $('session-list');
    ul.innerHTML = state.sessions.map((s) => {
      const active = s.id === state.currentSessionId ? ' active' : '';
      const engine = state.engines.find((e) => e.engineId === s.engineId);
      return '<li class="' + active + '" data-id="' + escapeHtml(s.id) + '">' +
        '<span class="title" title="' + escapeHtml(s.title) + '">' + escapeHtml(s.title) + '</span>' +
        '<span class="engine-tag" style="font-size:10px;opacity:.7">' + escapeHtml(engine ? engine.label : s.engineId) + '</span>' +
        '<button class="del" data-del="' + escapeHtml(s.id) + '" title="删除">✕</button>' +
        '</li>';
    }).join('') || '<li style="color:var(--muted);cursor:default">暂无会话</li>';
  }

  function renderMessages() {
    state.streaming = null; // 全量渲染时清掉流式状态
    const box = $('messages');
    if (state.messages.length === 0) {
      box.innerHTML = '<div class="empty">选择或新建一个会话，开始提问</div>';
      return;
    }
    box.innerHTML = state.messages.map((m) => {
      const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'assistant';
      const meta = m.engineId ? '<span class="meta">' + escapeHtml(m.engineId) + '</span>' : '';
      return '<div class="msg ' + role + '">' + escapeHtml(m.content) + meta + '</div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  /** 用 DOM 构造一条完整消息气泡（textContent，天然防 XSS） */
  function makeMessageBubble(message) {
    const div = document.createElement('div');
    div.className = 'msg ' + (message.role === 'user' ? 'user' : 'assistant');
    div.textContent = message.content;
    if (message.engineId) {
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = message.engineId;
      div.append(meta);
    }
    return div;
  }

  /** 流式开始：创建 assistant 气泡（思考区/工具区默认折叠） */
  function startStreaming() {
    const box = $('messages');
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant streaming';
    const thinking = document.createElement('div');
    thinking.className = 'thinking hidden';
    const tools = document.createElement('div');
    tools.className = 'tools hidden';
    const textEl = document.createElement('div');
    textEl.className = 'stream-text';
    wrap.append(thinking, tools, textEl);
    box.append(wrap);
    box.scrollTop = box.scrollHeight;
    state.streaming = { wrap, thinking, tools, textEl };
  }

  /** 创建面板：选择 Harness（引擎卡片）+ 模型 + 推理强度，创建并对话 */
  function openCreatePanel() {
    if (state.busy) return;
    state.creating = true;
    renderCreatePanel();
    $('create-panel').classList.remove('hidden');
  }

  function closeCreatePanel() {
    state.creating = false;
    $('create-panel').classList.add('hidden');
  }

  function renderCreatePanel() {
    const box = $('cp-engines');
    box.innerHTML = state.engines.map((e) =>
      '<label class="cp-engine' + (e.engineId === state.currentEngineId ? ' active' : '') +
      '" data-id="' + escapeHtml(e.engineId) + '">' +
      '<input type="radio" name="cp-engine" value="' + escapeHtml(e.engineId) + '"' +
      (e.engineId === state.currentEngineId ? ' checked' : '') + '>' +
      '<span>' + escapeHtml(e.label) + '</span>' +
      '<button class="cp-term" data-term="' + escapeHtml(e.engineId) + '" title="在集成终端打开原生 CLI（完整交互）">终端</button>' +
      '</label>'
    ).join('') || '<div class="muted">未检测到可用引擎</div>';
    renderCreateModelEffort();
    $('cp-create').disabled = state.busy || state.engines.length === 0;
  }

  function renderCreateModelEffort() {
    const engine = state.engines.find((e) => e.engineId === state.currentEngineId);
    const models =
      engine && Array.isArray(engine.models) && engine.models.length === 0
        ? []
        : engine?.models && engine.models.length > 0
          ? engine.models
          : ['default'];
    const efforts =
      engine && Array.isArray(engine.efforts) && engine.efforts.length === 0
        ? []
        : engine?.efforts && engine.efforts.length > 0
          ? engine.efforts
          : ['default'];
    const mSel = $('cp-model');
    mSel.innerHTML = models.map((m) =>
      '<option value="' + escapeHtml(m) + '"' +
      ((state.currentModel ?? 'default') === m ? ' selected' : '') + '>' +
      escapeHtml(m) + '</option>'
    ).join('');
    mSel.disabled = state.busy || models.length === 0;
    const eSel = $('cp-effort');
    eSel.innerHTML = efforts.map((m) =>
      '<option value="' + escapeHtml(m) + '"' +
      ((state.currentEffort ?? 'default') === m ? ' selected' : '') + '>' +
      escapeHtml(m) + '</option>'
    ).join('');
    eSel.disabled = state.busy || efforts.length === 0;
  }

  /** 引擎卡片点击：更新创建目标（并同步 composer 下拉） */
  function pickCreateEngine(engineId) {
    if (state.busy) return;
    state.currentEngineId = engineId;
    state.currentModel = undefined;
    state.currentEffort = undefined;
    renderCreatePanel();
    renderEngines(); // 同步 composer
  }

  function scrollToBottom() {
    $('messages').scrollTop = $('messages').scrollHeight;
  }

  /* —— 内置终端（xterm）—— */
  let term = null;
  function ensureTerminal() {
    if (term) return term;
    term = new Terminal({ convertEol: true, cursorBlink: true });
    term.open($('terminal-container'));
    term.onData((data) => vscode.postMessage({ type: 'ptyInput', sessionId: state.terminalSessionId, data }));
    term.onResize((size) =>
      vscode.postMessage({ type: 'ptyResize', sessionId: state.terminalSessionId, cols: size.cols, rows: size.rows }));
    return term;
  }
  function showTerminal(sessionId, command) {
    state.terminalSessionId = sessionId;
    $('messages').classList.add('hidden');
    $('composer').classList.add('hidden');
    $('statusbar').classList.add('hidden');
    $('terminal-header').classList.remove('hidden');
    $('terminal-header').textContent = '终端 · ' + command + '（Ctrl+C 退出 · /model 切模型）';
    $('terminal-container').classList.remove('hidden');
    ensureTerminal().reset();
    ensureTerminal().focus();
  }
  function showMessages() {
    state.terminalSessionId = undefined;
    $('terminal-container').classList.add('hidden');
    $('terminal-header').classList.add('hidden');
    $('messages').classList.remove('hidden');
    $('composer').classList.remove('hidden');
    $('statusbar').classList.remove('hidden');
  }

  /** 消息到达：流式期间 user 插到气泡前、assistant 结束后替换为完整消息 */
  function handleMessage(message) {
    if (state.streaming && message.role === 'user') {
      state.messages = state.messages.concat([message]);
      $('messages').insertBefore(makeMessageBubble(message), state.streaming.wrap);
      scrollToBottom();
      return;
    }
    if (state.streaming && message.role === 'assistant') {
      state.streaming.wrap.remove();
      state.streaming = null;
      state.messages = state.messages.concat([message]);
      renderMessages();
      return;
    }
    state.messages = state.messages.concat([message]);
    renderMessages();
  }

  function renderEngines() {
    const sel = $('engine-select');
    sel.innerHTML = state.engines.map((e) =>
      '<option value="' + escapeHtml(e.engineId) + '"' +
      (e.engineId === state.currentEngineId ? ' selected' : '') + '>' +
      escapeHtml(e.label) + '</option>'
    ).join('');
    // 会话存在时 Harness 已绑定（创建时选定，不可更改）；无会话时可选（决定新建用哪个）
    const bound = !!state.currentSessionId;
    sel.disabled = state.busy || state.engines.length === 0 || bound;
    sel.title = bound
      ? '当前会话已绑定该 Harness（创建时选定，不可更改）'
      : '选择 Harness（新建会话时绑定）';
    renderModels();
    renderEfforts();
  }

  /** 模型下拉：跟随当前引擎的 models（'default' = 用引擎 CLI/配置默认模型） */
  function renderModels() {
    const engine = state.engines.find((e) => e.engineId === state.currentEngineId);
    // 明确声明空数组 = 该引擎无可选模型 → 置灰；未声明 → 默认 'default'
    const models =
      engine && Array.isArray(engine.models) && engine.models.length === 0
        ? []
        : engine?.models && engine.models.length > 0
          ? engine.models
          : ['default'];
    const sel = $('model-select');
    sel.innerHTML = models.map((m) =>
      '<option value="' + escapeHtml(m) + '"' +
      ((state.currentModel ?? 'default') === m ? ' selected' : '') + '>' +
      escapeHtml(m) + '</option>'
    ).join('');
    // 无可用模型 → 置灰不可点
    const empty = models.length === 0;
    sel.disabled = state.busy || empty;
    sel.title = empty ? '当前引擎无可选模型' : '模型（default = 引擎默认）';
  }

  /** 推理强度下拉：跟随当前引擎的 efforts（'default' = 引擎默认；空列表 = 不支持置灰） */
  function renderEfforts() {
    const engine = state.engines.find((e) => e.engineId === state.currentEngineId);
    const efforts =
      engine && Array.isArray(engine.efforts) && engine.efforts.length === 0
        ? []
        : engine?.efforts && engine.efforts.length > 0
          ? engine.efforts
          : ['default'];
    const sel = $('effort-select');
    sel.innerHTML = efforts.map((m) =>
      '<option value="' + escapeHtml(m) + '"' +
      ((state.currentEffort ?? 'default') === m ? ' selected' : '') + '>' +
      escapeHtml(m) + '</option>'
    ).join('');
    const empty = efforts.length === 0;
    sel.disabled = state.busy || empty;
    sel.title = empty ? '当前引擎不支持调节推理强度' : '推理强度（default = 引擎默认）';
  }

  function renderStatus() {
    const bar = $('statusbar');
    if (state.busy) {
      bar.innerHTML = '<span class="busy"><span class="spinner">⏳</span>' +
        escapeHtml(state.busyHint || '处理中…') + '</span>';
      return;
    }
    const m = state.metrics;
    if (!m || m.totalRequests === 0) {
      bar.innerHTML = '<span>等待首次提问（前缀稳定后自动命中缓存）</span>';
      return;
    }
    const rate = (m.hitRate * 100).toFixed(0) + '%';
    const saved = m.prefixTokensSaved > 0
      ? '<span class="hit-ok">✓ 已复用 ~' + m.prefixTokensSaved.toLocaleString() + ' token</span>' : '';
    bar.innerHTML =
      '<span>请求 ' + m.totalRequests + ' · 命中率 ' + rate + '</span>' + saved;
  }

  /** 请求期间禁用发送区，防止重复发送（transport 单槽） */
  function updateComposer() {
    sendBtn.disabled = state.busy || input.value.trim().length === 0;
    input.disabled = state.busy;
    const bound = !!state.currentSessionId;
    $('engine-select').disabled = state.busy || state.engines.length === 0 || bound;
    $('model-select').disabled = state.busy;
    $('effort-select').disabled = state.busy;
  }

  function showNotice(text) {
    const el = $('notice');
    el.textContent = text;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 4000);
  }
  function showError(text) {
    const el = $('error');
    el.textContent = text;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 6000);
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'sessions':
        state.sessions = msg.sessions;
        if ('currentSessionId' in msg) {
          state.currentSessionId = msg.currentSessionId ?? undefined;
        }
        closeCreatePanel(); // 会话列表变化时关闭创建面板
        renderSessions();
        renderEngines(); // 引擎绑定状态随当前会话更新
        updateComposer();
        break;
      case 'engines': {
        const prevEngine = state.currentEngineId;
        state.engines = msg.engines;
        state.currentEngineId = msg.currentEngineId ?? state.currentEngineId;
        if (prevEngine !== state.currentEngineId) {
          state.currentModel = undefined;
          state.currentEffort = undefined;
        }
        renderEngines();
        updateComposer();
        break;
      }
      case 'metrics':
        state.metrics = msg.metrics;
        renderStatus();
        break;
      case 'messages':
        showMessages();
        state.messages = msg.messages;
        renderMessages();
        break;
      case 'terminalStart':
        showTerminal(msg.sessionId, msg.command);
        break;
      case 'ptyData':
        if (term && state.terminalSessionId === msg.sessionId) {
          term.write(msg.data);
        }
        break;
      case 'ptyExit':
        if (term && state.terminalSessionId === msg.sessionId) {
          term.write('\r\n\x1b[33m[进程已退出 code=' + msg.exitCode + ']\x1b[0m\r\n');
        }
        break;
      case 'message':
        handleMessage(msg.message);
        break;
      case 'streamStart':
        startStreaming();
        break;
      case 'streamText':
        if (state.streaming) {
          state.streaming.textEl.textContent += msg.delta;
          scrollToBottom();
        }
        break;
      case 'streamThinking':
        if (state.streaming) {
          const t = state.streaming.thinking;
          t.classList.remove('hidden');
          t.textContent += msg.delta;
          scrollToBottom();
        }
        break;
      case 'streamTool':
        if (state.streaming) {
          const tl = state.streaming.tools;
          tl.classList.remove('hidden');
          const line = document.createElement('div');
          line.className = 'tool-line';
          line.textContent = msg.label;
          tl.append(line);
          scrollToBottom();
        }
        break;
      case 'busy':
        state.busy = msg.busy;
        state.busyHint = msg.hint ?? '';
        renderStatus();
        updateComposer();
        break;
      case 'notice': showNotice(msg.text); break;
      case 'error': showError(msg.text); break;
    }
  });

  // —— 交互 ——
  $('new-session').addEventListener('click', () => openCreatePanel());

  $('cp-engines').addEventListener('click', (e) => {
    // 终端按钮：在集成终端打开原生 CLI（不选引擎、不创建会话）
    const termBtn = e.target.closest('[data-term]');
    if (termBtn) {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: 'openTerminal', engineId: termBtn.getAttribute('data-term') });
      return;
    }
    const input = e.target.closest('input[type=radio]');
    if (input) pickCreateEngine(input.value);
  });
  $('cp-model').addEventListener('change', (e) => {
    state.currentModel = e.target.value === 'default' ? undefined : e.target.value;
  });
  $('cp-effort').addEventListener('change', (e) => {
    state.currentEffort = e.target.value === 'default' ? undefined : e.target.value;
  });
  $('cp-create').addEventListener('click', () => {
    if (state.busy || state.engines.length === 0) return;
    closeCreatePanel();
    vscode.postMessage({ type: 'createSession', engineId: state.currentEngineId });
  });
  $('cp-cancel').addEventListener('click', () => closeCreatePanel());

  $('session-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      // 本地同步：删除当前会话则回到无会话状态（引擎解锁）
      if (del.getAttribute('data-del') === state.currentSessionId) {
        state.currentSessionId = undefined;
        updateComposer();
        renderEngines();
      }
      vscode.postMessage({ type: 'deleteSession', sessionId: del.getAttribute('data-del') });
      return;
    }
    const li = e.target.closest('li[data-id]');
    if (li) {
      // 本地同步：立即切换当前会话（引擎绑定状态即时刷新）
      state.currentSessionId = li.getAttribute('data-id');
      renderSessions();
      renderEngines();
      updateComposer();
      vscode.postMessage({ type: 'selectSession', sessionId: state.currentSessionId });
    }
  });

  $('engine-select').addEventListener('change', (e) => {
    // 仅无会话时生效（决定新建会话绑定的 Harness）；有会话时下拉已禁用
    const engineId = e.target.value;
    state.currentEngineId = engineId;
    state.currentModel = undefined;
    state.currentEffort = undefined;
    renderModels();
    renderEfforts();
  });

  $('model-select').addEventListener('change', (e) => {
    state.currentModel = e.target.value === 'default' ? undefined : e.target.value;
  });

  $('effort-select').addEventListener('change', (e) => {
    state.currentEffort = e.target.value === 'default' ? undefined : e.target.value;
  });

  const input = $('input');
  const sendBtn = $('send');
  input.addEventListener('input', () => updateComposer());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener('click', send);

  function send() {
    if (state.busy) return;
    const text = input.value.trim();
    if (!text) return;
    const sessionId = state.currentSessionId;
    const engineId = state.currentSessionId ? undefined : $('engine-select').value;
    const model = state.currentModel;
    const effort = state.currentEffort;
    // 本地乐观置忙：状态条立即显示处理中，等待后端 busy 确认
    state.busy = true;
    state.busyHint = '正在连接引擎并发送…';
    input.value = '';
    updateComposer();
    renderStatus();
    vscode.postMessage({ type: 'send', sessionId, text, engineId, model, effort });
  }

  // 初始化
  vscode.postMessage({ type: 'init' });
})();
</script>
</body>
</html>`;
}
