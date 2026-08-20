const fs = require('fs');
const src = fs.readFileSync('D:/code/DeepSeekHarness/ContextFlow/src/webview/ui/panelHtml.ts', 'utf8');
// 匹配带 nonce 的内联脚本
const m = src.match(/<script nonce="\$\{options\.nonce\}">([\s\S]*?)<\/script>/);
if (!m) {
  console.log('未匹配到内联脚本（regex 可能过时）');
  // 尝试匹配任意 <script>...</script>（排除 src 的）
  const all = [...src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  for (const a of all) {
    if (!a[0].includes('src=')) {
      console.log('找到内联脚本，长度:', a[1].length);
      fs.writeFileSync(process.env.TEMP + '/panel-script.js', a[1]);
    }
  }
} else {
  console.log('内联脚本长度:', m[1].length);
  fs.writeFileSync(process.env.TEMP + '/panel-script.js', m[1]);
}
// 渲染 HTML 数行号
const { renderPanelHtml } = require('D:/code/DeepSeekHarness/ContextFlow/out/src/webview/ui/panelHtml.js');
const html = renderPanelHtml({ cspSource: 'vscode-webview://x', nonce: 'abc', xtermJsUri: 'https://xterm.js', xtermCssUri: 'https://xterm.css' });
const lines = html.split('\n');
console.log('渲染 HTML 总行数:', lines.length);
// 找内联 script 起止行
const startLine = lines.findIndex((l) => l.includes('<script nonce'));
console.log('内联 script 起始行:', startLine + 1);
console.log('第 340-360 行:', JSON.stringify(lines.slice(339, 360), null, 1));
