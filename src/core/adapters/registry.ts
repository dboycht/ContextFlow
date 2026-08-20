import type { AgentAdapter } from './types';

/**
 * 适配器注册表（docs/02 第 3 节）。
 * engineId 是稳定标识（deepseek | claude | openai），路由层只用字符串，不依赖具体类。
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  /** 启动时注册全部 */
  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.capabilities.engineId, adapter);
  }

  get(engineId: string): AgentAdapter | undefined {
    return this.adapters.get(engineId);
  }

  /** 面板下拉框数据源 */
  list(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  /** 故障转移判断依据 */
  async healthMap(): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {};
    for (const adapter of this.list()) {
      result[adapter.capabilities.engineId] = await adapter.healthCheck();
    }
    return result;
  }
}
