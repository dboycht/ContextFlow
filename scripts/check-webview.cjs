const fs = require('fs');
const src = fs.readFileSync('D:/code/DeepSeekHarness/ContextFlow/src/webview/ui/panelHtml.ts', 'utf8');
const m = src.match(/<script>([\s\S]*?)<\/script>/);
const js = m[1];
const issues = [];
const ids = [...js.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map((x) => x[1]);
const htmlIds = [...src.matchAll(/id="([^"]+)"/g)].map((x) => x[1]);
for (const id of new Set(ids)) {
  if (!htmlIds.includes(id)) {
    issues.push('引用不存在的 id: #' + id);
  }
}
console.log('脚本长度:', js.length);
console.log('JS 引用 id:', [...new Set(ids)].join(', '));
console.log('HTML id:', htmlIds.join(', '));
console.log('问题:', issues.length ? issues.join('; ') : '无');
