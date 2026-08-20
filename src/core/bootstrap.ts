import * as fs from 'node:fs';
import * as path from 'node:path';
import { CacheStore } from './cache/cacheStore';
import { CacheMetrics } from './cache/metrics';
import { PrefixCache } from './cache/prefixCache';
import { AdapterRegistry } from './adapters/registry';
import { DeepSeekAdapter } from './adapters/deepseek';
import { DshJsonRpcTransport } from './adapters/dshTransport';
import { ConfigStore } from './config/configStore';

/**
 * core 装配层：把 VS Code 提供的资源（存储路径）注入纯 Node 的 core 模块。
 * 只有 extension.ts / webview 允许 import vscode；本文件保持纯 Node。
 */
export interface Core {
  cacheStore: CacheStore;
  metrics: CacheMetrics;
  prefixCache: PrefixCache;
  config: ConfigStore;
  registry: AdapterRegistry;
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

  const config = new ConfigStore();
  const registry = new AdapterRegistry();

  // DeepSeekAdapter：驱动 DeepSeek Harness（SDK JSON-RPC，docs/02 §4.1）
  const dsh = config.getDeepSeekConfig();
  registry.register(
    new DeepSeekAdapter(
      new DshJsonRpcTransport({
        command: dsh.command,
        args: dsh.args,
        cwd: dsh.cwd,
        env: {
          DEEPSEEK_API_KEY: process.env[dsh.apiKeyEnv] ?? '',
        },
      }),
      dsh,
    ),
  );

  return { cacheStore, metrics, prefixCache, config, registry };
}
