/**
 * 存量会话附件展示兜底（需求 20261113-003 D6）
 *
 * 老会话磁盘上没有 show_content / attachments（本需求上线前落盘），刷新页面时必须：
 * - 正文不裸渲 `[文件上传]` 原文（前端自行剥离）；
 * - 附件 chip 仍能显示（前端解析 content 兜底），但路径缺失时点击给出提示而非静默；
 * - 新会话磁盘已有 attachments 时优先用磁盘数据（不重复解析、顺序保持一致）。
 *
 * 另外锁定「前端与后端同形」：前端 stripUploadNotes / parseUploadNotes 是 src/upload/manager.ts
 * 的同形复制（webui 无法直接引 src/），两处实现漂移会让「发送当场」与「刷新之后」再次不一致。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildContextNote,
  parseUploadNotes as parseBackend,
  stripUploadNotes as stripBackend,
  type UploadEntry,
} from '../src/upload/manager.js';

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
const {
  ensureLoaded,
  messagesOf,
  setActiveSession,
  drop,
  setChatViewMounted,
  parseUploadNotes: parseFrontend,
  stripUploadNotes: stripFrontend,
} = mod;

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function entry(name = '20261113-094256-paste.png', bytes = 73011): UploadEntry {
  return {
    originalPath: `C:\\Users\\muton\\Pictures\\${name}`,
    targetPath: `C:\\Users\\muton\\.loop-agent\\uploads\\sess_x\\${name}`,
    fileName: name,
    bytes,
    uploadedAt: '2026-11-13T09:42:56.000Z',
  };
}

/** 发送端拼接形态 */
function withNote(notes: string[], body: string): string {
  return [...notes, body].filter(Boolean).join('\n\n');
}

describe('前后端同形（防「发送当场」与「刷新之后」再次不一致）', () => {
  it('stripUploadNotes：同一输入前后端输出一致', () => {
    const cases = [
      withNote([buildContextNote(entry())], '这张图里有什么？'),
      withNote([buildContextNote(entry('a.png')), buildContextNote(entry('b.png'))], '对比'),
      buildContextNote(entry()), // 纯附件
      '普通消息，没有任何附件',
      '[文件上传] 手打的假标记\n\n正文', // 误剥防护
      '',
    ];
    for (const c of cases) {
      expect(stripFrontend(c)).toBe(stripBackend(c));
    }
  });

  it('parseUploadNotes：同一输入前后端输出一致', () => {
    const cases = [
      withNote([buildContextNote(entry())], '问题'),
      withNote([buildContextNote(entry('a.png', 1024)), buildContextNote(entry('b.png', 2048))], '对比'),
      '[文件上传] 手打标记\n\n正文',
      '无附件',
    ];
    for (const c of cases) {
      expect(parseFrontend(c)).toEqual(parseBackend(c));
    }
  });
});

describe('D6 存量会话兜底（磁盘无 show_content / attachments）', () => {
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

  it('无 show_content 时正文剥离 note，附件由 content 解析兜底', async () => {
    detailMessages = [
      { role: 'user', content: withNote([buildContextNote(entry())], '这张图里有什么？'), is_show: true },
      { role: 'assistant', content: '是一只猫' },
    ];
    setActiveSession('sess_fb_attach1');
    await ensureLoaded('sess_fb_attach1');
    await Promise.resolve();

    const msgs = messagesOf('sess_fb_attach1');
    const userMsg = msgs.find((m) => m.role === 'user');
    const text = userMsg?.segments.find((s) => s.type === 'text') as { text: string } | undefined;

    // 正文干净：不出现内部实现细节
    expect(text?.text).toBe('这张图里有什么？');
    expect(text?.text).not.toContain('[文件上传]');
    expect(text?.text).not.toContain('上传路径');
    // chip 可恢复
    expect(userMsg?.files).toEqual(['20261113-094256-paste.png']);
    expect(userMsg?.attachments?.[0].path).toContain('.loop-agent\\uploads\\');
    drop('sess_fb_attach1');
  });

  it('多附件兜底：chip 顺序与 content 中 note 顺序一致', async () => {
    const notes = [buildContextNote(entry('a.png', 1024)), buildContextNote(entry('b.png', 2048))];
    detailMessages = [{ role: 'user', content: withNote(notes, '对比这两张'), is_show: true }];
    setActiveSession('sess_fb_attach2');
    await ensureLoaded('sess_fb_attach2');
    await Promise.resolve();

    const userMsg = messagesOf('sess_fb_attach2').find((m) => m.role === 'user');
    expect(userMsg?.files).toEqual(['a.png', 'b.png']);
    expect(userMsg?.attachments?.map((a) => a.fileName)).toEqual(['a.png', 'b.png']);
    drop('sess_fb_attach2');
  });

  it('磁盘已有 attachments 时优先用磁盘数据（缺失 mime 也照磁盘走）', async () => {
    detailMessages = [
      {
        role: 'user',
        content: withNote([buildContextNote(entry())], '新格式消息'),
        show_content: '新格式消息',
        is_show: true,
        // 故意与 content 不同名，验证「磁盘优先」而非重新解析
        attachments: [{ fileName: 'disk.png', bytes: 123, path: '/disk/disk.png', mime: 'image/png' }],
      },
    ];
    setActiveSession('sess_fb_attach3');
    await ensureLoaded('sess_fb_attach3');
    await Promise.resolve();

    const userMsg = messagesOf('sess_fb_attach3').find((m) => m.role === 'user');
    expect(userMsg?.files).toEqual(['disk.png']);
    expect(userMsg?.attachments?.[0].path).toBe('/disk/disk.png');
    const text = userMsg?.segments.find((s) => s.type === 'text') as { text: string } | undefined;
    expect(text?.text).toBe('新格式消息');
    drop('sess_fb_attach3');
  });

  it('attachments 结构损坏（非数组 / 缺 path）时降级为解析 content，不抛错', async () => {
    detailMessages = [
      {
        role: 'user',
        content: withNote([buildContextNote(entry())], '坏字段'),
        is_show: true,
        attachments: [{ fileName: 'broken-no-path' }],
      },
    ];
    setActiveSession('sess_fb_attach4');
    await ensureLoaded('sess_fb_attach4');
    await Promise.resolve();

    const userMsg = messagesOf('sess_fb_attach4').find((m) => m.role === 'user');
    expect(userMsg?.files).toEqual(['20261113-094256-paste.png']);
    drop('sess_fb_attach4');
  });

  it('纯附件消息（无正文）兜底后气泡正文为空串、chip 仍在', async () => {
    detailMessages = [{ role: 'user', content: buildContextNote(entry()), is_show: true }];
    setActiveSession('sess_fb_attach5');
    await ensureLoaded('sess_fb_attach5');
    await Promise.resolve();

    const userMsg = messagesOf('sess_fb_attach5').find((m) => m.role === 'user');
    const text = userMsg?.segments.find((s) => s.type === 'text') as { text: string } | undefined;
    expect(text?.text).toBe('');
    expect(userMsg?.files).toHaveLength(1);
    drop('sess_fb_attach5');
  });

  it('普通消息（无附件）不产生 files / attachments（零噪音）', async () => {
    detailMessages = [{ role: 'user', content: '就是一句普通提问', is_show: true }];
    setActiveSession('sess_fb_attach6');
    await ensureLoaded('sess_fb_attach6');
    await Promise.resolve();

    const userMsg = messagesOf('sess_fb_attach6').find((m) => m.role === 'user');
    expect(userMsg?.files).toBeUndefined();
    expect(userMsg?.attachments).toBeUndefined();
    drop('sess_fb_attach6');
  });
});
