// 20261021-008 缓存命中率优化：P1 单测
// R2（CuratedMemory.buildSystemPromptCached mtime+size 短路）+ R5（summary 首轮/后续命中率拆分）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CuratedMemory } from '../src/memory/curated.js';
import { buildLLMStatsSummary } from '../src/agent/stats.js';
import type { LLMStats } from '../src/types.js';

describe('20261021-008 R2：CuratedMemory.buildSystemPromptCached', () => {
  let dir: string;
  let curated: CuratedMemory;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'curated-cache-'));
    curated = new CuratedMemory(dir, null, null);
    await curated.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('内容未变时（mtime+size 短路）重复调用返回一致结果', async () => {
    await writeFile(join(dir, 'MEMORY.md'), '# MEMORY - 精炼事实\n\n- 条目1\n', 'utf-8');
    const first = await curated.buildSystemPromptCached();
    const second = await curated.buildSystemPromptCached();
    expect(second).toBe(first);
    expect(first).toContain('条目1');
    expect(first).toContain('# MEMORY');
  });

  it('文件变化后重读重算（mtime 更新触发）', async () => {
    await writeFile(join(dir, 'MEMORY.md'), '# MEMORY - 精炼事实\n\n- 旧条目\n', 'utf-8');
    const before = await curated.buildSystemPromptCached();
    expect(before).toContain('旧条目');

    // 显式更新 mtime（内容变化伴随 mtime 变化；utimes 保证跨平台确定性）
    await writeFile(join(dir, 'MEMORY.md'), '# MEMORY - 精炼事实\n\n- 新条目\n', 'utf-8');
    const future = Date.now() / 1000 + 10;
    await utimes(join(dir, 'MEMORY.md'), future, future);
    const after = await curated.buildSystemPromptCached();
    expect(after).toContain('新条目');
    expect(after).not.toContain('旧条目');
    expect(after).not.toBe(before);
  });

  it('文件被删除后不再出现在拼接结果中', async () => {
    await writeFile(join(dir, 'MEMORY.md'), '# MEMORY - 精炼事实\n\n- 条目\n', 'utf-8');
    const before = await curated.buildSystemPromptCached();
    expect(before).toContain('条目');
    await rm(join(dir, 'MEMORY.md'));
    const after = await curated.buildSystemPromptCached();
    expect(after).not.toContain('条目');
  });

  it('空文件不产生 section（与 buildSystemPrompt 语义一致）', async () => {
    await writeFile(join(dir, 'MEMORY.md'), '   \n  \n', 'utf-8');
    const out = await curated.buildSystemPromptCached();
    expect(out).not.toContain('MEMORY');
  });

  it('缓存版与原版 buildSystemPrompt 产物一致', async () => {
    await writeFile(join(dir, 'MEMORY.md'), '# MEMORY - 精炼事实\n\n- 一致性条目\n', 'utf-8');
    await writeFile(join(dir, 'SOUL.md'), '# SOUL - Agent 人格\n\n核心身份内容\n', 'utf-8');
    const plain = await curated.buildSystemPrompt();
    const cached = await curated.buildSystemPromptCached();
    expect(cached).toBe(plain);
  });
});

/** 构造一条 LLMStats（iteration 决定归属口径） */
function makeStats(iteration: number, promptTokens: number, cacheHitTokens?: number): LLMStats {
  return {
    iteration,
    maxIterations: 10,
    contextTokens: promptTokens,
    contextMaxTokens: 64000,
    contextThreshold: 48000,
    promptTokens,
    completionTokens: 100,
    totalTokens: promptTokens + 100,
    cacheHitTokens,
    cacheHitRate: cacheHitTokens !== undefined && promptTokens ? cacheHitTokens / promptTokens : undefined,
    elapsedMs: 1000,
  };
}

describe('20261021-008 R5：summary 首轮/后续命中率拆分', () => {
  it('首轮与后续口径按 token 加权拆分正确', () => {
    const summary = buildLLMStatsSummary([
      makeStats(0, 1000, 500), // 首轮 50%
      makeStats(1, 2000, 1800), // 后续 90%
      makeStats(2, 3000, 2700), // 后续 90%
    ]);
    expect(summary.firstIterationHitRate).toBeCloseTo(0.5);
    expect(summary.subsequentIterationsHitRate).toBeCloseTo(0.9);
    expect(summary.avgCacheHitRate).toBeCloseTo(5000 / 6000);
  });

  it('无缓存字段轮次不进入任何分母（N/A 不拉低均值）', () => {
    const summary = buildLLMStatsSummary([
      makeStats(0, 1000, 500),
      makeStats(1, 2000), // 无缓存字段
      makeStats(2, 3000, 3000),
    ]);
    expect(summary.firstIterationHitRate).toBeCloseTo(0.5);
    expect(summary.subsequentIterationsHitRate).toBeCloseTo(1.0);
  });

  it('只有首轮（单轮会话）时 subsequent 为 undefined', () => {
    const summary = buildLLMStatsSummary([makeStats(0, 1000, 400)]);
    expect(summary.firstIterationHitRate).toBeCloseTo(0.4);
    expect(summary.subsequentIterationsHitRate).toBeUndefined();
  });

  it('整体无缓存字段时全部为 undefined', () => {
    const summary = buildLLMStatsSummary([makeStats(0, 1000), makeStats(1, 2000)]);
    expect(summary.avgCacheHitRate).toBeUndefined();
    expect(summary.firstIterationHitRate).toBeUndefined();
    expect(summary.subsequentIterationsHitRate).toBeUndefined();
  });

  it('空列表返回 0 与 undefined', () => {
    const summary = buildLLMStatsSummary([]);
    expect(summary.iterations).toBe(0);
    expect(summary.firstIterationHitRate).toBeUndefined();
    expect(summary.subsequentIterationsHitRate).toBeUndefined();
  });
});
