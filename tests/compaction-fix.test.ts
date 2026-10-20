/**
 * Task-17：上下文压缩信息丢失修复 验证
 *
 * 覆盖（docs/tasks/task-17-compaction-flush-fix.md 第七节测试计划）：
 * 1. flush 消息格式：mock LLM 收到的消息中 system 仅 1 条且在首位
 * 2. 提取成功路径：flush 返回非空 → 写入 L2（tag=compaction）→ compact 执行 → onCompaction(failed:false)
 * 3. 提取失败 + skip：flush 返回空 → 不写入 L2、不 compact、消息原样保留
 * 4. 提取失败 + archive：flush 返回空 → 原始消息写入 L2（tag=compaction_fallback）→ compact 执行
 * 5. 检索可见性（8.4）：scope=session 无 sessionId 条目在带 sessionId 检索时可见
 * 6. 中文检索（8.5）：查询"我会打篮球吗？"能召回"我会打篮球"条目
 * 7. 回归：压缩成功后 keepRecentTurns 语义不变
 * 8. #1 单轮内压缩：整段历史只有一个 user 时按 token 预算截尾
 * 9. #3 触发口径：按「消息预算」判定，固定开销大而消息少时不得误触发
 * 10. #4 压缩后重置 _lastContextTokens：下一迭代不重复压缩
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { WorkingMemory } from '../src/memory/working.js';
import { EpisodicMemory } from '../src/memory/episodic.js';
import { ReActAgent } from '../src/agent/react-agent.js';
import { ConfigLoader } from '../src/config/index.js';
import type { ChatMessage, CompactionInfo } from '../src/types.js';
import type { ILLMClient } from '../src/memory/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';

/** mock llm 模块（react-agent 依赖；chat=其他记忆调用，chatStream=flush 提取（流式）+ 主对话流） */
const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  chatStream: vi.fn(),
}));

vi.mock('../src/llm/client.js', () => ({
  llm: {
    chat: (...args: unknown[]) => mocks.chat(...args),
    chatStream: async function* (...args: unknown[]) {
      yield* mocks.chatStream(...args);
    },
  },
  LLMClient: class {},
}));

/**
 * flush 提取（流式）与主对话流共用 chatStream mock：按 messages[0] 是否压缩 prompt 区分。
 * flushContent 为 null 表示 flush 提取失败（done 携带 content:null）。
 */
function mockChatStreamWithFlush(flushContent: string | null): void {
  mocks.chatStream.mockImplementation(async function* (messages: ChatMessage[]) {
    const isFlush =
      messages[0]?.role === 'system' && String(messages[0].content ?? '').includes('压缩对话历史');
    if (isFlush) {
      if (flushContent) yield { type: 'delta', content: flushContent };
      yield {
        type: 'done',
        response: {
          content: flushContent,
          finish_reason: 'stop',
          usage: { prompt_tokens: 60, completion_tokens: 4, total_tokens: 64 },
        },
      };
      return;
    }
    yield { type: 'delta', content: '测试回答' };
    yield {
      type: 'done',
      response: {
        content: '测试回答',
        finish_reason: 'stop',
        usage: { prompt_tokens: 120, completion_tokens: 6, total_tokens: 126 },
      },
    };
  });
}

const BASE = join(tmpdir(), 'loop-agent-tests', 'compaction-fix');

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  if (role === 'tool') {
    return { role, tool_call_id: `call_${content.length}`, content };
  }
  return { role, content } as ChatMessage;
}

