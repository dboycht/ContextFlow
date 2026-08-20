import type { Session } from './session';
import type { AdapterRegistry } from '../adapters/registry';
import type { ConfigStore } from '../config/configStore';

/**
 * 路由策略（docs/03 第 4 节）：手动优先 > 会话亲和性 + 记忆 > 默认 + 故障转移。
 * 核心原则：缓存收益绑定「同一会话尽量用同一引擎」，路由默认遵守，用户强制切换才迁移。
 */

export type RouteReason = 'manual' | 'memory' | 'default' | 'affinity' | 'failover';

export interface RouteDecision {
  /** 本轮引擎 */
  engineId: string;
  /** 决策依据 */
  reason: RouteReason;
  /** 是否发生了跨引擎迁移（需重建缓存） */
  migrated: boolean;
}

export interface RouteOptions {
  /** 为 true 时对候选引擎做 healthCheck，失败则降级到第一个健康引擎（故障转移） */
  preferHealthy?: boolean;
}

export class Router {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly config: ConfigStore,
  ) {}

  /**
   * 决策顺序（docs/03 第 4 节）：
   * 1. manual：用户在面板选了引擎 → 用它（与 session 归属不同则 migrated）
   * 2. affinity + memory：没手动选 → 优先 session.engineId（亲和性）；会话新建取 config 默认（记忆）
   * 3. default：无会话归属 → config 默认引擎
   * 4. failover：preferHealthy 且候选引擎 healthCheck 失败 → 降级到第一个健康引擎
   */
  async decide(
    session: Session | undefined,
    requestedEngineId?: string,
    options: RouteOptions = {},
  ): Promise<RouteDecision> {
    // 1. manual
    if (requestedEngineId && this.registry.get(requestedEngineId)) {
      return this.decideResult(requestedEngineId, 'manual', session, options);
    }

    // 2/3. affinity（会话归属）→ memory/default（config 默认模型）
    const engineId = session?.engineId ?? this.config.getDefaultModel();
    const reason: RouteReason = session?.engineId ? 'affinity' : 'default';
    return this.decideResult(engineId, reason, session, options);
  }

  /** 记录「记忆上次选择」：把引擎写进 config（docs/03 第 4 节 memory 策略） */
  remember(engineId: string): void {
    this.config.setDefaultModel(engineId);
  }

  private async decideResult(
    engineId: string,
    reason: RouteReason,
    session: Session | undefined,
    options: RouteOptions,
  ): Promise<RouteDecision> {
    const migrated = session ? session.engineId !== engineId : false;

    // 4. failover：候选引擎不可用时降级
    if (options.preferHealthy) {
      const adapter = this.registry.get(engineId);
      if (adapter && !(await adapter.healthCheck())) {
        const backup = this.registry
          .list()
          .find((a) => a.capabilities.engineId !== engineId);
        if (backup) {
          return {
            engineId: backup.capabilities.engineId,
            reason: 'failover',
            migrated: session ? session.engineId !== backup.capabilities.engineId : true,
          };
        }
      }
    }

    return { engineId, reason, migrated };
  }
}
