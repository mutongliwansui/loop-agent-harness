// Task-15：LLM 统计纯函数（可独立测试）
// buildLLMStatsSummary：从每轮 LLMStats 列表聚合会话级汇总
import type { LLMStats, LLMStatsSummary } from '../types.js';

/**
 * 聚合会话级统计汇总
 * - 总输入/输出/总 token：逐轮累加
 * - 平均缓存命中率 = 累计命中 token / 累计「有缓存数据的」输入 token
 *   （20261021-009：无缓存字段的轮次只进 totalPrompt，不进缓存分母——N/A 不拉低均值）
 * - 上下文峰值：各轮 contextTokens 最大值
 */
export function buildLLMStatsSummary(statsList: LLMStats[]): LLMStatsSummary {
  if (statsList.length === 0) {
    return {
      iterations: 0,
      totalPrompt: 0,
      totalCompletion: 0,
      totalTokens: 0,
      totalCacheHit: 0,
      peakContextTokens: 0,
      peakContextMaxTokens: 0,
    };
  }

  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalTokens = 0;
  let totalCacheHit = 0;
  /** 有缓存数据轮次的输入 token 合计（缓存命中率分母） */
  let promptTokensWithCache = 0;
  let hasCache = false;
  let peakContextTokens = 0;
  let peakContextMaxTokens = 0;

  for (const s of statsList) {
    totalPrompt += s.promptTokens;
    totalCompletion += s.completionTokens;
    totalTokens += s.totalTokens;
    if (s.cacheHitTokens !== undefined) {
      totalCacheHit += s.cacheHitTokens;
      // 分母用「有缓存字段轮次」的 promptTokens（与 hit 同源，口径一致）
      promptTokensWithCache += s.promptTokens;
      hasCache = true;
    }
    if (s.contextTokens > peakContextTokens) peakContextTokens = s.contextTokens;
    if (s.contextMaxTokens > peakContextMaxTokens) peakContextMaxTokens = s.contextMaxTokens;
  }

  return {
    iterations: statsList.length,
    totalPrompt,
    totalCompletion,
    totalTokens,
    totalCacheHit,
    promptTokensWithCache,
    avgCacheHitRate: hasCache && promptTokensWithCache > 0 ? totalCacheHit / promptTokensWithCache : undefined,
    peakContextTokens,
    peakContextMaxTokens,
  };
}
