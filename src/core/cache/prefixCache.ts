import type { CacheMetrics } from './metrics';
import type { ContextRef } from './types';
import { estimateTokens } from './cacheKey';
import type { CacheStore } from './cacheStore';

export interface PrefixCacheOptions {
  /** 最小缓存长度门槛（token），低于则跳过缓存。默认 1024。 */
  minTokens?: number;
  /** 本地缓存过期时间，默认 1 小时。 */
  ttlMs?: number;
  /** 命中指标（可选，注入后 prepare 自动记录命中/未命中） */
  metrics?: CacheMetrics;
}

const DEFAULT_MIN_TOKENS = 1024;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * 前缀缓存主流程（docs/01 第 6 节）。
 * 组装一次请求所需的 ContextRef：前缀（固定+历史）哈希 → 查 SQLite → 命中/未命中判定。
 */
export class PrefixCache {
  private readonly minTokens: number;
  private readonly ttlMs: number;
  private readonly metrics?: CacheMetrics;

  constructor(
    private readonly store: CacheStore,
    opts: PrefixCacheOptions = {},
  ) {
    this.minTokens = opts.minTokens ?? DEFAULT_MIN_TOKENS;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.metrics = opts.metrics;
  }

  /**
   * 组装一次请求所需的 contextRef。
   * @param fixed    系统提示 + 项目背景（数组，按序拼接，放最前）
   * @param history  已确认历史轮次（数组，固定部分）
   * @param question 当前问题（可变部分，不进前缀）
   * @param engineId 目标引擎 id（deepseek | claude | openai）
   */
  async prepare(
    fixed: string[],
    history: string[],
    question: string,
    engineId: string,
  ): Promise<ContextRef> {
    const prefixText = [...fixed, ...history].join('\n');
    const prefixTokens = estimateTokens(prefixText);

    // 最小缓存长度门槛：厂商对短前缀缓存可能不生效甚至更贵，跳过
    if (prefixTokens < this.minTokens) {
      return { cacheEntry: null, prefixText, newText: question };
    }

    const entry = this.store.getOrCreate(prefixText, engineId);

    if (entry.cacheId != null) {
      // 命中：更新触达时间/次数，记录指标
      this.store.touch(entry.id);
      this.metrics?.recordHit(entry.prefixTokens);
      // touch 只更新 DB，需重读以拿到最新 hitCount
      const fresh = this.store.get(entry.id) ?? entry;
      return { cacheEntry: fresh, prefixText, newText: question };
    }

    // 未命中：adapter 首次发送后应调用 store.attachCacheId 回填，下次才能命中
    this.metrics?.recordMiss();
    return { cacheEntry: entry, prefixText, newText: question };
  }

  /** 清理本地过期缓存（按构造时 ttlMs） */
  async prune(): Promise<number> {
    return this.store.prune(this.ttlMs);
  }
}
