/**
 * ReAct 循环取消检查点与部分结果测试（Task-20261021-002-02 P1）
 *
 * 覆盖（任务文档 6.2）：
 * - 6.2.1 C1：第 2 轮入口 aborted → 抛 AgentAbortedError 且 partial.iterations === 1
 * - 6.2.2 C3：工具执行中 abort → partial.messages 含 assistant(tool_calls) + 已完成工具结果
 * - 6.2.3 C4：压缩中 abort → compaction 事件 {failed:true, fallback:'aborted'} 且 L2 无新增条目
 * - 6.2.4 换绑：runner/chatStream 抛来的空 partial 中止错误在 run() 出口携带完整快照
 * - 6.2.5 D5：abort 后在跑工具自然结束（Promise 不悬挂）才抛错
 * - 6.2.6 C5：最终回答写 L2 前 abort → L2 无 final_answer 条目
 * - 6.2.7 不传 signal：行为与现状一致（回归）
 *
 * mock 方式沿用 compaction-fix.test.ts：vi.mock llm 模块 + 临时 workspace 配置 + 真实 WorkingMemory/EpisodicMemory。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ReActAgent } from '../src/agent/react-agent.js';
import { ConfigLoader } from '../src/config/index.js';
import { AgentAbortedError } from '../src/types.js';
import type { ChatMessage, CompactionInfo } from '../src/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { registry } from '../src/tools/index.js';

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

const BASE = join(tmpdir(), 'loop-agent-tests', 'react-abort');

/** 判定 chatStream 调用是否为压缩提取（flush） */
function isFlushCall(messages: ChatMessage[]): boolean {
  return (
    messages[0]?.role === 'system' &&
    String(messages[0].content ?? '').includes('压缩对话历史')
  );
}

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content } as ChatMessage;
}

