/**
 * 后台子任务全局可感知（需求 20261107-008 P1）
 *
 * 背景（task-006 §2.2/§2.3）：后台任务生命周期远长于主 run。主 run 一 done，SSE 就关闭，
 * 此后 subagent_event / subagent_result 无人接收；原轮询只在「SSE 活跃时收到 sub_ start 事件」
 * 才启动，刷新页面或错过事件就永久失联 → 运行中看不见、完成也不知道。
 *
 * 本文件覆盖治理后的数据驱动链路：
 * - G2 加载即补偿：不依赖任何 SSE 事件，会话加载后就能拿到「运行中 N」
 * - G2 轮询收敛：任务结束后停表并以落盘历史重建时间线
 * - G4 完成提示：运行中 → 终态时弹 toast（仅本端正在看该会话）
 * - G3 resync 排队：重建期间的再次重建请求不被丢弃
 * - 删除会话：停轮询、清快照，不残留全局计数
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const memStore = new Map<string, string>();
function stubBrowserGlobals(): void {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => memStore.get(k) ?? null,
    setItem: (k: string, v: string) => void memStore.set(k, v),
    removeItem: (k: string) => void memStore.delete(k),
    clear: () => void memStore.clear(),
  });
}

// sse.js 全程不产生事件：本文件的关注点是「没有 SSE 事件也要能感知」
vi.mock('./../webui/src/api/sse.js', () => ({
  sseFetch: async (): Promise<void> => {},
  sseGet: async (): Promise<{ status: number }> => ({ status: 204 }),
}));

const toastMock = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('./../webui/src/toast.js', () => toastMock);

const mod = await import('./../webui/src/chat-stream.js');
const {
  ensureLoaded,
  subAgentTasksOf,
  subAgentRunningCount,
  setActiveSession,
  setChatViewMounted,
  reloadHistory,
  drop,
} = mod;

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** 一轮轮询间隔（与 chat-stream 的 SUB_POLL_MS 对齐） */
const POLL_MS = 2000;

let fetchMock: ReturnType<typeof vi.fn>;
/** /subagents 返回的任务列表（测试中途可改） */
let subItems: { taskId: string; task: string; status: string; startedAt?: number; elapsedMs?: number; iterations?: number }[];
/** GET /sessions/:id 返回的消息列表 */
let detailMessages: unknown[];
/** 统计各路径请求次数 */
let calls: { detail: number; subs: number };

