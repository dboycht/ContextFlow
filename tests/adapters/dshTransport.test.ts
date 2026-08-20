import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  JsonRpcLineTransport,
  JsonRpcResponseError,
  DshJsonRpcTransport,
  type DshLaunchSpec,
  type JsonRpcNotification,
} from '../../src/core/adapters/dshTransport';

function waitTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function until(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('until: timeout');
    }
    await waitTick();
  }
}

/** 假子进程：用 PassThrough 模拟 stdio */
function fakeChild() {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const child = {
    stdout,
    stdin,
    stderr,
    exitCode: null as number | null,
    once(_event: string, _cb: () => void) {
      /* 不触发，close 走 kill 超时路径 */
    },
    kill(): void {
      child.exitCode = 0;
    },
  };
  return child;
}

// ---------- JsonRpcLineTransport：帧层 ----------

test('帧层：request 发出标准帧，响应按 id resolve', async () => {
  const serverToClient = new PassThrough(); // input
  const clientToServer = new PassThrough(); // output
  const frames: string[] = [];
  clientToServer.on('data', (c) => frames.push(c.toString()));

  const t = new JsonRpcLineTransport(serverToClient, clientToServer);
  const p = t.request('initialize', { provider: 'deepseek-official' });

  await until(() => frames.length > 0);
  const parsed = JSON.parse(frames[0]!) as { id: number; method: string; params: unknown };
  assert.equal(parsed.method, 'initialize');
  assert.equal((parsed.params as { provider: string }).provider, 'deepseek-official');

  serverToClient.write(`${JSON.stringify({ id: parsed.id, result: { ok: true } })}\n`);
  const result = await p;
  assert.deepEqual(result, { ok: true });
});

test('帧层：错误响应 reject 为 JsonRpcResponseError（保留 code）', async () => {
  const serverToClient = new PassThrough();
  const clientToServer = new PassThrough();
  const t = new JsonRpcLineTransport(serverToClient, clientToServer);
  const p = t.request('session/prompt', {});
  clientToServer.on('data', (c) => {
    const msg = JSON.parse(c.toString()) as { id: number };
    serverToClient.write(
      `${JSON.stringify({ id: msg.id, error: { code: -32000, message: 'boom' } })}\n`,
    );
  });
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof JsonRpcResponseError);
    assert.equal((err as JsonRpcResponseError).code, -32000);
    return true;
  });
});

test('帧层：通知分发到 onNotification', async () => {
  const serverToClient = new PassThrough();
  const clientToServer = new PassThrough();
  const notifications: JsonRpcNotification[] = [];
  const t = new JsonRpcLineTransport(serverToClient, clientToServer, {
    onNotification: (n) => notifications.push(n),
  });
  serverToClient.write(
    `${JSON.stringify({ method: 'session.status', params: { status: 'idle' } })}\n`,
  );
  await until(() => notifications.length > 0);
  assert.equal(notifications[0]!.method, 'session.status');
  assert.deepEqual(notifications[0]!.params, { status: 'idle' });
});

test('帧层：畸形 JSON 行忽略、不崩溃', async () => {
  const serverToClient = new PassThrough();
  const clientToServer = new PassThrough();
  const notifications: JsonRpcNotification[] = [];
  const t = new JsonRpcLineTransport(serverToClient, clientToServer, {
    onNotification: (n) => notifications.push(n),
  });
  serverToClient.write('not-json\n');
  serverToClient.write(`${JSON.stringify({ method: 'session.status', params: {} })}\n`);
  await until(() => notifications.length > 0);
  assert.equal(notifications.length, 1);
});

test('帧层：服务端请求回 -32601（dead capability）', async () => {
  const serverToClient = new PassThrough();
  const clientToServer = new PassThrough();
  const replies: string[] = [];
  clientToServer.on('data', (c) => replies.push(c.toString()));
  const t = new JsonRpcLineTransport(serverToClient, clientToServer);
  serverToClient.write(`${JSON.stringify({ id: 7, method: 'unknown' })}\n`);
  await until(() => replies.length > 0);
  const parsed = JSON.parse(replies[0]!) as { id: number; error: { code: number } };
  assert.equal(parsed.id, 7);
  assert.equal(parsed.error.code, -32601);
});

test('帧层：close 后 pending 拒绝、新请求拒绝', async () => {
  const serverToClient = new PassThrough();
  const clientToServer = new PassThrough();
  const t = new JsonRpcLineTransport(serverToClient, clientToServer);
  const p = t.request('initialize', {});
  t.close();
  await assert.rejects(p, /closed/);
  await assert.rejects(t.request('shutdown'), /closed/);
});

