/**
 * 后台任务完成通知不进入 LLM 历史前缀（需求 20261105-001 D9）
 *
 * 背景：旧实现把通知 pushMessage 成普通 user 消息，通知会
 *  - 在该 run 后续每一轮请求里重复出现（提示前缀被污染）
 *  - 落盘后成为历史，下一轮/重启后被当作正常历史注入
 *  - 被 L2 记忆注入误当作「最后一条 user 消息」（记忆前缀挂到通知上）
 *
 * 覆盖：
 * - 通知只在 drain 的那一轮作为尾部消息投递一次，下一轮请求不含通知
 * - result.messages 仍保留通知（前端据此渲染通知卡片）
 * - SessionStore.getRestoreMessages 过滤通知（含旧版记忆前缀包裹的遗留形态）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { ReActAgent } from '../src/agent/react-agent.js';
import { ConfigLoader } from '../src/config/index.js';
import { SessionStore } from '../src/session/store.js';
import { registry } from '../src/tools/index.js';
import {
  backgroundTasks,
  setRunsDirForTest,
} from '../src/tools/background-tasks.js';
import {
  installBackgroundNoticeForwarder,
  resetBackgroundNoticesForTest,
} from '../src/agent/background-notice.js';
import {
  BACKGROUND_NOTICE_CLOSE,
  BACKGROUND_NOTICE_OPEN,
  isBackgroundNoticeContent,
  type ChatMessage,
} from '../src/types.js';

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

const BASE = join(tmpdir(), 'loop-agent-tests', 'background-notice-history');
const TOOL = 'notice_probe_echo';

function writeWorkspaceConfig(wsDir: string): void {
  mkdirSync(join(wsDir, '.loop-agent'), { recursive: true });
  writeFileSync(
    join(wsDir, '.loop-agent', '.agent-config.json'),
    JSON.stringify({
      skill: { enabled: false },
      session: { autoSave: false, autoRestore: false },
      model: { name: 'test-model', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', temperature: 0 },
      agent: { verbose: false, showTokenStats: false, llmLogEnabled: false, maxIterations: 6 },
      memory: { enabled: false },
    }),
    'utf-8',
  );
}

/** 通知文本（与 renderNotice 输出结构一致） */
function noticeText(taskId: string): string {
  return [
    BACKGROUND_NOTICE_OPEN,
    `taskId: ${taskId}`,
    'command: echo done',
    'status: exited (exitCode=0)',
    'duration: 1.0s',
    'logTail:',
    'done',
    BACKGROUND_NOTICE_CLOSE,
  ].join('\n');
}

/** 入队一条完成通知（走真实 finish → 监听器 → 队列链路） */
function enqueueNotice(sessionId: string, taskId: string, runsDir: string, cwd: string): void {
  const logPath = join(runsDir, `${taskId}.log`);
  writeFileSync(logPath, 'done\n');
  backgroundTasks.start({ taskId, pid: 1, command: 'echo done', cwd, logPath, startedAt: Date.now(), sessionId });
  backgroundTasks.finish(taskId, 0);
}

describe('后台通知仅投递一次、不进历史前缀（20261105-001 D9）', () => {
  beforeAll(() => {
    rmSync(BASE, { recursive: true, force: true });
    mkdirSync(BASE, { recursive: true });
    registry.register({
      name: TOOL,
      description: '测试工具',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => 'ok',
    });
  });

  afterAll(() => {
    registry.unregister(TOOL);
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
    resetBackgroundNoticesForTest();
  });

  it('只出现在投递那一轮的请求里；下一轮与 result.messages 行为分别正确', async () => {
    const wsDir = join(BASE, 'main');
    const runsDir = join(BASE, 'runs');
    rmSync(runsDir, { recursive: true, force: true });
    mkdirSync(runsDir, { recursive: true });
    writeWorkspaceConfig(wsDir);
    setRunsDirForTest(runsDir);
    installBackgroundNoticeForwarder();

    const taskId = 'bg_00c0ffee_1700000000';
    enqueueNotice('s-notice', taskId, runsDir, wsDir);

    // 记录每次请求实际发给 LLM 的消息
    const calls: ChatMessage[][] = [];
    let n = 0;
    mocks.chatStream.mockImplementation(async function* (messages: ChatMessage[]) {
      calls.push((messages as ChatMessage[]).map((m) => ({ ...m })));
      n++;
      if (n === 1) {
        yield {
          type: 'done',
          response: {
            content: '先确认一下',
            tool_calls: [
              { id: 'call_1', type: 'function' as const, function: { name: TOOL, arguments: '{}' } },
            ],
            finish_reason: 'tool_calls' as const,
            usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
          },
        };
        return;
      }
      yield { type: 'delta', content: '已完成' };
      yield {
        type: 'done',
        response: { content: '已完成', finish_reason: 'stop' as const, usage: { prompt_tokens: 120, completion_tokens: 3, total_tokens: 123 } },
      };
    });

    const loader = new ConfigLoader(wsDir, join(wsDir, 'global'));
    const agent = new ReActAgent(loader);
    agent.setCurrentSessionId('s-notice');
    const result = await agent.run('后台任务跑完了吗');

    expect(calls.length).toBe(2);
    // 第一轮：通知作为尾部 user 消息投递
    const first = calls[0];
    expect(isBackgroundNoticeContent(first[first.length - 1].content)).toBe(true);
    expect(String(first[first.length - 1].content)).toContain(taskId);
    // 第二轮：历史视图不含通知（旧实现会一直带着）
    const second = calls[1];
    expect(second.some((m) => isBackgroundNoticeContent(m.content))).toBe(false);
    // 落盘/展示仍保留通知（前端据此渲染卡片）
    expect(result.messages.some((m) => isBackgroundNoticeContent(m.content))).toBe(true);
  });

  it('getRestoreMessages 过滤通知（含旧版记忆前缀包裹的遗留通知）', async () => {
    const root = join(BASE, 'store');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const store = new SessionStore(root, false, root);
    await store.init();
    const listener = `
## 相关历史记忆

<<<LOOP_AGENT_MEMORY_END_7f3a9c2e>>>

${noticeText('bg_00c0ffee_1600000000')}`;
    const created = await store.createSession('hi', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: noticeText('bg_00c0ffee_1600000001') },
      { role: 'user', content: listener },
    ]);

    const data = await store.loadSession(created.id);
    expect(data).toBeDefined();
    const restored = SessionStore.getRestoreMessages(data);
    expect(restored.some((m) => isBackgroundNoticeContent(m.content))).toBe(false);
    expect(restored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(restored[0].content).toBe('hi');
  });
});
