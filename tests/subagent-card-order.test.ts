/**
 * 后台子任务结果卡片的时间线位置回归
 *
 * 复现的 bug：两个子 Agent 后台任务完成后，结果卡片出现在本轮「用户消息之前」。
 * 根因：`updateSession` 只追加本轮消息、不重排已有条目；提交回调若立刻 append 卡片落盘，
 * 此刻本轮用户消息还只在内存（等首个快照/收尾才写盘），卡片就排到了用户消息前面。
 *
 * 修复后契约：本轮进行中提交/完成的卡片先排队，等本轮落盘结束（finally）再写，
 * 位置落在本轮消息之后（用户消息 → 助手回答 → 结果卡片）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';
import { SessionManager } from '../src/api/session-manager.js';
import { RunHub } from '../src/api/run-hub.js';
import { runMessageTurn } from '../src/api/handlers/messages.js';
import { subAgentRegistry } from '../src/agent/subagent-registry.js';
import type { HandlerContext } from '../src/api/router.js';
import type { AgentOptions, AgentResult, ChatMessage } from '../src/types.js';

const BASE = join(tmpdir(), 'loop-agent-tests', 'subagent-card-order');
const CARD_TAG = '<subagent_result>';
const USER_TEXT = '用子Agent做全量比对';

/** 最小假响应：非流式路径只用到 writableEnded / writeHead / end */
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

/** 一轮「助手调用了 delegate(background) 并收尾」的最小消息轨迹 */
function turnMessages(userText: string): ChatMessage[] {
  return [
    { role: 'user', content: userText },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_dg',
          type: 'function',
          function: { name: 'delegate', arguments: '{"task":"后台任务","background":true}' },
        },
      ],
    },
    { role: 'tool', content: '已提交后台子任务', tool_call_id: 'call_dg' },
    { role: 'assistant', content: '已提交两个后台子任务，完成后会以卡片通知。' },
  ];
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

/** 从落盘消息里定位：本轮用户消息、结果卡片 */
function locate(messages: ChatMessage[], userText: string): { user: number; cards: number[] } {
  return {
    user: messages.findIndex((m) => m.role === 'user' && (m.content ?? '') === userText),
    cards: messages
      .map((m, i) => (m.content?.includes(CARD_TAG) ? i : -1))
      .filter((i) => i >= 0),
  };
}

beforeAll(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
});
afterAll(() => rmSync(BASE, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
  subAgentRegistry.reset();
});

