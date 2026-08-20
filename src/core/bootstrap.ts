import * as fs from 'node:fs';
import * as path from 'node:path';
import { CacheStore } from './cache/cacheStore';
import { CacheMetrics } from './cache/metrics';
import { PrefixCache } from './cache/prefixCache';

/**
 * core 装配层：把 VS Code 提供的资源（存储路径）注入纯 Node 的 core 模块。
 * 只有 extension.ts / webview 允许 import vscode；本文件保持纯 Node。
 */
export interface Core {
  cacheStore: CacheStore;
  metrics: CacheMetrics;
  prefixCache: PrefixCache;
}

export function createCore(storagePath: string): Core {
  fs.mkdirSync(storagePath, { recursive: true });
  const dbPath = path.join(storagePath, 'contextflow.db');

  const cacheStore = new CacheStore(dbPath);
  const metrics = new CacheMetrics();
  const prefixCache = new PrefixCache(cacheStore, {
    minTokens: 1024,
    ttlMs: 60 * 60 * 1000,
    metrics,
  });

  return { cacheStore, metrics, prefixCache };
}
