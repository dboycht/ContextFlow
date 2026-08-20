/**
 * 缓存层核心数据结构（docs/01 第 3 节）。
 * 本文件只定义类型，不含任何引擎/存储细节。
 */

/** 一条本地缓存记录（SQLite cache_entries 表的对象形态） */
export interface CacheEntry {
  /** 本地主键（uuid） */
  id: string;
  /** SHA-256(前缀文本) 的 hex，唯一键 */
  prefixHash: string;
  /** 完整前缀原文（用于重建/校验） */
  prefixText: string;
  /** 厂商返回的缓存标识（如 DeepSeek/OpenAI 的 cache id）；未回填为 null */
  cacheId: string | null;
  /** 归属引擎：deepseek | claude | openai */
  engineId: string;
  /** 创建时间（epoch ms） */
  createdAt: number;
  /** 最近命中时间（epoch ms） */
  lastHitAt: number;
  /** 累计命中次数 */
  hitCount: number;
  /** 前缀 token 数（引擎回传精确值前用本地估算） */
  prefixTokens: number;
}

/**
 * 传给 adapter 的引用，避免 adapter 感知缓存存储细节。
 * cacheEntry 为 null 表示「跳过缓存」（低于最小长度门槛）或「尚未建立缓存」。
 */
export interface ContextRef {
  /** null = 未命中/跳过，adapter 需首次发送 */
  cacheEntry: CacheEntry | null;
  /** 命中的前缀文本 */
  prefixText: string;
  /** 本次新增的可变部分（当前问题） */
  newText: string;
}
