/**
 * 20261106-005 P1：ReActAgent.compactNow 单元测试
 *
 * 覆盖：
 * - memory 未启用 → reason='memory_disabled'
 * - 无可丢弃消息 → reason='nothing_to_compact' 且不调用 LLM（D6）
 * - 正常压缩 → 返回前后 token / 丢弃条数，写 L2（tag=compaction），消息视图含摘要占位
 * - flush 失败 + skip → reason='flush_failed'、不落 L2、消息原样保留
 * - 压缩前强制落盘回调（onBeforeCompact）被调用（D14 前置）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ReActAgent } from '../src/agent/react-agent.js';
import { ConfigLoader } from '../src/config/index.js';
import { isSummaryMessage } from '../src/memory/summary-message.js';
import type { ChatMessage } from '../src/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';

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

const BASE = join(tmpdir(), 'loop-agent-tests', 'compact-now');

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content } as ChatMessage;
}

function writeWorkspaceConfig(
  wsDir: string,
  opts: { flushFailure?: 'skip' | 'archive'; memoryEnabled?: boolean } = {},
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
        enabled: opts.memoryEnabled !== false,
        working: {
          maxTokens: 500,
          compactionThreshold: 0.8,
          keepRecentTurns: 1,
          flushFailure: opts.flushFailure ?? 'skip',
        },
        episodic: { dir: episodicDir, searchTopK: 0, searchTimeoutMs: 100 },
        curated: { maxLines: 100, dedupe: { enabled: false } },
        dreaming: { enabled: false, daysBack: 1, onExit: false, batchByDay: true, incremental: false },
      },
    }),
    'utf-8',
  );
  return episodicDir;
}

/** 10 轮长历史（不含 system；与 entry.history 口径一致），估算 ≈530 token > 预算 400 */
function buildLongHistory(): ChatMessage[] {
  const list: ChatMessage[] = [];
  for (let i = 0; i < 10; i++) {
    list.push(msg('user', `第 ${i} 轮问题：请分析 ${'x'.repeat(100)}`));
    list.push(msg('assistant', `第 ${i} 轮回答：分析中 ${'y'.repeat(100)}`));
  }
  return list;
}

/** flush 提取成功（流式 done 带 content） */
function mockFlush(content: string | null): void {
  mocks.chatStream.mockImplementation(async function* (messages: ChatMessage[]) {
    const isFlush =
      messages[0]?.role === 'system' && String(messages[0].content ?? '').includes('压缩对话历史');
    if (!isFlush) throw new Error('compactNow 不应触发主对话流');
    if (content) yield { type: 'delta', content };
    yield {
      type: 'done',
      response: {
        content,
        finish_reason: 'stop',
        usage: { prompt_tokens: 60, completion_tokens: 4, total_tokens: 64 },
      },
    };
  });
}

function readTodayL2(episodicDir: string): string {
  const day = new Date().toISOString().split('T')[0];
  try {
    return readFileSync(join(episodicDir, `${day}.md`), 'utf-8');
  } catch {
    return '';
  }
}

describe('ReActAgent.compactNow', () => {
  beforeAll(() => {
    rmSync(BASE, { recursive: true, force: true });
    mkdirSync(BASE, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(BASE, { recursive: true, force: true });
    } catch {
      // Windows 下 sqlite 句柄释放延迟可能导致删除失败，残留临时目录不影响结果
    }
  });

  beforeEach(() => {
    mocks.chat.mockReset();
    mocks.chatStream.mockReset();
  });

  it('memory 未启用 → memory_disabled', async () => {
    const wsDir = join(BASE, 'disabled');
    writeWorkspaceConfig(wsDir, { memoryEnabled: false });
    const agent = new ReActAgent(new ConfigLoader(wsDir, join(wsDir, 'global')));
    await agent.initMemory(wsDir);
    const r = await agent.compactNow(buildLongHistory());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('memory_disabled');
    expect(mocks.chatStream).not.toHaveBeenCalled();
    agent.dispose();
  });

  it('无可丢弃消息 → nothing_to_compact 且不调用 LLM（D6）', async () => {
    const wsDir = join(BASE, 'nothing');
    writeWorkspaceConfig(wsDir);
    const agent = new ReActAgent(new ConfigLoader(wsDir, join(wsDir, 'global')));
    await agent.initMemory(wsDir);
    const shortHistory: ChatMessage[] = [
      msg('user', '短问题'),
      msg('assistant', '短回答'),
    ];
    const r = await agent.compactNow(shortHistory);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('nothing_to_compact');
    expect(r.droppedCount).toBe(0);
    expect(r.keptMessages).toBe(shortHistory.length);
    expect(mocks.chatStream).not.toHaveBeenCalled();
    agent.dispose();
  });

  it('正常压缩：写 L2（compaction）+ 返回前后 token + 会话视图含摘要占位', async () => {
    const wsDir = join(BASE, 'success');
    const episodicDir = writeWorkspaceConfig(wsDir);
    const agent = new ReActAgent(new ConfigLoader(wsDir, join(wsDir, 'global')));
    await agent.initMemory(wsDir);
    agent.setCurrentSessionId('sess_compact');

    const history = buildLongHistory();
    mockFlush('- 关键事实：用户在做压缩测试');
    let beforeSnapshot: ChatMessage[] | null = null;
    const r = await agent.compactNow(history, {
      sessionId: 'sess_compact',
      onBeforeCompact: async (snap) => {
        beforeSnapshot = snap.messages;
      },
    });

    expect(r.ok).toBe(true);
    expect(r.droppedCount).toBeGreaterThan(0);
    expect(r.beforeTokens).toBeGreaterThan(r.afterTokens!);
    expect(r.messages).toBeDefined();
    expect(r.transcript?.length).toBe(history.length);
    // 压缩前强制落盘收到的是完整历史
    expect(beforeSnapshot?.length).toBe(history.length);
    // 视图首条为摘要占位（is_show=false / kind=summary）
    expect(r.messages!.some((m) => isSummaryMessage(m))).toBe(true);
    // L2 写入（tag=compaction）
    expect(readTodayL2(episodicDir)).toContain('用户在做压缩测试');
    agent.dispose();
  });

  it('flush 失败 + skip → flush_failed，不落 L2，消息原样保留', async () => {
    const wsDir = join(BASE, 'flush-fail');
    const episodicDir = writeWorkspaceConfig(wsDir, { flushFailure: 'skip' });
    const agent = new ReActAgent(new ConfigLoader(wsDir, join(wsDir, 'global')));
    await agent.initMemory(wsDir);
    agent.setCurrentSessionId('sess_flush_fail');

    const history = buildLongHistory();
    mockFlush(null);
    const r = await agent.compactNow(history, { sessionId: 'sess_flush_fail' });

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('flush_failed');
    expect(r.fallback).toBe('skip');
    expect(r.messages).toBeUndefined();
    expect(readTodayL2(episodicDir)).toBe('');
    agent.dispose();
  });
});
