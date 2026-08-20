const fs = require('fs');
const p = 'D:/code/DeepSeekHarness/ContextFlow/src/webview/ui/panelHtml.ts';
let s = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
// 替换整段内联脚本为外链引用
const re = /<script nonce="\$\{options\.nonce\}">[\s\S]*?<\/script>/;
if (!re.test(s)) {
  console.error('未找到内联脚本块');
  process.exit(1);
}
s = s.replace(re, '<script src="${options.panelJsUri}" nonce="${options.nonce}"></script>');
// options 接口加 panelJsUri
s = s.replace(
  "  /** xterm.js 的 webview 资源 URI */\n  xtermJsUri: string;\n  xtermCssUri: string;",
  "  /** xterm.js 的 webview 资源 URI */\n  xtermJsUri: string;\n  xtermCssUri: string;\n  /** 面板前端脚本（media/panel.js）URI */\n  panelJsUri: string;",
);
fs.writeFileSync(p, s, 'utf8');
console.log('panelHtml.ts 已改为外链脚本');
const cnt = (s.match(/panelJsUri/g) || []).length;
console.log('panelJsUri 出现次数:', cnt);
