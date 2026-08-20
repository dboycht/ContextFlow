/**
 * Webview 面板 UI（原生 HTML/CSS/JS，docs/04）。
 * 三大区块：① 会话列表 ② 对话流 + 输入 ③ 缓存状态条；引擎切换下拉。
 * 所有字符串经 escapeHtml 转义（回复文本来自引擎，视为不可信输入）。
 */

export function renderPanelHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
      <div class="messages" id="messages">
        <div class="empty">选择或新建一个会话，开始提问</div>
      </div>
      <div id="notice" class="notice hidden"></div>
      <div id="error" class="error hidden"></div>
      <div class="composer">
        <select id="engine-select" title="引擎"></select>
        <textarea id="input" placeholder="输入问题，Enter 发送（Shift+Enter 换行）"></textarea>
        <button id="send" disabled>发送</button>
      </div>
      <div class="statusbar" id="statusbar"></div>
    </section>
  </div>
<script>
(function () {
  const vscode = acquireVsCodeApi();
  const state = {
    sessions: [], currentSessionId: undefined,
    engines: [], currentEngineId: undefined,
    messages: [], metrics: null,
    busy: false, busyHint: '',
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

  function renderEngines() {
    const sel = $('engine-select');
    sel.innerHTML = state.engines.map((e) =>
      '<option value="' + escapeHtml(e.engineId) + '"' +
      (e.engineId === state.currentEngineId ? ' selected' : '') + '>' +
      escapeHtml(e.label) + '</option>'
    ).join('');
    sel.disabled = state.engines.length === 0;
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
    $('engine-select').disabled = state.busy || state.engines.length === 0;
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
        state.currentSessionId = msg.currentSessionId ?? state.currentSessionId;
        renderSessions();
        break;
      case 'engines':
        state.engines = msg.engines;
        state.currentEngineId = msg.currentEngineId ?? state.currentEngineId;
        renderEngines();
        updateComposer();
        break;
      case 'metrics':
        state.metrics = msg.metrics;
        renderStatus();
        break;
      case 'messages':
        state.messages = msg.messages;
        renderMessages();
        break;
      case 'message':
        state.messages = state.messages.concat([msg.message]);
        renderMessages();
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
  $('new-session').addEventListener('click', () => vscode.postMessage({ type: 'createSession' }));

  $('session-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      vscode.postMessage({ type: 'deleteSession', sessionId: del.getAttribute('data-del') });
      return;
    }
    const li = e.target.closest('li[data-id]');
    if (li) vscode.postMessage({ type: 'selectSession', sessionId: li.getAttribute('data-id') });
  });

  $('engine-select').addEventListener('change', (e) => {
    const engineId = e.target.value;
    if (state.currentSessionId) {
      vscode.postMessage({ type: 'selectEngine', engineId, sessionId: state.currentSessionId });
    } else {
      showNotice('请先选择或新建会话');
    }
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
    const engineId = $('engine-select').value;
    // 本地乐观置忙：状态条立即显示处理中，等待后端 busy 确认
    state.busy = true;
    state.busyHint = '正在连接引擎并发送…';
    input.value = '';
    updateComposer();
    renderStatus();
    vscode.postMessage({ type: 'send', sessionId, text, engineId });
  }

  // 初始化
  vscode.postMessage({ type: 'init' });
})();
</script>
</body>
</html>`;
}
