import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../../src/core/session/sessionStore';
import {
  createAssistantMessage,
  createUserMessage,
  titleFromFirstUserInput,
} from '../../src/core/session/session';

function makeStore(): SessionStore {
  return new SessionStore(':memory:');
}

test('create：返回会话骨架（uuid/空消息）', () => {
  const store = makeStore();
  const s = store.create('我的会话', 'deepseek');
  assert.ok(s.id.length > 0);
  assert.equal(s.title, '我的会话');
  assert.equal(s.engineId, 'deepseek');
  assert.deepEqual(s.messages, []);
});

test('appendMessage + get：消息按 ts 升序返回，含 engine 溯源与 usage', () => {
  const store = makeStore();
  const s = store.create('', 'deepseek');
  const user = createUserMessage('背景是什么？', 'deepseek');
  store.appendMessage(s.id, user);
  const assistant = createAssistantMessage('回答', 'deepseek', {
    inputTokens: 100,
    outputTokens: 20,
    cacheHitTokens: 60,
  });
  store.appendMessage(s.id, assistant);

  const loaded = store.get(s.id)!;
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[0]!.role, 'user');
  assert.equal(loaded.messages[1]!.role, 'assistant');
  assert.equal(loaded.messages[1]!.engineId, 'deepseek');
  assert.deepEqual(loaded.messages[1]!.usage, {
    inputTokens: 100,
    outputTokens: 20,
    cacheHitTokens: 60,
  });
});

test('appendMessage：首条用户消息自动生成标题（截断）', () => {
  const store = makeStore();
  const s = store.create('', 'deepseek');
  const longText = '这是一个非常非常长的用户问题，用来验证标题自动生成时的截断逻辑是否能够正常工作并且保留省略号标记';
  store.appendMessage(s.id, createUserMessage(longText));
  const loaded = store.get(s.id)!;
  assert.ok(loaded.title.endsWith('…'));
  assert.ok(loaded.title.length <= 31); // 30 + 省略号
});

test('list：按 updatedAt 倒序，不含 messages', async () => {
  const store = makeStore();
  const a = store.create('A', 'deepseek');
  // 间隔几毫秒，确保 updatedAt 可区分（同毫秒内排序不稳定）
  await new Promise((r) => setTimeout(r, 5));
  const b = store.create('B', 'claude');
  store.appendMessage(b.id, createUserMessage('b 的问题'));
  const list = store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0]!.id, b.id); // b 更新晚，排前
  assert.deepEqual(list[0]!.messages, []); // 列表不含消息体
});

test('rename / setEngine / delete', () => {
  const store = makeStore();
  const s = store.create('旧标题', 'deepseek');
  store.appendMessage(s.id, createUserMessage('问题'));
  store.rename(s.id, '新标题');
  assert.equal(store.get(s.id)!.title, '新标题');

  store.setEngine(s.id, 'claude');
  assert.equal(store.get(s.id)!.engineId, 'claude');

  store.delete(s.id);
  assert.equal(store.get(s.id), undefined);
  // 消息级联删除
  const messages = (store as unknown as { db: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } } }).db
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?')
    .all(s.id);
  assert.equal((messages[0] as { n: number }).n, 0);
});

test('historyPrefix：user/assistant 按序转文本行，system 默认排除', () => {
  const store = makeStore();
  const s = store.create('', 'deepseek');
  store.appendMessage(s.id, {
    id: 'm1',
    role: 'system',
    content: '你是助手',
    ts: 1,
  });
  store.appendMessage(s.id, createUserMessage('你好', 'deepseek'));
  store.appendMessage(s.id, createAssistantMessage('嗨', 'deepseek'));

  const prefix = store.historyPrefix(s.id);
  assert.deepEqual(prefix, ['[user] 你好', '[assistant] 嗨']);

  const withSystem = store.historyPrefix(s.id, { includeSystem: true });
  assert.equal(withSystem.length, 3);
  assert.equal(withSystem[0], '[system] 你是助手');
});

test('historyPrefix：只有已确认（已 append）的消息进入历史', () => {
  const store = makeStore();
  const s = store.create('', 'deepseek');
  store.appendMessage(s.id, createUserMessage('已确认的问题'));
  // 「中断/未发送」的消息从未 append，不会出现在历史
  const prefix = store.historyPrefix(s.id);
  assert.deepEqual(prefix, ['[user] 已确认的问题']);
});

test('titleFromFirstUserInput：压缩空白并截断', () => {
  assert.equal(titleFromFirstUserInput('  你好   世界  '), '你好 世界');
  assert.ok(titleFromFirstUserInput('a'.repeat(100)).length <= 31);
});
