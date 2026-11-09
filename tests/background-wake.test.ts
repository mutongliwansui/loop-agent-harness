/**
 * 后台命令任务完成通知的空闲唤醒（需求 20261108-002）
 *
 * 契约：
 * - 会话空闲期间任务完成 → 以合成输入（[后台任务完成通知] 前缀）发起一轮 wake run；
 * - 主 run 运行期间完成 → 不唤醒，由该 run 的下一轮 LLM 前 drain 注入（情况1）；
 * - 唤醒轮次的合成输入只给 LLM 看，落盘历史不出现该气泡；
 *   通知详情由 display-only 卡片（<background_task_notification>）落盘展示；
 * - wakeIdle=false 时不请求唤醒；监听器可注销。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';
import { SessionManager } from '../src/api/session-manager.js';
import { RunHub } from '../src/api/run-hub.js';
import { runMessageTurn, scheduleBackgroundWake } from '../src/api/handlers/messages.js';
import {
  configureBackgroundNotify,
  drainBackgroundNotices,
  installBackgroundNoticeForwarder,
  onBackgroundNoticeWake,
  resetBackgroundNoticesForTest,
} from '../src/agent/background-notice.js';
import { backgroundTasks, setRunsDirForTest } from '../src/tools/background-tasks.js';
import type { HandlerContext } from '../src/api/router.js';
import type { AgentOptions, AgentResult, ChatMessage } from '../src/types.js';

const BASE = join(tmpdir(), 'loop-agent-tests', 'background-wake');
const WAKE_PREFIX = '[后台任务完成通知]';
const NOTICE_TAG = '<background_task_notification>';
const USER_TEXT = '帮我后台跑一下测试';

let runsDir = '';

function fakeRes(): unknown {
  const chunks: string[] = [];
  return {
    writableEnded: false,
    writeHead: () => {},
    end(this: { writableEnded: boolean }, chunk?: string) {
      if (chunk) chunks.push(chunk);
      this.writableEnded = true;
    },
    on: () => {},
    chunks,
  };
}

function makeCtx(
  store: SessionStore,
  runAgent: (id: string, input: string, options: AgentOptions) => Promise<AgentResult>,
  runs: RunHub = new RunHub(),
): HandlerContext {
  return {
    deps: { sessionStore: store, runAgent },
    sessions: new SessionManager(store),
    runs,
    log: () => {},
    configLoader: {} as never,
  } as unknown as HandlerContext;
}

/** 在 runs 目录登记一个已完成的后台任务（触发 finish 监听 → 通知入队） */
function finishFakeTask(taskId: string, sessionId: string, command = 'npm test'): void {
  const logPath = join(runsDir, `${taskId}.log`);
  writeFileSync(logPath, 'all tests passed\n');
  backgroundTasks.start({
    taskId,
    pid: 1,
    command,
    cwd: runsDir,
    logPath,
    startedAt: Date.now(),
    sessionId,
  });
  backgroundTasks.finish(taskId, 0);
}

beforeAll(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
});
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

