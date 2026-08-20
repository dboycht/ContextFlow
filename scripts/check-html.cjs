const { renderPanelHtml } = require('D:/code/DeepSeekHarness/ContextFlow/out/src/webview/ui/panelHtml.js');
const html = renderPanelHtml({
  cspSource: 'vscode-webview://test',
  xtermJsUri: 'https://xterm.js',
  xtermCssUri: 'https://xterm.css',
});
console.log('HTML 长度:', html.length);
console.log('--- CSP meta:', (html.match(/Content-Security-Policy[^>]*/) || ['未找到'])[0].slice(0, 180));
console.log('--- 内联 script 存在:', html.includes('<script>'));
console.log('--- xterm.js 引用:', html.includes('xterm.js'));
console.log('--- acquireVsCodeApi:', html.includes('acquireVsCodeApi'));
console.log('--- new-session 绑定:', html.includes('new-session'));
const m = html.match(/<script>([\s\S]*?)<\/script>/);
const js = m ? m[1] : '';
console.log('--- JS 长度:', js.length);
const bad = (js.match(/\$\{/g) || []).length;
console.log('--- JS 内 ${ 字面量出现次数:', bad);
// 检查 HTML 里是否有残留的 ${（未插值）
const htmlBad = (html.match(/\$\{[a-z]/g) || []).length;
console.log('--- HTML 残留未插值 ${:', htmlBad);
