/**
 * ContextFlow 缓存演示脚本（源码，进 git）。
 *
 * 用法：先 `npm run compile`，然后 `node scripts/cache-demo.cjs`
 *
 * 演示内容：同一 dsh 会话连续提问 3 次（固定长前缀经会话历史累积），
 * 验证「第二次提问起命中 DeepSeek 自动缓存、重复 token 不再全额计费」，
 * 并产出真实测试数据与可视化 HTML 表。
 *
 * 输出（运行时数据，均落在 data/ 下，绝不上 GitHub）：
 *   data/demo/cache-demo.json   — 结构化测试数据
 *   data/demo/cache-demo.html   — 极简风可视化表（自包含）
 *
 * API key：从 Harness 仓库根 `.env` 读取（不打印值），经 spawn env 注入。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  DshJsonRpcTransport,
} = require('../out/src/core/adapters/dshTransport.js');

const HARNESS = 'D:/Toolkit/tkFile/deepseek-harness-master';
const OUT_DIR = path.join(__dirname, '..', 'data', 'demo');

// 参考单价（元/百万 token，与 ConfigStore 默认值一致；以官方定价页为准）
const PRICING = { input: 2, cachedInput: 0.2, output: 8 };

/** 简单 .env 解析 */
function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** 构造固定前缀：一段"项目背景"（与 docs/01 的 fixed 部分对应） */
function buildBackground() {
  const lines = [];
  lines.push('# ContextFlow 项目背景');
  lines.push('ContextFlow 是一个 VS Code 插件，统一编排多家 AI 编程引擎，并在引擎之上加一层前缀缓存与会话编排，让重复的项目背景、代码上下文、历史对话不再重复计费。');
  lines.push('');
  lines.push('## 技术架构');
  lines.push('1. 插件壳：TypeScript + VS Code Extension API，侧边栏 Webview 面板呈现会话列表、模型切换器、缓存状态条三大区块。');
  lines.push('2. 编排与缓存服务：Node.js (TypeScript)，与插件同进程，封装为独立 core 模块，保持纯 Node 可单测。');
  lines.push('3. 会话与缓存存储：SQLite（better-sqlite3），零部署，文件落在插件全局存储目录。');
  lines.push('4. 缓存键：SHA-256 前缀哈希（node:crypto 内置），固定前缀版本化，改动版本号即失效旧缓存。');
  lines.push('5. 接入层：Adapter 模式，统一接口 AgentAdapter，每家引擎一个实现；DeepSeek / Claude / OpenAI 三家引擎。');
  lines.push('6. 会话亲和性：同一会话默认绑定同一引擎，吃满该厂商缓存；用户强制切换时才迁移并重建缓存。');
  lines.push('7. 成本度量：统一从 adapter 回传的 usage 采集，命中率、节省 token、估算费用可视化呈现。');
  lines.push('');
  lines.push('## 核心机制：前缀缓存');
  lines.push('- 固定部分（系统提示 + 项目背景 + 已确认历史）永远放前面且内容版本化；可变部分（当前问题）放最后。');
  lines.push('- 前缀一变，缓存全失效；前缀完全匹配才命中，只对新增部分计费。');
  lines.push('- 缓存命中率目标（长会话场景）≥ 60%，Token 成本降低 ≥ 30%，响应延迟 ≤ 无缓存时的 70%。');
  lines.push('- 最小缓存长度门槛：前缀 token 数低于阈值时跳过缓存，避免无效缓存影响命中率与计费。');
  lines.push('');
  lines.push('## 会话与路由');
  lines.push('- 路由策略由简到繁：手动选择（GUI 下拉框）→ 默认模型 + 记忆上次选择 → 规则路由（远期）。');
  lines.push('- 故障转移：主引擎报错或限流时自动降级到备用引擎，降级时经缓存层导出上下文、在目标引擎侧重建。');
  lines.push('- 跨模型会话迁移：切换模型时导出上下文，在新模型侧重建缓存，上下文不丢。');
  lines.push('');
  lines.push('## 面板功能');
  lines.push('- 会话列表：跨模型统一视图，建立/切换/删除会话。');
  lines.push('- 模型切换器：当前引擎 + 一键切换，切换后提示正在目标引擎重建缓存。');
  lines.push('- 缓存状态条：命中率、本次会话节省的 token 与费用估算，数字全部来自 metrics，不写死。');
  lines.push('');
  lines.push('## 验收指标（P0）');
  lines.push('1. 缓存层单测全绿（相同前缀二次命中、前缀一字符不同即未命中、最小长度门槛、过期清理、版本号失效）。');
  lines.push('2. DeepSeekAdapter 打通：能真发请求、拿回回复，usage 归一化到统一口径。');
  lines.push('3. 核心演示：同一会话第二次提问命中缓存，usage.cacheHitTokens > 0，状态条显示节省。');
  lines.push('4. 成本对照：有缓存 vs 无缓存的费用与命中率数据产出。');
  lines.push('5. 插件可演示：会话列表 + 模型切换 + 缓存状态条。');
  lines.push('');
  lines.push('以上为固定背景内容，后续轮次的请求会自动复用此前缀的缓存。');
  return lines.join('\n');
}

