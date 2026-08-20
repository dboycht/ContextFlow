import { createHash } from 'node:crypto';

/**
 * 固定前缀版本号。
 * 模板一旦改动（系统提示/项目背景/历史格式变化），版本号 +1，
 * 哈希随之改变，旧缓存自然失效——避免「改了固定内容却还在吃旧缓存」。
 */
export const FIXED_PREFIX_VERSION = 1;

/**
 * 稳定、可复现的前缀哈希。
 * 用 node:crypto 的 createHash，不要用带随机盐的哈希——前缀哈希必须确定，
 * 才能在下次请求命中。
 * @param prefixText 系统提示 + 项目背景 + 历史前缀（不含当前问题）
 * @param version    固定前缀模板版本，默认取 FIXED_PREFIX_VERSION
 */
export function computePrefixKey(
  prefixText: string,
  version: number = FIXED_PREFIX_VERSION,
): string {
  return createHash('sha256')
    .update(`${version}\n${prefixText}`, 'utf8')
    .digest('hex');
}

/**
 * 轻量 token 估算（启发式，引擎回传精确值前使用）。
 * - 英文/空白约 4 字符 = 1 token；
 * - CJK 等宽字符约每字符 0.6 token（粗估）。
 * 仅用于 docs/01 的「最小缓存长度门槛」判断，不参与计费。
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  const cjk =
    (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.max(1, Math.ceil(rest / 4) + Math.ceil(cjk * 0.6));
}