/** 写入 workspace 配置并返回 episodic 目录（绝对路径，避免写真实 HOME） */
function writeWorkspaceConfig(
  wsDir: string,
  flushFailure: 'skip' | 'archive',
  /** L2 检索 topK；置 0 可关闭记忆注入，使 token 计算保持确定 */
  episodicSearchTopK = 1,
): string {
  const episodicDir = join(wsDir, 'l2');
  mkdirSync(join(wsDir, '.loop-agent'), { recursive: true });
  writeFileSync(
    join(wsDir, '.loop-agent', '.agent-config.json'),
    JSON.stringify({
      skill: { enabled: false },
      session: { autoSave: false, autoRestore: false },
      model: { name: 'test-model', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', temperature: 0 },
      agent: { verbose: false, showTokenStats: false, llmLogEnabled: false, maxIterations: 5 },
      memory: {
        enabled: true,
        working: { maxTokens: 500, compactionThreshold: 0.8, keepRecentTurns: 1, flushFailure },
        episodic: { dir: episodicDir, searchTopK: episodicSearchTopK, searchTimeoutMs: 100 },
        curated: { maxLines: 100, dedupe: { enabled: false } },
        dreaming: { enabled: false, daysBack: 1, onExit: false, batchByDay: true, incremental: false },
      },
    }),
    'utf-8',
  );
  return episodicDir;
}

/** 构造超阈值历史：maxTokens=500 → 阈值 400，估算 ~530 token */
function buildLongHistory(): ChatMessage[] {
  const history: ChatMessage[] = [msg('system', '你是智能助手')];
  for (let i = 0; i < 10; i++) {
    history.push(msg('user', `第 ${i} 轮问题：请分析 ${'x'.repeat(100)}`));
    history.push(msg('assistant', `第 ${i} 轮回答：分析中 ${'y'.repeat(100)}`));
  }
  return history;
}

/** 读取 episodic 目录当天 md 文件内容 */
function readTodayL2(episodicDir: string): string {
  const day = new Date().toISOString().split('T')[0];
  try {
    return readFileSync(join(episodicDir, `${day}.md`), 'utf-8');
  } catch {
    return '';
  }
}

/** 与 WorkingMemory.estimateTokens 同口径（每条消息 ceil(content.length / 4) 求和） */
function estimateOf(messages: ChatMessage[]): number {
  return messages.reduce((acc, m) => acc + Math.ceil(String(m.content ?? '').length / 4), 0);
}

/**
 * 主对话 mock：让 prompt_tokens = 消息估算 + overhead，
 * 从而让 ReActAgent 推算出的「固定开销」恒等于 overhead，便于精确控制触发口径。
 * responses 按主对话调用次序取用，最后一项在后续调用中复用。
 */
function mockStreamsWithOverhead(
  overhead: number,
  responses: Array<{ content: string; toolCall?: string }>,
  flushContent = '- 关键事实',
): { mainCalls: () => number } {
  let mainCalls = 0;
  mocks.chatStream.mockImplementation(async function* (messages: ChatMessage[]) {
    const isFlush =
      messages[0]?.role === 'system' && String(messages[0].content ?? '').includes('压缩对话历史');
    if (isFlush) {
      yield { type: 'delta', content: flushContent };
      yield {
        type: 'done',
        response: {
          content: flushContent,
          finish_reason: 'stop',
          usage: { prompt_tokens: 60, completion_tokens: 4, total_tokens: 64 },
        },
      };
      return;
    }

    const turn = responses[Math.min(mainCalls, responses.length - 1)];
    mainCalls++;
    const promptTokens = estimateOf(messages) + overhead;
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: 10,
      total_tokens: promptTokens + 10,
    };
    if (turn.toolCall) {
      yield {
        type: 'done',
        response: {
          content: turn.content,
          tool_calls: [
            {
              id: `call_${mainCalls}`,
              type: 'function' as const,
              function: { name: turn.toolCall, arguments: '{}' },
            },
          ],
          finish_reason: 'tool_calls' as const,
          usage,
        },
      };
    } else {
      yield { type: 'delta', content: turn.content };
      yield {
        type: 'done',
        response: { content: turn.content, finish_reason: 'stop', usage },
      };
    }
  });
  return { mainCalls: () => mainCalls };
}

