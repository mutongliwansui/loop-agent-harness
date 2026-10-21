/**
 * normalizeUsage 归一化单测（优化建议 20261021-009）
 *
 * 覆盖台账要求的五类报文 + 防御性边界：
 * - DeepSeek/智谱风格：prompt_cache_hit_tokens（hit>0 / 真实 0）
 * - OpenAI 风格：prompt_tokens_details.cached_tokens（缺失→N/A、=0→真 0%、>0→正确命中率）
 * - 旧式顶层 cached_tokens（三级 fallback）
 * - 仅有 miss 字段：hit = prompt - miss 推导
 * - 完全无缓存字段：hit/miss 均 undefined（N/A，不误判 0%）
 * - 一致性：hit+miss ≠ prompt 以 hit 为准；clamp 越界；非有限数视为缺失
 * - 汇总口径：N/A 轮次不进缓存分母（promptTokensWithCache）
 */
import { describe, it, expect } from 'vitest';
import { normalizeUsage } from '../src/llm/usage.js';
import { buildLLMStatsSummary } from '../src/agent/stats.js';
import type { LLMStats } from '../src/types.js';

/** 台账示例报文：OpenAI 兼容服务商，仅 prompt_tokens_details.cached_tokens */
const OPENAI_STYLE = {
  prompt_tokens: 2647,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens: 210,
  completion_tokens_details: { reasoning_tokens: 149 },
  total_tokens: 2857,
};

describe('normalizeUsage：DeepSeek/智谱风格（prompt_cache_hit_tokens）', () => {
  it('hit=1872/2588：直接命中，miss 推导补齐', () => {
    const u = normalizeUsage({
      prompt_tokens: 2588,
      prompt_cache_hit_tokens: 1872,
      completion_tokens: 412,
      total_tokens: 3000,
    });
    expect(u.prompt_cache_hit_tokens).toBe(1872);
    expect(u.prompt_cache_miss_tokens).toBe(716); // 2588 - 1872
    expect(u.prompt_tokens).toBe(2588);
  });

  it('显式 hit=0：视为真 0 命中（有缓存数据，N/A≠0%）', () => {
    const u = normalizeUsage({
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 0,
      completion_tokens: 100,
      total_tokens: 1100,
    });
    expect(u.prompt_cache_hit_tokens).toBe(0);
    expect(u.prompt_cache_miss_tokens).toBe(1000);
  });
});

describe('normalizeUsage：OpenAI 风格（prompt_tokens_details.cached_tokens）', () => {
  it('台账示例报文：cached_tokens=0 → hit=0（有缓存数据），不再误判为无缓存能力', () => {
    const u = normalizeUsage(OPENAI_STYLE);
    expect(u.prompt_cache_hit_tokens).toBe(0);
    expect(u.prompt_cache_miss_tokens).toBe(2647); // 推导补齐
    expect(u.prompt_tokens).toBe(2647);
    expect(u.prompt_tokens_details).toEqual({ cached_tokens: 0 });
    // 无关字段（completion_tokens_details）不带入归一化结果
    expect((u as Record<string, unknown>).completion_tokens_details).toBeUndefined();
  });

  it('cached_tokens=2000/2647 → hit=2000，命中率 75.6%', () => {
    const u = normalizeUsage({
      ...OPENAI_STYLE,
      prompt_tokens_details: { cached_tokens: 2000 },
    });
    expect(u.prompt_cache_hit_tokens).toBe(2000);
    expect(u.prompt_cache_miss_tokens).toBe(647);
    const rate = (u.prompt_cache_hit_tokens! / u.prompt_tokens) * 100;
    expect(rate.toFixed(1)).toBe('75.6');
  });

  it('details 为 null（部分服务商返回 null）：不影响归一化，走无缓存字段路径', () => {
    const u = normalizeUsage({
      prompt_tokens: 500,
      prompt_tokens_details: null,
      completion_tokens: 50,
      total_tokens: 550,
    });
    expect(u.prompt_cache_hit_tokens).toBeUndefined();
    expect(u.prompt_cache_miss_tokens).toBeUndefined();
    expect(u.prompt_tokens).toBe(500);
  });
});

describe('normalizeUsage：旧式顶层 cached_tokens（fallback）', () => {
  it('无直接字段时读取 cached_tokens', () => {
    const u = normalizeUsage({
      prompt_tokens: 1000,
      cached_tokens: 400,
      completion_tokens: 50,
      total_tokens: 1050,
    });
    expect(u.prompt_cache_hit_tokens).toBe(400);
    expect(u.prompt_cache_miss_tokens).toBe(600);
  });

  it('优先级：prompt_cache_hit_tokens > details.cached_tokens > cached_tokens', () => {
    const u = normalizeUsage({
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 900,
      prompt_tokens_details: { cached_tokens: 100 },
      cached_tokens: 1,
      completion_tokens: 10,
      total_tokens: 1010,
    });
    expect((u as Record<string, unknown>).prompt_cache_hits).toBeUndefined(); // 防手滑：字段名打错应失败
    expect(u.prompt_cache_hit_tokens).toBe(900);
  });
});

