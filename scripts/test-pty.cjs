/**
 * PtyManager 独立测试脚本（node-pty/ConPTY 在 node:test 环境残留句柄导致
 * 进程不退出，故用独立脚本 + 强制 process.exit 运行）。
 *
 * 用法：npm run test:pty
 */
'use strict';

const assert = require('node:assert/strict');
const { PtyManager } = require('../out/src/core/pty/ptyManager.js');

function waitTick() {
  return new Promise((r) => setImmediate(r));
}
async function until(cond, timeoutMs = 15_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('until: timeout');
    await waitTick();
  }
}

async function main() {
  // 用例 1：一次性命令输出转发 + 退出回调
  {
    const datas = [];
    const exits = [];
    const manager = new PtyManager({
      onData: (id, data) => datas.push(data),
      onExit: (id, code) => exits.push({ id, code }),
    });
    const session = manager.spawn('s1', 'cmd.exe', ['/c', 'echo pty-test-ok'], process.cwd());
    assert.equal(session.id, 's1');
    assert.ok(session.pid > 0);
    await until(() => datas.join('').includes('pty-test-ok'));
    assert.ok(datas.join('').includes('pty-test-ok'), '输出应包含 pty-test-ok');
    await until(() => exits.length > 0);
    assert.equal(exits[0].id, 's1');
    assert.equal(session.exited, true);
    manager.killAll();
    console.log('✔ 一次性命令输出转发 + 退出回调');
  }

  // 用例 2：kill 后 write 不抛错
  {
    const manager = new PtyManager({ onData: () => {}, onExit: () => {} });
    manager.spawn('s2', 'cmd.exe', ['/c', 'ping -n 30 127.0.0.1 >nul'], process.cwd());
    await new Promise((r) => setTimeout(r, 300));
    manager.kill('s2');
    assert.equal(manager.get('s2'), undefined);
    manager.write('s2', 'echo should-not-crash\r');
    manager.killAll();
    console.log('✔ kill 后 write 不抛错');
  }

  console.log('pty tests passed');
  process.exit(0);
}

main().catch((err) => {
  console.error('pty tests FAIL:', err.message);
  process.exit(1);
});
