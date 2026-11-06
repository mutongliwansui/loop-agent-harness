/**
 * run 级会话身份注入（task-20261106-002 P0/D1/D2/D7）
 *
 * 覆盖：
 * - options.sessionId 优先于实例 _currentSessionId
 * - 未传 options.sessionId 时回落实例字段（CLI 兼容）
 * - 双缺失（CLI 首轮未建会话）→ 拒绝写入 L2，不产出裸条目
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { ReActAgent } from '../src/agent/react-agent.js';
import { ConfigLoader } from '../src/config/index.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

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

// 独立临时目录（含时间戳）：agent 持有的 sqlite 句柄在 Windows 下会阻止删除，故不做清理
const BASE = join(tmpdir(), 'loop-agent-tests', `agent-session-id-${Date.now()}`);

/** 写入 workspace 配置，返回 episodic 目录（绝对路径，避免写真实 HOME） */
function writeWorkspaceConfig(wsDir: string, episodicDir: string): void {
  mkdirSync(join(wsDir, '.loop-agent'), { recursive: true });
  writeFileSync(
    join(wsDir, '.loop-agent', '.agent-config.json'),
    JSON.stringify({
      skill: { enabled: false },
      session: { autoSave: false, autoRestore: false },
      model: { name: 'test-model', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', temperature: 0 },
      agent: { verbose: false, showTokenStats: false, llmLogEnabled: false, maxIterations: 3 },
      memory: {
        enabled: true,
        // 阈值放大：本轮不触发 L1 压缩，只验证最终答案写入的会话归属
        working: { maxTokens: 100000, compactionThreshold: 0.8, keepRecentTurns: 1, flushFailure: 'skip' },
        episodic: { dir: episodicDir, searchTopK: 1, searchTimeoutMs: 100 },
        curated: { maxLines: 100, dedupe: { enabled: false } },
        dreaming: { enabled: false, daysBack: 1, onExit: false, batchByDay: true, incremental: false },
      },
    }),
    'utf-8',
  );
}

/** 主对话流 mock：直接返回最终答案 */
function mockFinalAnswer(): void {
  mocks.chatStream.mockImplementation(async function* () {
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

function readTodayL2(episodicDir: string): string {
  const day = new Date().toISOString().split('T')[0];
  try {
    return readFileSync(join(episodicDir, `${day}.md`), 'utf-8');
  } catch {
    return '';
  }
}

async function makeAgent(wsDir: string, episodicDir: string): Promise<ReActAgent> {
  writeWorkspaceConfig(wsDir, episodicDir);
  const agent = new ReActAgent(new ConfigLoader(wsDir, join(wsDir, 'global')));
  // run() 不自建记忆子系统，需与 CLI/runtime 一致显式初始化
  await agent.initMemory(wsDir);
  return agent;
}

describe('ReActAgent run 级会话身份', () => {
  beforeAll(() => {
    mkdirSync(BASE, { recursive: true });
    mockFinalAnswer();
  });

  beforeEach(() => {
    mocks.chatStream.mockClear();
    mockFinalAnswer();
  });

  it('options.sessionId 优先于实例 _currentSessionId', async () => {
    const wsDir = join(BASE, 'priority');
    const episodicDir = join(wsDir, 'l2');
    const agent = await makeAgent(wsDir, episodicDir);
    agent.setCurrentSessionId('sess_legacy');

    await agent.run('记录一下', { sessionId: 'sess_api_a' });

    const content = readTodayL2(episodicDir);
    expect(content).toContain('[sessionId: sess_api_a]');
    expect(content).toContain('[scope: session]');
    expect(content).toContain('[tag: final_answer]');
    expect(content).not.toContain('sess_legacy');
  });

  it('未传 options.sessionId 时回落实例字段（CLI 兼容）', async () => {
    const wsDir = join(BASE, 'fallback');
    const episodicDir = join(wsDir, 'l2');
    const agent = await makeAgent(wsDir, episodicDir);
    agent.setCurrentSessionId('sess_cli');

    await agent.run('记录一下');

    const content = readTodayL2(episodicDir);
    expect(content).toContain('[sessionId: sess_cli]');
    expect(content).toContain('[tag: final_answer]');
  });

  it('双缺失（CLI 首轮）→ 拒绝写入，不产出裸条目', async () => {
    const wsDir = join(BASE, 'missing');
    const episodicDir = join(wsDir, 'l2');
    const agent = await makeAgent(wsDir, episodicDir);

    await agent.run('记录一下');

    const content = readTodayL2(episodicDir);
    expect(content).toBe('');
  });
});