describe('normalizeUsage：仅有 miss 字段（推导）', () => {
  it('hit = prompt_tokens - miss', () => {
    const u = normalizeUsage({
      prompt_tokens: 1000,
      prompt_cache_miss_tokens: 300,
      completion_tokens: 50,
      total_tokens: 1050,
    });
    expect(u.prompt_cache_hit_tokens).toBe(700);
    expect(u.prompt_cache_miss_tokens).toBe(300);
  });
});

describe('normalizeUsage：完全无缓存字段 → N/A（不误判 0%）', () => {
  it('hit/miss 均 undefined，仅基础 token 数', () => {
    const u = normalizeUsage({
      prompt_tokens: 2647,
      completion_tokens: 210,
      total_tokens: 2857,
    });
    expect(u.prompt_cache_hit_tokens).toBeUndefined();
    expect(u.prompt_cache_miss_tokens).toBeUndefined();
  });

  it('raw 为 undefined/null 也不抛错', () => {
    expect(normalizeUsage(undefined).prompt_tokens).toBe(0);
    expect(normalizeUsage(null).total_tokens).toBe(0);
    expect(normalizeUsage(undefined).prompt_cache_hit_tokens).toBeUndefined();
  });
});

describe('normalizeUsage：一致性与防御', () => {
  it('hit+miss ≠ prompt_tokens：以 hit 为准，miss 重算', () => {
    const u = normalizeUsage({
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 100, // 800+100=900 ≠ 1000
      completion_tokens: 50,
      total_tokens: 1050,
    });
    expect(u.prompt_cache_hit_tokens).toBe(800);
    expect(u.prompt_cache_miss_tokens).toBe(200);
  });

  it('hit 越界（> prompt_tokens）clamp 到 prompt_tokens；负数视为字段缺失', () => {
    const u = normalizeUsage({
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 1200,
      completion_tokens: 50,
      total_tokens: 1050,
    });
    expect(u.prompt_cache_hit_tokens).toBe(1000);
    expect(u.prompt_cache_miss_tokens).toBe(0);

    const neg = normalizeUsage({
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: -5,
      completion_tokens: 50,
      total_tokens: 1050,
    });
    // 负数 → parseCount 视为缺失 → 走无缓存字段路径
    expect(neg.prompt_cache_hit_tokens).toBeUndefined();
  });

  it('非有限数（NaN/Infinity/字符串）视为字段缺失', () => {
    const u = normalizeUsage({
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: Number.NaN,
      prompt_tokens_details: { cached_tokens: Number.POSITIVE_INFINITY },
      completion_tokens: 50,
      total_tokens: 1050,
    });
    expect(u.prompt_cache_hit_tokens).toBeUndefined();
  });
});

describe('buildLLMStatsSummary：N/A 与 0% 口径分离（20261021-009）', () => {
  function makeStats(overrides: Partial<LLMStats> = {}): LLMStats {
    return {
      iteration: 0,
      maxIterations: 5,
      contextTokens: 1000,
      contextMaxTokens: 8000,
      contextThreshold: 6400,
      promptTokens: 1000,
      completionTokens: 100,
      totalTokens: 1100,
      elapsedMs: 100,
      ...overrides,
    };
  }

  it('混合轮次：N/A 轮次只进 totalPrompt，不进缓存分母', () => {
    const list: LLMStats[] = [
      // 有缓存数据：hit=500/1000（50%）
      makeStats({ iteration: 0, cacheHitTokens: 500, cacheHitRate: 0.5 }),
      // 无缓存字段：N/A 轮次
      makeStats({ iteration: 1, promptTokens: 3000, totalTokens: 3100, cacheHitTokens: undefined, cacheHitRate: undefined }),
    ];
    const s = buildLLMStatsSummary(list);
    expect(s.totalPrompt).toBe(4000); // N/A 轮次仍计入总输入
    expect(s.promptTokensWithCache).toBe(1000); // 缓存分母只有有数据轮次
    expect(s.totalCacheHit).toBe(500);
    // 均值 = 500/1000 = 50%，不被 N/A 轮次的 3000 拉低成 12.5%
    expect(s.avgCacheHitRate).toBeCloseTo(0.5);
  });

  it('全部轮次无缓存字段 → promptTokensWithCache=0，avgCacheHitRate=undefined', () => {
    const list: LLMStats[] = [
      makeStats({ cacheHitTokens: undefined, cacheHitRate: undefined }),
      makeStats({ iteration: 1, cacheHitTokens: undefined, cacheHitRate: undefined }),
    ];
    const s = buildLLMStatsSummary(list);
    expect(s.totalPrompt).toBe(2000);
    expect(s.promptTokensWithCache).toBe(0);
    expect(s.avgCacheHitRate).toBeUndefined();
  });

  it('真 0 命中轮次：进缓存分母，avgCacheHitRate=0%（与 N/A 区分）', () => {
    const list: LLMStats[] = [
      makeStats({ iteration: 0, cacheHitTokens: 0, cacheHitRate: 0 }),
      makeStats({ iteration: 1, promptTokens: 2000, totalTokens: 2100, cacheHitTokens: 500, cacheHitRate: 0.25 }),
    ];
    const s = buildLLMStatsSummary(list);
    expect(s.promptTokensWithCache).toBe(3000);
    expect(s.totalCacheHit).toBe(500);
    expect(s.avgCacheHitRate).toBeCloseTo(500 / 3000);
  });
});
