import * as fs from 'node:fs';

/**
 * 配置与密钥（docs/00 §8）：API key 只存 VS Code SecretStorage（extension 层），
 * core 层保持纯 Node——真实 key 由 extension 注入 process.env 或 ConfigStore 覆写。
 */

export interface PricingConfig {
  /** 输入单价（元/百万 token，参考值） */
  input: number;
  /** 缓存命中输入单价（参考值） */
  cachedInput: number;
  /** 输出单价（参考值） */
  output: number;
}

export interface DeepSeekConfig {
  /** dsh 启动命令（如 node） */
  command: string;
  /** dsh 启动参数（如 [<jsonrpc-demo>/lib/bin.js, <cordis.yml>]） */
  args: string[];
  /** 工作目录（Harness 仓库/安装目录；空则继承扩展宿主 cwd） */
  cwd?: string;
  /** dsh 环境变量文件（如 Harness 根 .env，用于读取 DEEPSEEK_API_KEY；不打印值） */
  envFile?: string;
  /** 初始 provider 路由 */
  provider: string;
  /** 初始模型 */
  model: string;
  /** 从哪个环境变量读 API key（spawn 时注入） */
  apiKeyEnv: string;
  /** 最大上下文（token，参考值） */
  maxContextTokens: number;
  /** 前缀缓存最小长度门槛（token） */
  minCacheTokens: number;
  /** 成本估算单价（参考值，可配置覆写） */
  pricing: PricingConfig;
}

/**
 * 配置存储（进程内，可被 extension 层以 SecretStorage/设置覆写）。
 * 默认值均为参考值；dsh 安装路径等必须由用户在设置里配置（P1 面板提供 UI）。
 */
export class ConfigStore {
  private defaultModel = 'deepseek';

  private deepseek: DeepSeekConfig = {
    command: 'node',
    // TODO(联调): 指向本机 dsh jsonrpc-demo bin + cordis.yml；P1 提供配置 UI
    args: [],
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    maxContextTokens: 128_000,
    minCacheTokens: 1024,
    // 参考值（元/百万 token）：DeepSeek 2026 实行峰谷定价且常变动，
    // 按官方定价页 https://api-docs.deepseek.com/quick_start/pricing 校准；可配置覆写。
    pricing: { input: 2, cachedInput: 0.2, output: 8 },
  };

  getDeepSeekConfig(): DeepSeekConfig {
    return { ...this.deepseek, pricing: { ...this.deepseek.pricing } };
  }

  updateDeepSeekConfig(partial: Partial<DeepSeekConfig>): void {
    this.deepseek = {
      ...this.deepseek,
      ...partial,
      pricing: partial.pricing ? { ...partial.pricing } : this.deepseek.pricing,
    };
  }

  /**
   * 从 JSON 文件加载覆盖（存在才读；data/config.json 为本机运行时配置，不进 git）。
   * 结构：{ deepseek?: Partial<DeepSeekConfig>, defaultModel?: string }
   */
  loadFromFile(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      return;
    }
    let raw: { deepseek?: Partial<DeepSeekConfig>; defaultModel?: string };
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as typeof raw;
    } catch {
      return; // 损坏的配置忽略，用默认
    }
    if (raw.deepseek) {
      this.updateDeepSeekConfig(raw.deepseek);
    }
    if (typeof raw.defaultModel === 'string') {
      this.setDefaultModel(raw.defaultModel);
    }
  }

  /** 默认引擎（新建会话无归属时使用；router 的 memory 策略写这里） */
  getDefaultModel(): string {
    return this.defaultModel;
  }

  setDefaultModel(engineId: string): void {
    this.defaultModel = engineId;
  }
}
