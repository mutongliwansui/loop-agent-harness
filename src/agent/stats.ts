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
  // 20261021-008 R5：首轮 / 第 2 轮起拆分口径（均只统计有缓存字段的轮次）
  let firstPrompt = 0;
  let firstHit = 0;
  let subsequentPrompt = 0;
  let subsequentHit = 0;
  let hasSubsequentCache = false;

  for (const s of statsList) {
    totalPrompt += s.promptTokens;
    totalCompletion += s.completionTokens;
    totalTokens += s.totalTokens;
    if (s.cacheHitTokens !== undefined) {
      totalCacheHit += s.cacheHitTokens;
      // 分母用「有缓存字段轮次」的 promptTokens（与 hit 同源，口径一致）
      promptTokensWithCache += s.promptTokens;
      hasCache = true;
      if (s.iteration === 0) {
        firstPrompt += s.promptTokens;
        firstHit += s.cacheHitTokens;
      } else {
        subsequentPrompt += s.promptTokens;
        subsequentHit += s.cacheHitTokens;
        hasSubsequentCache = true;
      }
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
    // R5：首轮/第 2 轮起命中率拆分（token 加权；无数据保持 undefined）
    firstIterationHitRate: hasCache && firstPrompt > 0 ? firstHit / firstPrompt : undefined,
    subsequentIterationsHitRate:
      hasSubsequentCache && subsequentPrompt > 0 ? subsequentHit / subsequentPrompt : undefined,
    peakContextTokens,
    peakContextMaxTokens,
  };
}
