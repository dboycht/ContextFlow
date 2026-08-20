import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { CliTransport } from '../../src/core/adapters/cliTransport';
import { ClaudeCodeAdapter } from '../../src/core/adapters/claude';
import { OpencodeAdapter } from '../../src/core/adapters/opencode';
import type { ContextRef } from '../../src/core/cache/types';

/** 假子进程：EventEmitter + PassThrough stdio */
function fakeChild() {
  const ee = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(ee, {
    stdout,
    stderr,
    exitCode: null as number | null,
    kill(): void {
      child.exitCode = 0;
    },
  });
  return child;
}

/** 记录 spawn 调用并返回可编程 child */
function mockSpawn() {
  const calls: Array<{ command: string; args: string[] }> = [];
  const child = fakeChild();
  const spawnFn = ((command: string, args: string[]) => {
    calls.push({ command, args });
    return child as never;
  }) as never;
  return { calls, child, spawnFn };
}

const CONTEXT_REF: ContextRef = {
  cacheEntry: null,
  prefixText: '前缀',
  newText: '问题',
};

// ---------- CliTransport ----------

test('CliTransport：exit 0 → parse stdout 并返回', async () => {
  const { child, spawnFn } = mockSpawn();
  const t = new CliTransport({
    spawnFn,
    parse: (stdout) => ({ content: stdout.trim(), inputTokens: 1, outputTokens: 2 }),
  });
  const p = t.run({ command: 'claude', args: ['-p', 'hi'] });
  child.stdout.write('hello\n');
  child.emit('exit', 0);
  const result = await p;
  assert.equal(result.content, 'hello');
  assert.equal(result.inputTokens, 1);
  assert.equal(result.rawStdout, 'hello\n');
});

test('CliTransport：非 0 退出 → reject 并携带 stderr 尾部', async () => {
  const { child, spawnFn } = mockSpawn();
  const t = new CliTransport({ spawnFn, parse: () => ({ content: '', inputTokens: 0, outputTokens: 0 }) });
  const p = t.run({ command: 'claude', args: ['-p', 'hi'] });
  child.stderr.write('boom error detail');
  child.emit('exit', 1);
  await assert.rejects(p, /cli exited 1: boom error detail/);
});

test('CliTransport：超时 → reject', async () => {
  const { child, spawnFn } = mockSpawn();
  const t = new CliTransport({ spawnFn, parse: () => ({ content: '', inputTokens: 0, outputTokens: 0 }) });
  // 不触发 exit：进程无响应 → 超时定时器（50ms）触发 kill + reject
  const p = t.run({ command: 'slow', args: [], timeoutMs: 50 });
  await assert.rejects(p, /cli timeout after 50ms/);
});

test('CliTransport：checkExecutable 只看退出码', async () => {
  const { child, spawnFn } = mockSpawn();
  const t = new CliTransport({ spawnFn, parse: () => ({ content: '', inputTokens: 0, outputTokens: 0 }) });
  const p = t.checkExecutable('claude');
  child.emit('exit', 0);
  assert.equal(await p, true);

  const { child: bad, spawnFn: badSpawn } = mockSpawn();
  const t2 = new CliTransport({ spawnFn: badSpawn, parse: () => ({ content: '', inputTokens: 0, outputTokens: 0 }) });
  const p2 = t2.checkExecutable('nope');
  bad.emit('exit', 1);
  assert.equal(await p2, false);
});

test('CliTransport：runStream 逐行回调事件流，exit 0 完成', async () => {
  const { child, spawnFn } = mockSpawn();
  const t = new CliTransport({ spawnFn, parse: () => ({ content: '', inputTokens: 0, outputTokens: 0 }) });
  const lines: string[] = [];
  const p = t.runStream({ command: 'claude', args: ['-p', 'hi', '--output-format', 'stream-json'] }, (line) => lines.push(line));
  child.stdout.write('{"type":"a"}\n{"type":"b"}\n');
  child.emit('exit', 0);
  await p;
  assert.deepEqual(lines, ['{"type":"a"}', '{"type":"b"}']);
});

// ---------- ClaudeCodeAdapter ----------

test('Claude：buildArgs 含 -p/--output-format json，模型参数可选', async () => {
  const { calls, child, spawnFn } = mockSpawn();
  const adapter = new ClaudeCodeAdapter({ spawnFn });
  const p = adapter.send({ prompt: '你好', contextRef: CONTEXT_REF, sessionId: 's1' });
  child.stdout.write(
    `${JSON.stringify({ result: '收到', usage: { input_tokens: 100, cache_read_input_tokens: 60, output_tokens: 20 } })}\n`,
  );
  child.emit('exit', 0);
  const result = await p;
  assert.equal(result.content, '收到');
  assert.equal(result.usage.inputTokens, 100);
  assert.equal(result.usage.cacheHitTokens, 60);
  assert.equal(result.usage.outputTokens, 20);
  assert.deepEqual(calls[0]!.args, ['-p', '你好', '--output-format', 'json']);

  // 带模型
  const { calls: calls2, child: child2, spawnFn: spawn2 } = mockSpawn();
  const adapter2 = new ClaudeCodeAdapter({ spawnFn: spawn2 });
  const p2 = adapter2.send({ prompt: 'hi', contextRef: CONTEXT_REF, sessionId: 's1', options: { model: 'sonnet' } });
  child2.stdout.write(`${JSON.stringify({ result: 'ok', usage: {} })}\n`);
  child2.emit('exit', 0);
  await p2;
  assert.deepEqual(calls2[0]!.args, ['-p', 'hi', '--output-format', 'json', '--model', 'sonnet']);
});

