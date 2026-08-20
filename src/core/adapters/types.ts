import type { ContextRef } from '../cache/types';

/**
 * Adapter 接入层统一接口（docs/02 第 2 节）。
 * 每家引擎的缓存协议、鉴权方式、计价规则差异全部封装在各自 adapter 内。
 */

/** 一次发送的输入 */
export interface SendInput {
  /** 完整一次性 prompt（前缀 + 当前问题，已由缓存层组织） */
  prompt: string;
  /** 来自缓存层（docs/01），携带 cache 标识 */
  contextRef: ContextRef;
  /** 归属会话（docs/03） */
  sessionId: string;
  /** 引擎特有参数透传 */
  options?: Record<string, unknown>;
}

/** 一次响应的结果 */
export interface SendResult {
  /** 回复文本 */
  content: string;
  /** 厂商原始返回（诊断/度量用） */
  raw: unknown;
  /** 用量，供 docs/05 度量 */
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** 命中的缓存 token（厂商能回传时填） */
    cacheHitTokens?: number;
    /** 本次估算费用 */
    costEstimate?: number;
  };
  /** 厂商返回的新缓存标识（显式缓存厂商如 Anthropic 回填用；DeepSeek 自动缓存无此字段） */
  cacheId?: string;
}

/** 能力声明，供路由与面板展示 */
export interface Capabilities {
  /** deepseek | claude | openai */
  engineId: string;
  /** 展示名 */
  label: string;
  /** 最大上下文 */
  maxContextTokens: number;
  /** 是否支持缓存 */
  supportsCache: boolean;
  /** 单价（元/百万 token，参考值，用于成本估算；以各厂商官方定价页为准，可配置覆写） */
  pricing?: {
    input: number;
    cachedInput: number;
    output: number;
  };
}

/** 统一 Adapter 接口：只管「发一次请求、拿回一次真实引擎结果」 */
export interface AgentAdapter {
  readonly capabilities: Capabilities;
  send(input: SendInput): Promise<SendResult>;
  healthCheck(): Promise<boolean>;
  estimateCost(usage: SendResult['usage']): number;
}