/** 费用估算：命中 token 用 cachedInput 价，新增用 input 价，输出用 output 价 */
function estimateCost(usage, pricing) {
  const hit = usage.cacheHitTokens ?? 0;
  const fresh = Math.max(0, usage.inputTokens - hit);
  return (
    (fresh * pricing.input + hit * pricing.cachedInput + usage.outputTokens * pricing.output) /
    1_000_000
  );
}

/** baseline = 假设无缓存（全部输入按 input 价） */
function estimateBaseline(usage, pricing) {
  return (
    (usage.inputTokens * pricing.input + usage.outputTokens * pricing.output) / 1_000_000
  );
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** 极简风 HTML 表（自包含、内联样式） */
function renderHtml(rows, summary, meta) {
  const rowsHtml = rows
    .map((r, i) => {
      const hitClass = r.cacheHitTokens > 0 ? ' class="hit"' : '';
      const hitCell =
        r.cacheHitTokens > 0
          ? `<span class="hit-badge">${r.cacheHitTokens.toLocaleString()} ✓</span>`
          : '<span class="muted">—</span>';
      return `<tr${hitClass}>
        <td>${i + 1}</td>
        <td>${escapeHtml(r.kind)}</td>
        <td>${escapeHtml(r.question.slice(0, 24))}</td>
        <td>${r.inputTokens.toLocaleString()}</td>
        <td>${hitCell}</td>
        <td>${r.freshTokens.toLocaleString()}</td>
        <td>${r.outputTokens.toLocaleString()}</td>
        <td>${r.latencyMs.toFixed(0)} ms</td>
        <td>¥${r.cost.toFixed(4)}</td>
        <td>¥${r.saved.toFixed(4)}</td>
      </tr>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ContextFlow 缓存演示</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
         max-width: 900px; margin: 48px auto; padding: 0 24px; color: #1f2328; background: #fff; }
  h1 { font-size: 20px; font-weight: 600; letter-spacing: .5px; margin: 0 0 6px; }
  .sub { color: #6e7781; font-size: 13px; margin-bottom: 32px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-weight: 500; color: #57606a; border-bottom: 1px solid #d0d7de;
       padding: 8px 10px; white-space: nowrap; }
  td { border-bottom: 1px solid #eaeef2; padding: 8px 10px; font-variant-numeric: tabular-nums; }
  tr.hit td { background: #f6f8fa; }
  .hit-badge { color: #1a7f37; font-weight: 600; }
  .muted { color: #8b949e; }
  .summary { display: flex; gap: 48px; margin-top: 28px; flex-wrap: wrap; }
  .metric .v { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .metric .k { color: #6e7781; font-size: 12px; margin-top: 4px; }
  .foot { margin-top: 40px; color: #8b949e; font-size: 11px; line-height: 1.8; }
</style>
</head>
<body>
  <h1>ContextFlow 缓存演示</h1>
  <div class="sub">DeepSeek Harness 真实调用 · 同一会话连续提问，第二次起命中自动缓存</div>
  <table>
    <thead><tr>
      <th>#</th><th>类型</th><th>问题</th><th>输入 token</th><th>命中 token</th>
      <th>新增 token</th><th>输出 token</th><th>耗时</th><th>费用</th><th>节省</th>
    </tr></thead>
    <tbody>
${rowsHtml}
    </tbody>
  </table>
  <div class="summary">
    <div class="metric"><div class="v">${summary.hitRateToken.toFixed(1)}%</div><div class="k">token 命中率（命中/总输入）</div></div>
    <div class="metric"><div class="v">¥${summary.totalSaved.toFixed(4)}</div><div class="k">累计节省（参考单价）</div></div>
    <div class="metric"><div class="v">${summary.costReduction.toFixed(1)}%</div><div class="k">成本降低比例</div></div>
    <div class="metric"><div class="v">${summary.totalHitTokens.toLocaleString()}</div><div class="k">累计命中 token</div></div>
  </div>
  <div class="foot">
    生成时间：${escapeHtml(meta.generatedAt)}<br>
    会话 id：<code>${escapeHtml(meta.sessionId)}</code>（dsh 持久化会话，跨轮次累积前缀）<br>
    参考单价（元/百万 token）：输入 ¥${PRICING.input} · 缓存命中 ¥${PRICING.cachedInput} · 输出 ¥${PRICING.output}（以官方定价页为准，可配置覆写）<br>
    ⚠️ 本页为本地演示数据，不随源码分发
  </div>
</body>
</html>`;
}

async function main() {
  const env = parseEnvFile(path.join(HARNESS, '.env'));
  const apiKey = env['DEEPSEEK_API_KEY'] ?? '';
  if (!apiKey) {
    console.error('[demo] 未找到 DEEPSEEK_API_KEY（Harness .env）');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

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

  const transport = new DshJsonRpcTransport(launch, {
    idleTimeoutMs: 180_000,
    exitTimeoutMs: 10_000,
  });

  const sessionId = `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const background = buildBackground();
  const questions = [
    '请用一句话说明 ContextFlow 的核心机制是什么。',
    '请列举 ContextFlow 的三大面板区块。',
    '请说明前缀缓存为什么要求固定部分放前面。',
  ];

  console.log(`[demo] 会话 ${sessionId}，共 ${questions.length} 轮真实调用`);
  console.log('[demo] initialize...');
  await transport.start();
  console.log('[demo] 开始逐轮提问');

  const rows = [];
  for (let i = 0; i < questions.length; i++) {
    const isFirst = i === 0;
    // 首轮携带完整固定前缀；后续轮次前缀经会话历史自动累积
    const prompt = isFirst ? `${background}\n\n【当前问题】\n${questions[i]}` : questions[i];
    const t0 = Date.now();
    const result = await transport.send({ prompt, sessionId });
    const latencyMs = Date.now() - t0;

    const hit = result.cacheHitTokens ?? 0;
    const cost = estimateCost(result, PRICING);
    const baseline = estimateBaseline(result, PRICING);
    const row = {
      round: i + 1,
      kind: hit > 0 ? '命中缓存' : '首次/未命中',
      question: questions[i],
      inputTokens: result.inputTokens,
      cacheHitTokens: hit,
      freshTokens: Math.max(0, result.inputTokens - hit),
      outputTokens: result.outputTokens,
      latencyMs,
      cost,
      saved: Math.max(0, baseline - cost),
    };
    rows.push(row);
    console.log(
      `[demo] 第${i + 1}轮 kind=${row.kind} input=${result.inputTokens} hit=${hit} ` +
        `output=${result.outputTokens} ${latencyMs}ms cost=¥${cost.toFixed(4)} saved=¥${row.saved.toFixed(4)}`,
    );
  }

  await transport.close();

  const totalInput = rows.reduce((s, r) => s + r.inputTokens, 0);
  const totalHit = rows.reduce((s, r) => s + r.cacheHitTokens, 0);
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const totalBaseline = rows.reduce((s, r) => s + r.cost + r.saved, 0);
  const totalSaved = rows.reduce((s, r) => s + r.saved, 0);

  const summary = {
    totalRounds: rows.length,
    hitRounds: rows.filter((r) => r.cacheHitTokens > 0).length,
    totalInputTokens: totalInput,
    totalHitTokens: totalHit,
    hitRateToken: totalInput > 0 ? (totalHit / totalInput) * 100 : 0,
    totalCost,
    totalBaseline,
    totalSaved,
    costReduction: totalBaseline > 0 ? (totalSaved / totalBaseline) * 100 : 0,
  };

  const meta = {
    generatedAt: new Date().toLocaleString('zh-CN'),
    sessionId,
    engine: 'deepseek (DeepSeek Harness SDK JSON-RPC)',
    pricing: PRICING,
  };

  const jsonPath = path.join(OUT_DIR, 'cache-demo.json');
  const htmlPath = path.join(OUT_DIR, 'cache-demo.html');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ meta, summary, rows }, null, 2),
    'utf8',
  );
  fs.writeFileSync(htmlPath, renderHtml(rows, summary, meta), 'utf8');

  console.log('\n[demo] 汇总：');
  console.log(`[demo]   token 命中率 ${summary.hitRateToken.toFixed(1)}%`);
  console.log(`[demo]   累计节省 ¥${totalSaved.toFixed(4)}（成本降低 ${summary.costReduction.toFixed(1)}%）`);
  console.log(`[demo] 数据: ${jsonPath}`);
  console.log(`[demo] HTML: ${htmlPath}`);
}

main().catch((err) => {
  console.error('[demo] FAIL:', err.message);
  process.exit(1);
});