test('Claude：is_error → reject', async () => {
  const { child, spawnFn } = mockSpawn();
  const adapter = new ClaudeCodeAdapter({ spawnFn });
  const p = adapter.send({ prompt: 'hi', contextRef: CONTEXT_REF, sessionId: 's1' });
  child.stdout.write(`${JSON.stringify({ is_error: true, error: { message: 'auth failed' } })}\n`);
  child.emit('exit', 0);
  await assert.rejects(p, /auth failed/);
});

test('Claude：sendStream 流式转发思考/文本/工具流 + result usage', async () => {
  const { calls, child, spawnFn } = mockSpawn();
  const adapter = new ClaudeCodeAdapter({ spawnFn });
  const texts: string[] = [];
  const thinkings: string[] = [];
  const tools: string[] = [];
  const p = adapter.sendStream(
    { prompt: '你好', contextRef: CONTEXT_REF, sessionId: 's1' },
    {
      onText: (d) => texts.push(d),
      onThinking: (d) => thinkings.push(d),
      onTool: (l) => tools.push(l),
    },
  );
  child.stdout.write(
    `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '思考中…' }] } })}\n` +
    `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '收到' }, { type: 'tool_use', name: 'Read', input: { file: 'a.txt' } }] } })}\n` +
    `${JSON.stringify({ type: 'result', result: '收到', usage: { input_tokens: 100, cache_read_input_tokens: 60, output_tokens: 20 } })}\n`,
  );
  child.emit('exit', 0);
  const result = await p;
  assert.deepEqual(thinkings, ['思考中…']);
  assert.deepEqual(texts, ['收到']);
  assert.equal(tools.length, 1);
  assert.ok(tools[0]!.includes('Read'));
  assert.equal(result.content, '收到');
  assert.equal(result.usage.inputTokens, 100);
  assert.equal(result.usage.cacheHitTokens, 60);
  // 流式参数：stream-json + verbose
  assert.ok(calls[0]!.args.includes('--output-format'));
  assert.ok(calls[0]!.args.includes('stream-json'));
  assert.ok(calls[0]!.args.includes('--verbose'));
});

test('Claude：sendStream 无 result 事件 → reject', async () => {
  const { child, spawnFn } = mockSpawn();
  const adapter = new ClaudeCodeAdapter({ spawnFn });
  const p = adapter.sendStream({ prompt: 'hi', contextRef: CONTEXT_REF, sessionId: 's1' }, {});
  child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [] } })}\n`);
  child.emit('exit', 0);
  await assert.rejects(p, /no result event/);
});

// ---------- OpencodeAdapter ----------

test('opencode：NDJSON 事件流解析（text 拼接 + step_finish tokens 映射）', async () => {
  const { calls, child, spawnFn } = mockSpawn();
  const adapter = new OpencodeAdapter({ spawnFn });
  const p = adapter.send({ prompt: '你好', contextRef: CONTEXT_REF, sessionId: 's1' });
  child.stdout.write(
    `${JSON.stringify({ type: 'step_start', part: { type: 'step-start' } })}\n` +
    `${JSON.stringify({ type: 'text', part: { type: 'text', text: '收到' } })}\n` +
    `${JSON.stringify({ type: 'step_finish', part: { tokens: { input: 300, output: 31, cache: { read: 1024 } } } })}\n`,
  );
  child.emit('exit', 0);
  const result = await p;
  assert.equal(result.content, '收到');
  assert.equal(result.usage.inputTokens, 300);
  assert.equal(result.usage.outputTokens, 31);
  assert.equal(result.usage.cacheHitTokens, 1024);
  assert.deepEqual(calls[0]!.args, ['run', '你好', '--format', 'json']);

  // 带模型 -m
  const { calls: calls2, child: child2, spawnFn: spawn2 } = mockSpawn();
  const adapter2 = new OpencodeAdapter({ spawnFn: spawn2 });
  const p2 = adapter2.send({ prompt: 'hi', contextRef: CONTEXT_REF, sessionId: 's1', options: { model: 'anthropic/claude-sonnet' } });
  child2.stdout.write(`${JSON.stringify({ type: 'step_finish', part: { tokens: {} } })}\n`);
  child2.emit('exit', 0);
  await p2;
  assert.deepEqual(calls2[0]!.args, ['run', 'hi', '--format', 'json', '-m', 'anthropic/claude-sonnet']);
});

test('opencode：error 事件 → reject', async () => {
  const { child, spawnFn } = mockSpawn();
  const adapter = new OpencodeAdapter({ spawnFn });
  const p = adapter.send({ prompt: 'hi', contextRef: CONTEXT_REF, sessionId: 's1' });
  child.stdout.write(`${JSON.stringify({ type: 'error', error: 'provider not configured' })}\n`);
  child.emit('exit', 0);
  await assert.rejects(p, /provider not configured/);
});

test('cli adapters：estimateCost 命中/新增/输出分价', () => {
  const adapter = new ClaudeCodeAdapter({ spawnFn: (() => fakeChild()) as never });
  const cost = adapter.estimateCost({ inputTokens: 1000, outputTokens: 100, cacheHitTokens: 800 });
  // (200*3 + 800*0.3 + 100*15) / 1e6 = (600+240+1500)/1e6 = 0.00234
  assert.ok(Math.abs(cost - 0.00234) < 1e-12, `cost=${cost}`);
});