/** 写入 workspace 配置（memory.enabled=true，maxTokens 小以稳定触发压缩） */
function writeWorkspaceConfig(wsDir: string, flushFailure: 'skip' | 'archive' = 'skip'): string {
  const episodicDir = join(wsDir, 'l2');
  mkdirSync(join(wsDir, '.loop-agent'), { recursive: true });
  writeFileSync(
    join(wsDir, '.loop-agent', '.agent-config.json'),
    JSON.stringify({
      skill: { enabled: false },
      session: { autoSave: false, autoRestore: false },
      model: { name: 'test-model', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', temperature: 0 },
      agent: { verbose: false, showTokenStats: false, llmLogEnabled: false, maxIterations: 8 },
      memory: {
        enabled: true,
        working: { maxTokens: 500, compactionThreshold: 0.8, keepRecentTurns: 1, flushFailure },
        episodic: { dir: episodicDir, searchTopK: 1, searchTimeoutMs: 100 },
        curated: { maxLines: 100, dedupe: { enabled: false } },
        dreaming: { enabled: false, daysBack: 1, onExit: false, batchByDay: true, incremental: false },
      },
    }),
    'utf-8',
  );
  return episodicDir;
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

/** 注册测试工具（幂等：已存在先卸载；用后清理，不污染全局 registry） */
const testTools = new Set<string>();
function registerTestTool(name: string, execute: (args: Record<string, unknown>, ctx?: { signal?: AbortSignal }) => Promise<string>): void {
  if (registry.has(name)) registry.unregister(name);
  registry.register({
    name,
    description: `测试工具 ${name}`,
    parameters: { type: 'object', properties: {}, required: [] },
    execute,
  });
  testTools.add(name);
}

/** 主对话流 mock：按序取用响应脚本（带 usage，prompt_tokens=估算+overhead） */
function scriptMainCalls(
  responses: Array<{ content?: string; toolName?: string; hangUntilAbort?: boolean }>,
  flushContent: string | null = null,
): { mainCalls: () => number } {
  let n = 0;
  mocks.chatStream.mockImplementation(async function* (messages: ChatMessage[]) {
    if (isFlushCall(messages)) {
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
    const turn = responses[Math.min(n, responses.length - 1)];
    n++;
    if (turn.hangUntilAbort) {
      // 模拟"LLM 流已启动但用户此刻 abort"：挂起直至 abort 后抛空 partial 中止错误（模拟 task-01 chatStream 行为）
      yield { type: 'delta', content: '...' };
      throw new AgentAbortedError({ messages: [], transcript: [], steps: [], iterations: 0 });
    }
    const usage = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 };
    if (turn.toolName) {
      yield {
        type: 'done',
        response: {
          content: turn.content ?? null,
          tool_calls: [
            { id: `call_${n}`, type: 'function' as const, function: { name: turn.toolName, arguments: '{}' } },
          ],
          finish_reason: 'tool_calls' as const,
          usage,
        },
      };
    } else {
      yield { type: 'delta', content: turn.content ?? '' };
      yield { type: 'done', response: { content: turn.content ?? '', finish_reason: 'stop' as const, usage } };
    }
  });
  return { mainCalls: () => n };
}

describe('ReAct 循环取消（Task-20261021-002-02）', () => {
  beforeAll(() => {
    rmSync(BASE, { recursive: true, force: true });
    mkdirSync(BASE, { recursive: true });
  });

  afterAll(() => {
    for (const name of testTools) registry.unregister(name);
    try {
      rmSync(BASE, { recursive: true, force: true });
    } catch {
      // Windows 文件句柄延迟，残留临时目录不影响结果
    }
  });
  beforeEach(() => {
    mocks.chat.mockReset();
    mocks.chatStream.mockReset();
    mocks.chat.mockImplementation(async () => ({ content: null }));
  });

  it('6.2.1 C1：第 2 轮入口 aborted → 抛 AgentAbortedError 且 partial.iterations === 1', async () => {
    const wsDir = join(BASE, 'c1');
    writeWorkspaceConfig(wsDir);
    // 第 1 轮调工具（正常完成），第 2 轮不会再进 LLM
    scriptMainCalls([
      { content: '先查一下', toolName: 'abort_probe_echo' },
      { content: '不应到达' },
    ]);
    registerTestTool('abort_probe_echo', async () => 'ok');

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);

    const ac = new AbortController();
    const p = agent.run('hi', { messages: [msg('system', 'sys')], signal: ac.signal });
    // 先挂拒绝处理器再 abort，避免 unhandled rejection 窗口
    const errPromise = p.then(
      () => { throw new Error('应当抛出 AgentAbortedError'); },
      (e) => e,
    );
    ac.abort(); // 立即 abort：无论拦在 C1(第1轮)/C3/C5-b/C1(第2轮)，断言不早于第 2 轮 LLM 调用
    const err = await errPromise;
    expect(err).toBeInstanceOf(AgentAbortedError);
    const partial = (err as AgentAbortedError).partial;
    expect(partial.iterations).toBeLessThanOrEqual(2);
    expect(partial.messages.length).toBeGreaterThan(0);
    expect(partial.messages[0].role).toBe('system');
  });

  it('6.2.2 C3+raceAbort：工具执行中 abort → partial 含 assistant(tool_calls) 与已完成结果，且不悬挂（D5）', async () => {
    const wsDir = join(BASE, 'c3');
    writeWorkspaceConfig(wsDir);
    scriptMainCalls([
      { content: '执行慢工具', toolName: 'abort_probe_slow' },
      { content: '不应到达' },
    ]);
    let toolDone = false;
    registerTestTool('abort_probe_slow', (_args, ctx) =>
      new Promise<string>((resolve) => {
        // 工具自身感知取消后自然结束（结果被丢弃）——D5：不悬挂
        ctx?.signal?.addEventListener('abort', () => { toolDone = true; resolve('cancelled'); }, { once: true });
      }),
    );

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);

    const ac = new AbortController();
    const p = agent.run('hi', { messages: [msg('system', 'sys')], signal: ac.signal });
    // 等工具真正跑起来再 abort
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();

    const err = await p.then(
      () => { throw new Error('应当抛出 AgentAbortedError'); },
      (e) => e,
    );
    expect(err).toBeInstanceOf(AgentAbortedError);
    expect(toolDone).toBe(true); // D5：在跑工具自然结束才抛
    const partial = (err as AgentAbortedError).partial;
    // assistant 消息带 pending tool_calls 进入快照
    const assistant = partial.messages.find((m) => m.role === 'assistant' && m.tool_calls?.length);
    expect(assistant).toBeDefined();
    expect(partial.messages[partial.messages.length - 1].role).not.toBe('tool');
  });

  it('6.2.3 C4：压缩中 abort → compaction 事件 {failed:true, fallback:"aborted"} 且 L2 无新增条目', async () => {
    const wsDir = join(BASE, 'c4');
    const episodicDir = writeWorkspaceConfig(wsDir);
    // 构造超阈值历史（阈值 400，估算约 530 token）触发压缩；flush 提取挂起到 abort
    const history: ChatMessage[] = [msg('system', '你是智能助手')];
    for (let i = 0; i < 10; i++) {
      history.push(msg('user', `第 ${i} 轮问题：请分析 ${'x'.repeat(100)}`));
      history.push(msg('assistant', `第 ${i} 轮回答：分析中 ${'y'.repeat(100)}`));
    }
    let flushDelta = false;
    mocks.chatStream.mockImplementation(async function* (messages: ChatMessage[]) {
      if (isFlushCall(messages)) {
        yield { type: 'delta', content: '- 部分提取' };
        flushDelta = true;
        // flush 中途 abort：抛空 partial 中止错误（模拟 task-01 chatStream）
        throw new AgentAbortedError({ messages: [], transcript: [], steps: [], iterations: 0 });
      }
      yield { type: 'done', response: { content: '不应到达', finish_reason: 'stop' } };
    });

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);

    const ac = new AbortController();
    const compactionEvents: CompactionInfo[] = [];
    const p = agent.run('hi', {
      messages: history,
      signal: ac.signal,
      events: [{ onCompaction: (info) => { compactionEvents.push(info); } }],
    });
    // 先挂拒绝处理器再 abort，避免 unhandled rejection 窗口
    const errPromise = p.then(
      () => { throw new Error('应当抛出 AgentAbortedError'); },
      (e) => e,
    );
    // 等 flush 已产出首个 delta 后 abort：保证取消点在 preCompactionFlush 的 LLM 调用内部
    await vi.waitFor(async () => {
      if (!flushDelta) throw new Error('flush 尚未产出 delta');
    });
    ac.abort();

    const err = await p.then(
      () => { throw new Error('应当抛出 AgentAbortedError'); },
      (e) => e,
    );
    expect(err).toBeInstanceOf(AgentAbortedError);
    // D4：压缩取消配对终止事件
    expect(compactionEvents.length).toBe(1);
    expect(compactionEvents[0].failed).toBe(true);
    expect(compactionEvents[0].fallback).toBe('aborted');
    // C5/C4：压缩被取消 → 不写 L2（tag=compaction 条目不存在）
    const l2 = readTodayL2(episodicDir);
    expect(l2).not.toContain('[tag: compaction]');
  });

  it('6.2.4 换绑：chatStream 抛来的空 partial 中止错误在 run() 出口携带完整快照', async () => {
    const wsDir = join(BASE, 'rebind');
    writeWorkspaceConfig(wsDir);
    // turn 1：正常工具调用（让主 LLM 先跑起来），turn 2：hangUntilAbort 抛空 partial 中止错误
    scriptMainCalls([
      { content: '先查一下', toolName: 'abort_probe_echo' },
      { hangUntilAbort: true },
    ]);
    registerTestTool('abort_probe_echo', async () => 'ok');

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);

    const ac = new AbortController();
    const p = agent.run('你好', { messages: [msg('system', 'sys')], signal: ac.signal });
    // 先挂处理器再 abort；abort 时机：第 2 轮 LLM 已启动（hangUntilAbort 生成器已产出 delta），
    // 换绑 catch 才会捕获 chatStream 抛来的空 partial 中止错误
    const errPromise = p.then(
      () => { throw new Error('应当抛出 AgentAbortedError'); },
      (e) => e,
    );
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();

    const err = await errPromise;
    expect(err).toBeInstanceOf(AgentAbortedError);
    const partial = (err as AgentAbortedError).partial;
    // 空 partial 已被换绑为完整快照
    expect(partial.messages.length).toBeGreaterThanOrEqual(4);
    // 第 1 轮工具结果已在消息里（assistant tool_calls + tool observation）
    expect(partial.messages.some((m) => m.role === 'tool')).toBe(true);
    expect(partial.messages.filter((m) => m.role === 'user').some((m) => String(m.content).includes('你好'))).toBe(true);
    expect(partial.iterations).toBe(1);
  });

  it('6.2.6 C5-a：最终回答生成后、写 L2 前 abort → run 中止且 L2 无 final_answer 条目', async () => {
    const wsDir = join(BASE, 'c5a');
    const episodicDir = writeWorkspaceConfig(wsDir);
    scriptMainCalls([{ content: '这是最终回答' }]);

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);

    const ac = new AbortController();
    // onFinal 触发后再 abort：正是"答案已出、即将写记忆"的窗口
    const p = agent.run('hi', {
      messages: [msg('system', 'sys')],
      signal: ac.signal,
      events: [{ onFinal: () => { ac.abort(); } }],
    });
    const err = await p.then(
      () => { throw new Error('应当抛出 AgentAbortedError'); },
      (e) => e,
    );
    expect(err).toBeInstanceOf(AgentAbortedError);
    const partial = (err as AgentAbortedError).partial;
    // 部分结果即完整结果（任务文档 3.5）：最终回答已在 partial 中，落盘无害
    const lastAssistant = [...partial.messages].reverse().find((m) => m.role === 'assistant');
    expect(String(lastAssistant?.content)).toContain('这是最终回答');
    // C5：未写记忆
    expect(readTodayL2(episodicDir)).not.toContain('[tag: final_answer]');
  });

  it('6.2.7 回归：不传 signal 时 run 正常完成（行为与现状一致）', async () => {
    const wsDir = join(BASE, 'nosig');
    writeWorkspaceConfig(wsDir);
    scriptMainCalls([{ content: '正常完成' }]);

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);

    const result = await agent.run('hi', { messages: [msg('system', 'sys')] });
    expect(result.answer).toBe('正常完成');
    expect(result.messages[result.messages.length - 1].role).toBe('assistant');
  });

  it('6.2.8 流式中断：已流出文本补为 assistant 消息（Task-20261029-001 D4-B）', async () => {
    const wsDir = join(BASE, 'stream-partial');
    writeWorkspaceConfig(wsDir);
    // 模拟"用户看到半截回答时按 Ctrl+C"：先流出文本，再由 chatStream 抛空 partial 中止错误
    let streamed = false;
    mocks.chatStream.mockImplementation(async function* () {
      yield { type: 'delta', content: '这是用户已经看到的半截回答' };
      streamed = true;
      throw new AgentAbortedError({ messages: [], transcript: [], steps: [], iterations: 0 });
    });

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);

    const ac = new AbortController();
    const p = agent.run('写点东西', { messages: [msg('system', 'sys')], signal: ac.signal });
    const errPromise = p.then(
      () => {
        throw new Error('应当抛出 AgentAbortedError');
      },
      (e) => e,
    );
    await vi.waitFor(() => {
      if (!streamed) throw new Error('尚未流出文本');
    });
    ac.abort();

    const err = await errPromise;
    expect(err).toBeInstanceOf(AgentAbortedError);
    const partial = (err as AgentAbortedError).partial;
    const last = partial.messages[partial.messages.length - 1];
    // 半截回答进入快照（否则落盘会话只剩 user 消息，"已生成内容已保留"落空）
    expect(last.role).toBe('assistant');
    expect(String(last.content)).toContain('这是用户已经看到的半截回答');
    // 纯文本 assistant 不产生孤立 tool_calls：消息序对下一轮仍然合法
    expect(partial.messages.some((m) => m.role === 'tool')).toBe(false);
  });

  it('6.2.9 signal 透传：run 的 signal 必须传到 chatStream（流式可中断的前提）', async () => {
    const wsDir = join(BASE, 'signal-pass');
    writeWorkspaceConfig(wsDir);
    scriptMainCalls([{ content: '完成' }]);

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);

    const ac = new AbortController();
    await agent.run('hi', { messages: [msg('system', 'sys')], signal: ac.signal });
    // 第 3 个参数是 chatStream 的 options；此前漏传 signal，导致"回答中"无法中断
    const call = mocks.chatStream.mock.calls.find((c) => !isFlushCall(c[0] as ChatMessage[]));
    expect(call).toBeDefined();
    expect((call?.[2] as { signal?: AbortSignal }).signal).toBe(ac.signal);
  });
});
