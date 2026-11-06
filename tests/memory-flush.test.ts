/**
 * Phase 2.4 压缩质量验证：pre-compaction flush → L2 写入 → 压缩 → 关键信息可检索
 *
 * 覆盖验收项：
 * - 2.1 Pre-compaction flush：压缩前 LLM 提取关键信息写入 L2
 * - 2.2 压缩信息保留：压缩后关键信息以 is_show=false 摘要占位保留在上下文（L2 原文不再参与检索，避免双通道重复注入）
 * - 2.5 压缩后对话延续：压缩后 Agent 能正常继续对话
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WorkingMemory, isSummaryPlaceholder } from '../src/memory/working.js';
import { EpisodicMemory } from '../src/memory/episodic.js';
import { ToolMemoryCallback } from '../src/memory/callback.js';
import type { ChatMessage } from '../src/types.js';
import type { ILLMClient } from '../src/memory/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const MEMORY_DIR = join(tmpdir(), 'loop-agent-tests', 'test-memory-flush');

/** 模拟 LLM：从对话中提取关键事实 */
const flushLLM: ILLMClient = {
  async chat() {
    return { content: '- 用户是采购负责人\n- 华锐报价 12.5 元/股\n- 关注性价比优先' };
  },
};

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  if (role === 'tool') {
    return { role, tool_call_id: `call_${content.length}`, content };
  }
  return { role, content } as ChatMessage;
}

describe('Phase 2.4 压缩质量验证', () => {
  let episodic: EpisodicMemory;

  beforeAll(async () => {
    rmSync(MEMORY_DIR, { recursive: true, force: true });
    mkdirSync(MEMORY_DIR, { recursive: true });
    episodic = new EpisodicMemory(MEMORY_DIR);
    await episodic.init();
  });

  afterAll(async () => {
    episodic.closeIndex();
    rmSync(MEMORY_DIR, { recursive: true, force: true });
  });

  it('2.1+2.2 flush 提取关键信息，压缩后以摘要占位保留在上下文中', async () => {
    const wm = new WorkingMemory({
      // 小阈值便于触发：maxTokens=500, 阈值 80% → 400 token 触发
      maxTokens: 500,
      compactionThreshold: 0.8,
      keepRecentTurns: 2,
    });

    // 构造长对话（超过阈值）
    const history: ChatMessage[] = [msg('system', 'sys')];
    for (let i = 0; i < 20; i++) {
      history.push(msg('user', `第 ${i} 轮：请分析华锐的报价情况 ${'x'.repeat(50)}`));
      history.push(msg('assistant', `第 ${i} 轮回答：报价分析中 ${'y'.repeat(50)}`));
    }

    // 超阈值，触发 flush
    expect(wm.needsCompaction(history)).toBe(true);

    // 1. pre-compaction flush：LLM 提取关键信息
    const extracted = await wm.preCompactionFlush(history, flushLLM);
    expect(extracted.length).toBeGreaterThan(0);

    // 2. 写入 L2（模拟 ReActAgent 行为：scope=session, tag=compaction）
    await episodic.appendToday(extracted, {
      sessionId: 'sess_flush',
      scope: 'session',
      tag: 'compaction',
    });

    // 3. 压缩：只保留最近 2 轮，并把同一份笔记作为摘要占位（is_show=false）注入视图
    const compacted = wm.compact(history, extracted);
    expect(compacted.length).toBeLessThan(history.length);
    expect(compacted.length).toBeLessThanOrEqual(6); // system + 占位 + 2 轮*2
    expect(compacted[0]).toEqual(msg('system', 'sys'));
    // 占位紧随 system：LLM 可见，落盘时转写为总结消息
    expect(isSummaryPlaceholder(compacted[1])).toBe(true);
    expect(compacted[1].content).toContain('华锐报价');

    // 4. 笔记已落盘 L2（读回原文可见），但不再参与语义检索
    //    （防护 B：同一份内容已由 L1 占位注入，检索召回会造成双通道重复注入）
    const day = new Date().toISOString().split('T')[0];
    expect(await episodic.readDay(day)).toContain('华锐报价');
    const results = await episodic.search('华锐报价', 5, { sessionId: 'sess_flush' });
    expect(results.length).toBe(0);
  });

  it('2.2b 压缩笔记不再被其他会话召回（scope: session + 检索侧过滤 compaction）', async () => {
    const results = await episodic.search('华锐报价', 5, { sessionId: 'sess_other' });
    expect(results.length).toBe(0);
  });

  it('2.5 压缩后对话可延续（保留最近轮次 + system）', async () => {
    const wm = new WorkingMemory({
      maxTokens: 8000,
      compactionThreshold: 0.8,
      keepRecentTurns: 3,
    });

    const history: ChatMessage[] = [
      msg('system', '你是一个助手'),
      msg('user', '问题1'),
      msg('assistant', '回答1'),
      msg('tool', 'tool_result_1'),
      msg('user', '问题2'),
      msg('assistant', '回答2'),
      msg('tool', 'tool_result_2'),
      msg('user', '问题3'),
      msg('assistant', '回答3'),
      msg('user', '问题4'),
      msg('assistant', '回答4'),
    ];

    const compacted = wm.compact(history);

    // system 保留
    expect(compacted[0]).toEqual(msg('system', '你是一个助手'));

    // 最后一轮对话完整保留（可延续）
    const contents = compacted.map((m) => (m as { content?: string }).content);
    expect(contents[contents.length - 1]).toBe('回答4');
    expect(contents).toContain('问题4');

    // 压缩后上下文远小于原历史
    expect(compacted.length).toBeLessThan(history.length);

    // 压缩后不再触发压缩（可正常继续对话）
    expect(wm.needsCompaction(compacted)).toBe(false);
  });

  it('2.3 工具结果自动记录到 L2（与 flush 内容共存）', async () => {
    const callback = new ToolMemoryCallback(episodic);
    await callback.log('commandRun', { cmd: 'quote' }, '华锐报价 12.5 元/股', 'sess_flush');

    const day = new Date().toISOString().split('T')[0];
    const content = await episodic.readDay(day);
    expect(content).toContain('[tool:commandRun]');
    expect(content).toContain('华锐报价');
  });
});
