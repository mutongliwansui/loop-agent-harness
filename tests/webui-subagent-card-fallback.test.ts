/**
 * 前端展示兜底回归（需求 20261108-003）：
 * 1) 卡片 kind 被清掉后，前端按内容特征仍能识别为卡片（不裸渲 <subagent_result> 原文）
 * 2) show_content 缺失时，普通 user 消息展示前剥离 L2 记忆注入前缀
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

vi.mock('./../webui/src/api/sse.js', () => ({
  sseFetch: async (): Promise<void> => {},
  sseGet: async (): Promise<{ status: number }> => ({ status: 204 }),
}));

const mod = await import('./../webui/src/chat-stream.js');
const { ensureLoaded, messagesOf, setActiveSession, drop, setChatViewMounted } = mod;

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const CARD = [
  '<subagent_result>',
  'taskId: sub_fb_1',
  'status: done',
  'task: 渲染兜底验证',
  'elapsedMs: 800',
  'iterations: 1',
  'answer: 完成',
  'error: ',
  '</subagent_result>',
].join('\n');

const MEM_PREFIX =
  '## 相关历史记忆\n以下是你在之前会话中积累的相关信息，请参考：\n某段历史记忆\n\n' +
  '<<<LOOP_AGENT_MEMORY_END_7f3a9c2e>>>\n\n';

describe('需求 20261108-003：前端展示兜底', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let detailMessages: unknown[];

  beforeEach(() => {
    stubBrowserGlobals();
    detailMessages = [];
    fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/context')) {
        return ok({ contextTokens: 0, maxTokens: 1000, threshold: 800, source: 'estimate' });
      }
      return ok({ messages: detailMessages, run: null });
    });
    vi.stubGlobal('fetch', fetchMock);
    setChatViewMounted(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setChatViewMounted(false);
    setActiveSession(null);
  });

  it('kind 被清掉的卡片仍按卡片渲染（内容特征兜底）', async () => {
    detailMessages = [
      { role: 'user', content: '你好', is_show: true },
      // 存量脏数据形态：kind 丢失，仅剩内容特征
      { role: 'user', content: CARD, is_show: true },
    ];
    setActiveSession('sess_fb1');
    await ensureLoaded('sess_fb1');
    await Promise.resolve();

    const msgs = messagesOf('sess_fb1');
    expect(msgs.some((m) => m.subResult?.taskId === 'sub_fb_1')).toBe(true);
    // 原文不得作为文本段渲染
    expect(msgs.some((m) => m.segments.some((s) => s.type === 'text' && s.text.includes('<subagent_result>')))).toBe(false);
    drop('sess_fb1');
  });

  it('show_content 缺失时剥离记忆前缀；有 show_content 时优先使用', async () => {
    detailMessages = [
      // 存量脏数据形态：content 带前缀且无 show_content
      { role: 'user', content: MEM_PREFIX + '带前缀的提问', is_show: true },
      // 正常形态：show_content 为纯净原文
      { role: 'user', content: MEM_PREFIX + '另一条提问', show_content: '另一条提问', is_show: true },
    ];
    setActiveSession('sess_fb2');
    await ensureLoaded('sess_fb2');
    await Promise.resolve();

    const msgs = messagesOf('sess_fb2');
    const texts = msgs
      .flatMap((m) => m.segments)
      .filter((s) => s.type === 'text')
      .map((s) => (s as { type: 'text'; text: string }).text);
    expect(texts).toContain('带前缀的提问');
    expect(texts).toContain('另一条提问');
    expect(texts.some((t) => t.includes('相关历史记忆'))).toBe(false);
    expect(texts.some((t) => t.includes('LOOP_AGENT_MEMORY_END'))).toBe(false);
    drop('sess_fb2');
  });
});
