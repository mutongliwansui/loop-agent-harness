/**
 * 回归：L1 压缩总结消息落盘（曾漏写 createSession 分支，占位被过滤导致总结丢失）
 *
 * 链路：种子长历史会话 → agent.run 触发 L1 压缩（注入 is_show=false 摘要占位）
 * → SessionStore 落盘 → 校验 messages 中：
 *   1) 存在 is_show=false 的总结消息（role=user，内容剥离 [历史摘要] 前缀）
 *   2) 边界前消息 is_compact=true，边界后 is_compact=false
 *   3) 无 [历史摘要] 前缀残留
 *   4) 下一轮基线（_chatHistory / entry.history）不含 is_compact=true 折叠历史
 *
 * 场景 A：API 模式（agent 不注入 SessionStore，handler 侧调 updateSession）
 * 场景 B：同 agent 连续第二轮（summary 应被新总结取代，且不重复）
 * 场景 C：CLI 模式首轮（agent 注入 store + autoSave + _currentSessionId=null
 *         → autoSave 走 createSession 分支，占位原位转写为总结消息）
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ReActAgent } from '../src/agent/react-agent.js';
import { ConfigLoader } from '../src/config/index.js';
import { SessionStore } from '../src/session/store.js';
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

/** flush 提取返回 '- 关键事实'；主对话流返回大 prompt_tokens(600) 武装下一轮压缩判定 */
function mockStreams(): void {
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
    yield { type: 'delta', content: '测试回答' };
    yield {
      type: 'done',
      response: {
        content: '测试回答',
        finish_reason: 'stop',
        usage: { prompt_tokens: 600, completion_tokens: 6, total_tokens: 606 },
      },
    };
  });
}

const BASE = join(tmpdir(), 'loop-agent-tests', 'compaction-summary-repro');

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content } as ChatMessage;
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

/** 10 轮长历史（估算 ~600 token，超 400 阈值） */
function buildLongHistory(): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (let i = 0; i < 10; i++) {
    history.push(msg('user', `第 ${i} 轮问题：请分析 ${'x'.repeat(100)}`));
    history.push(msg('assistant', `第 ${i} 轮回答：分析中 ${'y'.repeat(100)}`));
  }
  return history;
}

