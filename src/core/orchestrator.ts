import type { Router, RouteDecision } from './session/router';
import type { SessionStore } from './session/sessionStore';
import type { Session, Message } from './session/session';
import { createAssistantMessage, createUserMessage } from './session/session';
import type { PrefixCache } from './cache/prefixCache';
import type { CacheStore } from './cache/cacheStore';
import type { CacheMetrics } from './cache/metrics';
import type { AdapterRegistry } from './adapters/registry';
import type { ContextRef } from './cache/types';
import type { SendResult, StreamHandlers } from './adapters/types';

/**
 * 关键闭环编排器（docs/03 §6）：
 * router.decide → sessionStore.historyPrefix → prefixCache.prepare → adapter.send → appendMessage
 * 只有「已确认」的轮次（发送并回写后）才进历史前缀。
 *
 * ⚠️ 不注入自定义系统提示（persona）：ContextFlow 只做编排/缓存/连接，
 * 各 Harness 使用自身默认身份（如 Claude Code 的 CLAUDE.md、opencode 的配置），
 * 避免模型自称 ContextFlow。
 */
export interface OrchestratorDeps {
  router: Router;
  sessionStore: SessionStore;
  prefixCache: PrefixCache;
  cacheStore: CacheStore;
  registry: AdapterRegistry;
  metrics: CacheMetrics;
}

export interface SendOutcome {
  userMessage: Message;
  assistantMessage: Message;
  decision: RouteDecision;
  contextRef: ContextRef;
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  /** 新建会话：归属引擎走 router（默认/记忆），亲和性锚点即创建时的引擎 */
  async newSession(requestedEngineId?: string): Promise<Session> {
    const decision = await this.deps.router.decide(undefined, requestedEngineId);
    return this.deps.sessionStore.create('', decision.engineId);
  }

  /**
   * 一轮完整提问（docs/03 §6 关键闭环；非流式入口，等价于 sendStream 无 handlers）。
   * @param sessionId 会话 id
   * @param text      当前问题（可变部分，不进前缀）
   * @param requestedEngineId 面板手动选择（undefined = 走亲和性/默认）
   * @param requestedModel    面板选择的模型（undefined = 引擎默认；'default' 同义）
   * @param requestedEffort   面板选择的推理强度（undefined = 引擎默认；'default' 同义）
   */
  async send(
    sessionId: string,
    text: string,
    requestedEngineId?: string,
    requestedModel?: string,
    requestedEffort?: string,
  ): Promise<SendOutcome> {
    return this.sendStream(sessionId, text, {}, requestedEngineId, requestedModel, requestedEffort);
  }

