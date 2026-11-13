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
import {
  WorkingMemory,
  buildCompactedView,
  isSummaryPlaceholder,
  SUMMARY_PLACEHOLDER_PREFIX,
} from '../src/memory/working.js';
import type { ChatMessage } from '../src/types.js';
import type { ILLMClient } from '../src/memory/types.js';

/** 构造一条消息 */
function msg(role: ChatMessage['role'], content: string): ChatMessage {
  if (role === 'tool') {
    return { role, tool_call_id: `call_${content.length}`, content };
  }
  return { role, content } as ChatMessage;
}

/** 4 次模型调用：keepRecentTurns=3 时第 1 次调用会被丢弃（flush 才有内容可总结） */
function historyWithDroppable(): ChatMessage[] {
  return [
    msg('user', 'q1'),
    msg('assistant', 'a1'),
    msg('user', 'q2'),
    msg('assistant', 'a2'),
    msg('user', 'q3'),
    msg('assistant', 'a3'),
    msg('user', 'q4'),
    msg('assistant', 'a4'),
  ];
}

/** 单轮内多轮工具迭代：按 user 切轮无法丢弃任何消息 */
function singleTurnHistory(): ChatMessage[] {
  const toolCall = (id: string): ChatMessage => ({
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name: 'readFile', arguments: '{}' } }],
  });
  return [
    msg('system', 'sys'),
    msg('user', '任务开始'),
    toolCall('c1'),
    { role: 'tool', tool_call_id: 'c1', content: 'r'.repeat(40) },
    toolCall('c2'),
    { role: 'tool', tool_call_id: 'c2', content: 'r'.repeat(40) },
    toolCall('c3'),
    { role: 'tool', tool_call_id: 'c3', content: 'r'.repeat(40) },
    msg('assistant', '完成'),
  ];
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

  it('2.1b preCompactionFlush：请求固定 2 条消息（system + 将被丢弃消息的 JSON）', async () => {
    const wm = new WorkingMemory({ maxTokens: 10000, compactionThreshold: 0.8, keepRecentTurns: 3 });
    let calledWith: ChatMessage[] = [];
    const fakeLLM: ILLMClient = {
      async chat(messages: ChatMessage[]) {
        calledWith = messages;
        return { content: '- 用户偏好：华锐\n- 报价：12.5 元/股' };
      },
    };

    const history = historyWithDroppable();
    const extracted = await wm.preCompactionFlush(history, fakeLLM);

    // 提取出结构化笔记
    expect(extracted).toContain('华锐');
    expect(extracted).toContain('12.5');
    // 固定 2 条：system 指令 + JSON 载荷
    expect(calledWith.length).toBe(2);
    expect(calledWith[0].role).toBe('system');
    expect(calledWith[0].content).toContain('压缩对话历史');
    // 只包含本次将被丢弃的第 1 轮
    const payload = JSON.parse(calledWith[1].content as string);
    expect(payload.messages).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  it('2.1c preCompactionFlush 失败时返回空串（不阻塞主流程）', async () => {
    const wm = new WorkingMemory({ maxTokens: 10000, compactionThreshold: 0.8, keepRecentTurns: 3 });
    const failingLLM: ILLMClient = {
      async chat() {
        throw new Error('LLM 不可用');
      },
    };
    const extracted = await wm.preCompactionFlush(historyWithDroppable(), failingLLM);
    expect(extracted).toBe('');
  });

  it('2.1d preCompactionFlush：adapter 提供 chatViaStream 时优先走流式', async () => {
    const wm = new WorkingMemory({ maxTokens: 10000, compactionThreshold: 0.8, keepRecentTurns: 3 });
    let chatCalled = false;
    let streamCalled = false;
    const fakeLLM: ILLMClient = {
      async chat() {
        chatCalled = true;
        return { content: 'should-not-be-used' };
      },
      async chatViaStream() {
        streamCalled = true;
        return { content: '- 流式提取结果' };
      },
    };
    const extracted = await wm.preCompactionFlush(historyWithDroppable(), fakeLLM);
    expect(streamCalled).toBe(true);
    expect(chatCalled).toBe(false);
    expect(extracted).toBe('- 流式提取结果');
  });

  it('2.1e 本次无可丢弃消息：planCompaction.droppedCount=0 且不调用 LLM', () => {
    const wm = new WorkingMemory();
    const history: ChatMessage[] = [msg('user', 'hi'), msg('assistant', 'hello')];
    const plan = wm.planCompaction(history);
    expect(plan.droppedCount).toBe(0);
    expect(plan.droppable).toEqual([]);
  });

  it('2.1e2 无消息可丢弃时 preCompactionFlush 直接返回空串（不调用 LLM）', async () => {
    const wm = new WorkingMemory();
    let called = false;
    const fakeLLM: ILLMClient = {
      async chat() {
        called = true;
        return { content: '不该被调用' };
      },
    };
    const extracted = await wm.preCompactionFlush([msg('user', 'hi')], fakeLLM);
    expect(extracted).toBe('');
    expect(called).toBe(false);
  });

  it('2.1f 单轮长任务：按模型调用保留，不再被 user 数量挡住压缩', () => {
    const wm = new WorkingMemory({ maxTokens: 1000, compactionThreshold: 0.8, keepRecentTurns: 3 });
    const history = singleTurnHistory();
    const nonSystemCount = history.length - 1;

    // 1 条 user 触发 4 次模型调用：保留最近 3 次
    // 需求 20261113-008（D2）：不再把当前轮 user pin 回保留区头部——kept 为纯后缀，
    // user 留在 droppable 里，其原文改由摘要占位携带（anchorUserText）。
    const plan = wm.planCompaction(history);
    expect(plan.droppedCount).toBeGreaterThan(0);
    expect(plan.withinTurnTrim).toBe(false);
    expect(plan.kept[0].role).toBe('assistant');
    expect(plan.droppable[0].content).toBe('任务开始');
    expect(plan.anchorUserText).toBe('任务开始');
    // 顺序保真：droppable 是纯前缀、kept 是纯后缀（磁盘顺序得以保持）
    const historyNonSystem = history.filter((m) => m.role !== 'system');
    expect(plan.droppable).toEqual(historyNonSystem.slice(0, plan.droppable.length));
    expect(plan.kept).toEqual(historyNonSystem.slice(plan.droppable.length));
    // 丢弃 + 保留 = 全部非 system 消息，二者不重不漏
    expect(plan.droppable.length + plan.kept.length).toBe(nonSystemCount);

    // 预算更小时继续少留一次调用，直到 1 次（仍不走单次内截尾）
    const tight = wm.planCompaction(history, { messageTokensBudget: 10 });
    expect(tight.withinTurnTrim).toBe(false);
    expect(tight.droppedCount).toBeGreaterThan(plan.droppedCount);
    expect(tight.droppable.length + tight.kept.length).toBe(nonSystemCount);

    // compact 直接采用 plan.kept，与 droppable 严格互补；当前轮原文进入摘要占位
    const compacted = wm.compact(history, '- 摘要', plan);
    expect(compacted[0]).toEqual(msg('system', 'sys'));
    expect(isSummaryPlaceholder(compacted[1])).toBe(true);
    expect(compacted[1].content).toContain('[当前问题] 任务开始');
    expect(compacted.slice(2)).toEqual(plan.kept);
  });

  it('2.1i 工具循环中压缩：原始 user 锚点不被摘要吞掉', () => {
    const wm = new WorkingMemory({ maxTokens: 1000, compactionThreshold: 0.8, keepRecentTurns: 2 });
    const toolCall = (id: string): ChatMessage => ({
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name: 'readFile', arguments: '{}' } }],
    });
    // 典型形态：user 在最前，之后是多轮工具调用，压缩发生在工具循环中（尾部是 tool）
    const history: ChatMessage[] = [
      msg('system', 'sys'),
      msg('user', '实现 A 功能，改 store.ts'),
      toolCall('c1'),
      { role: 'tool', tool_call_id: 'c1', content: 'r'.repeat(40) },
      toolCall('c2'),
      { role: 'tool', tool_call_id: 'c2', content: 'r'.repeat(40) },
      toolCall('c3'),
      { role: 'tool', tool_call_id: 'c3', content: 'r'.repeat(40) },
    ];

    const plan = wm.planCompaction(history, { messageTokensBudget: 10 });
    expect(plan.withinTurnTrim).toBe(false);
    // 需求 20261113-008（D2/D6）：user 不再被 pin 出 droppable，而是原位丢弃、
    // 原文交给摘要占位——「不丢」由占位承载，「顺序」由纯前缀/纯后缀保证。
    expect(plan.droppable[0].content).toBe('实现 A 功能，改 store.ts');
    expect(plan.kept[0].role).toBe('assistant');
    expect(plan.anchorUserText).toBe('实现 A 功能，改 store.ts');
    expect(plan.droppable.length + plan.kept.length).toBe(history.length - 1);
    // dropped 中出现的 user 只有这一条，不会被重复计入摘要两次
    expect(plan.droppable.filter((m) => m.role === 'user').length).toBe(1);

    const compacted = wm.compact(history, '- 摘要', plan);
    // 占位在 system 之后（index 1），kept 从 index 2 起
    expect(String(compacted[1].content)).toContain('[当前问题] 实现 A 功能，改 store.ts');
    expect(compacted[2].role).toBe('assistant');
    expect(compacted[2]).toEqual(plan.kept[0]);
    // 占位里原文段只出现一次（D5 幂等）
    expect(String(compacted[1].content).match(/\[当前问题\]/g)?.length).toBe(1);
  });

  it('2.1j 锚点过大时不再强制保留：原文进摘要，保留区不超预算', () => {
    const wm = new WorkingMemory({ maxTokens: 1000, compactionThreshold: 0.8, keepRecentTurns: 3 });
    const toolCall: ChatMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'readFile', arguments: '{}' } }],
    };
    const history: ChatMessage[] = [
      msg('system', 'sys'),
      msg('user', 'u'.repeat(400)), // 100 tokens，远超保留预算
      toolCall,
      { role: 'tool', tool_call_id: 'c1', content: 'r'.repeat(40) },
      toolCall,
      { role: 'tool', tool_call_id: 'c1', content: 'r'.repeat(40) },
    ];

    const plan = wm.planCompaction(history, { messageTokensBudget: 30 });
    expect(plan.withinTurnTrim).toBe(false);
    // 需求 20261113-008（D2）：不再「强制保留锚点」，user 原位丢弃、原文进摘要
    expect(plan.droppable[0].content).toBe('u'.repeat(400));
    expect(plan.anchorUserText).toBe('u'.repeat(400));
    expect(plan.kept.length).toBeGreaterThan(0);
    expect(plan.droppable.length + plan.kept.length).toBe(history.length - 1);
    // 保留区不再被超大锚点顶穿预算
    const keptTokens = plan.kept.reduce(
      (acc, m) => acc + Math.ceil((m.content ?? '').length / 4),
      0,
    );
    expect(keptTokens).toBeLessThanOrEqual(30);
    // 摘要占位仍能把原文带给模型
    const compacted = wm.compact(history, '- 摘要', plan);
    expect(String(compacted[1].content)).toContain('u'.repeat(400));
  });

  it('2.1k 截尾起点落在工具组内：整组丢弃，kept 不因回退 assistant 而超预算', () => {
    const wm = new WorkingMemory({ maxTokens: 1000, compactionThreshold: 0.8, keepRecentTurns: 3 });
    const toolCall = (id: string): ChatMessage => ({
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name: 'readFile', arguments: '{}' } }],
    });
    // 复刻线上日志形态：user 在头部，之后两组工具，第一组的结果很大
    const history: ChatMessage[] = [
      msg('system', 'sys'),
      msg('user', '帮我看下项目结构'),
      toolCall('c1'),
      { role: 'tool', tool_call_id: 'c1', content: 'r'.repeat(4248) }, // 1062 tokens
      { role: 'tool', tool_call_id: 'c1', content: 'r'.repeat(1674) }, // 419 tokens
      toolCall('c2'),
      { role: 'tool', tool_call_id: 'c2', content: 'r'.repeat(275) }, // 69 tokens
      { role: 'tool', tool_call_id: 'c2', content: 'r'.repeat(862) }, // 216 tokens
    ];

    const plan = wm.planCompaction(history, { messageTokensBudget: 1228 });
    expect(plan.withinTurnTrim).toBe(false);
    // 需求 20261113-008（D2）：当前轮 user 与其后的第一组工具一起进丢弃区（位置不动）
    expect(plan.droppable[0].content).toBe('帮我看下项目结构');
    expect(plan.anchorUserText).toBe('帮我看下项目结构');
    // 大工具组被整组丢弃（而不是整组回退），保留区只留最后一组
    expect(plan.droppable.length).toBe(4);
    expect(plan.kept.length).toBe(3);
    expect(plan.kept[0].role).toBe('assistant');
    // kept 控制在「保留预算」量级，不再出现 1766 tokens 压不下去的情况
    const keptTokens = plan.kept.reduce((acc, m) => acc + Math.ceil((m.content ?? '').length / 4), 0);
    expect(keptTokens).toBeLessThanOrEqual(Math.floor(1228 * 0.6));
    expect(plan.droppable.length + plan.kept.length).toBe(history.length - 1);
  });

  it('2.1l head 只剩 user 且其自身超预算：user 进摘要，原文不丢', () => {
    const wm = new WorkingMemory({ maxTokens: 1000, compactionThreshold: 0.8, keepRecentTurns: 3 });
    const history: ChatMessage[] = [
      msg('system', 'sys'),
      msg('user', 'q'),
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'readFile', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'r'.repeat(400) },
    ];

    const plan = wm.planCompaction(history, { messageTokensBudget: 40 });
    // 需求 20261113-008（D2/D6）：单次调用自身超预算时退回单次内截尾，
    // 截尾起点落在工具组内 → 整组保留，user 则进丢弃区；其原文由摘要占位承载。
    expect(plan.withinTurnTrim).toBe(true);
    expect(plan.droppable.map((m) => m.content)).toEqual(['q']);
    expect(plan.droppedCount).toBe(1);
    expect(plan.anchorUserText).toBe('q');
    expect(plan.kept[0].role).toBe('assistant');
    // 不切开 assistant(tool_calls) / tool 配对：kept 不以 tool 开头
    expect(plan.kept[0].role).not.toBe('tool');
  });

  it('2.1m 起点落在最后一组工具内：整组保留（保住最新 observation）', () => {
    const wm = new WorkingMemory({ maxTokens: 1000, compactionThreshold: 0.8, keepRecentTurns: 3 });
    const history: ChatMessage[] = [
      msg('system', 'sys'),
      msg('user', 'q'),
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'readFile', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'r'.repeat(400) },
      { role: 'tool', tool_call_id: 'c1', content: 'r'.repeat(40) },
    ];

    const plan = wm.planCompaction(history, { messageTokensBudget: 40 });
    // kept 不能以 tool 开头（不能切开 assistant(tool_calls) / tool 配对）
    // 需求 20261113-008（D2）：user 不再被 pin 到 kept 头部，整组保留从 assistant 起
    expect(plan.kept[0].role).toBe('assistant');
    expect(plan.kept.length).toBe(3);
    expect(plan.droppable.map((m) => m.content)).toEqual(['q']);
  });

  it('2.1g 单轮内未超预算：不截尾', () => {
    const wm = new WorkingMemory();
    const plan = wm.planCompaction(singleTurnHistory(), { messageTokensBudget: 1000 });
    expect(plan.droppedCount).toBe(0);
    expect(plan.withinTurnTrim).toBe(false);
  });

  it('2.1h 多轮历史按调用切分；仍超预算时继续减少保留次数（不走单次内截尾）', () => {
    const wm = new WorkingMemory({ maxTokens: 1000, compactionThreshold: 0.8, keepRecentTurns: 2 });
    const plan = wm.planCompaction(historyWithDroppable(), { messageTokensBudget: 3 });
    // 预算 3 tokens 只够最后 1 次调用（q4+a4）→ 丢弃 6 条，且不触发单次内截尾
    expect(plan.droppedCount).toBe(6);
    expect(plan.withinTurnTrim).toBe(false);
  });
});

