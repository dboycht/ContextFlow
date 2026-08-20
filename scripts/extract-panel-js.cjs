const fs = require('fs');
const src = fs.readFileSync('D:/code/DeepSeekHarness/ContextFlow/src/webview/ui/panelHtml.ts', 'utf8');
const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/g);
let inline = null;
for (const tag of m) {
  if (!tag.includes('src=')) {
    inline = tag.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  }
}
if (!inline) {
  console.error('未找到内联脚本');
  process.exit(1);
}
// 前置错误可见化：任何运行错误显示到面板 #error
const header = `(function () {
  window.addEventListener('error', function (e) {
    var el = document.getElementById('error');
    if (el) { el.textContent = '[面板错误] ' + (e.message || 'unknown'); el.classList.remove('hidden'); }
  });
`;
// 去除原 IIFE 开头 "(function () {" 避免重复，改用 header
const body = inline.replace(/^\s*\(function \(\) \{/, '');
// 原结尾 "})();" 保留
const out = header + body;
fs.writeFileSync('D:/code/DeepSeekHarness/ContextFlow/media/panel.js', out, 'utf8');
console.log('已写入 media/panel.js，长度:', out.length);
// 校验语法
const { execSync } = require('child_process');
try {
  execSync('node --check "' + 'D:/code/DeepSeekHarness/ContextFlow/media/panel.js' + '"', { stdio: 'pipe' });
  console.log('panel.js 语法 OK');
} catch (e) {
  console.error('panel.js 语法错误:', e.stdout?.toString() || e.message);
}
