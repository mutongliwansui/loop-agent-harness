/**
 * Task-16 验收测试：Dreaming 按天分批 + 增量处理
 *
 * 覆盖验收项：
 * - 9.1 按天分批：单次输入仅含单天内容
 * - 9.2/9.3 增量生效：只处理上次之后新增的天
 * - 9.5 开关可控：batchByDay=false / incremental=false 行为兼容
 * - 失败不丢数据：单天失败 → errors 记录、状态不推进
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EpisodicMemory } from '../src/memory/episodic.js';
import { CuratedMemory } from '../src/memory/curated.js';
import { PromotionGate } from '../src/memory/gate.js';
import { DreamingPipeline } from '../src/memory/dreaming.js';
import type { ChatMessage } from '../src/types.js';
import type { ILLMClient } from '../src/memory/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const MEMORY_DIR = join(tmpdir(), 'loop-agent-tests', 'test-dreaming-batch');
const EPISODIC_DIR = join(MEMORY_DIR, 'episodic');
const CURATED_DIR = join(MEMORY_DIR, 'curated');

/** 状态文件路径 */
const STATE_FILE = join(EPISODIC_DIR, '.dreaming-state.json');

/** 生成指定偏移天的 ISO 日期（offset=0 今天，1 昨天…） */
function dayOffset(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toISOString().split('T')[0];
}

/** 记录每次 LLM 调用输入的 mock（candidates 可为函数，按输入内容返回不同候选） */
function makeRecordingLLM(
  candidates: unknown[] | ((content: string) => unknown[]),
  onCall?: (content: string) => void,
  failOn?: (content: string) => boolean,
): { llm: ILLMClient; calls: string[] } {
  const calls: string[] = [];
  const llm: ILLMClient = {
    async chat(messages: ChatMessage[]) {
      const content = messages.map((m) => m.content ?? '').join('\n');
      calls.push(content);
      if (failOn?.(content)) throw new Error('mock LLM failure');
      const result = typeof candidates === 'function' ? candidates(content) : candidates;
      return { content: JSON.stringify(result) };
    },
  };
  return { llm, calls };
}

const FACT = (day: string, n: number) => ({
  fact: `${day} 测试事实 ${n}`,
  confidence: 10,
  category: 'fact',
  targetFile: 'MEMORY.md',
});