describe('buildCompactedView 统一压缩视图', () => {
  const chain = (): ChatMessage[] => [
    msg('system', 'sys'),
    msg('user', 'u1'),
    msg('assistant', 'a1'),
    msg('user', 'u2'),
    msg('assistant', 'a2'),
    msg('user', 'u3'),
    msg('assistant', 'a3'),
  ];

  it('保留最近 N 轮，system 只保留一条', () => {
    const result = buildCompactedView(chain(), { keepRecentTurns: 2 });
    expect(result.map((m) => m.content)).toEqual(['sys', 'u2', 'a2', 'u3', 'a3']);
  });

  it('头部被裁且有摘要 → 注入摘要占位（is_show=false），位置在 system 之后', () => {
    const result = buildCompactedView(chain(), {
      keepRecentTurns: 2,
      summaryText: '- 已修复 store 合并写',
    });
    expect(result[1].role).toBe('user');
    expect(isSummaryPlaceholder(result[1])).toBe(true);
    expect(result[1].content).toBe(`${SUMMARY_PLACEHOLDER_PREFIX} - 已修复 store 合并写`);
  });

  it('占位内容按上限上浮 20% 截断（800 → 960 字符），避免长期占用 token', () => {
    // 需求 20261113-008（D1）：摘要目标上限 500 → 800，硬截断 = ceil(800 * 1.2) = 960
    const result = buildCompactedView(chain(), {
      keepRecentTurns: 1,
      summaryText: 'x'.repeat(1000),
    });
    expect(result[1].content).toBe(`${SUMMARY_PLACEHOLDER_PREFIX} ${'x'.repeat(960)}`);
  });

  it('无摘要不注入占位；全部轮次都在保留范围内也不注入', () => {
    // 有头部被裁，但没摘要 → 无占位
    const withoutSummary = buildCompactedView(chain(), { keepRecentTurns: 2 });
    expect(withoutSummary.some((m) => isSummaryPlaceholder(m))).toBe(false);

    // 没有头部被裁（保留 3 轮即全部）→ 即使给了摘要也不注入
    const noDrop = buildCompactedView(chain(), {
      keepRecentTurns: 3,
      summaryText: '不该出现',
    });
    expect(noDrop.some((m) => isSummaryPlaceholder(m))).toBe(false);
    expect(noDrop.length).toBe(7);
  });

  it('已含旧占位时再次压缩：旧占位被清除，不堆积', () => {
    const withOld: ChatMessage[] = [
      msg('system', 'sys'),
      { role: 'user', content: `${SUMMARY_PLACEHOLDER_PREFIX} 旧摘要`, is_show: false },
      ...chain().slice(1),
    ];
    const result = buildCompactedView(withOld, {
      keepRecentTurns: 2,
      summaryText: '新摘要',
    });
    const placeholders = result.filter((m) => isSummaryPlaceholder(m));
    expect(placeholders.length).toBe(1);
    expect(placeholders[0].content).toBe(`${SUMMARY_PLACEHOLDER_PREFIX} 新摘要`);
    // 切轮不受旧占位影响（旧占位不参与分轮）
    expect(result.map((m) => m.content)).toEqual([
      'sys',
      `${SUMMARY_PLACEHOLDER_PREFIX} 新摘要`,
      'u2',
      'a2',
      'u3',
      'a3',
    ]);
  });

  it('无 user 消息时循环自然结束：头部残片保留，不注入占位', () => {
    const messages: ChatMessage[] = [
      msg('system', 'sys'),
      msg('assistant', 'a1'),
      msg('tool', 'tool-result'),
    ];
    const result = buildCompactedView(messages, {
      keepRecentTurns: 3,
      summaryText: '不该出现',
    });
    expect(result.length).toBe(3);
    expect(result.some((m) => isSummaryPlaceholder(m))).toBe(false);
  });

  it('消息里无 system 时用 systemPrompt 兜底', () => {
    const result = buildCompactedView([msg('user', 'u1'), msg('assistant', 'a1')], {
      keepRecentTurns: 1,
      systemPrompt: '兜底提示',
    });
    expect(result[0]).toEqual({ role: 'system', content: '兜底提示' });
  });

  it('compact() 与 buildCompactedView 行为一致（同一生成器）', () => {
    const wm = new WorkingMemory({ maxTokens: 10000, compactionThreshold: 0.8, keepRecentTurns: 2 });
    const summary = '- 关键决策：统一压缩视图';
    const viaCompact = wm.compact(chain(), summary);
    const viaGenerator = buildCompactedView(chain(), {
      keepRecentTurns: wm.getConfig().keepRecentTurns,
      summaryText: summary,
    });
    expect(viaCompact).toEqual(viaGenerator);
  });
});

