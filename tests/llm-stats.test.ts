/**
 * Task-15 验收测试：每轮迭代 Token/缓存/上下文统计
 *
 * 覆盖验收项：
 * - 8.1 每轮上下文占用格式
 * - 8.2 每轮缓存命中率（含 N/A 降级）
 * - 8.3 每轮输入/输出 token
 * - 8.4 会话累积汇总聚合
 * - 8.5 开关独立（showTokenStats 与 verbose 解耦）
 * - 8.6 静默降级（usage/缓存字段缺失）
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildLLMStatsSummary } from '../src/agent/stats.js';
import { ConsoleLogger } from '../src/agent/logger.js';
import type { LLMStats, LLMStatsSummary } from '../src/types.js';

function makeStats(overrides: Partial<LLMStats> = {}): LLMStats {
  return {
    iteration: 0,
    maxIterations: 5,
    contextTokens: 3214,
    contextMaxTokens: 8000,
    contextThreshold: 6400,
    promptTokens: 2588,
    completionTokens: 412,
    totalTokens: 3000,
    cacheHitTokens: 1872,
    cacheHitRate: 1872 / 2588,
    elapsedMs: 1200,
    ...overrides,
  };
}

/** 捕获 console.log 调用并剥离 ANSI 颜色码，返回纯文本列表 */
function captureLog(): { calls: string[]; spy: ReturnType<typeof vi.spyOn> } {
  const calls: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    calls.push(args.map(String).join(' ').replace(/\x1b\[[0-9;]*m/g, ''));
  });
  return { calls, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildLLMStatsSummary（8.4 汇总聚合）', () => {
  it('多轮聚合：总数/平均缓存率/上下文峰值正确', () => {
    const list: LLMStats[] = [
      makeStats({ iteration: 0, promptTokens: 1000, completionTokens: 200, totalTokens: 1200, cacheHitTokens: 500, contextTokens: 3000 }),
      makeStats({ iteration: 1, promptTokens: 2000, completionTokens: 300, totalTokens: 2300, cacheHitTokens: 1000, contextTokens: 4500 }),
    ];
    const summary = buildLLMStatsSummary(list);
    expect(summary.iterations).toBe(2);
    expect(summary.totalPrompt).toBe(3000);
    expect(summary.totalCompletion).toBe(500);
    expect(summary.totalTokens).toBe(3500);
    expect(summary.totalCacheHit).toBe(1500);
    expect(summary.avgCacheHitRate).toBeCloseTo(0.5);
    expect(summary.peakContextTokens).toBe(4500);
    expect(summary.peakContextMaxTokens).toBe(8000);
  });

  it('无缓存字段 → avgCacheHitRate 为 undefined（8.6 降级）', () => {
    const list: LLMStats[] = [
      makeStats({ cacheHitTokens: undefined, cacheHitRate: undefined }),
      makeStats({ cacheHitTokens: undefined, cacheHitRate: undefined }),
    ];
    const summary = buildLLMStatsSummary(list);
    expect(summary.avgCacheHitRate).toBeUndefined();
    expect(summary.totalCacheHit).toBe(0);
  });

  it('空列表 → iterations 0（不触发打印）', () => {
    const summary = buildLLMStatsSummary([]);
    expect(summary.iterations).toBe(0);
    expect(summary.totalTokens).toBe(0);
  });

  it('单轮会话也能聚合', () => {
    const summary = buildLLMStatsSummary([makeStats()]);
    expect(summary.iterations).toBe(1);
    expect(summary.totalPrompt).toBe(2588);
    expect(summary.avgCacheHitRate).toBeCloseTo(1872 / 2588);
  });
});

describe('ConsoleLogger.onLLMStats（8.1/8.2/8.3 每轮统计）', () => {
  it('单行格式：迭代/上下文/输入/输出/缓存/耗时', () => {
    const { calls } = captureLog();
    const logger = new ConsoleLogger(true, true);
    logger.onLLMStats(makeStats());

    const line = calls[0];
    expect(line).toContain('[迭代 1/5]');
    expect(line).toContain('上下文');
    expect(line).toContain('3214/8000 (40%)');
    expect(line).toContain('输入 2588');
    expect(line).toContain('输出 412');
    expect(line).toContain('缓存 72.3%');
    expect(line).toContain('1.2s');
  });

  it('缓存字段缺失 → 显示 N/A（8.2/8.6 降级）', () => {
    const { calls } = captureLog();
    const logger = new ConsoleLogger(true, true);
    logger.onLLMStats(makeStats({ cacheHitTokens: undefined, cacheHitRate: undefined }));
    expect(calls[0]).toContain('缓存 N/A');
  });

  it('上下文达到压缩阈值 → 黄色 ⚠ 警示', () => {
    const { calls } = captureLog();
    const logger = new ConsoleLogger(true, true);
    logger.onLLMStats(makeStats({ contextTokens: 6500, contextThreshold: 6400 }));
    expect(calls[0]).toContain('⚠');
    expect(calls[0]).toContain('(81%)');
  });

  it('showTokenStats=false → 不输出（8.5 开关）', () => {
    const { calls } = captureLog();
    const logger = new ConsoleLogger(true, false);
    logger.onLLMStats(makeStats());
    expect(calls.length).toBe(0);
  });

  it('verbose=false 但 showTokenStats=true → 仍输出（8.5 独立开关）', () => {
    const { calls } = captureLog();
    const logger = new ConsoleLogger(false, true);
    logger.onLLMStats(makeStats());
    expect(calls.length).toBe(1);
  });
});

describe('ConsoleLogger.onLLMStatsSummary（8.4 汇总）', () => {
  const summary: LLMStatsSummary = {
    iterations: 2,
    totalPrompt: 3000,
    totalCompletion: 500,
    totalTokens: 3500,
    totalCacheHit: 1500,
    avgCacheHitRate: 0.5,
    peakContextTokens: 4500,
    peakContextMaxTokens: 8000,
  };

  it('汇总格式：轮数/总输入/总输出/总 token/平均缓存/峰值', () => {
    const { calls } = captureLog();
    const logger = new ConsoleLogger(true, true);
    logger.onLLMStatsSummary(summary);

    const line = calls[0];
    expect(line).toContain('[统计汇总]');
    expect(line).toContain('2 轮');
    expect(line).toContain('总输入 3000');
    expect(line).toContain('总输出 500');
    expect(line).toContain('总 token 3500');
    expect(line).toContain('平均缓存命中 50.0%');
    expect(line).toContain('上下文峰值 4500/8000 (56%)');
  });

  it('avgCacheHitRate 缺失 → N/A', () => {
    const { calls } = captureLog();
    const logger = new ConsoleLogger(true, true);
    logger.onLLMStatsSummary({ ...summary, avgCacheHitRate: undefined });
    expect(calls[0]).toContain('平均缓存命中 N/A');
  });

  it('iterations=0 → 不输出', () => {
    const { calls } = captureLog();
    const logger = new ConsoleLogger(true, true);
    logger.onLLMStatsSummary({ ...summary, iterations: 0 });
    expect(calls.length).toBe(0);
  });

  it('showTokenStats=false → 不输出', () => {
    const { calls } = captureLog();
    const logger = new ConsoleLogger(true, false);
    logger.onLLMStatsSummary(summary);
    expect(calls.length).toBe(0);
  });
});
