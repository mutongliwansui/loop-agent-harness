/**
 * Phase 2 验收测试：L1 WorkingMemory（preCompactionFlush 智能压缩）
 *
 * 覆盖验收项：
 * - 2.1 Pre-compaction flush：压缩前 LLM 提取关键信息写入 L2
 * - 1.1 L1 token 估算
 * - 1.2 L1 压缩触发（80% 阈值）
 * - 1.3 L1 压缩保留最近 N 轮
 */

import { describe, it, expect } from 'vitest';
import { WorkingMemory } from '../src/memory/working.js';
import type { ChatMessage } from '../src/types.js';
import type { ILLMClient } from '../src/memory/types.js';

/** 构造一条消息 */
function msg(role: ChatMessage['role'], content: string): ChatMessage {
  if (role === 'tool') {
    return { role, tool_call_id: `call_${content.length}`, content };
  }
  return { role, content } as ChatMessage;
}

describe('L1 WorkingMemory', () => {
  it('2.1a token 估算：字符数/4 向上取整', () => {
    const wm = new WorkingMemory();
    const messages: ChatMessage[] = [
      msg('system', 'system-prompt'), // 13 字符 → ceil(13/4) = 4
      msg('user', '你好'), // 2 字符 → ceil(2/4) = 1
      msg('assistant', 'abcd'), // 4 字符 → ceil(4/4) = 1
    ];
    expect(wm.estimateTokens(messages)).toBe(6);
  });

  it('1.2 压缩触发：达到 maxTokens * threshold 时触发', () => {
    // 构造小阈值配置，便于触发
    const wm = new WorkingMemory({ maxTokens: 40, compactionThreshold: 0.5, keepRecentTurns: 3 });
    // 40 * 0.5 = 20 token 触发
    const messages: ChatMessage[] = [
      msg('system', 'x'.repeat(80)), // 20 token → 恰好达到阈值（>=）
      msg('user', 'y'),
    ];
    expect(wm.estimateTokens(messages)).toBe(21);
    expect(wm.needsCompaction(messages)).toBe(true);
  });

  it('1.2b 未达阈值不触发', () => {
    const wm = new WorkingMemory({ maxTokens: 100, compactionThreshold: 0.8, keepRecentTurns: 3 });
    const messages: ChatMessage[] = [msg('user', 'short')]; // 6/4=1.5→2 token
    expect(wm.needsCompaction(messages)).toBe(false);
  });

  it('1.3 压缩保留最近 N 轮对话', () => {
    const wm = new WorkingMemory({ maxTokens: 10000, compactionThreshold: 0.8, keepRecentTurns: 2 });
    const messages: ChatMessage[] = [
      msg('system', 'sys'),
      msg('user', '问题1'),
      msg('assistant', '回答1'),
      msg('user', '问题2'),
      msg('assistant', '回答2'),
      msg('user', '问题3'),
      msg('assistant', '回答3'),
    ];
    const compacted = wm.compact(messages);

    // system 保留
    expect(compacted[0]).toEqual(msg('system', 'sys'));
    // 只保留最近 2 轮（问题2/回答2/问题3/回答3）
    const contents = compacted.map((m) => (m as { content?: string }).content);
    expect(contents).toEqual(['sys', '问题2', '回答2', '问题3', '回答3']);
  });

  it('2.1b preCompactionFlush：调用 LLM 提取关键信息', async () => {
    const wm = new WorkingMemory();
    let calledWith = '';
    const fakeLLM: ILLMClient = {
      async chat(messages: ChatMessage[]) {
        calledWith = messages[messages.length - 1].content as string;
        return { content: '- 用户偏好：华锐\n- 报价：12.5 元/股' };
      },
    };

    const history: ChatMessage[] = [
      msg('user', '帮我查华锐报价'),
      msg('assistant', '好的，正在查询'),
    ];
    const extracted = await wm.preCompactionFlush(history, fakeLLM);

    // 提取出结构化笔记
    expect(extracted).toContain('华锐');
    expect(extracted).toContain('12.5');
    // 最后一条消息传入 LLM
    expect(calledWith).toBe('好的，正在查询');
  });

  it('2.1c preCompactionFlush 失败时返回空串（不阻塞主流程）', async () => {
    const wm = new WorkingMemory();
    const failingLLM: ILLMClient = {
      async chat() {
        throw new Error('LLM 不可用');
      },
    };
    const extracted = await wm.preCompactionFlush([msg('user', 'hi')], failingLLM);
    expect(extracted).toBe('');
  });
});
