import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { CacheEntry } from './types';
import { computePrefixKey } from './cacheKey';

/** better-sqlite3 构造函数类型（仅类型导入，不触发 native 加载） */
type DatabaseConstructor = typeof import('better-sqlite3');

/** SQLite 原始行（snake_case） */
interface CacheRow {
  id: string;
  prefix_hash: string;
  prefix_text: string;
  cache_id: string | null;
  engine_id: string;
  created_at: number;
  last_hit_at: number;
  hit_count: number;
  prefix_tokens: number;
}

function toEntry(row: CacheRow): CacheEntry {
  return {
    id: row.id,
    prefixHash: row.prefix_hash,
    prefixText: row.prefix_text,
    cacheId: row.cache_id,
    engineId: row.engine_id,
    createdAt: row.created_at,
    lastHitAt: row.last_hit_at,
    hitCount: row.hit_count,
    prefixTokens: row.prefix_tokens,
  };
}

/**
 * 缓存存储（SQLite，better-sqlite3）。
 * 纯 Node：构造函数只接收 db 路径字符串，由 extension 层注入
 * （context.globalStorageUri 下），不感知 VS Code。
 */
export class CacheStore {
  private readonly db: BetterSqlite3.Database;

  constructor(dbPath: string) {
    // 惰性加载 native 模块：ABI 不匹配时扩展能在 import 阶段之后先打印诊断信息，
    // 而不是在模块加载期直接崩溃（见 DEVELOPMENT.md 排坑记录）
    const Database = require('better-sqlite3') as DatabaseConstructor;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        id TEXT PRIMARY KEY,
        prefix_hash TEXT NOT NULL,
        prefix_text TEXT NOT NULL,
        cache_id TEXT,
        engine_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_hit_at INTEGER NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        prefix_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_prefix_engine
        ON cache_entries(prefix_hash, engine_id);
    `);
  }

  /**
   * 命中返回既有记录；未命中新建空白记录（cacheId=null）。
   * 哈希在本方法内按当前 FIXED_PREFIX_VERSION 计算——版本升级后旧记录自然不再被查中。
   */
  getOrCreate(prefixText: string, engineId: string): CacheEntry {
    const hash = computePrefixKey(prefixText);
    const existing = this.db
      .prepare(
        `SELECT * FROM cache_entries WHERE prefix_hash = ? AND engine_id = ?`,
      )
      .get(hash, engineId) as CacheRow | undefined;

    if (existing) {
      return toEntry(existing);
    }

    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO cache_entries
           (id, prefix_hash, prefix_text, cache_id, engine_id, created_at, last_hit_at, hit_count, prefix_tokens)
         VALUES (?, ?, ?, NULL, ?, ?, ?, 0, ?)`,
      )
      .run(id, hash, prefixText, engineId, now, now, 0);
    return {
      id,
      prefixHash: hash,
      prefixText,
      cacheId: null,
      engineId,
      createdAt: now,
      lastHitAt: now,
      hitCount: 0,
      prefixTokens: 0,
    };
  }

  /** 引擎首次返回后回填厂商 cache 标识与精确前缀 token 数 */
  attachCacheId(id: string, cacheId: string, prefixTokens: number): void {
    this.db
      .prepare(
        `UPDATE cache_entries SET cache_id = ?, prefix_tokens = ? WHERE id = ?`,
      )
      .run(cacheId, prefixTokens, id);
  }

  /** 命中时更新 last_hit_at / hit_count */
  touch(id: string): void {
    this.db
      .prepare(
        `UPDATE cache_entries SET last_hit_at = ?, hit_count = hit_count + 1 WHERE id = ?`,
      )
      .run(Date.now(), id);
  }

  /** 按 id 读取最新记录（touch 后重新读取，避免返回陈旧快照） */
  get(id: string): CacheEntry | undefined {
    const row = this.db
      .prepare(`SELECT * FROM cache_entries WHERE id = ?`)
      .get(id) as CacheRow | undefined;
    return row ? toEntry(row) : undefined;
  }

  /** 面板展示或诊断用 */
  listByEngine(engineId: string): CacheEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM cache_entries WHERE engine_id = ? ORDER BY last_hit_at DESC`)
      .all(engineId) as CacheRow[];
    return rows.map(toEntry);
  }

  /** 清理过期记录（厂商缓存有 TTL，本地也设过期）。返回删除条数。 */
  prune(ttlMs: number): number {
    const cutoff = Date.now() - ttlMs;
    const result = this.db
      .prepare(`DELETE FROM cache_entries WHERE last_hit_at < ?`)
      .run(cutoff);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
