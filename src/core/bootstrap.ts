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
 *
 * @param storagePath 扩展全局存储目录（SQLite 落盘）
 * @param configDirs  额外配置搜索目录（如工作区文件夹；扩展宿主 cwd 不可靠，不能只依赖 cwd）
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

/** 从 envFile（如 Harness 根 .env）读取 DEEPSEEK_API_KEY（不打印值） */
function readApiKeyFromEnvFile(envFile: string | undefined): string | undefined {
  if (!envFile || !fs.existsSync(envFile)) {
    return undefined;
  }
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*DEEPSEEK_API_KEY\s*=\s*(.*)\s*$/);
    if (m && m[1]) {
      return m[1];
    }
  }
  return undefined;
}

export function createCore(storagePath: string, configDirs: string[] = []): Core {
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
  // 本机运行时配置覆盖（data/config.json，gitignore 不随源码分发；产品未来走设置 UI）。
  // 候选路径：环境变量 DSH_CONFIG > 当前目录 > 传入的配置目录（如工作区文件夹）。
  const configCandidates = [
    process.env['DSH_CONFIG'],
    path.join(process.cwd(), 'data', 'config.json'),
    ...configDirs.map((dir) => path.join(dir, 'data', 'config.json')),
  ].filter((p): p is string => Boolean(p));
  for (const candidate of configCandidates) {
    config.loadFromFile(candidate);
  }
  const registry = new AdapterRegistry();

  // DeepSeekAdapter：驱动 DeepSeek Harness（SDK JSON-RPC，docs/02 §4.1）
  const dsh = config.getDeepSeekConfig();
  const apiKey =
    readApiKeyFromEnvFile(dsh.envFile) ?? process.env[dsh.apiKeyEnv] ?? '';
  registry.register(
    new DeepSeekAdapter(
      new DshJsonRpcTransport(
        {
          command: dsh.command,
          args: dsh.args,
          cwd: dsh.cwd,
          env: {
            DEEPSEEK_API_KEY: apiKey,
          },
        },
        {
          // dsh 启动诊断打到扩展宿主控制台（stdout 只走协议帧，诊断在 stderr）
          stderrSink: (chunk) => {
            const line = chunk.trim();
            if (line) {
              console.error('[ContextFlow][dsh]', line.slice(0, 500));
            }
          },
        },
      ),
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