  /**
   * 流式一轮完整提问：支持流式的引擎实时转发对话/思考/工具流（handlers），
   * 不支持流式的引擎回退 send（一次性输出，面板随后推完整消息）。
   */
  async sendStream(
    sessionId: string,
    text: string,
    handlers: StreamHandlers,
    requestedEngineId?: string,
    requestedModel?: string,
    requestedEffort?: string,
  ): Promise<SendOutcome> {
    const { sessionStore, router, prefixCache, registry, cacheStore, metrics } = this.deps;
    const session = sessionStore.get(sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }

    // 1. 路由决策（手动 > 亲和 > 默认 > failover）
    const decision = await router.decide(session, requestedEngineId);

    // 2. 跨引擎迁移：更新亲和性锚点（重建缓存在目标引擎侧自然发生）
    if (decision.migrated) {
      sessionStore.setEngine(sessionId, decision.engineId);
      session.engineId = decision.engineId;
    }

    // 3. 历史前缀（已确认轮次）+ 缓存 prepare（不注入自定义系统提示，引擎用自身 persona）
    const history = sessionStore.historyPrefix(sessionId);
    const contextRef = await prefixCache.prepare([], history, text, decision.engineId);

    // 4. 发送到目标引擎（流式优先，非流式回退）
    const adapter = registry.get(decision.engineId);
    if (!adapter) {
      throw new Error(`adapter not found: ${decision.engineId}`);
    }
    const prompt = contextRef.prefixText
      ? `${contextRef.prefixText}\n\n${contextRef.newText}`
      : contextRef.newText;
    const options: Record<string, unknown> = {};
    if (requestedModel && requestedModel !== 'default') {
      options.model = requestedModel;
    }
    if (requestedEffort && requestedEffort !== 'default') {
      options.effort = requestedEffort;
    }
    let result: SendResult;
    if (adapter.sendStream) {
      result = await adapter.sendStream({ prompt, contextRef, sessionId, options }, handlers);
    } else {
      result = await adapter.send({ prompt, contextRef, sessionId, options });
    }

    // 5. cacheId 回填（显式缓存厂商如 Anthropic；DeepSeek 自动缓存无 cache_id）
    if (result.cacheId && contextRef.cacheEntry) {
      cacheStore.attachCacheId(
        contextRef.cacheEntry.id,
        result.cacheId,
        result.usage.inputTokens,
      );
    }

    // 6. 回写会话历史（回复确认后才 append——未完成/中断的内容绝不进前缀）
    const userMessage = createUserMessage(text, decision.engineId);
    const assistantMessage = createAssistantMessage(
      result.content,
      decision.engineId,
      result.usage,
    );
    sessionStore.appendMessage(sessionId, userMessage);
    sessionStore.appendMessage(sessionId, assistantMessage);

    // 7. 命中指标（跨厂商一致：以 adapter 回传的最终 usage 为准，DeepSeek 自动缓存
    //    无 cache_id，本地前缀命中判定对它恒为 miss，故不依赖 prefixCache 内部记录）
    if ((result.usage.cacheHitTokens ?? 0) > 0) {
      metrics.recordHit(result.usage.cacheHitTokens ?? 0);
    } else {
      metrics.recordMiss();
    }
    metrics.recordInputTokens(result.usage.inputTokens);

    return { userMessage, assistantMessage, decision, contextRef };
  }

  /** 用户强制切换引擎：记忆选择 + 更新会话归属（docs/03 §5 强制切换才迁移） */
  switchEngine(sessionId: string, engineId: string): void {
    this.deps.router.remember(engineId);
    this.deps.sessionStore.setEngine(sessionId, engineId);
  }

  listSessions(): Session[] {
    return this.deps.sessionStore.list();
  }

  getSession(sessionId: string): Session | undefined {
    return this.deps.sessionStore.get(sessionId);
  }

  deleteSession(sessionId: string): void {
    this.deps.sessionStore.delete(sessionId);
  }

  renameSession(sessionId: string, title: string): void {
    this.deps.sessionStore.rename(sessionId, title);
  }

  /** 面板引擎下拉数据源（同步：capabilities 声明值，立即返回，不阻塞 init） */
  enginesSync(): Array<{ engineId: string; label: string; models?: string[]; efforts?: string[] }> {
    return this.deps.registry.list().map((a) => ({
      engineId: a.capabilities.engineId,
      label: a.capabilities.label,
      models: a.capabilities.models,
      efforts: a.capabilities.efforts,
    }));
  }

  /**
   * 面板引擎下拉数据源（异步：opencode 等引擎查询真实模型列表）。
   * ⚠️ 会 await listModels（可能 spawn 子进程），仅供后台刷新，勿阻塞 init。
   */
  async engines(): Promise<Array<{ engineId: string; label: string; models?: string[]; efforts?: string[] }>> {
    const out: Array<{ engineId: string; label: string; models?: string[]; efforts?: string[] }> = [];
    for (const adapter of this.deps.registry.list()) {
      let models = adapter.capabilities.models;
      if (adapter.listModels) {
        try {
          models = await adapter.listModels();
        } catch {
          // 查询失败保持声明值
        }
      }
      out.push({
        engineId: adapter.capabilities.engineId,
        label: adapter.capabilities.label,
        models,
        efforts: adapter.capabilities.efforts,
      });
    }
    return out;
  }

  metricsSnapshot() {
    return this.deps.metrics.snapshot();
  }

  async healthMap(): Promise<Record<string, boolean>> {
    return this.deps.registry.healthMap();
  }
}
