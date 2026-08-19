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

/** mock llm 模块（react-agent 依赖；chat=flush 调用，chatStream=主对话流） */
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

const BASE = join(tmpdir(), 'loop-agent-tests', 'compaction-fix');

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  if (role === 'tool') {
    return { role, tool_call_id: `call_${content.length}`, content };
  }
  return { role, content } as ChatMessage;
}

/** 写入 workspace 配置并返回 episodic 目录（绝对路径，避免写真实 HOME） */
function writeWorkspaceConfig(wsDir: string, flushFailure: 'skip' | 'archive'): string {
  const episodicDir = join(wsDir, 'l2');
  mkdirSync(join(wsDir, '.loop-agent'), { recursive: true });
  writeFileSync(
    join(wsDir, '.loop-agent', '.agent-config.json'),
    JSON.stringify({
      skill: { enabled: false },
      session: { autoSave: false, autoRestore: false },
      model: { name: 'test-model', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', temperature: 0, maxIterations: 5 },
      agent: { verbose: false, showTokenStats: false, llmLogEnabled: false },
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

  it('1. flush 消息格式：system 仅 1 条且在首位', async () => {
    const wm = new WorkingMemory({ maxTokens: 500, compactionThreshold: 0.8, keepRecentTurns: 1, flushFailure: 'skip' });
    const history: ChatMessage[] = [
      msg('system', '主 system prompt'),
      msg('user', '问题1'),
      msg('assistant', '回答1'),
      msg('user', '问题2'),
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

    // system 唯一且在首位
    const systems = captured.filter((m) => m.role === 'system');
    expect(systems.length).toBe(1);
    expect(captured[0].role).toBe('system');
    expect(captured[0].content).toContain('压缩对话历史');
    // 其余消息均非 system，且内容与历史一致
    expect(captured.slice(1).every((m) => m.role !== 'system')).toBe(true);
    expect(captured.length).toBe(history.length);
    expect(captured.slice(1).map((m) => m.content)).toEqual(
      history.filter((m) => m.role !== 'system').map((m) => m.content),
    );
  });

  it('2. 提取成功 → 写 L2(tag=compaction) → 压缩 → onCompaction(failed:false)', async () => {
    const wsDir = join(BASE, 't2');
    const episodicDir = writeWorkspaceConfig(wsDir, 'skip');
    mocks.chat.mockImplementation(async () => ({ content: '- 关键事实：我会打篮球' }));
    mocks.chatStream.mockImplementation(
      async function* () {
        yield { type: 'delta', content: '测试回答' };
        yield {
          type: 'done',
          response: {
            content: '测试回答',
            finish_reason: 'stop',
            usage: { prompt_tokens: 120, completion_tokens: 6, total_tokens: 126 },
          },
        };
      },
    );

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
    mocks.chatStream.mockImplementation(
      async function* () {
        yield { type: 'delta', content: '测试回答' };
        yield {
          type: 'done',
          response: {
            content: '测试回答',
            finish_reason: 'stop',
            usage: { prompt_tokens: 120, completion_tokens: 6, total_tokens: 126 },
          },
        };
      },
    );

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
    mocks.chatStream.mockImplementation(
      async function* () {
        yield { type: 'delta', content: '测试回答' };
        yield {
          type: 'done',
          response: {
            content: '测试回答',
            finish_reason: 'stop',
            usage: { prompt_tokens: 120, completion_tokens: 6, total_tokens: 126 },
          },
        };
      },
    );

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
});