describe('keepRecentTurns = 最近 N 次模型调用', () => {
  const toolCall = (id: string): ChatMessage => ({
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name: 'readFile', arguments: '{}' } }],
  });

  it('一次调用 + 多条 tool 结果整组计数，保留区不从 tool 中间开始', () => {
    const wm = new WorkingMemory({ maxTokens: 10000, compactionThreshold: 0.8, keepRecentTurns: 2 });
    const history: ChatMessage[] = [
      msg('system', 'sys'),
      msg('user', 'q1'),
      toolCall('c1'),
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'tool', tool_call_id: 'c1', content: 'r2' },
      msg('assistant', 'done'),
      msg('user', 'q2'),
      msg('assistant', 'a2'),
    ];
    const plan = wm.planCompaction(history);
    // 3 次调用（toolCall / done / a2），保留最近 2 次
    expect(plan.kept.map((m) => m.content)).toEqual(['done', 'q2', 'a2']);
    expect(plan.droppable.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
  });

  it('调用次数未超过窗口：不产生任何丢弃', () => {
    const wm = new WorkingMemory({ maxTokens: 10000, compactionThreshold: 0.8, keepRecentTurns: 10 });
    const plan = wm.planCompaction(historyWithDroppable());
    expect(plan.droppedCount).toBe(0);
    expect(plan.droppable).toEqual([]);
  });

  it('尾部未回复的 user 不占调用名额，且永远不被丢弃', () => {
    const history: ChatMessage[] = [
      msg('system', 'sys'),
      msg('user', 'q1'),
      msg('assistant', 'a1'),
      msg('user', 'q2'),
    ];
    const result = buildCompactedView(history, { keepRecentTurns: 1 });
    expect(result.map((m) => m.content)).toEqual(['sys', 'q1', 'a1', 'q2']);
  });

  it('预算收缩：保留次数逐级减少，直到装进预算或只剩 1 次', () => {
    const wm = new WorkingMemory({ maxTokens: 10000, compactionThreshold: 0.8, keepRecentTurns: 10 });
    // 4 次调用各 2 token（q/a 各 1 token）
    const loose = wm.planCompaction(historyWithDroppable(), { messageTokensBudget: 5 });
    expect(loose.droppedCount).toBe(4);
    const tight = wm.planCompaction(historyWithDroppable(), { messageTokensBudget: 3 });
    expect(tight.droppedCount).toBe(6);
  });

  it('单次调用自身超预算：才退回单次内 token 截尾', () => {
    const wm = new WorkingMemory({ maxTokens: 1000, compactionThreshold: 0.8, keepRecentTurns: 1 });
    const history: ChatMessage[] = [
      msg('system', 'sys'),
      msg('user', 'q'),
      toolCall('c1'),
      { role: 'tool', tool_call_id: 'c1', content: 'r'.repeat(400) },
      { role: 'tool', tool_call_id: 'c1', content: 'r'.repeat(40) },
    ];
    const plan = wm.planCompaction(history, { messageTokensBudget: 40 });
    expect(plan.withinTurnTrim).toBe(true);
    // 截尾起点回退到 assistant：整组保留、不切开配对；
    // 需求 20261113-008（D2）：user 不再 pin 回保留区，改为原文进摘要占位
    expect(plan.kept[0].role).toBe('assistant');
    expect(plan.droppable.map((m) => m.content)).toEqual(['q']);
    expect(plan.anchorUserText).toBe('q');
  });

  it('planCompaction 与 compact 严格互补（kept 即最终保留区）', () => {
    const wm = new WorkingMemory({ maxTokens: 1000, compactionThreshold: 0.8, keepRecentTurns: 3 });
    const history = singleTurnHistory();
    const plan = wm.planCompaction(history);
    const compacted = wm.compact(history, '- 摘要', plan);
    expect(compacted.slice(2)).toEqual(plan.kept);
    expect(plan.droppable.length + plan.kept.length).toBe(history.length - 1);
  });
});
