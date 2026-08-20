/** 命中指标快照（docs/01 第 7 节） */
export interface CacheMetricsSnapshot {
  /** 含缓存的请求数（跳过缓存的短前缀不计入） */
  totalRequests: number;
  /** 命中次数 */
  cacheHits: number;
  /** 命中率 = hits / requests */
  hitRate: number;
  /** 因命中省下的 token（= 命中前缀 token 数之和） */
  prefixTokensSaved: number;
  /** 累计实际输入 token */
  inputTokensTotal: number;
  /** 估算节省费用（需单价，docs/05 接入前恒为 0） */
  estCostSaved: number;
}

/**
 * 缓存命中指标：进程内累加 + snapshot 读取。
 * SQLite/JSON 持久化快照与费用折算在 docs/05（成本度量）里程碑接入。
 */
export class CacheMetrics {
  private totalRequests = 0;
  private cacheHits = 0;
  private prefixTokensSaved = 0;
  private inputTokensTotal = 0;
  private estCostSaved = 0;

  recordHit(prefixTokens: number): void {
    this.totalRequests += 1;
    this.cacheHits += 1;
    this.prefixTokensSaved += prefixTokens;
  }

  recordMiss(): void {
    this.totalRequests += 1;
  }

  /** 累计实际输入 token（由 adapter usage 回传，docs/02 接入后启用） */
  recordInputTokens(tokens: number): void {
    this.inputTokensTotal += tokens;
  }

  snapshot(): CacheMetricsSnapshot {
    return {
      totalRequests: this.totalRequests,
      cacheHits: this.cacheHits,
      hitRate: this.totalRequests > 0 ? this.cacheHits / this.totalRequests : 0,
      prefixTokensSaved: this.prefixTokensSaved,
      inputTokensTotal: this.inputTokensTotal,
      estCostSaved: this.estCostSaved,
    };
  }
}
