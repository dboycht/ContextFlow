/**
 * dsh 真实联调冒烟脚本（开发工具，进 git，不含任何密钥）。
 *
 * 用法：先 `npm run compile`，然后 `node scripts/dsh-smoke.cjs`
 * 作用：spawn 真实 DeepSeek Harness（jsonrpc-agent 配置）→ healthCheck → 一次真实 prompt，
 *       验证传输层协议握手、事件提取、idle 检测；并打印通知结构辅助校准 extractor。
 *
 * API key：从 Harness 仓库根 `.env` 读取（不打印值），经 spawn env 注入。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  DshJsonRpcTransport,
  defaultTurnExtractor,
} = require('../out/src/core/adapters/dshTransport.js');

const HARNESS = 'D:/Toolkit/tkFile/deepseek-harness-master';

/** 简单 .env 解析（只取 KEY=VALUE 行，不处理引号展开） */
function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** 递归收集通知里的字符串值（截断，用于校准提取器，不打印 key） */
function collectStrings(value, out, depth = 0, max = 12) {
  if (out.length >= max || depth > 6) return;
  if (typeof value === 'string') {
    if (value.trim().length > 0) out.push(value.slice(0, 80));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1, max);
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (key.toLowerCase().includes('key') || key.toLowerCase().includes('secret')) continue;
      collectStrings(value[key], out, depth + 1, max);
    }
  }
}

async function main() {
  const env = parseEnvFile(path.join(HARNESS, '.env'));
  const apiKey = env['DEEPSEEK_API_KEY'] ?? '';
  if (!apiKey) {
    console.error('[smoke] 未找到 DEEPSEEK_API_KEY（Harness .env）');
    process.exit(1);
  }
  console.log(`[smoke] key 已加载（长度 ${apiKey.length}），Harness=${HARNESS}`);

  const launch = {
    command: 'node',
    args: [
      path.join(HARNESS, 'packages/examples/jsonrpc-demo/lib/bin.js'),
      path.join(HARNESS, 'examples/jsonrpc-agent/cordis.yml'),
    ],
    cwd: path.join(HARNESS, 'examples/jsonrpc-agent'),
    env: {
      DEEPSEEK_API_KEY: apiKey,
      ...(env['DEEPSEEK_BASE_URL'] ? { DEEPSEEK_BASE_URL: env['DEEPSEEK_BASE_URL'] } : {}),
    },
  };

  const seen = [];
  const extractor = (notification, acc) => {
    seen.push(notification);
    defaultTurnExtractor(notification, acc);
  };

  const transport = new DshJsonRpcTransport(launch, {
    extractor,
    idleTimeoutMs: 180_000,
    exitTimeoutMs: 10_000,
    stderrSink: (chunk) => {
      const line = chunk.trim();
      if (line) console.log('[dsh-stderr]', line.slice(0, 300));
    },
  });

  console.log('[smoke] start（initialize 握手）...');
  try {
    await transport.start();
    console.log('[smoke] start OK');
  } catch (err) {
    console.error('[smoke] start FAIL:', err.message);
    if (err && typeof err === 'object' && 'code' in err) {
      console.error('[smoke] 错误码:', err.code);
    }
    process.exit(1);
  }

  console.log('[smoke] send（真实调用，需数秒~数十秒）...');
  // 会话 id 必须唯一：dsh 会把会话持久化到磁盘（jsonl），复用旧 id 会 id collision
  const sessionId = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await transport.send({
    prompt: '请只回复两个字：收到',
    sessionId,
  });
  console.log('[smoke] content =', JSON.stringify(result.content.slice(0, 300)));
  console.log(
    '[smoke] usage =',
    JSON.stringify({
      input: result.inputTokens,
      output: result.outputTokens,
      hit: result.cacheHitTokens,
    }),
  );
  console.log('[smoke] 收到通知数 =', seen.length);
  for (let i = 0; i < Math.min(seen.length, 12); i++) {
    const n = seen[i];
    const params = n.params ?? {};
    const event = params['event'];
    const eventType = event && typeof event === 'object' ? event['type'] : undefined;
    const status = params['status'];
    let detail = '';
    if (event && typeof event === 'object' && event['data'] && typeof event['data'] === 'object') {
      const d = event['data'];
      if (d['error']) detail = ' error=' + JSON.stringify(d['error']).slice(0, 300);
      if (d['reason']) detail += ' reason=' + JSON.stringify(d['reason']).slice(0, 200);
      if (d['usage']) detail += ' usage=' + JSON.stringify(d['usage']).slice(0, 200);
    }
    console.log(
      `[smoke] 通知#${i} method=${n.method} eventType=${eventType ?? ''} status=${status ?? ''}${detail}`,
    );
  }

  console.log('[smoke] close...');
  await transport.close();
  console.log('[smoke] OK');
}

main().catch((err) => {
  console.error('[smoke] FAIL:', err.message);
  process.exit(1);
});