describe('DreamingPipeline Task-16（按天分批 + 增量）', () => {
  let episodic: EpisodicMemory;
  let curated: CuratedMemory;
  let gate: PromotionGate;

  beforeAll(async () => {
    rmSync(MEMORY_DIR, { recursive: true, force: true });
    mkdirSync(MEMORY_DIR, { recursive: true });
    episodic = new EpisodicMemory(EPISODIC_DIR);
    await episodic.init();
    curated = new CuratedMemory(CURATED_DIR);
    await curated.init();
    gate = new PromotionGate();
  });

  afterAll(async () => {
    episodic.closeIndex();
    rmSync(MEMORY_DIR, { recursive: true, force: true });
  });

  /** 写入指定天的 L2 记录 */
  async function seedDay(offset: number, content: string): Promise<string> {
    const day = dayOffset(offset);
    await episodic.append(day, content, { sessionId: 'sess_t16', scope: 'session', tag: 'tool' });
    return day;
  }

  it('1. 按天分批：单次输入仅含单天内容，调用次数=目标天数', async () => {
    rmSync(STATE_FILE, { force: true });
    const today = await seedDay(0, '[tool:cmd] 处理今日数据');
    const yesterday = await seedDay(1, '[tool:cmd] 处理昨日数据');
    const { llm, calls } = makeRecordingLLM([FACT(today, 1)]);

    const pipeline = new DreamingPipeline(episodic, gate, curated, llm);
    // dedupeEnabled:false → 归并阶段不调 LLM，calls 只统计提取调用
    await pipeline.run(2, undefined, { batchByDay: true, incremental: false, dedupeEnabled: false });

    expect(calls.length).toBe(2);
    // 每次输入含对应日期标题，且不含另一天的内容
    expect(calls[0]).toContain(`---对话记录（${today}）---`);
    expect(calls[1]).toContain(`---对话记录（${yesterday}）---`);
    expect(calls[0]).not.toContain('处理昨日数据');
    expect(calls[1]).not.toContain('处理今日数据');
  });

  it('2. 增量过滤：跳过已处理天和当天，只处理新增的昨日记录', async () => {
    await seedDay(0, '[tool:cmd] 今天新记录');
    await seedDay(1, '[tool:cmd] 昨天新记录');
    await seedDay(2, '[tool:cmd] 前天旧记录');
    // 状态：已处理到前天 → 应只处理昨天（今天内容留到明天整理）
    writeFileSync(STATE_FILE, JSON.stringify({ lastProcessedDay: dayOffset(2) }), 'utf-8');

    const { llm, calls } = makeRecordingLLM([FACT(dayOffset(1), 2)]);
    const pipeline = new DreamingPipeline(episodic, gate, curated, llm);
    await pipeline.run(3, undefined, { batchByDay: true, incremental: true, dedupeEnabled: false });

    expect(calls.length).toBe(1);
    expect(calls[0]).toContain(`---对话记录（${dayOffset(1)}）---`);
    expect(calls[0]).not.toContain('今天新记录');
    expect(calls[0]).not.toContain('前天旧记录');
  });

  it('3. 状态更新：处理完成后 lastProcessedDay = 窗口内最新非当天日期', async () => {
    rmSync(STATE_FILE, { force: true });
    await seedDay(1, '[tool:cmd] 记录A');
    const { llm } = makeRecordingLLM([FACT(dayOffset(1), 3)]);
    const pipeline = new DreamingPipeline(episodic, gate, curated, llm);
    await pipeline.run(2, undefined, { batchByDay: true, incremental: true, dedupeEnabled: false });

    const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    // 当天不处理（留到明天），状态推进到已处理的最晚非当天日期
    expect(state.lastProcessedDay).toBe(dayOffset(1));
  });

  it('4. 单天失败：进 errors、其他天正常、状态不推进', async () => {
    // 清空状态（模拟无状态）
    rmSync(STATE_FILE, { force: true });
    await seedDay(1, '[tool:cmd] 昨天失败场景');
    await seedDay(2, '[tool:cmd] 前天正常场景');

    const { llm } = makeRecordingLLM([FACT(dayOffset(2), 4)], undefined, (c) =>
      c.includes(`---对话记录（${dayOffset(1)}）---`),
    );
    const pipeline = new DreamingPipeline(episodic, gate, curated, llm);
    const result = await pipeline.run(3, undefined, { batchByDay: true, incremental: true });

    // 昨天失败 → errors 记录；前天正常 → 有候选
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain(dayOffset(1));
    // 状态未推进（任一天失败保留旧状态）
    expect(existsSync(STATE_FILE)).toBe(false);
  });

  it('5. 无新增天：不调用 LLM，返回空 promoted', async () => {
    await seedDay(0, '[tool:cmd] 已整理过的记录');
    writeFileSync(STATE_FILE, JSON.stringify({ lastProcessedDay: dayOffset(0) }), 'utf-8');

    const { llm, calls } = makeRecordingLLM([FACT(dayOffset(0), 5)]);
    const pipeline = new DreamingPipeline(episodic, gate, curated, llm);
    const result = await pipeline.run(3, undefined, { batchByDay: true, incremental: true });

    expect(calls.length).toBe(0);
    expect(result.promoted.length).toBe(0);
  });

  it('6a. batchByDay=false：合并全部天一次调用', async () => {
    await seedDay(0, '[tool:cmd] 合并场景A');
    await seedDay(1, '[tool:cmd] 合并场景B');
    const { llm, calls } = makeRecordingLLM([FACT(dayOffset(0), 6)]);
    const pipeline = new DreamingPipeline(episodic, gate, curated, llm);
    await pipeline.run(2, undefined, { batchByDay: false, incremental: false, dedupeEnabled: false });

    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('合并场景A');
    expect(calls[0]).toContain('合并场景B');
  });

  it('6b. incremental=false：忽略状态文件，全量处理', async () => {
    await seedDay(0, '[tool:cmd] 忽略状态A');
    await seedDay(1, '[tool:cmd] 忽略状态B');
    writeFileSync(STATE_FILE, JSON.stringify({ lastProcessedDay: dayOffset(0) }), 'utf-8');

    const { llm, calls } = makeRecordingLLM([FACT(dayOffset(0), 7)]);
    const pipeline = new DreamingPipeline(episodic, gate, curated, llm);
    await pipeline.run(2, undefined, { batchByDay: true, incremental: false, dedupeEnabled: false });

    expect(calls.length).toBe(2);
  });

  it('7. 状态文件损坏：loadState 返回默认值，不崩溃', async () => {
    await seedDay(0, '[tool:cmd] 损坏状态场景');
    writeFileSync(STATE_FILE, '{invalid json', 'utf-8');
    const { llm, calls } = makeRecordingLLM([FACT(dayOffset(0), 8)]);
    const pipeline = new DreamingPipeline(episodic, gate, curated, llm);
    const result = await pipeline.run(2, undefined, { batchByDay: true, incremental: true, dedupeEnabled: false });

    // 损坏状态被忽略，正常全量处理（不抛错）
    expect(result.errors.length).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('8. 候选汇总一致：分批提取的候选正确合并', async () => {
    await seedDay(0, '[tool:cmd] 汇总A');
    await seedDay(1, '[tool:cmd] 汇总B');
    // 按输入内容返回不同候选（当天/昨天各一条）
    const { llm } = makeRecordingLLM((content) => {
      const day = content.includes('汇总A') ? dayOffset(0) : dayOffset(1);
      return [FACT(day, 9)];
    });
    const pipeline = new DreamingPipeline(episodic, gate, curated, llm);
    const result = await pipeline.run(2, undefined, { batchByDay: true, incremental: false, dedupeEnabled: false });

    // 两天各返回 1 条候选，high confidence 全部晋升
    expect(result.promoted.length).toBe(2);
    expect(result.promoted[0].fact).toContain('测试事实 9');
  });
});
