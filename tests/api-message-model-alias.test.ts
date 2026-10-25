/**
 * POST /sessions/:id/messages 的 modelAlias 解析（task-20261025-002 D4/D11）
 *
 * 覆盖验收项：
 * - 缺省 / 空串 → 不注入凭据，agent 拿到的是全局配置（旧行为，CLI 等价）
 * - 合法 alias → runOptions 带该 profile 的 name/baseUrl/apiKey/temperature
 * - 不存在 alias → 400，消息里列出已登记别名（不静默回落）
 * - profile 无 apiKey → 400，提示补 key 的路径
 * - 成功后兜底写入会话元数据（前端在「新会话还没 id」时选了模型的情形）
 *
 * 手法：createApiServer 注入假 configLoader（runtime seam），
 * 不读写用户真实配置文件；runAgent 用 fake 捕获实际收到的 AgentOptions。
 */
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { SessionStore } from '../src/session/store.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import type { AgentOptions } from '../src/types.js';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-model-alias');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');

/** 测试用登记簿：一个完整 profile、一个缺 key 的 profile */
function makeConfig(): AgentConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.api = { ...cfg.api, port: 0 };
  cfg.models = {
    active: 'deepseek',
    profiles: {
      deepseek: {
        name: 'deepseek-chat',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-deepseek',
        temperature: 0.2,
      },
      glm: {
        name: 'glm-4-plus',
        baseUrl: 'https://tokenhub.haizhi.com/v1',
        apiKey: 'sk-glm',
      },
      nokey: {
        name: 'gpt-x',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
      },
    },
  };
  return cfg;
}

type Res = Awaited<ReturnType<typeof fetch>>;

let base = '';
let store: SessionStore;
let server: ApiServer;
let config: AgentConfig;
/** 最近一次 runAgent 收到的 options（用于断言凭据是否透传） */
let lastOptions: AgentOptions | null = null;

async function req(method: string, path: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function newSession(): Promise<string> {
  const res = await req('POST', '/sessions');
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  store = new SessionStore(TEST_WORKSPACE, false, TEST_DIR);
  await store.init();
  config = makeConfig();

  server = createApiServer({
    // 非流式：一次性返回 JSON，断言更直接
    runAgent: async (_sessionId, input, options) => {
      lastOptions = options;
      return {
        answer: 'ok',
        steps: [],
        iterations: 1,
        messages: [
          { role: 'user', content: input },
          { role: 'assistant', content: 'ok' },
        ],
      };
    },
    sessionStore: store,
    getConfig: () => config,
    // 假 configLoader：只实现 load()，不落盘、不读用户目录
    runtime: {
      configLoader: { load: () => ({ config }) } as never,
    },
  });
  const { port } = await server.start();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  lastOptions = null;
  config = makeConfig();
});

