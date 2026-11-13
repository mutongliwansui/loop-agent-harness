/**
 * 上传附件落盘与模型请求隔离（需求 20261113-003 P0）
 *
 * 覆盖三处断点修复：
 * - 落盘侧：`content` 一字不动（模型仍可取图）、`show_content` 为纯净正文、`attachments` 结构化；
 * - 零膨胀：无附件的普通消息不出现 `show_content` / `attachments`（D2）；
 * - 模型隔离：`attachments` 必须被 normalizeMessages 剥掉，否则非标准字段触发 API 400（D8）；
 * - 重试等价：`attachments` 重建 note 拼回正文，与首轮 content 逐字节一致（D4）。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore, workspaceId } from '../src/session/store.js';
import {
  buildContextNote,
  parseUploadNotes,
  rebuildContextNote,
  type UploadEntry,
} from '../src/upload/manager.js';
import { llm } from '../src/llm/client.js';
import type { ChatMessage } from '../src/types.js';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('openai', () => {
  class APIError extends Error {
    status: number | undefined;
    constructor(status: number | undefined, message: string) {
      super(message);
      this.name = 'APIError';
      this.status = status;
    }
  }
  class MockOpenAI {
    static APIError = APIError;
    chat = { completions: { create: createMock } };
    constructor(_opts?: unknown) {}
  }
  return { default: MockOpenAI };
});

let root: string;
let userDir: string;
let store: SessionStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loop-agent-attach-'));
  userDir = join(root, 'user');
  store = new SessionStore(join(root, 'workspace'), false, userDir);
  await store.init();
  createMock.mockReset();
  createMock.mockResolvedValue({
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function sessionFile(id: string): string {
  return join(userDir, 'sessions', workspaceId(join(root, 'workspace')), `${id}.json`);
}

/** 构造上传记录（图片） */
function entry(name = '20261113-094256-paste.png', bytes = 73011): UploadEntry {
  return {
    originalPath: `C:\\Users\\muton\\Pictures\\${name}`,
    targetPath: `C:\\Users\\muton\\.loop-agent\\uploads\\sess_x\\${name}`,
    fileName: name,
    bytes,
    uploadedAt: '2026-11-13T09:42:56.000Z',
  };
}

/** 发送端拼接形态：note + "\n\n" + 正文（与 ChatView.send 一致） */
function userContentWithNote(notes: string[], body: string): string {
  return [...notes, body].filter(Boolean).join('\n\n');
}

/** 直接读磁盘 JSON，绕过任何读取侧归一化，看「真落盘了什么」 */
async function readStored(id: string): Promise<{ messages: ChatMessage[] }> {
  return JSON.parse(await readFile(sessionFile(id), 'utf-8')) as { messages: ChatMessage[] };
}