beforeEach(() => {
  runsDir = join(BASE, `runs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(runsDir, { recursive: true });
  setRunsDirForTest(runsDir);
  resetBackgroundNoticesForTest();
  configureBackgroundNotify({ enabled: true, tailLines: 5, maxChars: 500, wakeIdle: true });
  installBackgroundNoticeForwarder();
});

afterEach(() => {
  setRunsDirForTest(undefined);
  resetBackgroundNoticesForTest();
});

describe('后台任务完成通知的空闲唤醒', () => {
  it('空闲期间任务完成：直接发起一轮 wake run，合成输入不落盘、通知卡片落盘', async () => {
    const store = new SessionStore(BASE, false, BASE);
    await store.init();
    const created = await store.createSession('第一轮', [
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
    ]);

    let calls = 0;
    const wakeInputs: string[] = [];
    const runAgent = async (
      id: string,
      input: string,
      options: AgentOptions,
    ): Promise<AgentResult> => {
      calls++;
      if (input.startsWith(WAKE_PREFIX)) {
        // 唤醒轮次：模拟真实 agent 首轮迭代 drain 通知并 pushMessage 进轨迹
        const notices = drainBackgroundNotices(id);
        wakeInputs.push(input);
        const messages: ChatMessage[] = [
          ...(options.messages ?? []),
          { role: 'user', content: input },
          ...notices.map((t) => ({ role: 'user' as const, content: t })),
          { role: 'assistant', content: '已根据后台任务结果继续处理。' },
        ];
        return {
          answer: '已根据后台任务结果继续处理。',
          steps: [],
          iterations: 1,
          messages,
          transcript: messages,
        };
      }
      const messages: ChatMessage[] = [
        { role: 'user', content: input },
        { role: 'assistant', content: '好的，任务已在后台运行。' },
      ];
      return { answer: '好的，任务已在后台运行。', steps: [], iterations: 1, messages, transcript: messages };
    };

    const ctx = makeCtx(store, runAgent);
    const detach = onBackgroundNoticeWake((sid) => scheduleBackgroundWake(ctx as never, sid));
    try {
      // 会话空闲（无 run）期间后台任务完成 → 唤醒
      finishFakeTask('bg_idle_0001', created.id);
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      detach();
    }

    expect(calls).toBe(1);
    expect(wakeInputs[0]).toContain(WAKE_PREFIX);
    expect(wakeInputs[0]).toContain('bg_idle_0001');

    const data = await store.loadSession(created.id);
    // 合成输入只给 LLM 看：落盘历史不出现唤醒气泡
    expect(data.messages.some((m) => (m.content ?? '').startsWith(WAKE_PREFIX))).toBe(false);
    // 通知详情以 display-only 卡片落盘（前端渲染通知卡片）
    expect(data.messages.some((m) => (m.content ?? '').includes(NOTICE_TAG))).toBe(true);
    // 唤醒轮次的回答在通知卡片之后
    const cardAt = data.messages.findIndex((m) => (m.content ?? '').includes(NOTICE_TAG));
    const answerAt = data.messages.findIndex((m) =>
      (m.content ?? '').includes('已根据后台任务结果继续处理'),
    );
    expect(cardAt).toBeGreaterThan(0);
    expect(answerAt).toBeGreaterThan(cardAt);
  });

  it('主 run 运行期间任务完成：不唤醒（情况1），收尾兜底补一次唤醒', async () => {
    const store = new SessionStore(BASE, false, BASE);
    await store.init();
    const created = await store.createSession('第一轮', [
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
    ]);

    let calls = 0;
    const wakeInputs: string[] = [];
    const runAgent = async (
      id: string,
      input: string,
      options: AgentOptions,
    ): Promise<AgentResult> => {
      calls++;
      if (input.startsWith(WAKE_PREFIX)) {
        drainBackgroundNotices(id);
        wakeInputs.push(input);
      }
      const messages: ChatMessage[] = input.startsWith(WAKE_PREFIX)
        ? [
            ...(options.messages ?? []),
            { role: 'user', content: input },
            { role: 'assistant', content: '已根据后台任务结果继续处理。' },
          ]
        : [
            { role: 'user', content: input },
            { role: 'assistant', content: '已提交后台任务，运行期间完成会注入下一轮。' },
          ];
      return {
        answer: input.startsWith(WAKE_PREFIX)
          ? '已根据后台任务结果继续处理。'
          : '已提交后台任务。',
        steps: [],
        iterations: 1,
        messages,
        transcript: messages,
      };
    };

    const ctx = makeCtx(store, runAgent);
    const detach = onBackgroundNoticeWake((sid) => scheduleBackgroundWake(ctx as never, sid));
    try {
      // 主 run 运行期间后台任务完成：监听器触发但 isRunning → 情况1 不唤醒
      const runAgentWithNotice = async (
        id: string,
        input: string,
        options: AgentOptions,
      ): Promise<AgentResult> => {
        const result = await runAgent(id, input, options);
        if (calls === 1) finishFakeTask('bg_run_0002', id);
        return result;
      };
      const wrappedCtx = makeCtx(store, runAgentWithNotice);
      await runMessageTurn(wrappedCtx as never, fakeRes() as never, created.id, USER_TEXT, false, '');
      // 主 run 收尾后：兜底应补一次唤醒
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      detach();
    }

    expect(calls).toBe(2);
    expect(wakeInputs[0]).toContain(WAKE_PREFIX);
  });

  it('运行中的 run 存在时 scheduleBackgroundWake 直接返回（情况1 防重入）', async () => {
    const store = new SessionStore(BASE, false, BASE);
    await store.init();
    const created = await store.createSession('第一轮', [
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
    ]);

    let calls = 0;
    const runAgent = async (id: string, input: string): Promise<AgentResult> => {
      calls++;
      const messages: ChatMessage[] = [
        { role: 'user', content: input },
        { role: 'assistant', content: 'ok' },
      ];
      return { answer: 'ok', steps: [], iterations: 1, messages, transcript: messages };
    };

    const runs = new RunHub();
    const ctx = makeCtx(store, runAgent, runs);
    finishFakeTask('bg_busy_0003', created.id);
    runs.start(created.id); // 标记运行中
    scheduleBackgroundWake(ctx as never, created.id);
    await new Promise((r) => setTimeout(r, 200));
    runs.finish(created.id, 'done', { event: 'done', data: {} });

    expect(calls).toBe(0); // 情况1：活跃 run 自行消费，不发起唤醒
    // 通知仍在队列，等该 run 的下一轮 drain 或用户下次输入
    expect(drainBackgroundNotices(created.id).length).toBe(1);
  });

  it('wakeIdle=false：任务完成不请求唤醒', async () => {
    configureBackgroundNotify({ enabled: true, wakeIdle: false });
    const store = new SessionStore(BASE, false, BASE);
    await store.init();
    const created = await store.createSession('第一轮', [
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
    ]);

    let wakeCalls = 0;
    const runAgent = async (id: string, input: string): Promise<AgentResult> => {
      wakeCalls++;
      const messages: ChatMessage[] = [
        { role: 'user', content: input },
        { role: 'assistant', content: 'ok' },
      ];
      return { answer: 'ok', steps: [], iterations: 1, messages, transcript: messages };
    };
    const ctx = makeCtx(store, runAgent);
    const detach = onBackgroundNoticeWake((sid) => scheduleBackgroundWake(ctx as never, sid));
    try {
      finishFakeTask('bg_off_0004', created.id);
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      detach();
    }

    expect(wakeCalls).toBe(0);
    // 通知仍正常入队（enabled 只关唤醒，不关通知）
    expect(drainBackgroundNotices(created.id).length).toBe(1);
  });

  it('onBackgroundNoticeWake：回调收到会话 ID，注销后不再触发', async () => {
    const seen: string[] = [];
    const detach = onBackgroundNoticeWake((sid) => seen.push(sid));
    finishFakeTask('bg_cb_0005', 'sess-a');
    expect(seen).toEqual(['sess-a']);

    detach();
    finishFakeTask('bg_cb_0006', 'sess-b');
    expect(seen).toEqual(['sess-a']); // 注销后不再触发
  });
});