describe('复现：压缩总结消息落盘', () => {
  beforeAll(() => {
    rmSync(BASE, { recursive: true, force: true });
    mkdirSync(BASE, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(BASE, { recursive: true, force: true });
    } catch {
      // Windows sqlite 句柄释放延迟，残留不影响结果
    }
  });

  beforeEach(() => {
    mocks.chat.mockReset();
    mocks.chatStream.mockReset();
    mocks.chat.mockImplementation(async () => ({ content: null }));
    mockStreams();
  });

  it('场景 A：API 模式链路 — 压缩后轮次的总结消息应写入 messages', async () => {
    const wsDir = join(BASE, 'a');
    writeWorkspaceConfig(wsDir, true);
    const store = new SessionStore(wsDir, false, join(wsDir, 'user'));
    await store.init();

    // 种子：已存在的长历史会话（模拟 WebUI 里聊了 10 轮的会话）
    const meta = await store.createSession('种子会话', [msg('system', '你是智能助手'), ...buildLongHistory()]);

    // 模拟 handler：ensureEntry 恢复历史（不含 system）
    const data = await store.loadSession(meta.id);
    const history = SessionStore.getRestoreMessages(data).filter((m) => m.role !== 'system');

    // agent 不注入 SessionStore（与 bootstrap.ts 一致）
    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);

    const result = await agent.run('请继续', { messages: history, verbose: false });

    // sanity：result.messages 应含摘要占位（role=user, is_show=false）
    const placeholder = result.messages.find(
      (m) => m.role === 'user' && m.is_show === false,
    );
    expect(placeholder).toBeDefined();

    // handler 持久化
    await store.updateSession(meta.id, result.messages, '请继续');

    // 校验落盘
    const persisted = await store.loadSession(meta.id);
    const summary = persisted.messages.find((m) => m.role === 'user' && m.is_show === false);
    expect(summary, '应存在 is_show=false 的总结消息').toBeDefined();
    expect(typeof summary?.content === 'string' && summary.content.includes('关键事实')).toBe(true);
    expect(String(summary?.content ?? '').startsWith('[历史摘要]')).toBe(false);
    expect(persisted.messages.some((m) => m.is_compact === true)).toBe(true);
    // 总结消息 is_compact=false，不与折叠标记冲突
    expect(summary?.is_compact).toBe(false);
  });

  it('场景 B：同 agent 连续第二轮 — 总结被取代且不重复', async () => {
    const wsDir = join(BASE, 'b');
    writeWorkspaceConfig(wsDir, true);
    const store = new SessionStore(wsDir, false, join(wsDir, 'user'));
    await store.init();
    const meta = await store.createSession('种子会话', [msg('system', '你是智能助手'), ...buildLongHistory()]);

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);

    // 第 1 轮
    const d1 = await store.loadSession(meta.id);
    const h1 = SessionStore.getRestoreMessages(d1).filter((m) => m.role !== 'system');
    const r1 = await agent.run('请继续', { messages: h1, verbose: false });
    const stored1 = await store.updateSession(meta.id, r1.messages, '请继续');

    // 第 2 轮（handler 用 stored 作为 entry.history：剔除 system 与 is_compact=true 折叠历史）
    const h2 = stored1.filter((m) => m.role !== 'system' && m.is_compact !== true);
    const r2 = await agent.run('再说一遍', { messages: h2, verbose: false });
    await store.updateSession(meta.id, r2.messages, '再说一遍');

    const persisted = await store.loadSession(meta.id);
    const summaries = persisted.messages.filter((m) => m.role === 'user' && m.is_show === false);
    expect(summaries.length, '总结消息应只有一条（新总结取代旧总结）').toBe(1);
    expect(persisted.messages.some((m) => m.is_compact === true)).toBe(true);
    expect(persisted.messages.some((m) => m.is_compact === false && m.role !== 'system' && m.is_show !== false)).toBe(true);
  });

  it('场景 C：CLI 首轮 — autoSave 走 createSession 分支时总结消息同样落盘', async () => {
    const wsDir = join(BASE, 'c');
    writeWorkspaceConfig(wsDir, true);
    const store = new SessionStore(wsDir, false, join(wsDir, 'user'));
    await store.init();

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);
    agent.setSessionStore(store);
    // _currentSessionId 为 null（首轮），autoSave 将走 createSession 分支

    const result = await agent.run('请继续', {
      messages: [msg('system', '你是智能助手'), ...buildLongHistory()],
      verbose: false,
    });

    // sanity：本轮确实触发了压缩（result.messages 含摘要占位）
    const placeholder = result.messages.find(
      (m) => m.role === 'user' && m.is_show === false,
    );
    expect(placeholder).toBeDefined();

    const sessions = await store.listSessions();
    expect(sessions.length).toBe(1);
    const persisted = await store.loadSession(sessions[0].id);
    const summary = persisted.messages.find((m) => m.role === 'user' && m.is_show === false);
    expect(summary, 'createSession 分支也应写入总结消息').toBeDefined();
    expect(typeof summary?.content === 'string' && summary.content.includes('关键事实')).toBe(true);
    expect(String(summary?.content ?? '').startsWith('[历史摘要]')).toBe(false);
    expect(summary?.is_compact).toBe(false);

    // 内存基线（_chatHistory）：含总结消息、不含 is_compact=true
    const baseline = agent.getSessionMessages();
    expect(baseline.some((m) => m.role === 'user' && m.is_show === false)).toBe(true);
    expect(baseline.every((m) => m.is_compact !== true)).toBe(true);
  });

  it('场景 D：多轮迭代（第一轮 tool_calls）— 占位不得在后续压缩检查中丢失', async () => {
    const wsDir = join(BASE, 'd');
    writeWorkspaceConfig(wsDir, true);
    const store = new SessionStore(wsDir, false, join(wsDir, 'user'));
    await store.init();

    let mainCallCount = 0;
    mocks.chatStream.mockImplementation(async function* (messages: ChatMessage[]) {
      const isFlush =
        messages[0]?.role === 'system' && String(messages[0].content ?? '').includes('压缩对话历史');
      if (isFlush) {
        yield { type: 'delta', content: '- 关键事实' };
        yield {
          type: 'done',
          response: { content: '- 关键事实', finish_reason: 'stop', usage: { prompt_tokens: 60, completion_tokens: 4, total_tokens: 64 } },
        };
        return;
      }
      mainCallCount++;
      if (mainCallCount === 1) {
        // 第一轮：返回工具调用，触发第二轮迭代
        yield {
          type: 'done',
          response: {
            content: '我先查一下',
            tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'someTool', arguments: '{}' } }],
            finish_reason: 'tool_calls' as const,
            usage: { prompt_tokens: 600, completion_tokens: 30, total_tokens: 630 },
          },
        };
      } else {
        // 第二轮：最终答案
        yield { type: 'delta', content: '最终回答' };
        yield {
          type: 'done',
          response: { content: '最终回答', finish_reason: 'stop', usage: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 } },
        };
      }
    });

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    await agent.initMemory(wsDir);

    // 先建种子会话（供 updateSession 使用）
    const meta = await store.createSession('种子', [msg('system', '你是智能助手'), ...buildLongHistory()]);

    const result = await agent.run('请继续', {
      messages: [msg('system', '你是智能助手'), ...buildLongHistory()],
      verbose: false,
    });

    // 多轮迭代后 result.messages 仍应含摘要占位（修复前会被第二轮压缩检查丢弃）
    const placeholder = result.messages.find(
      (m) => m.role === 'user' && m.is_show === false,
    );
    expect(placeholder, '多轮迭代后占位应保留在 result.messages').toBeDefined();

    // 落盘后应有总结消息
    const stored = await store.updateSession(meta.id, result.messages, '请继续');
    expect(stored.find((m) => m.role === 'user' && m.is_show === false), '落盘应有总结消息').toBeDefined();
  });
});
