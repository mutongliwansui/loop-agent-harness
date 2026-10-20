/**
 * 回归：方案 B（完整轨迹补归档）+ 节流快照落盘
 *
 * 背景：L1 压缩在 run 过程中物理删除内存视图消息，而落盘只在 run 结束发生一次，
 * 导致「本轮内被压缩、从未落盘」的工具调用永久丢失。
 * 修复：run() 维护不压缩的 transcript 并随 result/快照交给 SessionStore，
 * 未被 kept 保留的轨迹消息全部以 is_compact=true 归档；同一 run 多次快照不得重复归档。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ReActAgent } from '../src/agent/react-agent.js';
import { ConfigLoader } from '../src/config/index.js';
import { SessionStore } from '../src/session/store.js';
import { stripMemorySection, withMemorySection } from '../src/memory/memory-section.js';
import type { ChatMessage } from '../src/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

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

const BASE = join(tmpdir(), 'loop-agent-tests', 'transcript-persist');

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content } as ChatMessage;
}

function toolCall(id: string, name: string): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
  } as ChatMessage;
}

function toolResult(id: string, content: string): ChatMessage {
  return { role: 'tool', content, tool_call_id: id } as ChatMessage;
}

function summaryPlaceholder(text: string): ChatMessage {
  return { role: 'user', content: `[历史摘要] ${text}`, is_show: false, kind: 'summary' } as ChatMessage;
}

function writeWorkspaceConfig(wsDir: string, autoSave: boolean): void {
  mkdirSync(join(wsDir, '.loop-agent'), { recursive: true });
  writeFileSync(
    join(wsDir, '.loop-agent', '.agent-config.json'),
    JSON.stringify({
      skill: { enabled: false },
      session: { autoSave, autoRestore: false, encryptionEnabled: false },
      model: { name: 'test-model', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', temperature: 0 },
      agent: { verbose: false, showTokenStats: false, llmLogEnabled: false, maxIterations: 5 },
      memory: {
        enabled: true,
        working: { maxTokens: 500, compactionThreshold: 0.8, keepRecentTurns: 1, flushFailure: 'skip' },
        episodic: { dir: join(wsDir, 'l2'), searchTopK: 1, searchTimeoutMs: 100 },
        curated: { maxLines: 100, dedupe: { enabled: false } },
        dreaming: { enabled: false, daysBack: 1, onExit: false, batchByDay: true, incremental: false },
      },
    }),
    'utf-8',
  );
}

/** 落盘消息唯一性 key（tool 消息按 tool_call_id、assistant 按 tool_calls id 区分） */
function messageKeys(list: ChatMessage[]): string[] {
  return list
    .filter((m) => m.role !== 'system')
    .map(
      (m) =>
        `${m.role}|${m.tool_call_id ?? ''}|${(m.tool_calls ?? []).map((c) => c.id).join(',')}|` +
        `${typeof m.content === 'string' ? m.content : ''}`,
    );
}

