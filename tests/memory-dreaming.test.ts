/**
 * Phase 3 验收测试：DreamingPipeline（后台晋升流水线）
 *
 * 覆盖验收项：
 * - 3.4 Dreaming 巡检：能从 L2 提取候选事实
 * - 3.5 晋升写入 L3：确认事实写入 USER.md / MEMORY.md
 * - 3.2/3.3 经过 Gate 过滤：高可信度晋升、低可信度待确认
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
import { mkdirSync, rmSync } from 'node:fs';

const MEMORY_DIR = join(tmpdir(), 'loop-agent-tests', 'test-memory-dreaming');
const CURATED_DIR = join(MEMORY_DIR, 'curated');

/** 模拟 LLM：返回结构化 JSON 候选事实 */
function makeFakeLLM(candidates: string): ILLMClient {
  return {
    async chat(messages: ChatMessage[]) {
      void messages;
      return { content: candidates };
    },
  };
}

describe('DreamingPipeline', () => {
  let episodic: EpisodicMemory;
  let curated: CuratedMemory;
  let gate: PromotionGate;

  beforeAll(async () => {
    rmSync(MEMORY_DIR, { recursive: true, force: true });
    mkdirSync(MEMORY_DIR, { recursive: true });

    episodic = new EpisodicMemory(join(MEMORY_DIR, 'episodic'));
    await episodic.init();
    curated = new CuratedMemory(CURATED_DIR);
    await curated.init();
    gate = new PromotionGate();
  });

  afterAll(async () => {
    episodic.closeIndex();
    rmSync(MEMORY_DIR, { recursive: true, force: true });
  });

  it('3.4 Dreaming 巡检：从 L2 Daily Notes 提取候选事实', async () => {
    // 写入今天的 L2 日记
    const today = new Date().toISOString().split('T')[0];
    await episodic.append(today, '- [tool:fileRead] input={"path":"报价.txt"} → 华锐报价 12.5 元/股', {
      sessionId: 'sess_1',
      scope: 'session',
      tag: 'tool',
    });

    const fakeLLM = makeFakeLLM(
      JSON.stringify([
        { fact: '华锐报价为 12.5 元/股', confidence: 8, category: 'fact', targetFile: 'MEMORY.md' },
        { fact: '用户关注性价比', confidence: 6, category: 'preference', targetFile: 'USER.md' },
      ]),
    );

    const pipeline = new DreamingPipeline(episodic, gate, curated, fakeLLM);
    const result = await pipeline.run(1);

    // LLM 被调用，提取出候选事实
    expect(result.errors.length).toBe(0);
    // 高可信度（confidence 8 → owner_direct，阈值 1）晋升
    expect(result.promoted.length).toBe(1);
    // 中可信度（confidence 6 → owner_derived，阈值 2）待确认
    expect(result.skipped.length).toBe(1);
  });

  it('3.5 晋升写入 L3：事实写入 MEMORY.md / USER.md', async () => {
    // 检查上次晋升结果
    const memoryContent = await curated.read('memory');
    expect(memoryContent).toContain('华锐报价为 12.5 元/股');

    // USER.md 的内容（被 skipped，尚未写入）
    const userContent = await curated.read('user');
    expect(userContent).not.toContain('用户关注性价比');
  });

  it('3.2 多次巡检后低可信度事实晋升到 USER.md', async () => {
    // 同一事实第二次出现（owner_derived 阈值 2）
    const fakeLLM = makeFakeLLM(
      JSON.stringify([
        { fact: '用户关注性价比', confidence: 6, category: 'preference', targetFile: 'USER.md' },
      ]),
    );
    const pipeline = new DreamingPipeline(episodic, gate, curated, fakeLLM);
    const result = await pipeline.run(1);

    // 第二次出现：达阈值晋升
    expect(result.promoted.length).toBe(1);
    const userContent = await curated.read('user');
    expect(userContent).toContain('用户关注性价比');
  });

  it('3.4b LLM 返回无内容时不晋升', async () => {
    const emptyLLM: ILLMClient = {
      async chat() {
        return { content: '' };
      },
    };
    const pipeline = new DreamingPipeline(episodic, gate, curated, emptyLLM);
    const result = await pipeline.run(1);
    expect(result.promoted.length).toBe(0);
    expect(result.skipped.length).toBe(0);
  });

  it('3.4c LLM 返回 markdown 代码块包裹的 JSON 可解析', async () => {
    const wrappedLLM = makeFakeLLM(
      '```json\n[{"fact": "项目使用 TypeScript", "confidence": 9, "category": "fact", "targetFile": "MEMORY.md"}]\n```',
    );
    const pipeline = new DreamingPipeline(episodic, gate, curated, wrappedLLM);
    const result = await pipeline.run(1);
    expect(result.promoted.length).toBe(1);
    expect(result.promoted[0].fact).toBe('项目使用 TypeScript');
  });

  it('3.4d LLM 调用失败时返回 errors 且不抛异常', async () => {
    const failingLLM: ILLMClient = {
      async chat() {
        throw new Error('LLM 不可用');
      },
    };
    const pipeline = new DreamingPipeline(episodic, gate, curated, failingLLM);
    const result = await pipeline.run(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('LLM 不可用');
  });

  it('3.1c Gate 状态在 Dreaming 后持久化到 .memory-gate.json', async () => {
    // 检查 .memory-gate.json 已生成
    const { readFile, access } = await import('node:fs/promises');
    const statePath = join(CURATED_DIR, '.memory-gate.json');
    await expect(access(statePath)).resolves.toBeUndefined();
    const content = await readFile(statePath, 'utf-8');
    // JSON 数组形式（Map entries）
    expect(JSON.parse(content)).toBeInstanceOf(Array);
  });
});
