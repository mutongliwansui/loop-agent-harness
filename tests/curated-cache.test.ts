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

describe('20261110-002 层2B：clipForSystem 软上限截断', () => {
  let curated: CuratedMemory;

  beforeEach(() => {
    // clipForSystem 是纯函数，不依赖文件系统，随便传个路径就行
    curated = new CuratedMemory('.', null, null);
  });

  it('短于 SYSTEM_MAX_CHARS 的内容原样返回', () => {
    const short = '# MEMORY - 精炼事实\n\n- 条目A\n- 条目B\n';
    const result = curated.clipForSystem(short.trim(), 'memory');
    expect(result).toBe(short.trim());
    expect(result).not.toContain('因 token 预算已省略');
  });

  it('超过上限时保留末尾条目、加 TRUNCATION_NOTE', () => {
    // 构造一条超长 MEMORY.md（> 3000 字符）
    const lines: string[] = ['# MEMORY - 精炼事实', ''];
    for (let i = 1; i <= 80; i++) {
      lines.push(`- 条目 ${i}：这是一条用于测试截断逻辑的示例事实，字符数大概控制在 60 个左右`);
    }
    const long = lines.join('\n');
    expect(long.length).toBeGreaterThan(3000);

    const clipped = curated.clipForSystem(long, 'memory');
    expect(clipped).toContain('因 token 预算已省略');
    expect(clipped.length).toBeLessThanOrEqual(3000 + 80); // 略宽限
    // 最新条目保留
    expect(clipped).toContain('条目 80');
    expect(clipped).toContain('条目 79');
    // 较早条目被裁
    expect(clipped).not.toContain('条目 1：');
  });

  it('截断点对齐到 "- " 边界，不会把一条事实切在中间', () => {
    const lines: string[] = ['# MEMORY', ''];
    for (let i = 1; i <= 100; i++) {
      lines.push(`- 事实 ${i}：内容填充填充填充填充填充填充填充填充填充填充填充`);
    }
    const long = lines.join('\n');
    const clipped = curated.clipForSystem(long, 'memory');

    // TRUNCATION_NOTE = "\n…（较早内容因 token 预算已省略，以上为最新条目）"
    // 所以完整 marker 之后应该紧跟 "- "
    const fullNote = '以上为最新条目）\n';
    const tailIdx = clipped.lastIndexOf(fullNote);
    expect(tailIdx).toBeGreaterThan(-1);
    const afterNote = clipped.slice(tailIdx + fullNote.length);
    // 必须以 "- " 开头，说明截断对齐到了条目边界
    expect(afterNote.startsWith('- ')).toBe(true);
  });

  it('多次调用相同输入返回相同输出（纯函数、保护前缀缓存）', () => {
    const lines: string[] = ['# USER', ''];
    for (let i = 1; i <= 30; i++) {
      lines.push(`- 用户偏好 ${i}：填充内容填充内容填充内容填充内容填充`);
    }
    const content = lines.join('\n');
    // user 上限 800，30 条 × 约 50 字 ≈ 1500 字，会触发截断
    expect(content.length).toBeGreaterThan(800);

    const a = curated.clipForSystem(content, 'user');
    const b = curated.clipForSystem(content, 'user');
    const c = curated.clipForSystem(content, 'user');
    expect(a).toBe(b);
    expect(b).toBe(c);
    // 关键：输出稳定 = 前缀缓存可复用
    expect(a.length).toBe(b.length);
  });

  it('不同 key 应用各自的上限（soul=300, user=800, memory=3000）', () => {
    // 用数组 join，构造多行列表（clipForSystem 依赖 "\n- " 边界截断）
    const makeLines = (title: string, count: number, filler: string) => {
      const arr = [`# ${title}`, ''];
      for (let i = 1; i <= count; i++) arr.push(`- ${filler} ${i}`);
      return arr.join('\n');
    };
    // soul 上限 300 → ~50 条足够
    const soulBig = makeLines('SOUL', 50, '人格特质填充填充填充填充');
    // user 上限 800 → ~80 条
    const userBig = makeLines('USER', 80, '用户偏好填充填充填充填充填充填充填充');
    // memory 上限 3000 → ~200 条
    const memBig = makeLines('MEMORY', 200, '记忆事实填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充');

    expect(soulBig.length).toBeGreaterThan(300);
    expect(userBig.length).toBeGreaterThan(800);
    expect(memBig.length).toBeGreaterThan(3000);

    const outS = curated.clipForSystem(soulBig, 'soul');
    const outU = curated.clipForSystem(userBig, 'user');
    const outM = curated.clipForSystem(memBig, 'memory');

    expect(outS.length).toBeLessThanOrEqual(300 + 80);
    expect(outU.length).toBeLessThanOrEqual(800 + 80);
    expect(outM.length).toBeLessThanOrEqual(3000 + 80);

    // 三者都含截断标记
    expect(outS).toContain('因 token 预算已省略');
    expect(outU).toContain('因 token 预算已省略');
    expect(outM).toContain('因 token 预算已省略');
  });
});

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