describe('方案 B：完整轨迹补归档', () => {
  beforeAll(() => {
    rmSync(BASE, { recursive: true, force: true });
    mkdirSync(BASE, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(BASE, { recursive: true, force: true });
    } catch {
      // Windows 文件句柄释放延迟，残留不影响结果
    }
  });

  beforeEach(() => {
    mocks.chat.mockReset();
    mocks.chatStream.mockReset();
    mocks.chat.mockImplementation(async () => ({ content: null }));
  });

  it('本轮已被压缩、从未落盘的消息以 is_compact=true 归档，锚点 user 保持 recent', async () => {
    const wsDir = join(BASE, 'store-a');
    writeWorkspaceConfig(wsDir, false);
    const store = new SessionStore(wsDir, false, join(wsDir, 'user'));
    await store.init();

    // 已落盘的历史（recent）
    const seed: ChatMessage[] = [];
    for (let i = 0; i < 6; i++) {
      seed.push(msg('user', `旧问题 ${i}`));
      seed.push(msg('assistant', `旧回答 ${i}`));
    }
    const meta = await store.createSession('种子会话', [msg('system', '你是助手'), ...seed]);

    // 本轮 run 的完整轨迹：历史（同内容不同对象）+ 本轮新增的工具调用链
    const pinned = msg('user', '帮我看下项目结构');
    const call1 = toolCall('call_a', 'listDir');
    const res1 = toolResult('call_a', 'a.ts\nb.ts');
    const call2 = toolCall('call_b', 'readFile');
    const res2 = toolResult('call_b', 'export const a = 1;');
    const final = msg('assistant', '项目结构如上');
    const transcript: ChatMessage[] = [
      ...seed.map((m) => ({ ...m }) as ChatMessage),
      pinned,
      call1,
      res1,
      call2,
      res2,
      final,
    ];

    // 压缩后的内存视图：system + 摘要占位 + kept（锚点 user + 最终答案，与 transcript 同引用）
    const view: ChatMessage[] = [
      msg('system', '你是助手'),
      summaryPlaceholder('早前讨论过项目结构'),
      pinned,
      final,
    ];
    await store.updateSession(meta.id, view, '帮我看下项目结构', { transcript });

    const persisted = await store.loadSession(meta.id);
    const archived = persisted.messages.filter((m) => m.is_compact === true);
    const recent = persisted.messages.filter(
      (m) => m.role !== 'system' && m.is_compact !== true && m.kind !== 'summary',
    );
    const summaries = persisted.messages.filter((m) => m.kind === 'summary');

    expect(archived.length, '轨迹中未被保留的消息应全部归档').toBe(transcript.length - 2);
    expect(archived.some((m) => m.tool_call_id === 'call_a')).toBe(true);
    expect(archived.some((m) => m.tool_call_id === 'call_b')).toBe(true);
    expect(archived.some((m) => m.is_show === true)).toBe(true);
    expect(summaries.length).toBe(1);
    expect(String(summaries[0].content)).toContain('早前讨论过项目结构');
    expect(recent.map((m) => m.content)).toEqual(['帮我看下项目结构', '项目结构如上']);
    expect(recent.every((m) => m.is_show !== false)).toBe(true);
  });

  it('同一 run 内多次压缩快照不重复归档', async () => {
    const wsDir = join(BASE, 'store-b');
    writeWorkspaceConfig(wsDir, false);
    const store = new SessionStore(wsDir, false, join(wsDir, 'user'));
    await store.init();

    const seed = [msg('user', '旧问题'), msg('assistant', '旧回答')];
    const meta = await store.createSession('种子会话', [msg('system', '你是助手'), ...seed]);

    const pinned = msg('user', '帮我看下项目结构');
    const call1 = toolCall('call_1', 'listDir');
    const res1 = toolResult('call_1', 'a.ts');
    const final = msg('assistant', '完成');
    const transcript: ChatMessage[] = [...seed.map((m) => ({ ...m }) as ChatMessage), pinned, call1, res1, final];

    // 第一次压缩快照
    const view1 = [msg('system', '你是助手'), summaryPlaceholder('第一次摘要'), pinned, final];
    await store.updateSession(meta.id, view1, '帮我看下项目结构', { transcript });

    // 第二次压缩快照（同 run，轨迹继续增长，kept 不变）
    const call2 = toolCall('call_2', 'readFile');
    const res2 = toolResult('call_2', 'b');
    const transcript2 = [...transcript, call2, res2];
    const view2 = [msg('system', '你是助手'), summaryPlaceholder('第二次摘要'), pinned, final];
    await store.updateSession(meta.id, view2, '帮我看下项目结构', { transcript: transcript2 });

    const persisted = await store.loadSession(meta.id);
    const archived = persisted.messages.filter((m) => m.is_compact === true);
    const keys = messageKeys(persisted.messages);

    expect(archived.length, '归档数应等于轨迹中未保留的条数（无重复）').toBe(transcript2.length - 2);
    expect(new Set(keys).size, '落盘消息不得重复').toBe(keys.length);
    expect(archived.some((m) => m.tool_call_id === 'call_2')).toBe(true);
    expect(persisted.messages.filter((m) => m.kind === 'summary').length).toBe(1);
  });

  it('存量消息带 L2 记忆前缀时仍能对齐边界：当前轮 user 留在 recent 且归档不重复', async () => {
    const wsDir = join(BASE, 'store-c');
    writeWorkspaceConfig(wsDir, false);
    const store = new SessionStore(wsDir, false, join(wsDir, 'user'));
    await store.init();

    // 存量会话：user content 已被旧逻辑写入 L2 记忆前缀
    const seed: ChatMessage[] = [
      { role: 'user', content: withMemorySection('旧记忆片段', '旧问题') } as ChatMessage,
      msg('assistant', '旧回答'),
    ];
    const meta = await store.createSession('种子会话', [msg('system', '你是助手'), ...seed]);

    // 本轮轨迹使用原始 content（记忆注入只作用于 LLM 视图）
    const historyRaw: ChatMessage[] = [msg('user', '旧问题'), msg('assistant', '旧回答')];
    const pinned = msg('user', '帮我看下项目结构');
    const call1 = toolCall('call_c1', 'listDir');
    const res1 = toolResult('call_c1', 'a.ts');
    const final = msg('assistant', '项目结构如上');
    const transcript = [...historyRaw, pinned, call1, res1, final];
    const view1 = [msg('system', '你是助手'), summaryPlaceholder('第一次摘要'), pinned, final];
    await store.updateSession(meta.id, view1, '帮我看下项目结构', { transcript });

    // 同 run 第二个快照：轨迹继续增长，kept 不变
    const call2 = toolCall('call_c2', 'readFile');
    const res2 = toolResult('call_c2', 'b');
    const transcript2 = [...transcript, call2, res2];
    const view2 = [msg('system', '你是助手'), summaryPlaceholder('第二次摘要'), pinned, final];
    await store.updateSession(meta.id, view2, '帮我看下项目结构', { transcript: transcript2 });

    const persisted = await store.loadSession(meta.id);
    const archived = persisted.messages.filter((m) => m.is_compact === true);
    const recent = persisted.messages.filter(
      (m) => m.role !== 'system' && m.is_compact !== true && m.kind !== 'summary',
    );

    expect(archived.length, '归档数应等于轨迹中未保留的条数（无重复）').toBe(transcript2.length - 2);
    expect(recent.map((m) => stripMemorySection(String(m.content)))).toEqual([
      '帮我看下项目结构',
      '项目结构如上',
    ]);
    expect(
      archived.filter((m) => stripMemorySection(String(m.content)) === '旧问题').length,
      '旧问题不得因前缀差异重复归档',
    ).toBe(1);
  });

  it('result.transcript 保留全部工具消息，节流快照与最终落盘均不重复', async () => {
    const wsDir = join(BASE, 'agent');
    writeWorkspaceConfig(wsDir, true);

    let mainCallCount = 0;
    mocks.chatStream.mockImplementation(async function* (messages: ChatMessage[]) {
      const isFlush =
        messages[0]?.role === 'system' && String(messages[0].content ?? '').includes('压缩对话历史');
      if (isFlush) {
        yield { type: 'delta', content: '- 关键事实' };
        yield {
          type: 'done',
          response: {
            content: '- 关键事实',
            finish_reason: 'stop',
            usage: { prompt_tokens: 60, completion_tokens: 4, total_tokens: 64 },
          },
        };
        return;
      }
      mainCallCount++;
      if (mainCallCount === 1) {
        yield {
          type: 'done',
          response: {
            content: '先列目录',
            tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'listDir', arguments: '{}' } }],
            finish_reason: 'tool_calls' as const,
            usage: { prompt_tokens: 600, completion_tokens: 20, total_tokens: 620 },
          },
        };
        return;
      }
      if (mainCallCount === 2) {
        yield {
          type: 'done',
          response: {
            content: '再读文件',
            tool_calls: [{ id: 'call_2', type: 'function' as const, function: { name: 'readFile', arguments: '{}' } }],
            finish_reason: 'tool_calls' as const,
            usage: { prompt_tokens: 600, completion_tokens: 20, total_tokens: 620 },
          },
        };
        return;
      }
      yield { type: 'delta', content: '项目结构如下' };
      yield {
        type: 'done',
        response: {
          content: '项目结构如下',
          finish_reason: 'stop',
          usage: { prompt_tokens: 300, completion_tokens: 10, total_tokens: 310 },
        },
      };
    });

    const store = new SessionStore(wsDir, false, join(wsDir, 'user'));
    await store.init();
    const longHistory: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) {
      longHistory.push(msg('user', `第 ${i} 轮问题：请分析 ${'x'.repeat(100)}`));
      longHistory.push(msg('assistant', `第 ${i} 轮回答：分析中 ${'y'.repeat(100)}`));
    }
    const meta = await store.createSession('种子会话', [msg('system', '你是助手'), ...longHistory]);

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);

    const snapshotSizes: number[] = [];
    const result = await agent.run('帮我看下项目结构', {
      messages: [msg('system', '你是助手'), ...longHistory],
      verbose: false,
      onSnapshot: async (snapshot) => {
        snapshotSizes.push(snapshot.transcript.length);
        await store.updateSession(meta.id, snapshot.messages, '帮我看下项目结构', {
          transcript: snapshot.transcript,
        });
      },
    });

    // 本轮确实触发了压缩（内存视图少于完整轨迹）
    expect(result.transcript, 'result 应携带完整轨迹').toBeDefined();
    expect(result.transcript!.filter((m) => m.role === 'tool').length).toBe(2);
    expect(snapshotSizes.length, '应有节流/压缩前快照').toBeGreaterThan(0);

    // 最终持久化（与 handler 一致）
    await store.updateSession(meta.id, result.messages, '帮我看下项目结构', {
      transcript: result.transcript,
    });

    const persisted = await store.loadSession(meta.id);
    const toolIds = persisted.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    const keys = messageKeys(persisted.messages);

    expect(toolIds.sort()).toEqual(['call_1', 'call_2']);
    expect(new Set(keys).size, '快照 + 最终落盘不得产生重复消息').toBe(keys.length);
    expect(persisted.messages.filter((m) => m.kind === 'summary').length).toBe(1);
    expect(persisted.messages.filter((m) => m.is_compact === true).length).toBeGreaterThan(0);
  });
});