describe('P0 落盘：content 不动 / show_content 纯净 / attachments 结构化', () => {
  it('带附件消息：content 保留完整 note，show_content 为正文，attachments 字段齐全', async () => {
    const content = userContentWithNote([buildContextNote(entry())], '这张图里有什么？');
    const created = await store.createSession('这张图里有什么？', [
      { role: 'user', content },
      { role: 'assistant', content: '是一只猫' },
    ]);

    const stored = await readStored(created.id);
    const u = stored.messages.find((m) => m.role === 'user') as ChatMessage & {
      show_content?: string;
      attachments?: Array<Record<string, unknown>>;
    };

    // D1：content 一字不动——模型侧仍能看到绝对路径与 MIME，analyzeImage 才取得到图
    expect(u.content).toBe(content);
    expect(u.content).toContain('  上传路径: C:\\Users\\muton\\.loop-agent\\uploads\\sess_x\\');
    expect(u.content).toContain('  类型: 图片 image/png');
    // 展示版干净
    expect(u.show_content).toBe('这张图里有什么？');
    // 结构化元信息
    expect(u.attachments).toEqual([
      {
        fileName: '20261113-094256-paste.png',
        bytes: 73011,
        path: 'C:\\Users\\muton\\.loop-agent\\uploads\\sess_x\\20261113-094256-paste.png',
        mime: 'image/png',
      },
    ]);
  });

  it('多附件：attachments 顺序与 content 中 note 顺序一致', async () => {
    const notes = [buildContextNote(entry('a.png', 1024)), buildContextNote(entry('b.png', 2048))];
    const created = await store.createSession('对比两张图', [
      { role: 'user', content: userContentWithNote(notes, '对比两张图') },
    ]);

    const stored = await readStored(created.id);
    const u = stored.messages.find((m) => m.role === 'user') as ChatMessage & {
      show_content?: string;
      attachments?: Array<{ fileName: string }>;
    };
    expect(u.attachments?.map((a) => a.fileName)).toEqual(['a.png', 'b.png']);
    expect(u.show_content).toBe('对比两张图');
  });

  it('纯附件无正文：show_content 写空串（前端据此渲染「仅附件」气泡）', async () => {
    const note = buildContextNote(entry());
    const created = await store.createSession('附件', [{ role: 'user', content: note }]);

    const stored = await readStored(created.id);
    const u = stored.messages.find((m) => m.role === 'user') as ChatMessage & {
      show_content?: string;
      attachments?: unknown[];
    };
    expect(u.show_content).toBe('');
    expect(u.attachments).toHaveLength(1);
    expect(u.content).toBe(note);
  });

  it('D2 零膨胀：普通文本消息不出现 show_content 与 attachments', async () => {
    const created = await store.createSession('你好', [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你？' },
    ]);

    const stored = await readStored(created.id);
    for (const m of stored.messages) {
      expect(m).not.toHaveProperty('show_content');
      expect(m).not.toHaveProperty('attachments');
    }
  });

  it('记忆前缀 + 附件同时存在：两段都剥掉，attachments 仍解析得到', async () => {
    const prefix =
      '## 相关历史记忆\n以下是你在之前会话中积累的相关信息，请参考：\n某段记忆\n\n' +
      '<<<LOOP_AGENT_MEMORY_END_7f3a9c2e>>>\n\n';
    const note = buildContextNote(entry());
    const content = prefix + userContentWithNote([note], '看图说话');
    const created = await store.createSession('看图说话', [{ role: 'user', content }]);

    const stored = await readStored(created.id);
    const u = stored.messages.find((m) => m.role === 'user') as ChatMessage & {
      show_content?: string;
      attachments?: unknown[];
    };
    expect(u.show_content).toBe('看图说话');
    expect(u.attachments).toHaveLength(1);
    expect(u.content).toBe(content);
  });
});

describe('D8 模型请求隔离：attachments 不进 LLM 载荷', () => {
  it('落盘带 attachments 的消息经 normalizeMessages 后不含该键，content 原样发出', async () => {
    const content = userContentWithNote([buildContextNote(entry())], '这张图里有什么？');
    const created = await store.createSession('这张图里有什么？', [
      { role: 'user', content },
      { role: 'assistant', content: '是一只猫' },
    ]);
    const stored = await readStored(created.id);

    await llm.chat(stored.messages as ChatMessage[]);
    const sent = createMock.mock.calls[0][0].messages as Array<Record<string, unknown>>;

    for (const m of sent) {
      expect(m).not.toHaveProperty('attachments');
      expect(m).not.toHaveProperty('show_content');
    }
    // 模型侧必须仍能拿到完整 note（D1）
    const userSent = sent.find((m) => m.role === 'user');
    expect(String(userSent?.content)).toContain('[文件上传]');
    expect(String(userSent?.content)).toContain('  上传路径: ');
  });

  it('仅含 attachments 键的裸消息也被剥净（白名单漏项即 400 的回归锁）', async () => {
    await llm.chat([
      { role: 'user', content: 'x', attachments: [{ fileName: 'a', bytes: 1, path: '/p' }] },
    ] as ChatMessage[]);
    const sent = createMock.mock.calls[0][0].messages as Array<Record<string, unknown>>;
    expect(sent[0]).toEqual({ role: 'user', content: 'x' });
  });
});

