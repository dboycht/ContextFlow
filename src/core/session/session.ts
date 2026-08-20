/**
 * 跨模型统一会话格式（docs/03 第 2 节）。
 * 字段语义对齐 SQLite sessions/messages 表；不绑定任何具体引擎。
 */

/** 一条消息（可溯源到产生它的引擎） */
export interface Message {
  /** uuid */
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** 这条消息由哪个引擎产生（模型溯源） */
  engineId?: string;
  /** epoch ms */
  ts: number;
  /** 本消息用量（供 docs/05 度量） */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens?: number;
  };
}

/** 一个跨模型会话（亲和性锚点 = engineId） */
export interface Session {
  /** uuid */
  id: string;
  /** 摘要标题（首条用户输入截断） */
  title: string;
  /** 当前会话的归属引擎（亲和性锚点） */
  engineId: string;
  createdAt: number;
  updatedAt: number;
  /** 完整消息流（按 ts 升序） */
  messages: Message[];
  /** 扩展：固定前缀配置、标签等 */
  meta?: Record<string, unknown>;
}

/** 首条用户输入截断生成标题 */
export function titleFromFirstUserInput(text: string, maxLength = 30): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}…` : oneLine;
}

/** 生成一条用户消息（编排层发送前创建） */
export function createUserMessage(content: string, engineId?: string): Message {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content,
    engineId,
    ts: Date.now(),
  };
}

/** 生成一条助手消息（回复后回写） */
export function createAssistantMessage(
  content: string,
  engineId: string,
  usage?: Message['usage'],
): Message {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content,
    engineId,
    ts: Date.now(),
    usage,
  };
}