// ---------- DshJsonRpcTransport：业务层（mock spawn） ----------

test('Dsh 驱动：start→send→close 全流程（mock 子进程）', async () => {
  const child = fakeChild();
  const spawnCalls: Array<{ command: string; args: string[] }> = [];
  const stdinFrames: string[] = [];
  child.stdin.on('data', (c) => stdinFrames.push(c.toString()));

  const launch: DshLaunchSpec = { command: 'node', args: ['bin.js'] };
  const t = new DshJsonRpcTransport(launch, {
    spawnFn: ((command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as never,
    idleTimeoutMs: 2000,
    exitTimeoutMs: 50,
  });

  // start：spawn + initialize
  const startP = t.start();
  await until(() => stdinFrames.length > 0);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]!.command, 'node');
  const initFrame = JSON.parse(stdinFrames[0]!) as { id: number; method: string };
  assert.equal(initFrame.method, 'initialize');
  child.stdout.write(
    `${JSON.stringify({ id: initFrame.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime' } } })}\n`,
  );
  await startP;

  // send：session/prompt → 回 messageId → 通知收集到 idle
  const sendP = t.send({ prompt: '你好', sessionId: 's1' });
  await until(() => stdinFrames.length > 1);
  const promptFrame = JSON.parse(stdinFrames[1]!) as { id: number; method: string; params: { sessionId: string } };
  assert.equal(promptFrame.method, 'session/prompt');
  assert.equal(promptFrame.params.sessionId, 's1');
  // 事件通知：一段 assistant 文本
  child.stdout.write(
    `${JSON.stringify({ method: 'session.event', params: { text: '回复第一段' } })}\n`,
  );
  // prompt 响应（enqueue receipt）
  child.stdout.write(
    `${JSON.stringify({ id: promptFrame.id, result: { messageId: 'm1' } })}\n`,
  );
  // idle 通知
  child.stdout.write(
    `${JSON.stringify({ method: 'session.status', params: { sessionId: 's1', status: 'idle' } })}\n`,
  );
  const result = await sendP;
  assert.equal(result.content, '回复第一段');
  assert.deepEqual(result.raw, { messageId: 'm1' });

  // close：shutdown 请求
  const closeP = t.close();
  await until(() => stdinFrames.length > 2);
  const shutdownFrame = JSON.parse(stdinFrames[2]!) as { method: string };
  assert.equal(shutdownFrame.method, 'shutdown');
  child.stdout.write(`${JSON.stringify({ id: 3, result: {} })}\n`);
  await closeP;
});

test('Dsh 驱动：healthCheck 在 initialize 失败时返回 false', async () => {
  const child = fakeChild();
  const stdinFrames: string[] = [];
  child.stdin.on('data', (c) => stdinFrames.push(c.toString()));
  const t = new DshJsonRpcTransport(
    { command: 'node', args: ['bin.js'] },
    {
      spawnFn: (() => child) as never,
      idleTimeoutMs: 500,
      exitTimeoutMs: 50,
    },
  );
  const checkP = t.healthCheck();
  await until(() => stdinFrames.length > 0);
  const initFrame = JSON.parse(stdinFrames[0]!) as { id: number };
  child.stdout.write(
    `${JSON.stringify({ id: initFrame.id, error: { code: -32603, message: 'no key' } })}\n`,
  );
  assert.equal(await checkP, false);
});

test('Dsh 驱动：send 超时抛错', async () => {
  const child = fakeChild();
  const stdinFrames: string[] = [];
  child.stdin.on('data', (c) => stdinFrames.push(c.toString()));
  const t = new DshJsonRpcTransport(
    { command: 'node', args: ['bin.js'] },
    {
      spawnFn: (() => child) as never,
      idleTimeoutMs: 100,
      exitTimeoutMs: 50,
    },
  );
  // 先手动完成 initialize
  const startP = t.start();
  await until(() => stdinFrames.length > 0);
  const initFrame = JSON.parse(stdinFrames[0]!) as { id: number };
  child.stdout.write(`${JSON.stringify({ id: initFrame.id, result: {} })}\n`);
  await startP;
  // 发 prompt 但永不回 idle → 超时
  const sendP = t.send({ prompt: 'hi', sessionId: 's1', timeoutMs: 150 });
  await until(() => stdinFrames.length > 1);
  const promptFrame = JSON.parse(stdinFrames[1]!) as { id: number };
  child.stdout.write(`${JSON.stringify({ id: promptFrame.id, result: { messageId: 'm1' } })}\n`);
  await assert.rejects(sendP, /timeout/);
});