describe('后台子任务结果卡片位置', () => {
  it('本轮提交的卡片落盘在本轮用户消息之后，而非之前', async () => {
    const store = new SessionStore(BASE, false, BASE);
    await store.init();
    const created = await store.createSession('第一轮', [
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
    ]);

    const runAgent = async (id: string, input: string, options: AgentOptions): Promise<AgentResult> => {
      await options.onSubAgentStart?.({
        taskId: 'sub_1',
        task: '后台任务A',
        startedAt: Date.now(),
      });
      const messages = turnMessages(input);
      return { answer: '已提交', steps: [], iterations: 1, messages, transcript: messages };
    };

    const ctx = makeCtx(store, runAgent);
    await runMessageTurn(ctx as never, fakeRes() as never, created.id, USER_TEXT, false, '');

    const data = await store.loadSession(created.id);
    const at = locate(data.messages, USER_TEXT);
    expect(at.user).toBeGreaterThanOrEqual(0);
    expect(at.cards).toHaveLength(1);
    expect(at.cards[0]).toBeGreaterThan(at.user);
    // 位置在本轮消息之后：卡片是整条时间线的最后一条
    expect(at.cards[0]).toBe(data.messages.length - 1);
  });

  it('本轮内提交并完成：只写一张卡片（终态），且仍在本轮消息之后', async () => {
    const store = new SessionStore(BASE, false, BASE);
    await store.init();
    const created = await store.createSession('第一轮', [
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
    ]);

    const runAgent = async (id: string, input: string, options: AgentOptions): Promise<AgentResult> => {
      // 完成通知触发的唤醒轮次：不再重复提交/完成，避免测试里形成唤醒死循环
      if (!input.startsWith('[后台子任务完成通知]')) {
        await options.onSubAgentStart?.({
          taskId: 'sub_2',
          task: '后台任务B',
          startedAt: Date.now(),
        });
        await options.onSubAgentComplete?.({
          taskId: 'sub_2',
          task: '后台任务B',
          status: 'done',
          answer: '结论B',
          iterations: 2,
          elapsedMs: 3000,
        });
      }
      const messages = turnMessages(input);
      return { answer: '已提交', steps: [], iterations: 1, messages, transcript: messages };
    };

    const ctx = makeCtx(store, runAgent);
    await runMessageTurn(ctx as never, fakeRes() as never, created.id, USER_TEXT, false, '');
    // 收尾兜底会在完成通知未被消费时触发一次唤醒轮次：等它跑完再取盘上快照
    await new Promise((r) => setTimeout(r, 100));

    const data = await store.loadSession(created.id);
    const at = locate(data.messages, USER_TEXT);
    expect(at.cards).toHaveLength(1);
    expect(at.cards[0]).toBeGreaterThan(at.user);
    const card = data.messages[at.cards[0]];
    expect(card.content).toContain('status: done');
    expect(card.content).toContain('结论B');
    expect(card.content).not.toContain('status: running');
  });

  it('done 终态事件到达时卡片已落盘（前端收到终态后重建即可见）', async () => {
    const store = new SessionStore(BASE, false, BASE);
    await store.init();
    const created = await store.createSession('第一轮', [
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
    ]);

    const runAgent = async (id: string, input: string, options: AgentOptions): Promise<AgentResult> => {
      await options.onSubAgentStart?.({
        taskId: 'sub_3',
        task: '后台任务C',
        startedAt: Date.now(),
      });
      const messages = turnMessages(input);
      return { answer: '已提交', steps: [], iterations: 1, messages, transcript: messages };
    };

    // done 事件发出前必须已 flush：在 done 回调里同步取盘上快照
    const hub = new RunHub();
    let atDone: Promise<ChatMessage[]> | null = null;
    const origStart = hub.start.bind(hub);
    hub.start = (sid: string): string => {
      const runId = origStart(sid);
      hub.subscribe(sid, 0, (ev) => {
        if (ev.event === 'done') atDone = store.loadSession(sid).then((d) => d.messages);
      });
      return runId;
    };

    const ctx = makeCtx(store, runAgent, hub);
    await runMessageTurn(ctx as never, fakeRes() as never, created.id, USER_TEXT, false, '');

    expect(atDone).not.toBeNull();
    const seen = await (atDone as unknown as Promise<ChatMessage[]>);
    const at = locate(seen, USER_TEXT);
    expect(at.cards).toHaveLength(1);
    expect(at.cards[0]).toBeGreaterThan(at.user);
  });

  it('主 Agent 已结束：完成通知触发新一轮模型调用，合成输入不落盘（20261107-011 情况2）', async () => {
    const store = new SessionStore(BASE, false, BASE);
    await store.init();
    const created = await store.createSession('第一轮', [
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回答' },
    ]);

    let calls = 0;
    let captured: AgentOptions | undefined;
    const wakeInputs: string[] = [];
    const runAgent = async (id: string, input: string, options: AgentOptions): Promise<AgentResult> => {
      calls++;
      if (calls === 1) {
        captured = options; // 模拟：后台任务仍在跑，主 run 结束时还没有完成
        const messages = turnMessages(input);
        return { answer: '已提交', steps: [], iterations: 1, messages, transcript: messages };
      }
      // 唤醒轮次：真实 agent 会在历史后追加合成 user 输入，再产出回答
      wakeInputs.push(input);
      const messages: ChatMessage[] = [
        ...(options.messages ?? []),
        { role: 'user', content: input },
        { role: 'assistant', content: '已根据后台结果继续处理。' },
      ];
      return {
        answer: '已根据后台结果继续处理。',
        steps: [],
        iterations: 1,
        messages,
        transcript: messages,
      };
    };

    const ctx = makeCtx(store, runAgent);
    await runMessageTurn(ctx as never, fakeRes() as never, created.id, USER_TEXT, false, '');
    expect(calls).toBe(1);

    // 主 run 已收尾后，后台子任务才完成 → 应触发新的模型调用
    await captured?.onSubAgentComplete?.({
      taskId: 'sub_4',
      task: '后台任务D',
      status: 'done',
      answer: '结论D',
      iterations: 2,
      elapsedMs: 2000,
    });
    await new Promise((r) => setTimeout(r, 300));

    expect(calls).toBe(2);
    expect(wakeInputs[0]).toContain('sub_4');
    expect(wakeInputs[0]).toContain('结论D');

    const data = await store.loadSession(created.id);
    // 合成输入只给 LLM 看：落盘历史里不应出现完成通知气泡
    expect(
      data.messages.some((m) => (m.content ?? '').startsWith('[后台子任务完成通知]')),
    ).toBe(false);
    // 结果卡片（终态）在本轮用户消息之后；唤醒轮次的回答在卡片之后
    const at = locate(data.messages, USER_TEXT);
    expect(at.cards).toHaveLength(1);
    expect(at.cards[0]).toBeGreaterThan(at.user);
    const answerAt = data.messages.findIndex(
      (m) => (m.content ?? '').includes('已根据后台结果继续处理'),
    );
    expect(answerAt).toBeGreaterThan(at.cards[0]);
  });
});
