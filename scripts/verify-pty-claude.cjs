/**
 * 验证 node-pty 在 PTY 里真实启动 claude（交互 TUI）并产生输出。
 * 用法：npm run native:node 后执行。
 */
'use strict';
const { PtyManager } = require('D:/code/DeepSeekHarness/ContextFlow/out/src/core/pty/ptyManager.js');
const manager = new PtyManager({
  onData: (id, data) => {
    process.stdout.write(data); // 直接打印 PTY 输出（ANSI）
  },
  onExit: (id, code) => {
    console.log('\n[verify] claude 进程退出 code=' + code);
    process.exit(0);
  },
});
console.log('[verify] 正在 PTY 中启动 claude（交互 TUI）...');
const session = manager.spawn('verify-claude', 'claude', [], process.cwd());
console.log('[verify] session pid =', session.pid);
// 15 秒后若无输出则超时失败
setTimeout(() => {
  console.log('\n[verify] 超时：claude 无输出，PTY 链路可能有问题');
  manager.killAll();
  process.exit(1);
}, 20000);
