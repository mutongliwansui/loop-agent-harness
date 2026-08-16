// Task-15：LLM 统计纯函数（可独立测试）
// buildLLMStatsSummary：从每轮 LLMStats 列表聚合会话级汇总
import type { LLMStats, LLMStatsSummary } from '../types.js';

/**
 * 聚合会话级统计汇总
 * - 总输入/输出/总 token：逐轮累加
 * - 平均缓存命中率 = 累计命中 token / 累计输入 token（无命中数据时为 undefined）
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
  let hasCache = false;
  let peakContextTokens = 0;
  let peakContextMaxTokens = 0;

  for (const s of statsList) {
    totalPrompt += s.promptTokens;
    totalCompletion += s.completionTokens;
    totalTokens += s.totalTokens;
    if (s.cacheHitTokens !== undefined) {
      totalCacheHit += s.cacheHitTokens;
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
    avgCacheHitRate: hasCache && totalPrompt > 0 ? totalCacheHit / totalPrompt : undefined,
    peakContextTokens,
    peakContextMaxTokens,
  };
}