describe('POST /messages 的 modelAlias', () => {
  it('缺省 → 不注入任何凭据（走全局配置，与改动前一致）', async () => {
    const id = await newSession();
    const res = await req('POST', `/sessions/${id}/messages`, { message: '你好', stream: false });
    expect(res.status).toBe(200);
    expect(lastOptions?.model).toBeUndefined();
    expect(lastOptions?.baseUrl).toBeUndefined();
    expect(lastOptions?.apiKey).toBeUndefined();
    expect(lastOptions?.temperature).toBeUndefined();
  });

  it('空串 / 纯空白 → 同样视为未指定', async () => {
    const id = await newSession();
    const res = await req('POST', `/sessions/${id}/messages`, {
      message: '你好',
      stream: false,
      modelAlias: '   ',
    });
    expect(res.status).toBe(200);
    expect(lastOptions?.baseUrl).toBeUndefined();
    expect(lastOptions?.apiKey).toBeUndefined();
  });

  it('合法 alias → 模型名/地址/key/温度全部透传', async () => {
    const id = await newSession();
    const res = await req('POST', `/sessions/${id}/messages`, {
      message: '你好',
      stream: false,
      modelAlias: 'deepseek',
    });
    expect(res.status).toBe(200);
    expect(lastOptions?.model).toBe('deepseek-chat');
    expect(lastOptions?.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(lastOptions?.apiKey).toBe('sk-deepseek');
    expect(lastOptions?.temperature).toBe(0.2);
  });

  it('切到另一供应商（glm）时带的是该 profile 的地址与 key —— D5 的核心断言', async () => {
    const id = await newSession();
    const res = await req('POST', `/sessions/${id}/messages`, {
      message: '你好',
      stream: false,
      modelAlias: 'glm',
    });
    expect(res.status).toBe(200);
    expect(lastOptions?.model).toBe('glm-4-plus');
    expect(lastOptions?.baseUrl).toBe('https://tokenhub.haizhi.com/v1');
    expect(lastOptions?.apiKey).toBe('sk-glm');
    // 未设置 temperature 的 profile 不覆盖全局温度
    expect(lastOptions?.temperature).toBeUndefined();
  });

  it('alias 不存在 → 400 且消息列出已登记别名（不静默回落）', async () => {
    const id = await newSession();
    const res = await req('POST', `/sessions/${id}/messages`, {
      message: '你好',
      stream: false,
      modelAlias: 'ghost',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    const msg = body.error?.message ?? JSON.stringify(body);
    expect(msg).toContain('ghost');
    // 已登记别名按字典序列出
    expect(msg).toContain('deepseek');
    expect(msg).toContain('glm');
    expect(lastOptions).toBeNull(); // agent 根本没被调用
  });

  it('profile 缺 apiKey → 400 且提示补 key 的方式', async () => {
    const id = await newSession();
    const res = await req('POST', `/sessions/${id}/messages`, {
      message: '你好',
      stream: false,
      modelAlias: 'nokey',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? '').toContain('apiKey');
    expect(lastOptions).toBeNull();
  });

  it('成功后把选择兜底写进会话元数据（新会话先选模型再发消息也能记住）', async () => {
    const id = await newSession();
    const before = (await store.listSessions()).find((s) => s.id === id);
    expect(before?.modelAlias).toBeUndefined();

    const res = await req('POST', `/sessions/${id}/messages`, {
      message: '你好',
      stream: false,
      modelAlias: 'glm',
    });
    expect(res.status).toBe(200);

    // 兜底写入是 best-effort（void 异步），轮询等待
    let after = (await store.listSessions()).find((s) => s.id === id);
    for (let i = 0; i < 50 && after?.modelAlias !== 'glm'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      after = (await store.listSessions()).find((s) => s.id === id);
    }
    expect(after?.modelAlias).toBe('glm');
  });
});

describe('PUT /sessions/:id/model', () => {
  it('写入后 GET /sessions/:id 的 meta 能读回 alias', async () => {
    const id = await newSession();
    const put = await req('PUT', `/sessions/${id}/model`, { modelAlias: 'glm' });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { modelAlias: string | null }).modelAlias).toBe('glm');

    const detail = await req('GET', `/sessions/${id}`);
    const body = (await detail.json()) as { meta?: { modelAlias?: string } };
    expect(body.meta?.modelAlias).toBe('glm');
  });

  it('传 null 清除（回到跟随全局）', async () => {
    const id = await newSession();
    await req('PUT', `/sessions/${id}/model`, { modelAlias: 'glm' });
    const put = await req('PUT', `/sessions/${id}/model`, { modelAlias: null });
    expect(put.status).toBe(200);
    const detail = await req('GET', `/sessions/${id}`);
    const body = (await detail.json()) as { meta?: Record<string, unknown> };
    expect('modelAlias' in (body.meta ?? {})).toBe(false);
  });

  it('非法 alias → 400（与发消息口径一致）', async () => {
    const id = await newSession();
    const put = await req('PUT', `/sessions/${id}/model`, { modelAlias: 'ghost' });
    expect(put.status).toBe(400);
  });

  it('会话不存在 → 404', async () => {
    const put = await req('PUT', '/sessions/sess_not_exist/model', { modelAlias: 'glm' });
    expect(put.status).toBe(404);
  });

  it('modelAlias 类型非法（数字）→ 400', async () => {
    const id = await newSession();
    const put = await req('PUT', `/sessions/${id}/model`, { modelAlias: 123 });
    expect(put.status).toBe(400);
  });
});
