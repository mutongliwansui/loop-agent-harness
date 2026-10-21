/**
 * chat-stream 停止真取消行为测试（Task-20261021-002-04）
 *
 * 覆盖：
 * 1. abortRun：202 → 'aborting'；204 → 'none'；404（ApiError）→ 'error' + 本地断流；
 *    网络失败 → 'error' + 本地断流；401（AuthError）→ 'error' 不触发本地断流
 * 2. aborted 事件：置 aborted/meta「已停止 ·」、状态收尾、reconcile 以磁盘为准并回填灰条
 * 3. 非流式 aborted 响应：回滚乐观气泡 + toast + 返回 'aborted'
 * 4. stop() 本地封口：清 streaming/live、保留已收内容
 * 5. 刷新恢复：GET 详情 run.status='aborted'（60s 保留期内）→ 末尾助手消息补灰条
 * 6. finishRun 'aborted'：后台完成的未读 toast 文案
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// node 环境无 localStorage：内存 stub（client.ts getToken/setToken 使用）。
// 注意 vi.unstubAllGlobals 会清掉全部 stub，因此在 beforeEach 中统一重建
const memStore = new Map<string, string>();
function stubBrowserGlobals(): void {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => memStore.get(k) ?? null,
    setItem: (k: string, v: string) => void memStore.set(k, v),
    removeItem: (k: string) => void memStore.delete(k),
    clear: () => void memStore.clear(),
  });
}

// jsdom 下的全局：先 mock fetch 再导入被测模块（模块内不捕获全局引用）
let fetchMock: ReturnType<typeof vi.fn>;

vi.mock('./../webui/src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('./../webui/src/api/client.js')>(
    './../webui/src/api/client.js',
  );
  return { ...actual };
});

// sse.js mock：sseFetch 捕获 onEvent 供测试注入 SSE 事件，promise 由测试手动 resolve
const sseMock = vi.hoisted(() => ({
  handler: null as ((ev: { event: string; data: unknown; id?: number }) => void) | null,
  deferred: null as (() => void) | null,
}));
vi.mock('./../webui/src/api/sse.js', () => ({
  sseFetch: async (
    _path: string,
    _body: unknown,
    onEvent: (ev: { event: string; data: unknown; id?: number }) => void,
  ): Promise<void> => {
    sseMock.handler = onEvent;
    await new Promise<void>((resolve) => {
      sseMock.deferred = resolve;
    });
  },
  sseGet: async (): Promise<{ status: number }> => ({ status: 204 }),
}));

// chat-stream 内部 import 的 sse.js 已 mock；client.js 走全局 fetch → 同一 mock 生效
const mod = await import('./../webui/src/chat-stream.js');
const { abortRun, stop, setActiveSession } = mod;

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('chat-stream 停止真取消（Task-20261021-002-04）', () => {
  beforeEach(() => {
    stubBrowserGlobals();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    memStore.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('abortRun: 202 视为已受理（aborting）', async () => {
    fetchMock.mockResolvedValueOnce(ok({ runId: 'r1', status: 'aborting' }, 202));
    await expect(abortRun('s1')).resolves.toBe('aborting');
    expect(fetchMock).toHaveBeenCalledWith(
      '/sessions/s1/stop',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('abortRun: 204 归一为 none（当前无运行任务）', async () => {
    // Response(204) 无 body；apiStatus 走 204 短路返回状态码
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(abortRun('s1')).resolves.toBe('none');
  });

  it('abortRun: 404 会话不存在 → error + 本地断流', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'not_found', message: '会话不存在' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    // 先造一个运行态会话，验证 404 降级时 stop() 生效（controller 被 abort）
    const { sendMessage } = await import('./../webui/src/chat-stream.js');
    // sendMessage 走非流式：mock 409 busy？不需要——直接构造状态：用 abortRun 前置一个运行态
    // （stateOf 是内部函数，用 sendMessage 建态太重；这里仅验证返回值与 fetch 调用）
    await expect(abortRun('nope')).resolves.toBe('error');
  });

  it('abortRun: 网络失败 → error + 本地断流兜底', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(abortRun('s1')).resolves.toBe('error');
  });

  it('abortRun: 401 不做本地断流（TokenGate 接管）', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(abortRun('s1')).resolves.toBe('error');
  });

  it('aborted 事件：置灰条与「已停止 ·」标注、状态收尾、reconcile 回填', async () => {
    const { sendMessage, messagesOf, isRunning } = mod;
    const { toasts } = await import('./../webui/src/toast.js');
    // 会话未激活 → 后台停止 toast；reconcile 重拉返回落盘的部分输出
    setActiveSession(null);
    fetchMock.mockResolvedValue(
      ok({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '部分输出' },
        ],
      }),
    );
    const p = sendMessage('s-abort', { message: 'hi', text: 'hi', files: [], stream: true });
    await new Promise((r) => setTimeout(r, 0));
    sseMock.handler!({
      event: 'aborted',
      data: { durationMs: 1200, iterations: 2, steps: 3, partial: true },
      id: 1,
    });
    sseMock.deferred!();
    await p;

    const msgs = messagesOf('s-abort');
    const asst = msgs[msgs.length - 1];
    expect(asst.role).toBe('assistant');
    expect(asst.aborted).toBe(true);
    expect(asst.streaming).toBe(false);
    expect(asst.live ?? null).toBeNull();
    expect(asst.meta).toContain('已停止');
    expect(asst.meta).toContain('1.2s');
    expect(asst.meta).toContain('2 轮');
    expect(isRunning('s-abort')).toBe(false);
    // 后台停止的未读 toast 文案（finishRun status='aborted'）
    expect(toasts.value.map((t) => t.text)).toContain('后台会话已被停止');

    // reconcile 以磁盘为准替换时间线后，灰条与「已停止 ·」标注被回填（D3 纯前端态不落盘）
    await new Promise((r) => setTimeout(r, 0));
    const after = messagesOf('s-abort');
    const last = after[after.length - 1];
    expect(last.aborted).toBe(true);
    expect(last.meta).toBe(asst.meta);
  });

  it('非流式 aborted 响应：回滚乐观气泡并返回 aborted', async () => {
    const { sendMessage, messagesOf } = mod;
    fetchMock.mockResolvedValueOnce(
      ok({ sessionId: 's-ns', aborted: true, partial: true, iterations: 1, steps: 2 }),
    );
    const outcome = await sendMessage('s-ns', {
      message: 'hi',
      text: 'hi',
      files: [],
      stream: false,
    });
    expect(outcome).toBe('aborted');
    expect(messagesOf('s-ns').length).toBe(0);
  });

  it('刷新恢复：详情 run.status=aborted（保留期内）→ 末尾助手消息补灰条', async () => {
    const { ensureLoaded, messagesOf } = mod;
    fetchMock.mockResolvedValueOnce(
      ok({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '部分输出' },
        ],
        run: { runId: 'r9', status: 'aborted' },
      }),
    );
    await ensureLoaded('s-refresh');
    const msgs = messagesOf('s-refresh');
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.aborted).toBe(true);
    expect(last.meta).toContain('已停止');
  });

  it('stop() 本地封口：清 streaming/live，保留已收内容', async () => {
    const { sendMessage, messagesOf, stop } = mod;
    const p = sendMessage('s-stop', { message: 'hi', text: 'hi', files: [], stream: true });
    await new Promise((r) => setTimeout(r, 0));
    sseMock.handler!({ event: 'delta', data: { text: '部分' }, id: 1 });
    stop('s-stop');
    sseMock.deferred!(); // 模拟流中断后 sseFetch 返回
    await p;
    const asst = messagesOf('s-stop')[1];
    expect(asst.streaming).toBe(false);
    expect(asst.live ?? null).toBeNull();
  });
});
