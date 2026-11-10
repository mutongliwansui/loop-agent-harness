﻿/**
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
import { DreamingPipeline, normalizeCandidates } from '../src/memory/dreaming.js';
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
    const result = await pipeline.run(1, undefined, { incremental: false });

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
    const result = await pipeline.run(1, undefined, { incremental: false });

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
    const result = await pipeline.run(1, undefined, { incremental: false });
    expect(result.promoted.length).toBe(0);
    expect(result.skipped.length).toBe(0);
  });

  it('3.4c LLM 返回 markdown 代码块包裹的 JSON 可解析', async () => {
    const wrappedLLM = makeFakeLLM(
      '```json\n[{"fact": "项目使用 TypeScript", "confidence": 9, "category": "fact", "targetFile": "MEMORY.md"}]\n```',
    );
    const pipeline = new DreamingPipeline(episodic, gate, curated, wrappedLLM);
    const result = await pipeline.run(1, undefined, { incremental: false });
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
    const result = await pipeline.run(1, undefined, { incremental: false });
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

/**
 * 需求 20261110-001：提取提示词重写后的入参形态与候选归一。
 * 目的：非法字段不再静默丢失、事实有粒度上限、source 决定晋升来源。
 */
describe('DreamingPipeline 提取改造（20261110-001）', () => {
  it('normalizeCandidates：非法 targetFile 不丢事实，按别名/category 归类并告警', () => {
    const { candidates, warnings } = normalizeCandidates([
      { fact: '用户偏好中文回答', confidence: 9, category: 'preference', targetFile: 'user.md' },
      { fact: '环境为 Windows 11', confidence: 8, category: 'fact', targetFile: '用户画像' },
      { fact: '构建用 pnpm', confidence: 7, category: 'fact', targetFile: '随便写的' },
    ]);
    expect(candidates.length).toBe(3);
    expect(candidates[0].targetFile).toBe('USER.md');
    expect(candidates[1].targetFile).toBe('USER.md');
    // 无法识别且 category 非 preference → MEMORY.md
    expect(candidates[2].targetFile).toBe('MEMORY.md');
    expect(warnings.some((w) => w.includes('随便写的'))).toBe(true);
  });

  it('normalizeCandidates：超长 fact 截断，缺 fact 丢弃并告警', () => {
    const long = '很'.repeat(100);
    const { candidates, warnings } = normalizeCandidates([
      { fact: long, confidence: 9, category: 'fact', targetFile: 'MEMORY.md' },
      { confidence: 9, category: 'fact', targetFile: 'MEMORY.md' },
    ]);
    expect(candidates.length).toBe(1);
    expect(candidates[0].fact.length).toBe(61); // 60 + 省略号
    expect(warnings.some((w) => w.includes('截断'))).toBe(true);
    expect(warnings.some((w) => w.includes('缺少 fact'))).toBe(true);
  });

  it('normalizeCandidates：非法 category 归为 fact，confidence 越界被夹紧', () => {
    const { candidates } = normalizeCandidates([
      { fact: '测试事实', confidence: 99, category: 'unknown', targetFile: 'MEMORY.md' },
      { fact: '测试事实2', confidence: -3, category: 'rule', targetFile: 'MEMORY.md' },
    ]);
    expect(candidates[0].category).toBe('fact');
    expect(candidates[0].confidence).toBe(10);
    expect(candidates[1].confidence).toBe(1);
  });

  it('source=user_stated 时首次出现即晋升（不再依赖自评 confidence）', async () => {
    const MEMORY_DIR = join(tmpdir(), 'loop-agent-tests', 'test-dreaming-source');
    rmSync(MEMORY_DIR, { recursive: true, force: true });
    mkdirSync(MEMORY_DIR, { recursive: true });
    try {
      const episodic = new EpisodicMemory(join(MEMORY_DIR, 'episodic'));
      await episodic.init();
      const curated = new CuratedMemory(join(MEMORY_DIR, 'curated'));
      await curated.init();
      const gate = new PromotionGate();
      const today = new Date().toISOString().split('T')[0];
      await episodic.append(today, '- 用户原话：以后都用中文回复我', {
        sessionId: 'sess_src',
        scope: 'session',
      });

      const llm: ILLMClient = {
        async chat() {
          // confidence 只有 5，但 source 表明是用户原话 → owner_direct
          return {
            content:
              '[{"fact":"回复语言：使用中文","confidence":5,"category":"preference","targetFile":"USER.md","source":"user_stated"}]',
          };
        },
      };
      const pipeline = new DreamingPipeline(episodic, gate, curated, llm);
      const result = await pipeline.run(1, undefined, { incremental: false });
      expect(result.promoted.length).toBe(1);
      expect(result.promoted[0].provenance).toBe('owner_direct');
      expect(await curated.read('user')).toContain('回复语言：使用中文');
      episodic.closeIndex();
    } finally {
      rmSync(MEMORY_DIR, { recursive: true, force: true });
    }
  });

  it('提取调用使用 system 角色，并注入已有 USER.md / MEMORY.md', async () => {
    const MEMORY_DIR = join(tmpdir(), 'loop-agent-tests', 'test-dreaming-prompt');
    rmSync(MEMORY_DIR, { recursive: true, force: true });
    mkdirSync(MEMORY_DIR, { recursive: true });
    try {
      const episodic = new EpisodicMemory(join(MEMORY_DIR, 'episodic'));
      await episodic.init();
      const curated = new CuratedMemory(join(MEMORY_DIR, 'curated'));
      await curated.init();
      await curated.append('memory', '已知：构建使用 vite');

      const seen: ChatMessage[][] = [];
      const llm: ILLMClient = {
        async chat(messages: ChatMessage[]) {
          seen.push(messages);
          return { content: '[]' };
        },
      };
      const today = new Date().toISOString().split('T')[0];
      await episodic.append(today, '- 普通对话内容', { sessionId: 'sess_prompt', scope: 'session' });

      const pipeline = new DreamingPipeline(episodic, new PromotionGate(), curated, llm);
      await pipeline.run(1, undefined, { incremental: false });

      expect(seen.length).toBe(1);
      const [systemMsg, userMsg] = seen[0];
      expect(systemMsg.role).toBe('system');
      expect(systemMsg.content).toContain('记忆提取器');
      expect(systemMsg.content).toContain('source');
      expect(userMsg.role).toBe('user');
      expect(userMsg.content).toContain('---已有记忆');
      expect(userMsg.content).toContain('## MEMORY.md');
      expect(userMsg.content).toContain('已知：构建使用 vite');
      episodic.closeIndex();
    } finally {
      rmSync(MEMORY_DIR, { recursive: true, force: true });
    }
  });
});
