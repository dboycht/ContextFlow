# ContextFlow

> One panel, every harness. Cached context, less token cost.

**ContextFlow** 是一个 VS Code 插件：在一个面板里**统一管理并调用多家 AI 编程引擎**（DeepSeek Harness / Claude Code / OpenAI Codex），并在引擎之上加一层**前缀缓存 + 会话编排**——重复的项目背景、代码上下文、历史对话不再重复计费。

## 解决的问题

| 浪费 | 表现 |
|---|---|
| Token 费用 | 重复上下文按输入 token 计费 |
| 响应延迟 | 长上下文预填充（prefill）耗时长 |
| 工作流割裂 | 换模型 / 重启会话 = 上下文清零 |

**省钱公式直觉**：`节省 = 重复发送次数 × 上下文长度 × 单价`。会话越长、切换越频繁，收益越大。

## 核心机制

```
用户（VS Code 插件 GUI）
   ↓
编排层：会话管理 / 路由 / Context Caching（前缀哈希 + SQLite）
   ↓
接入层：DeepSeek Harness | Claude Code | OpenAI Codex（Adapter）
```

- **前缀缓存**：固定部分（系统提示 + 项目背景 + 已确认历史）放前面且版本化，可变部分（当前问题）放最后——前缀完全匹配才命中缓存，只对新增部分计费。
- **会话亲和性**：同一会话默认绑定同一引擎，吃满该厂商的缓存。
- **跨模型迁移**：切换引擎时导出上下文，在目标引擎侧重建缓存，上下文不丢。

## 状态

- **v1.0.1（当前）**：工程骨架（可激活面板）+ P0 前缀缓存层（前缀哈希 / SQLite / 命中指标）+ 全绿单测。
- 规划：DeepSeek Adapter 打通最小闭环 → 会话管理与路由 → 面板三大区块（会话列表 / 模型切换 / 缓存状态条）→ Claude / OpenAI Adapter 与故障转移 → 成本度量与对照实验。

## 开发

```bash
npm install
npm run compile   # tsc 编译到 out/
npm test          # 编译 + node --test 跑缓存层单测
npm run package   # vsce 打包 vsix
```

技术栈：TypeScript + VS Code Extension API + `better-sqlite3`（SQLite）+ Node 内置 `crypto`（SHA-256）。依赖刻意保持最少。

## License

MIT