describe('D4 重试等价：show_content + 重建 note 拼回完整 content', () => {
  it('重建结果与首轮 content 逐字节一致（模型输入与首次等价）', async () => {
    const content = userContentWithNote([buildContextNote(entry())], '这张图里有什么？');
    const created = await store.createSession('这张图里有什么？', [
      { role: 'user', content },
      { role: 'assistant', content: '是一只猫' },
    ]);

    const stored = await readStored(created.id);
    const u = stored.messages.find((m) => m.role === 'user') as ChatMessage & {
      show_content?: string;
      attachments?: Parameters<typeof rebuildContextNote>[0][];
    };
    // 复刻 sessions.ts 重试路径的拼接逻辑
    const rebuilt = (u.attachments ?? []).map(rebuildContextNote).join('\n\n');
    const text = [rebuilt, (u.show_content ?? '').trim()].filter(Boolean).join('\n\n');

    expect(text).toBe(content);
  });

  it('多附件重试同样逐字节等价（顺序不丢）', async () => {
    const notes = [buildContextNote(entry('a.png', 1024)), buildContextNote(entry('b.png', 2048))];
    const content = userContentWithNote(notes, '对比一下');
    const created = await store.createSession('对比一下', [{ role: 'user', content }]);

    const stored = await readStored(created.id);
    const u = stored.messages.find((m) => m.role === 'user') as ChatMessage & {
      show_content?: string;
      attachments?: Parameters<typeof rebuildContextNote>[0][];
    };
    const rebuilt = (u.attachments ?? []).map(rebuildContextNote).join('\n\n');
    const text = [rebuilt, (u.show_content ?? '').trim()].filter(Boolean).join('\n\n');
    expect(text).toBe(content);
  });

  it('存量消息（无 attachments / show_content）重试回退 content 原文', async () => {
    const content = userContentWithNote([buildContextNote(entry())], '老会话里的提问');
    const created = await store.createSession('老会话里的提问', [{ role: 'user', content }]);
    // 模拟存量数据：抹掉新字段
    const stored = await readStored(created.id);
    const legacy = stored.messages.map((m) => {
      const { show_content: _s, attachments: _a, ...rest } = m as ChatMessage & {
        show_content?: string;
        attachments?: unknown;
      };
      return rest;
    });
    const u = legacy.find((m) => m.role === 'user') as ChatMessage & {
      show_content?: string;
      attachments?: unknown[];
    };
    const rebuilt = (u.attachments ?? []).map(rebuildContextNote).join('\n\n');
    const text =
      [rebuilt, (u.show_content ?? '').trim()].filter(Boolean).join('\n\n') ||
      (u.content ?? '').trim();
    expect(text).toBe(content);
  });
});

describe('读取侧归一化不回退已写入的展示字段', () => {
  it('loadSession 读回后 show_content / attachments 仍在（前端有数据源）', async () => {
    const content = userContentWithNote([buildContextNote(entry())], '读回检查');
    const created = await store.createSession('读回检查', [
      { role: 'user', content },
      { role: 'assistant', content: '收到' },
    ]);

    const loaded = await store.loadSession(created.id);
    const u = loaded.messages.find((m) => m.role === 'user') as ChatMessage & {
      show_content?: string;
      attachments?: unknown[];
    };
    expect(u.show_content).toBe('读回检查');
    expect(u.attachments).toHaveLength(1);
    // content 仍完整（模型可见性不因回读而丢）
    expect(u.content).toBe(content);
    // 解析器对落盘字段自洽：磁盘 attachments 与重新解析 content 一致
    expect(u.attachments).toEqual(parseUploadNotes(content));
  });

  it('多次落盘不重复追加 attachments（幂等）', async () => {
    const content = userContentWithNote([buildContextNote(entry())], '幂等检查');
    const created = await store.createSession('幂等检查', [
      { role: 'user', content },
      { role: 'assistant', content: 'a' },
    ]);
    await store.rewriteMessages(created.id, (await store.loadSession(created.id)).messages);

    const stored = await readStored(created.id);
    const u = stored.messages.find((m) => m.role === 'user') as ChatMessage & {
      attachments?: unknown[];
    };
    expect(u.attachments).toHaveLength(1);
  });
});
