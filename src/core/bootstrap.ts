import * as fs from 'node:fs';
import * as path from 'node:path';
import { CacheStore } from './cache/cacheStore';
import { CacheMetrics } from './cache/metrics';
import { PrefixCache } from './cache/prefixCache';
import { AdapterRegistry } from './adapters/registry';
import { DeepSeekAdapter } from './adapters/deepseek';
import { DshJsonRpcTransport } from './adapters/dshTransport';
import { SessionStore } from './session/sessionStore';
import { Router } from './session/router';
import { Orchestrator } from './orchestrator';
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
  sessionStore: SessionStore;
  router: Router;
  orchestrator: Orchestrator;
}

export function createCore(storagePath: string): Core {
  fs.mkdirSync(storagePath, { recursive: true });
  const dbPath = path.join(storagePath, 'contextflow.db');

  const cacheStore = new CacheStore(dbPath);
  const metrics = new CacheMetrics();
  // 命中统计统一由 orchestrator 按 adapter 回传的 usage 记录（DeepSeek 自动缓存无 cache_id，
  // prefixCache 本地命中判定对它恒为 miss；Claude 显式缓存路径可单独注入 metrics）
  const prefixCache = new PrefixCache(cacheStore, {
    minTokens: 1024,
    ttlMs: 60 * 60 * 1000,
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

  // 会话层：跨模型统一会话 + 路由（docs/03）
  const sessionStore = new SessionStore(dbPath);
  const router = new Router(registry, config);

  // 关键闭环编排器（docs/03 §6）
  const orchestrator = new Orchestrator({
    router,
    sessionStore,
    prefixCache,
    cacheStore,
    registry,
    metrics,
  });

  return {
    cacheStore,
    metrics,
    prefixCache,
    config,
    registry,
    sessionStore,
    router,
    orchestrator,
  };
}