/** 构造 N 轮「user + assistant」历史（首条为 system） */
function buildTurns(count: number, userChars: number, assistantChars: number): ChatMessage[] {
  const history: ChatMessage[] = [msg('system', 'sys')];
  for (let i = 0; i < count; i++) {
    history.push(msg('user', `U${i}${'u'.repeat(userChars)}`));
    history.push(msg('assistant', `A${i}${'a'.repeat(assistantChars)}`));
  }
  return history;
}

describe('Task-17 压缩信息丢失修复', () => {
  beforeAll(() => {
    rmSync(BASE, { recursive: true, force: true });
    mkdirSync(BASE, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(BASE, { recursive: true, force: true });
    } catch {
      // Windows 下 sqlite 文件句柄释放延迟可能删除失败，残留临时目录不影响测试结果
    }
  });

  beforeEach(() => {
    mocks.chat.mockReset();
    mocks.chatStream.mockReset();
  });

  it('1. flush 消息格式：固定 2 条（system 指令 + 将被丢弃消息 JSON）', async () => {
    const wm = new WorkingMemory({ maxTokens: 500, compactionThreshold: 0.8, keepRecentTurns: 1, flushFailure: 'skip' });
    const history: ChatMessage[] = [
      msg('system', '主 system prompt'),
      msg('user', '问题1'),
      msg('assistant', '回答1'),
      msg('user', '问题2'),
      msg('assistant', '回答2'),
      msg('user', '问题3'),
    ];
    const captured: ChatMessage[] = [];
    const mockLLM: ILLMClient = {
      async chat(messages) {
        captured.push(...messages);
        return { content: '- 事实1' };
      },
    };

    const extracted = await wm.preCompactionFlush(history, mockLLM);
    expect(extracted).toBe('- 事实1');

    // 固定 2 条：system 唯一且在首位，第 2 条是 JSON 文本
    expect(captured.length).toBe(2);
    expect(captured.filter((m) => m.role === 'system').length).toBe(1);
    expect(captured[0].role).toBe('system');
    expect(captured[0].content).toContain('压缩对话历史');
    // JSON 只包含本次将被丢弃的消息（问题1/回答1），且不含 system
    expect(captured[1].role).toBe('user');
    const payload = JSON.parse(captured[1].content as string);
    expect(payload.messages).toEqual([
      { role: 'user', content: '问题1' },
      { role: 'assistant', content: '回答1' },
    ]);
    expect(payload.messages.some((m: ChatMessage) => m.role === 'system')).toBe(false);
  });

  it('2. 提取成功 → 写 L2(tag=compaction) → 压缩 → onCompaction(failed:false)', async () => {
    const wsDir = join(BASE, 't2');
    const episodicDir = writeWorkspaceConfig(wsDir, 'skip');
    mocks.chat.mockImplementation(async () => ({ content: null }));
    mockChatStreamWithFlush('- 关键事实：我会打篮球');

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);

    const compactionEvents: CompactionInfo[] = [];
    const longHistory = buildLongHistory();
    const result = await agent.run('请继续', {
      messages: longHistory,
      verbose: false,
      events: [{ onCompaction: (info) => { compactionEvents.push(info); } }],
    });

    // onCompaction 触发且标记成功
    expect(compactionEvents.length).toBe(1);
    expect(compactionEvents[0].failed).toBe(false);
    expect(compactionEvents[0].flushedChars).toBeGreaterThan(0);
    // L2 出现 compaction 条目
    const l2 = readTodayL2(episodicDir);
    expect(l2).toContain('[tag: compaction]');
    expect(l2).toContain('我会打篮球');
    // 消息被压缩
    expect(result.messages.length).toBeLessThan(longHistory.length + 2);
  });

  it('3. 提取失败 + skip（默认）→ 不写 L2、不压缩、消息保留', async () => {
    const wsDir = join(BASE, 't3');
    const episodicDir = writeWorkspaceConfig(wsDir, 'skip');
    mocks.chat.mockImplementation(async () => ({ content: null }));
    mockChatStreamWithFlush(null);

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);

    const compactionEvents: CompactionInfo[] = [];
    const longHistory = buildLongHistory();
    const result = await agent.run('请继续', {
      messages: longHistory,
      verbose: false,
      events: [{ onCompaction: (info) => { compactionEvents.push(info); } }],
    });

    expect(compactionEvents.length).toBe(1);
    expect(compactionEvents[0].failed).toBe(true);
    expect(compactionEvents[0].fallback).toBe('skip');
    expect(compactionEvents[0].flushedChars).toBe(0);
    // L2 无 compaction / compaction_fallback 写入
    const l2 = readTodayL2(episodicDir);
    expect(l2).not.toContain('[tag: compaction]');
    expect(l2).not.toContain('[tag: compaction_fallback]');
    // 消息未截断（全部保留 + 本轮 user/assistant）
    expect(result.messages.length).toBe(longHistory.length + 2);
  });

  it('4. 提取失败 + archive → 原始对话写 L2(compaction_fallback) → 压缩', async () => {
    const wsDir = join(BASE, 't4');
    const episodicDir = writeWorkspaceConfig(wsDir, 'archive');
    mocks.chat.mockImplementation(async () => ({ content: null }));
    mockChatStreamWithFlush(null);

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);

    const compactionEvents: CompactionInfo[] = [];
    const longHistory = buildLongHistory();
    const result = await agent.run('请继续', {
      messages: longHistory,
      verbose: false,
      events: [{ onCompaction: (info) => { compactionEvents.push(info); } }],
    });

    expect(compactionEvents.length).toBe(1);
    expect(compactionEvents[0].failed).toBe(true);
    expect(compactionEvents[0].fallback).toBe('archive');
    expect(compactionEvents[0].flushedChars).toBe(0);
    // L2 出现 compaction_fallback 存档（原始对话内容）
    const l2 = readTodayL2(episodicDir);
    expect(l2).toContain('[tag: compaction_fallback]');
    expect(l2).toContain('第 0 轮问题');
    // 消息被压缩
    expect(result.messages.length).toBeLessThan(longHistory.length + 2);
  });

  it('5. 检索可见性（8.4）：无 sessionId 的 session 条目在带 sessionId 检索时可见', async () => {
    const dir = join(BASE, 't5');
    const epi = new EpisodicMemory(dir);
    await epi.init();

    // 无 sessionId 的旧条目（会话早期写入）
    await epi.appendToday('用户: 我会打篮球\n结果: 已记录', { scope: 'session', tag: 'final_answer' });
    // 带 sessionId 的其它会话条目（应保持隔离）
    await epi.appendToday('机密信息：华锐报价 12.5 元', { sessionId: 'sess_b', scope: 'session', tag: 'final_answer' });

    const res1 = await epi.search('我会打篮球', 5, { sessionId: 'sess_a' });
    expect(res1.length).toBe(1);
    expect(res1[0].content).toContain('我会打篮球');

    // 其它会话条目仍被隔离
    const res2 = await epi.search('华锐报价', 5, { sessionId: 'sess_a' });
    expect(res2.length).toBe(0);

    // 有 sessionId 且匹配时正常可见
    const res3 = await epi.search('华锐报价', 5, { sessionId: 'sess_b' });
    expect(res3.length).toBe(1);

    epi.closeIndex();
  });

  it('6. 中文检索（8.5）：查询"我会打篮球吗？"能召回"我会打篮球"条目', async () => {
    const dir = join(BASE, 't6');
    const epi = new EpisodicMemory(dir);
    await epi.init();

    await epi.appendToday('用户: 我会打篮球\n结果: 好的，已记录', { scope: 'session', tag: 'final_answer' });
    await epi.appendToday('今天天气不错', { scope: 'session', tag: 'final_answer' });

    const res = await epi.search('我会打篮球吗？', 5, { sessionId: 'sess_x' });
    expect(res.length).toBe(1);
    expect(res[0].content).toContain('我会打篮球');
    // 噪音条目不被召回
    expect(res.some((r) => r.content.includes('天气'))).toBe(false);

    // 降级路径（删除 sqlite 后走文件检索）同样召回
    epi.closeIndex();
    rmSync(join(dir, 'index.sqlite'), { force: true });
    const epi2 = new EpisodicMemory(dir);
    await epi2.init();
    const res2 = await epi2.search('我会打篮球吗？', 5, { sessionId: 'sess_x' });
    expect(res2.length).toBe(1);
    expect(res2[0].content).toContain('我会打篮球');
    epi2.closeIndex();
  });

  it('7. 回归：压缩成功后 keepRecentTurns 语义不变', async () => {
    const wm = new WorkingMemory({
      maxTokens: 8000,
      compactionThreshold: 0.8,
      keepRecentTurns: 3,
      flushFailure: 'skip',
    });

    const history: ChatMessage[] = [
      msg('system', '你是一个助手'),
      msg('user', '问题1'),
      msg('assistant', '回答1'),
      msg('tool', 'tool_result_1'),
      msg('user', '问题2'),
      msg('assistant', '回答2'),
      msg('user', '问题3'),
      msg('assistant', '回答3'),
      msg('user', '问题4'),
      msg('assistant', '回答4'),
    ];

    const compacted = wm.compact(history);
    // system 保留
    expect(compacted[0]).toEqual(msg('system', '你是一个助手'));
    // 最近 3 轮保留（最后一轮完整可延续）
    const contents = compacted.map((m) => (m as { content?: string }).content);
    expect(contents[contents.length - 1]).toBe('回答4');
    expect(contents).toContain('问题4');
    expect(contents).toContain('问题2');
    expect(contents).not.toContain('问题1');
    // 压缩后不再触发压缩
    expect(wm.needsCompaction(compacted)).toBe(false);
  });

  it('8. #1 单轮内压缩：整段历史只有一个 user 时按 token 预算截尾', async () => {
    const wsDir = join(BASE, 't8');
    const episodicDir = writeWorkspaceConfig(wsDir, 'skip', 0);
    mocks.chat.mockImplementation(async () => ({ content: null }));
    const { mainCalls } = mockStreamsWithOverhead(50, [{ content: '任务完成' }]);

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);

    const compactionEvents: CompactionInfo[] = [];
    // 单轮形态：40 个 assistant/tool 迭代，整段历史没有 user；
    // 本轮输入「请继续」是唯一 user（且位于末尾，pickRecentTurns 不会选中它切轮）
    // 每条 assistant 100 字（25 token）+ tool 19 字（5 token）→ 1200 token，远超阈值 400
    const history: ChatMessage[] = [msg('system', 'sys')];
    for (let i = 0; i < 40; i++) {
      const callId = `call_hist_${i}`;
      history.push({
        role: 'assistant',
        content: `A${i}${'a'.repeat(98)}`,
        tool_calls: [{ id: callId, type: 'function', function: { name: 'someTool', arguments: '{}' } }],
      } as ChatMessage);
      history.push({ role: 'tool', content: '工具 someTool 未注册，无法执行', tool_call_id: callId });
    }

    const result = await agent.run('请继续', {
      messages: history,
      verbose: false,
      events: [{ onCompaction: (info) => { compactionEvents.push(info); } }],
    });

    // 按 user 切轮丢弃 0 条 → 兜底按 token 截尾：keepBudget = floor(400×0.6) = 240
    expect(mainCalls()).toBe(1);
    expect(compactionEvents.length).toBe(1);
    expect(compactionEvents[0].failed).toBe(false);
    expect(compactionEvents[0].flushedChars).toBeGreaterThan(0);
    // 压缩后：system + 占位 + 保留后缀 17 条（8 对 assistant/tool + 本轮 user）
    expect(compactionEvents[0].keptMessages).toBe(19);
    expect(result.messages.length).toBe(20);
    expect(result.messages.length).toBeLessThan(history.length + 2);
    // 占位为 role=user & is_show=false；保留后缀起点回退到 assistant，不能以 tool 开头
    expect(result.messages[1].role).toBe('user');
    expect(result.messages[1].is_show).toBe(false);
    expect(result.messages[2].role).toBe('assistant');
    // 保留的最后一条是本轮输入，最终回答追加在其后
    expect(result.messages[18].role).toBe('user');
    expect(result.messages[19].content).toBe('任务完成');
    // flush 内容写入 L2
    expect(readTodayL2(episodicDir)).toContain('[tag: compaction]');
  });

  it('9. #3 触发口径：固定开销大但消息少时不得误触发', async () => {
    const wsDir = join(BASE, 't9');
    writeWorkspaceConfig(wsDir, 'skip', 0);
    mocks.chat.mockImplementation(async () => ({ content: null }));
    // 固定开销 350 → 消息预算 = max(0.2×400, 400-350) = 80
    mockStreamsWithOverhead(350, [{ content: '好的' }]);

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);

    const compactionEvents: CompactionInfo[] = [];
    const events = [{ onCompaction: (info: CompactionInfo) => { compactionEvents.push(info); } }];

    // run1：短历史（约 66 token < 80）→ 不压缩
    const shortHistory = buildTurns(4, 30, 30);
    const r1 = await agent.run('短问题', { messages: shortHistory, verbose: false, events });
    expect(compactionEvents.length).toBe(0);
    expect(r1.messages.length).toBe(shortHistory.length + 2);

    // run2：同样短历史。上一轮 prompt_tokens ≈ 消息 + 350 ≥ 400，
    // 旧口径（直接比 prompt_tokens）会误触发，新口径按消息预算不触发
    const r2 = await agent.run('短问题', { messages: shortHistory, verbose: false, events });
    expect(compactionEvents.length).toBe(0);
    expect(r2.messages.length).toBe(shortHistory.length + 2);

    // run3：长历史（约 130 token ≥ 80）→ 触发一次压缩
    const longHistory = buildTurns(4, 60, 60);
    const r3 = await agent.run('短问题', { messages: longHistory, verbose: false, events });
    expect(compactionEvents.length).toBe(1);
    expect(compactionEvents[0].failed).toBe(false);
    expect(compactionEvents[0].flushedChars).toBeGreaterThan(0);
    expect(r3.messages.length).toBeLessThan(longHistory.length + 2);
  });

  it('10. #4 压缩后重置 _lastContextTokens：下一迭代不重复压缩', async () => {
    const wsDir = join(BASE, 't10');
    writeWorkspaceConfig(wsDir, 'skip', 0);
    mocks.chat.mockImplementation(async () => ({ content: null }));
    // 固定开销 400 → 压缩后消息预算 = max(80, 0) = 80
    const { mainCalls } = mockStreamsWithOverhead(400, [
      { content: '先查一下', toolCall: 'someTool' },
      { content: '最终回答' },
    ]);

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);

    const compactionEvents: CompactionInfo[] = [];
    // 4 个大轮 + 一个很小的末轮：压缩只保留末轮（3 条），压缩后消息量远低于预算
    const history: ChatMessage[] = [msg('system', 'sys')];
    for (let i = 0; i < 4; i++) {
      history.push(msg('user', `U${i}${'u'.repeat(250)}`));
      history.push(msg('assistant', `A${i}${'a'.repeat(250)}`));
    }
    history.push(msg('user', '好的'), msg('assistant', '收到'));

    const result = await agent.run('继续', {
      messages: history,
      verbose: false,
      events: [{ onCompaction: (info) => { compactionEvents.push(info); } }],
    });

    // 只在迭代 0 压缩一次；迭代 1 工具结果后不得再次压缩
    expect(mainCalls()).toBe(2);
    expect(compactionEvents.length).toBe(1);
    expect(compactionEvents[0].failed).toBe(false);
    expect(compactionEvents[0].flushedChars).toBeGreaterThan(0);
    expect(compactionEvents[0].keptMessages).toBe(5);
    expect(result.iterations).toBe(2);
    expect(result.messages.length).toBe(8);
    expect(result.messages[1].is_show).toBe(false);
  });
});