function installFetch(): void {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/subagents')) {
      calls.subs++;
      return ok({ items: subItems });
    }
    if (url.includes('/context')) {
      return ok({ contextTokens: 0, maxTokens: 1000, threshold: 800, source: 'estimate' });
    }
    calls.detail++;
    return ok({ messages: detailMessages, run: null });
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** 冲刷微任务队列（让 void 的异步补偿跑完） */
async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('后台子任务全局可感知（需求 20261107-008）', () => {
  beforeEach(() => {
    stubBrowserGlobals();
    calls = { detail: 0, subs: 0 };
    subItems = [];
    detailMessages = [{ role: 'user', content: '你好', is_show: true }];
    toastMock.showToast.mockClear();
    installFetch();
    vi.useFakeTimers();
    setChatViewMounted(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setChatViewMounted(false);
    setActiveSession(null);
  });

  it('加载会话即补偿：无任何 SSE 事件也能拿到运行中的任务快照（G2）', async () => {
    subItems = [
      { taskId: 'sub_aaa', task: '做全量测试', status: 'running', startedAt: Date.now() },
    ];
    setActiveSession('sess_g1');

    await ensureLoaded('sess_g1');
    await flush();

    expect(calls.subs).toBeGreaterThanOrEqual(1);
    expect(subAgentTasksOf('sess_g1')).toHaveLength(1);
    expect(subAgentTasksOf('sess_g1')[0].taskId).toBe('sub_aaa');
    expect(subAgentRunningCount.value).toBe(1);

    drop('sess_g1');
  });

  it('轮询收敛：任务结束后停表，并且以落盘历史重建时间线', async () => {
    subItems = [
      { taskId: 'sub_bbb', task: '比对 README', status: 'running', startedAt: Date.now() },
    ];
    setActiveSession('sess_g2');

    await ensureLoaded('sess_g2');
    await flush();
    expect(subAgentRunningCount.value).toBe(1);
    const detailBefore = calls.detail;

    // 任务完成：下一轮轮询应发现无 running → 停表 + resync
    subItems = [
      { taskId: 'sub_bbb', task: '比对 README', status: 'done', elapsedMs: 5000, iterations: 3 },
    ];
    detailMessages = [
      { role: 'user', content: '你好', is_show: true },
      { role: 'user', content: '<subagent_result>\ntaskId: sub_bbb\nstatus: done\ntask: 比对 README\nelapsedMs: 5000\niterations: 3\nanswer: ok\nerror: \n</subagent_result>', is_show: true, kind: 'subagent_result' },
    ];

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    expect(calls.detail).toBeGreaterThan(detailBefore); // resync 重新拉了历史
    expect(subAgentRunningCount.value).toBe(0);
    // 收敛后进入「唤醒观察期」（20261107-011 情况2）：主 Agent 可能被完成通知唤醒并启动新 run，
    // 需要多观察几个周期才能接上，因此不再立即停表
    const subsAfterConverge = calls.subs;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    await flush();
    expect(calls.subs).toBeGreaterThan(subsAfterConverge);
    // 观察期结束（5 个空闲 tick）后停表：再推进若干个周期不再请求 /subagents
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    await flush();
    const subsAfter = calls.subs;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    await flush();
    expect(calls.subs).toBe(subsAfter);

    drop('sess_g2');
  });

  it('完成提示：运行中 → 终态时弹一次 toast，且不重复弹（G4）', async () => {
    subItems = [
      { taskId: 'sub_ccc', task: '写 PPT', status: 'running', startedAt: Date.now() },
    ];
    setActiveSession('sess_g3');

    await ensureLoaded('sess_g3');
    await flush();
    expect(toastMock.showToast).not.toHaveBeenCalled(); // 首次见到 running 不提示

    subItems = [
      { taskId: 'sub_ccc', task: '写 PPT', status: 'done', elapsedMs: 12000, iterations: 4 },
    ];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    expect(toastMock.showToast).toHaveBeenCalledTimes(1);
    expect(String(toastMock.showToast.mock.calls[0][0])).toContain('sub_ccc');

    // 再触发一次刷新（重复完成通知）不重复提示
    await reloadHistory('sess_g3');
    await flush();
    expect(toastMock.showToast).toHaveBeenCalledTimes(1);

    drop('sess_g3');
  });

  it('不看该会话时不打扰：完成提示不弹（交给未读/侧栏）', async () => {
    subItems = [
      { taskId: 'sub_ddd', task: '别的会话任务', status: 'running', startedAt: Date.now() },
    ];
    setActiveSession('sess_g4');

    await ensureLoaded('sess_g4');
    await flush();

    // 切到别的会话后再收敛
    setActiveSession('sess_other');
    subItems = [{ taskId: 'sub_ddd', task: '别的会话任务', status: 'done', elapsedMs: 3000 }];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    expect(toastMock.showToast).not.toHaveBeenCalled();
    expect(subAgentRunningCount.value).toBe(0);

    drop('sess_g4');
  });

  it('resync 排队：重建期间的再次重建不被丢弃（G3）', async () => {
    setActiveSession('sess_g5');
    await ensureLoaded('sess_g5');
    await flush();

    // 让下一次 /sessions/:id 挂起，模拟「正在重建」
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let gated = false;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/subagents')) return ok({ items: [] });
      if (url.includes('/context')) return ok({ source: 'estimate' });
      if (!gated) {
        gated = true;
        await gate; // 第一次重建：卡住
      }
      calls.detail++;
      return ok({ messages: detailMessages, run: null });
    });

    const first = reloadHistory('sess_g5');
    await flush(4); // 进入 reloading
    const second = reloadHistory('sess_g5'); // 应被排队而不是丢弃
    await flush(4);
    release?.();
    await first;
    await second;
    await flush();

    // 首个重建 + 补执行的那次，共两次
    expect(calls.detail).toBeGreaterThanOrEqual(2);

    drop('sess_g5');
  });

  it('删除会话：停轮询并清空快照，全局计数不残留', async () => {
    subItems = [
      { taskId: 'sub_eee', task: '长任务', status: 'running', startedAt: Date.now() },
    ];
    setActiveSession('sess_g6');

    await ensureLoaded('sess_g6');
    await flush();
    expect(subAgentRunningCount.value).toBe(1);

    drop('sess_g6');
    expect(subAgentTasksOf('sess_g6')).toHaveLength(0);
    expect(subAgentRunningCount.value).toBe(0);

    const subsAfter = calls.subs;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    await flush();
    expect(calls.subs).toBe(subsAfter); // 轮询已停
  });
});
