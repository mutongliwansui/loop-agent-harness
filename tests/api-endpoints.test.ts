/**
 * 命令资源化 REST 端点测试（Task-20261016-002 P0 + P1）
 *
 * 测试内容：
 * 1. uploads 组：POST（部分成功 201 / 全败 400 / 会话不存在 404 / 参数非法 400）、
 *    GET 列表、DELETE 清理（removed 布尔）、真实文件复制到临时 uploadsRoot
 * 2. config 组：GET 全量（secret 遮蔽）、GET /config/path（路由顺序：静态段先于 :key）、
 *    GET /config/:key（scope 来源 + 404）、PUT（默认 workspace / scope=global / restartRequired / 遮蔽回读）、
 *    DELETE（deleted 布尔）
 * 3. status 组：轻量快照结构
 * 4. tools 组（P1）：GET 列表/详情、PATCH 开关（落盘 + registry 同步 + 404/400）、POST reload
 * 5. models 组（P1）：POST 登记（201/409）、PUT 激活、GET 列表/快照（遮蔽）、DELETE（激活 409 / 跨层 404）、test 连通性
 * 6. mcp 组（P1）：POST 登记（连接失败 502 落盘 / 同名 409）、GET 列表/详情、reload failed、DELETE 反序
 * 7. skills 组（P1）：POST 安装（201/409/overwrite）、GET 列表/详情、DELETE、reload
 *    （Task-20261021-010-03：SkillLoader 的 workspace 目录显式取当前空间根 = TEST_WORKSPACE，
 *      用 API 自身 DELETE + 独特名清理）
 * 8. memory 组（P1）：status/curated/episodic/search/gate/dream(202)/init
 * 9. vision 组（P2）：GET 探测链状态（无 Key available:false / 假 Key available:true）、
 *    POST test 无 Key → ok:false（诊断语义，不触网）
 * 10. doctor 组（P2）：GET 逐项检查结构（ok 总开关与 blocker 一致性）
 *
 * D8/D9：createApiServer runtime 注入临时目录 ConfigLoader/ConfigWriter + uploadsRoot +
 * 临时 MCPManager + 临时目录版 createMemoryKit，起 port 0 真实 http server，fetch 断言；
 * CLI 命令层零改动。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { SessionStore } from '../src/session/store.js';
import { ConfigLoader } from '../src/config/loader.js';
import { ConfigWriter } from '../src/config/writer.js';
import { MCPManager } from '../src/config/mcp-manager.js';
import { createMemoryKit } from '../src/api/memory-kit.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-api-endpoints');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');
const TEST_GLOBAL_DIR = join(TEST_DIR, 'global');
const TEST_UPLOADS = join(TEST_DIR, 'uploads');

type Res = Awaited<ReturnType<typeof fetch>>;

// ===== 全局夹具 =====

let config: AgentConfig = structuredClone(DEFAULT_CONFIG);
let store: SessionStore;
let testLoader: ConfigLoader;
let testWriter: ConfigWriter;
let server: ApiServer;
let base = '';
/** 共享会话 id（uploads 组复用，避免同秒多会话创建的串行等待） */
let sessionId = '';

beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_WORKSPACE, { recursive: true });
  mkdirSync(TEST_GLOBAL_DIR, { recursive: true });

  store = new SessionStore(TEST_WORKSPACE, false, join(TEST_DIR, 'sessions'));
  await store.init();

  // 随机端口，避免占用默认 3000
  config = { ...config, api: { ...config.api, port: 0 } };

  // D8：临时目录实例注入（不触真实 ~/.loop-agent 与工作区配置）
  testLoader = new ConfigLoader(TEST_WORKSPACE, TEST_GLOBAL_DIR);
  testWriter = new ConfigWriter(TEST_WORKSPACE, TEST_GLOBAL_DIR, testLoader);

  const api = createApiServer({
    runAgent: async () => { throw new Error('本套件不触达 runAgent'); },
    sessionStore: store,
    getConfig: () => config,
    version: 'test-0.0.0',
    runtime: {
      configLoader: testLoader,
      configWriter: testWriter,
      uploadsRoot: TEST_UPLOADS,
      mcpManager: new MCPManager(testLoader),
      createMemoryKit: () => createMemoryKit(TEST_WORKSPACE, testLoader, {
        memoryRoot: join(TEST_DIR, 'memory'),
        globalCuratedDir: join(TEST_GLOBAL_DIR, 'curated'),
      }),
    },
  });
  server = api;
  const { port } = await api.start();
  base = `http://127.0.0.1:${port}`;

  // 共享会话
  const res = await req('POST', '/sessions');
  sessionId = ((await res.json()) as { id: string }).id;
});

afterAll(async () => {
  await server.close();
});

// ===== HTTP 辅助 =====

async function req(method: string, path: string, body?: unknown): Promise<Res> {
  return fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 在临时目录创建真实文件，返回绝对路径（uploads 复制源） */
function makeTmpFile(name: string, content = 'hello upload'): string {
  const dir = mkdtempSync(join(TEST_DIR, 'src-'));
  const p = join(dir, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

// ===== 1. uploads 组 =====

describe('uploads 组（POST / GET / DELETE /uploads）', () => {
  it('POST 全部成功 → 201，文件真实复制到 uploadsRoot/<sessionId>/，附 contextNote', async () => {
    const src = makeTmpFile('a.txt');
    const res = await req('POST', '/uploads', { sessionId, paths: [src] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      sessionId: string;
      entries: { originalPath: string; targetPath: string; bytes: number }[];
      contextNote: string;
      failed: unknown[];
    };
    expect(body.sessionId).toBe(sessionId);
    expect(body.failed).toEqual([]);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].originalPath).toBe(src);
    expect(body.entries[0].bytes).toBe('hello upload'.length);
    expect(body.entries[0].targetPath).toContain(join(TEST_UPLOADS, sessionId));
    expect(existsSync(body.entries[0].targetPath)).toBe(true);
    expect(body.contextNote).toContain('a.txt');
    expect(body.contextNote).toContain('[文件上传]');
  });

  it('POST 部分成功 → 201，failed 列出失败项与原因', async () => {
    const src = makeTmpFile('b.txt');
    const res = await req('POST', '/uploads', { sessionId, paths: [src, join(TEST_DIR, '不存在.txt')] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { entries: unknown[]; failed: { path: string; reason: string }[] };
    expect(body.entries).toHaveLength(1);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].reason).toBe('文件不存在');
  });

  it('POST 全部失败 → 400，消息含各失败原因', async () => {
    const res = await req('POST', '/uploads', { sessionId, paths: [join(TEST_DIR, '无1.txt'), join(TEST_DIR, '无2.txt')] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toContain('全部文件上传失败');
    expect(body.error.message).toContain('无1.txt');
  });

  it('POST 会话不存在 → 404；paths 缺失 / 空数组 / 含非字符串 → 400', async () => {
    const notFound = await req('POST', '/uploads', { sessionId: 'sess_unknown', paths: ['x'] });
    expect(notFound.status).toBe(404);
    expect(((await notFound.json()) as { error: { code: string } }).error.code).toBe('not_found');

    expect((await req('POST', '/uploads', { sessionId })).status).toBe(400);
    expect((await req('POST', '/uploads', { sessionId, paths: [] })).status).toBe(400);
    expect((await req('POST', '/uploads', { sessionId, paths: [123] })).status).toBe(400);
  });

  it('GET ?sessionId= 列出已上传文件（fileName/bytes/uploadedAt/targetPath）', async () => {
    const res = await req('GET', `/uploads?sessionId=${sessionId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      entries: { fileName: string; bytes: number; uploadedAt: string; targetPath: string }[];
    };
    expect(body.sessionId).toBe(sessionId);
    expect(body.entries.length).toBeGreaterThanOrEqual(2);
    const names = body.entries.map((e) => e.fileName);
    expect(names.some((n) => n.endsWith('a.txt'))).toBe(true);
    expect(body.entries.every((e) => e.bytes > 0 && e.uploadedAt && e.targetPath)).toBe(true);
  });

  it('GET 会话不存在 → 404；GET/DELETE 缺 sessionId → 400', async () => {
    expect((await req('GET', '/uploads?sessionId=sess_unknown')).status).toBe(404);
    expect((await req('GET', '/uploads')).status).toBe(400);
    expect((await req('DELETE', '/uploads')).status).toBe(400);
  });

  it('DELETE 清理 → removed:true，目录清空；重复删除 → removed:false', async () => {
    const res = await req('DELETE', `/uploads?sessionId=${sessionId}`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { removed: boolean }).toEqual({ sessionId, removed: true });

    const list = await req('GET', `/uploads?sessionId=${sessionId}`);
    expect(((await list.json()) as { entries: unknown[] }).entries).toEqual([]);

    const again = await req('DELETE', `/uploads?sessionId=${sessionId}`);
    expect((await again.json()) as { removed: boolean }).toEqual({ sessionId, removed: false });
  });
});

// ===== 2. config 组 =====

describe('config 组（GET /config、/config/path、GET|PUT|DELETE /config/:key）', () => {
  it('GET /config 返回全量生效配置；写入 secret 后回读被遮蔽', async () => {
    // 预置：写一个 token 到 workspace（同时覆盖 restartRequired 用例的前置）
    const put = await req('PUT', '/config/api.token', { value: 'my-secret-token' });
    expect(put.status).toBe(200);

    const res = await req('GET', '/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: { model: { name: string }; api: { token: string } } };
    expect(body.config.model.name).toBeTruthy();
    expect(body.config.api.token).toBe('****oken'); // 仅尾 4 位
  });

  it('GET /config/path 指向临时目录（静态段不被 :key 吞掉）', async () => {
    const res = await req('GET', '/config/path');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { globalPath: string; workspacePath: string; workspaceExists: boolean };
    expect(body.globalPath).toBe(join(TEST_GLOBAL_DIR, 'config.json'));
    expect(body.workspacePath).toBe(join(TEST_WORKSPACE, '.loop-agent', '.agent-config.json'));
    expect(body.workspaceExists).toBe(true); // 前序 PUT 已写盘
  });

  it('GET /config/:key 返回 {key, value, scope}；键不存在 → 404', async () => {
    const res = await req('GET', '/config/model.temperature');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; value: number; scope: string };
    expect(body.key).toBe('model.temperature');
    expect(typeof body.value).toBe('number');
    expect(['cli', 'workspace', 'global', 'env', 'default']).toContain(body.scope);

    const miss = await req('GET', '/config/no.such.key');
    expect(miss.status).toBe(404);
    expect(((await miss.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('PUT 默认写 workspace：盘上生效、GET 回读一致、响应 {key, scope, value}', async () => {
    const res = await req('PUT', '/config/model.temperature', { value: 0.7 });
    expect(res.status).toBe(200);
    expect((await res.json()) as { key: string; scope: string; value: number })
      .toEqual({ key: 'model.temperature', scope: 'workspace', value: 0.7 });

    const onDisk = await testLoader.loadWorkspace();
    expect((onDisk as { model?: { temperature?: number } }).model?.temperature).toBe(0.7);

    const get = await req('GET', '/config/model.temperature');
    const body = (await get.json()) as { value: number; scope: string };
    expect(body.value).toBe(0.7);
    expect(body.scope).toBe('workspace');
  });

  it('PUT scope=global 写入全局文件；中间段键路径自动建对象', async () => {
    const res = await req('PUT', '/config/agent.verbose', { value: false, scope: 'global' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { scope: string }).scope).toBe('global');

    const onDisk = await testLoader.loadGlobal();
    expect((onDisk as { agent?: { verbose?: boolean } }).agent?.verbose).toBe(false);
  });

  it('PUT scope 非法 → 400；缺 value → 400', async () => {
    expect((await req('PUT', '/config/model.name', { value: 'x', scope: 'session' })).status).toBe(400);
    expect((await req('PUT', '/config/model.name', {})).status).toBe(400);
    // 盘上未被误写
    const onDisk = await testLoader.loadWorkspace();
    expect((onDisk as { model?: { name?: string } }).model?.name).toBeUndefined();
  });

  it('PUT api.* → 响应附 restartRequired:true；普通键不附', async () => {
    const api = await req('PUT', '/config/api.host', { value: '127.0.0.1' });
    expect((await api.json()) as { restartRequired?: boolean }).toMatchObject({ restartRequired: true });

    const normal = await req('PUT', '/config/model.name', { value: 'switched-model' });
    expect((await normal.json()) as { restartRequired?: boolean }).not.toHaveProperty('restartRequired');
  });

  it('PUT 对象值整体写入并回读（如 vision 段内键）', async () => {
    const res = await req('PUT', '/config/vision.enabled', { value: true });
    expect(res.status).toBe(200);
    const get = await req('GET', '/config/vision.enabled');
    expect((await get.json()) as { value: boolean }).toEqual({ key: 'vision.enabled', value: true, scope: 'workspace' });
  });

  it('DELETE 存在的键 → deleted:true 且盘上移除；重复删除 → deleted:false', async () => {
    const res = await req('DELETE', '/config/model.temperature');
    expect(res.status).toBe(200);
    expect((await res.json()) as { deleted: boolean }).toEqual({ key: 'model.temperature', scope: 'workspace', deleted: true });

    const onDisk = await testLoader.loadWorkspace();
    expect((onDisk as { model?: { temperature?: number } }).model?.temperature).toBeUndefined();

    const again = await req('DELETE', '/config/model.temperature');
    expect((await again.json()) as { deleted: boolean }).toEqual({ key: 'model.temperature', scope: 'workspace', deleted: false });
  });

  it('DELETE ?scope=global 删除全局键；scope 非法 → 400', async () => {
    const res = await req('DELETE', '/config/agent.verbose?scope=global');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deleted: boolean }).deleted).toBe(true);

    expect((await req('DELETE', '/config/agent.verbose?scope=bogus')).status).toBe(400);
  });

  it('PUT 后 secret 键 GET 回读遮蔽（model.apiKey）', async () => {
    await req('PUT', '/config/model.apiKey', { value: 'sk-test-123456' });
    const res = await req('GET', '/config/model.apiKey');
    const body = (await res.json()) as { value: string };
    expect(body.value).toBe('****3456');
  });
});

// ===== 3. status 组 =====

describe('status 组（GET /status 轻量快照）', () => {
  it('返回 version / model / session / tools / mcp / memory / uploads 快照', async () => {
    // 保证 uploadsRoot 至少一个会话目录，验证 uploads.count 口径
    mkdirSync(join(TEST_UPLOADS, sessionId), { recursive: true });

    const res = await req('GET', '/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      model: { alias: string | null; provider: string; model: string };
      session: { current: string | null; count: number };
      tools: { total: number; disabled: number };
      mcp: { connected: number };
      memory: { enabled: boolean };
      uploads: { count: number };
    };
    expect(body.version).toBe('test-0.0.0');
    expect(body.model.model).toBe(config.model.name);
    expect(body.model.provider).toContain('.');
    expect(body.session.current).toBeNull();
    expect(body.session.count).toBeGreaterThanOrEqual(1); // 前序用例创建的共享会话
    expect(typeof body.tools.total).toBe('number');
    expect(body.tools.disabled).toBe(0);
    expect(body.mcp.connected).toBe(0);
    expect(body.memory.enabled).toBe(true); // DEFAULT_MEMORY_CONFIG.enabled=true
    expect(body.uploads.count).toBeGreaterThanOrEqual(1);
  });
});

// ===== 4. tools 组（P1）=====

describe('tools 组（GET /tools、GET|PATCH /tools/:name、POST /tools/reload）', () => {
  it('GET /tools 返回内置工具快照（vision 门控 + enabled 标记）', async () => {
    const res = await req('GET', '/tools');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tools: { name: string; description: string; enabled: boolean; source: string }[];
    };
    expect(body.tools.length).toBeGreaterThanOrEqual(5);
    const fileRead = body.tools.find((t) => t.name === 'fileRead');
    expect(fileRead).toMatchObject({ source: 'builtin', enabled: true });
    // vision.enabled 已被 config 组用例置 true → 视觉工具可见
    expect(body.tools.some((t) => t.name === 'describe_image')).toBe(true);
  });

  it('GET /tools/:name 内置工具含 schema；不存在 → 404', async () => {
    const res = await req('GET', '/tools/fileRead');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; enabled: boolean; source: string; schema: unknown };
    expect(body.name).toBe('fileRead');
    expect(body.source).toBe('builtin');
    expect(body.schema).toBeTruthy(); // JSON Schema

    const miss = await req('GET', '/tools/no_such_tool');
    expect(miss.status).toBe(404);
  });

  it('PATCH 禁用 → 落盘 disabled + GET 回读 enabled:false；启用 → 恢复', async () => {
    const off = await req('PATCH', '/tools/fileRead', { enabled: false });
    expect(off.status).toBe(200);
    expect((await off.json()) as { name: string; enabled: boolean; scope: string })
      .toEqual({ name: 'fileRead', enabled: false, scope: 'workspace' });

    const onDisk = await testLoader.loadWorkspace();
    const diskTools = (onDisk as { tools?: { enabled?: string[]; disabled?: string[] } }).tools;
    expect(diskTools?.disabled).toContain('fileRead');

    const detail = await req('GET', '/tools/fileRead');
    expect(((await detail.json()) as { enabled: boolean }).enabled).toBe(false);

    const on = await req('PATCH', '/tools/fileRead', { enabled: true });
    expect(on.status).toBe(200);
    expect(((await on.json()) as { enabled: boolean }).enabled).toBe(true);

    // 恢复原状：清除 tools 开关键
    await req('DELETE', '/config/tools.enabled');
    await req('DELETE', '/config/tools.disabled');
  });

  it('PATCH MCP 工具 → 400；非内置 → 404；缺 enabled → 400', async () => {
    expect((await req('PATCH', '/tools/foo__bar', { enabled: false })).status).toBe(400);
    expect((await req('PATCH', '/tools/no_such_tool', { enabled: false })).status).toBe(404);
    expect((await req('PATCH', '/tools/fileRead', {})).status).toBe(400);
  });

  it('POST /tools/reload → 重载内置 + MCP（reloaded 计数）', async () => {
    const res = await req('POST', '/tools/reload');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reloaded: number };
    expect(body.reloaded).toBeGreaterThanOrEqual(5); // 内置至少 6 个，MCP 为 0
  });
});

// ===== 5. models 组（P1）=====

describe('models 组（GET /models、GET|PUT /model、POST /models、DELETE /models/:alias、test）', () => {
  it('POST 登记 → 201（apiKey 遮蔽）；同名 → 409；非法 body → 400', async () => {
    const res = await req('POST', '/models', {
      alias: 'test-model',
      profile: { name: 'gpt-test', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-abc123456789', temperature: 0.5 },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { alias: string; scope: string; profile: { name: string; apiKey: string; temperature: number } };
    expect(body.alias).toBe('test-model');
    expect(body.scope).toBe('workspace');
    expect(body.profile.name).toBe('gpt-test');
    expect(body.profile.apiKey).toMatch(/^\*{4}/); // 遮蔽
    expect(body.profile.temperature).toBe(0.5);

    expect((await req('POST', '/models', {
      alias: 'test-model',
      profile: { name: 'x', baseUrl: 'http://x', apiKey: 'k' },
    })).status).toBe(409);

    expect((await req('POST', '/models', { alias: 'bad name', profile: { name: 'x', baseUrl: 'http://x', apiKey: 'k' } })).status).toBe(400);
    expect((await req('POST', '/models', { alias: 'ok-alias', profile: { name: 'x', baseUrl: '' } })).status).toBe(400);
  });

  it('GET /models 列表含已登记项（遮蔽 + isCurrent）；GET /model 返回当前快照', async () => {
    const list = await req('GET', '/models');
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      profiles: { alias: string; apiKey: string; isCurrent: boolean }[];
      active: string | null;
    };
    const tm = listBody.profiles.find((p) => p.alias === 'test-model');
    expect(tm).toBeTruthy();
    expect(tm?.apiKey).toMatch(/^\*{4}/);
    expect(tm?.isCurrent).toBe(false);
    expect(listBody.active).toBeFalsy(); // 未激活（DEFAULT 为空串/null 均视为未激活）

    const cur = await req('GET', '/model');
    expect(cur.status).toBe(200);
    const curBody = (await cur.json()) as { model: { name: string; apiKey: string }; active: string | null };
    expect(curBody.model.name).toBeTruthy();
    expect(curBody.active).toBeFalsy();
  });

  it('PUT /model 激活 → models.active + model.* 快照同步；未知名 → 404', async () => {
    const res = await req('PUT', '/model', { alias: 'test-model' });
    expect(res.status).toBe(200);
    expect((await res.json()) as { alias: string; scope: string; model: { name: string } })
      .toEqual({ alias: 'test-model', scope: 'workspace', model: { name: 'gpt-test', baseUrl: 'http://127.0.0.1:9/v1' } });

    const cur = await req('GET', '/model');
    const curBody = (await cur.json()) as { model: { name: string }; active: string | null };
    expect(curBody.model.name).toBe('gpt-test');
    expect(curBody.active).toBe('test-model');

    expect((await req('PUT', '/model', { alias: 'ghost' })).status).toBe(404);
    expect((await req('PUT', '/model', {})).status).toBe(400);
  });

  it('PATCH /models/:alias 编辑 → 只改提交字段；Key 留空保持；清 temperature 删键；生效模型同步快照', async () => {
    // 生效中的 test-model 改名 → 同时同步 model.* 快照
    const renamed = await req('PATCH', '/models/test-model', { profile: { name: 'gpt-test-2' } });
    expect(renamed.status).toBe(200);
    const renamedBody = (await renamed.json()) as {
      alias: string;
      scope: string;
      syncedActive: boolean;
      profile: { name: string; apiKey: string; temperature?: number };
    };
    expect(renamedBody.alias).toBe('test-model');
    expect(renamedBody.syncedActive).toBe(true);
    expect(renamedBody.profile.name).toBe('gpt-test-2');
    expect(renamedBody.profile.temperature).toBe(0.5); // 未提交 → 不变
    expect((await (await req('GET', '/model')).json() as { model: { name: string } }).model.name).toBe('gpt-test-2');

    // Key 留空 → 保持原值（后四位不变）
    const kept = await req('PATCH', '/models/test-model', { profile: { apiKey: '' } });
    expect(kept.status).toBe(200);
    expect(((await kept.json()) as { profile: { apiKey: string } }).profile.apiKey).toBe('****6789');

    // Key 填写 → 整体替换并重新遮蔽
    const rekeyed = await req('PATCH', '/models/test-model', { profile: { apiKey: 'sk-new-key-9876' } });
    expect(((await rekeyed.json()) as { profile: { apiKey: string } }).profile.apiKey).toBe('****9876');

    // temperature null → 从 profile 与生效快照中删除该键
    const cleared = await req('PATCH', '/models/test-model', { profile: { temperature: null } });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { profile: Record<string, unknown> }).profile.temperature).toBeUndefined();
    const listBody = (await (await req('GET', '/models')).json()) as { profiles: Record<string, unknown>[] };
    expect(listBody.profiles.find((p) => p.alias === 'test-model')?.temperature).toBeUndefined();
    const curBody = (await (await req('GET', '/model')).json()) as { model: Record<string, unknown> };
    // 快照键已删除；GET /model 回读的是默认配置里的 temperature: 0
    expect(curBody.model.temperature).toBe(0);

    // 跨层归属：全局层存在但按默认 workspace 编辑 → 404 提示 ?scope=global
    const g = await req('POST', '/models', {
      alias: 'global-edit-model',
      scope: 'global',
      profile: { name: 'gpt-global-edit', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-global-0001' },
    });
    expect(g.status).toBe(201);
    const wrong = await req('PATCH', '/models/global-edit-model', { profile: { name: 'x' } });
    expect(wrong.status).toBe(404);
    expect(((await wrong.json()) as { error: { message: string } }).error.message).toContain('scope=global');
    const ok = await req('PATCH', '/models/global-edit-model', { scope: 'global', profile: { name: 'gpt-global-edit-2' } });
    expect(ok.status).toBe(200);

    // 非法入参 / 未知模型
    expect((await req('PATCH', '/models/test-model', {})).status).toBe(400);
    expect((await req('PATCH', '/models/test-model', { profile: { name: '' } })).status).toBe(400);
    expect((await req('PATCH', '/models/test-model', { profile: { temperature: 'hot' } })).status).toBe(400);
    expect((await req('PATCH', '/models/ghost-model', { profile: { name: 'x' } })).status).toBe(404);
  });

  it('advanced：POST 可携带；PATCH 整体替换 / null 删除 / 生效快照同步；非法值 400', async () => {
    const advanced = {
      maxTokens: 2048,
      topP: 0.7,
      topK: 40,
      frequencyPenalty: 0.2,
      timeoutMs: 120000,
      headers: { 'api-version': '2024-10-21' },
    };
    const created = await req('POST', '/models', {
      alias: 'adv-model',
      profile: {
        name: 'gpt-adv',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-adv-0001',
        advanced,
      },
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { profile: { advanced: unknown } }).profile.advanced).toEqual(advanced);

    // 生效模型：整体替换（未提交的键消失）
    const replaced = await req('PATCH', '/models/test-model', { profile: { advanced: { topP: 0.3 } } });
    expect(replaced.status).toBe(200);
    expect(((await replaced.json()) as { profile: { advanced: unknown } }).profile.advanced).toEqual({ topP: 0.3 });
    const cur = (await (await req('GET', '/model')).json()) as { model: { advanced?: unknown } };
    expect(cur.model.advanced).toEqual({ topP: 0.3 });

    // 列表回读带 advanced
    const list = (await (await req('GET', '/models')).json()) as { profiles: Record<string, unknown>[] };
    expect(list.profiles.find((p) => p.alias === 'test-model')?.advanced).toEqual({ topP: 0.3 });

    // null / {} → 从 profile 与生效快照中删除整组
    const cleared = await req('PATCH', '/models/test-model', { profile: { advanced: null } });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { profile: Record<string, unknown> }).profile.advanced).toBeUndefined();
    expect(((await (await req('GET', '/model')).json()) as { model: Record<string, unknown> }).model.advanced).toBeUndefined();
    const emptied = await req('PATCH', '/models/test-model', { profile: { advanced: {} } });
    expect(emptied.status).toBe(200);
    expect(((await emptied.json()) as { profile: Record<string, unknown> }).profile.advanced).toBeUndefined();

    // 非法值逐项拒绝
    for (const bad of [
      { maxTokens: 0 },
      { maxTokens: 1.5 },
      { topP: 1.1 },
      { topK: -1 },
      { frequencyPenalty: -2.1 },
      { timeoutMs: 999 },
      { headers: { Authorization: 'x' } },
      { headers: { 'bad name': 'x' } },
      { headers: { 'X-Test': '' } },
      { bogus: 1 },
    ]) {
      expect((await req('PATCH', '/models/test-model', { profile: { advanced: bad } })).status).toBe(400);
    }

    expect((await req('DELETE', '/models/adv-model')).status).toBe(200);
  });

  it('DELETE 当前激活 → 409；跨层归属 → 404 提示 scope；目标层存在 → 200', async () => {
    expect((await req('DELETE', '/models/test-model')).status).toBe(409);

    // 全局层登记一个非激活模型
    const g = await req('POST', '/models', {
      alias: 'global-model',
      scope: 'global',
      profile: { name: 'gpt-global', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-global-9999' },
    });
    expect(g.status).toBe(201);

    // 默认 scope=workspace：目标层没有，但全局层有 → 404 带提示
    const wrong = await req('DELETE', '/models/global-model');
    expect(wrong.status).toBe(404);
    expect(((await wrong.json()) as { error: { message: string } }).error.message).toContain('?scope=global');

    // 指定 scope=global → 删除成功
    const ok = await req('DELETE', '/models/global-model?scope=global');
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { deleted: boolean; alias: string; scope: string })
      .toEqual({ deleted: true, alias: 'global-model', scope: 'global' });

    expect((await req('DELETE', '/models/no-such-model')).status).toBe(404);
  });

  it('POST /models/:alias/test 连通性失败 → 200 {ok:false, error}；未知名 → 404', async () => {
    const res = await req('POST', '/models/test-model/test');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; latencyMs: number; error: string };
    expect(body.ok).toBe(false); // baseUrl 指向 127.0.0.1:9，连接拒绝
    expect(typeof body.latencyMs).toBe('number');
    expect(body.error).toBeTruthy();

    expect((await req('POST', '/models/ghost/test')).status).toBe(404);
  });
});

// ===== 6. mcp 组（P1）=====

describe('mcp 组（GET /mcp/servers、POST /mcp/servers、reload、test、DELETE）', () => {
  // 用必然 spawn 失败的命令名（ENOENT 毫秒级失败），验证「502 但配置已落盘」边界
  const BAD_CMD = 'no-such-mcp-cmd-xyz';

  it('POST 登记（stdio，command 不存在）→ 502 且配置已落盘；transport 非法 / 缺 command → 400', async () => {
    const res = await req('POST', '/mcp/servers', { name: 'e2e-mcp', transport: 'stdio', command: BAD_CMD });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('disconnected');

    // 落盘验证
    const onDisk = await testLoader.loadWorkspace();
    const server = (onDisk as { tools?: { mcpServers?: Record<string, unknown> } }).tools?.mcpServers?.['e2e-mcp'];
    expect(server).toMatchObject({ type: 'stdio', command: BAD_CMD });

    expect((await req('POST', '/mcp/servers', { name: 'e2e-mcp', transport: 'stdio', command: BAD_CMD })).status).toBe(409);
    expect((await req('POST', '/mcp/servers', { name: 'x', transport: 'ftp' })).status).toBe(400);
    expect((await req('POST', '/mcp/servers', { name: 'x', transport: 'stdio' })).status).toBe(400);
  });

  it('GET /mcp/servers 列表含登记项（status disconnected）；GET 详情连接失败 → 502', async () => {
    const list = await req('GET', '/mcp/servers');
    expect(list.status).toBe(200);
    const body = (await list.json()) as { servers: { name: string; transport: string; status: string; toolCount: number }[] };
    const srv = body.servers.find((s) => s.name === 'e2e-mcp');
    // D9：列表项携带来源范围（workspace 登记）
    expect(srv).toMatchObject({ transport: 'stdio', status: 'disconnected', toolCount: 0, scope: 'workspace' });

    expect((await req('GET', '/mcp/servers/ghost')).status).toBe(404);
    expect((await req('GET', '/mcp/servers/e2e-mcp')).status).toBe(502);
  });

  it('POST /mcp/servers/:name/test → 200 {ok:false}；POST /mcp/reload → failed 含失败名', async () => {
    const test = await req('POST', '/mcp/servers/e2e-mcp/test');
    expect(test.status).toBe(200);
    const testBody = (await test.json()) as { ok: boolean; latencyMs: number; error: string };
    expect(testBody.ok).toBe(false);
    expect(testBody.error).toBeTruthy();

    const reload = await req('POST', '/mcp/reload');
    expect(reload.status).toBe(200);
    const reloadBody = (await reload.json()) as { reconnected: number; failed: string[] };
    expect(reloadBody.reconnected).toBe(0);
    expect(reloadBody.failed).toContain('e2e-mcp');
  });

  it('DELETE → 范围不匹配 deleted:false 且配置保留；正确范围 deleted:true 且盘上移除', async () => {
    // 全局登记一个 server（连接必败，但配置已落盘），验证列表 scope 与删除范围
    const globalReg = await req('POST', '/mcp/servers', {
      name: 'e2e-mcp-global', transport: 'stdio', command: BAD_CMD, scope: 'global',
    });
    expect(globalReg.status).toBe(502);

    const list = await req('GET', '/mcp/servers');
    const listBody = (await list.json()) as { servers: { name: string; scope: string }[] };
    expect(listBody.servers.find((s) => s.name === 'e2e-mcp-global')).toMatchObject({ scope: 'global' });

    // 用默认 workspace 范围删除全局 server：不误报成功，也不删全局配置
    const wrong = await req('DELETE', '/mcp/servers/e2e-mcp-global');
    expect(wrong.status).toBe(200);
    expect((await wrong.json()) as { name: string; scope: string; deleted: boolean })
      .toEqual({ name: 'e2e-mcp-global', scope: 'workspace', deleted: false });
    expect((await testLoader.loadGlobal() as { tools?: { mcpServers?: Record<string, unknown> } })
      .tools?.mcpServers?.['e2e-mcp-global']).toBeTruthy();

    // 切到 global 后删除成功
    const g = await req('DELETE', '/mcp/servers/e2e-mcp-global?scope=global');
    expect(g.status).toBe(200);
    expect((await g.json()) as { name: string; scope: string; deleted: boolean })
      .toEqual({ name: 'e2e-mcp-global', scope: 'global', deleted: true });
    expect((await testLoader.loadGlobal() as { tools?: { mcpServers?: Record<string, unknown> } })
      .tools?.mcpServers?.['e2e-mcp-global']).toBeUndefined();

    // workspace 登记项按默认范围删除
    const res = await req('DELETE', '/mcp/servers/e2e-mcp');
    expect(res.status).toBe(200);
    expect((await res.json()) as { name: string; scope: string; deleted: boolean })
      .toEqual({ name: 'e2e-mcp', scope: 'workspace', deleted: true });

    const onDisk = await testLoader.loadWorkspace();
    expect((onDisk as { tools?: { mcpServers?: Record<string, unknown> } }).tools?.mcpServers?.['e2e-mcp']).toBeUndefined();
  });
});

// ===== 7. skills 组（P1）=====

describe('skills 组（GET /skills、GET /skills/:name、POST /skills、DELETE、reload）', () => {
  // 独特名避免撞真实仓库 skill；workspace 根取 TEST_WORKSPACE，测试后用 API DELETE + 兜底 rmSync 清理
  const SKILL_NAME = 'api-e2e-skill-zz9';
  let sourceDir = '';

  beforeAll(() => {
    // installSkillDirs 以源目录 basename 作为安装目录名 → 源目录直接命名为 SKILL_NAME
    sourceDir = join(TEST_DIR, 'skill-src', SKILL_NAME);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, 'SKILL.md'),
      `---\nname: ${SKILL_NAME}\ndescription: API e2e 测试用 Skill\n---\n\n# 测试正文\n\nhello skill body。\n`,
      'utf-8',
    );
  });

  afterAll(() => {
    // 兜底清理：TEST_WORKSPACE/.loop-agent/skills 下的安装残留
    rmSync(join(TEST_WORKSPACE, '.loop-agent', 'skills', SKILL_NAME), { recursive: true, force: true });
  });

  it('POST 缺 sourcePath → 400；目录不存在 → 400', async () => {
    expect((await req('POST', '/skills', {})).status).toBe(400);
    expect((await req('POST', '/skills', { sourcePath: join(TEST_DIR, 'no-such-dir') })).status).toBe(400);
  });

  it('POST 安装 → 201（workspace 目录）；GET 列表/详情可见', async () => {
    const res = await req('POST', '/skills', { sourcePath: sourceDir });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; scope: string; path: string };
    expect(body.name).toBe(SKILL_NAME);
    expect(body.scope).toBe('workspace');
    expect(body.path).toContain(join('.loop-agent', 'skills', SKILL_NAME));

    const list = await req('GET', '/skills');
    const listBody = (await list.json()) as { skills: { name: string; scope: string; path: string }[] };
    expect(listBody.skills.some((s) => s.name === SKILL_NAME && s.scope === 'workspace')).toBe(true);

    const detail = await req('GET', `/skills/${SKILL_NAME}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { name: string; description: string; body: string };
    expect(detailBody.description).toBe('API e2e 测试用 Skill');
    expect(detailBody.body).toContain('hello skill body');

    expect((await req('GET', '/skills/no-such-skill')).status).toBe(404);
  });

  it('同名未 overwrite → 409（提示 overwrite）；overwrite:true → 201 覆盖', async () => {
    const dup = await req('POST', '/skills', { sourcePath: sourceDir });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { message: string } }).error.message).toContain('overwrite');

    const over = await req('POST', '/skills', { sourcePath: sourceDir, overwrite: true });
    expect(over.status).toBe(201);
    expect(((await over.json()) as { name: string }).name).toBe(SKILL_NAME);
  });

  it('DELETE → 200 deleted:true 且 GET 404；POST /skills/reload → loaded 计数', async () => {
    const res = await req('DELETE', `/skills/${SKILL_NAME}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean; name: string; scope: string; dir: string };
    expect(body.deleted).toBe(true);
    expect(body.scope).toBe('workspace');
    expect(body.dir).toContain(SKILL_NAME);

    expect((await req('GET', `/skills/${SKILL_NAME}`)).status).toBe(404);
    expect((await req('DELETE', '/skills/no-such-skill')).status).toBe(404);

    const reload = await req('POST', '/skills/reload');
    expect(reload.status).toBe(200);
    expect(typeof ((await reload.json()) as { loaded: number }).loaded).toBe('number');
  });
});

// ===== 8. memory 组（P1）=====

describe('memory 组（status / curated / episodic / search / gate / dream / init）', () => {
  it('GET /memory/status：分层目录 + 计数（临时 memoryRoot 隔离）', async () => {
    const res = await req('GET', '/memory/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      layers: { episodic: { dir: string }; curated: { workspace: string; files: Record<string, string> } };
      counts: { episodicDays: number; gatePending: number; gateApproved: number };
    };
    expect(body.enabled).toBe(true);
    expect(body.layers.episodic.dir.startsWith(join(TEST_DIR, 'memory'))).toBe(true);
    expect(body.layers.curated.workspace).toBe(TEST_WORKSPACE);
    expect(Object.keys(body.layers.curated.files).length).toBeGreaterThanOrEqual(1);
    expect(body.counts.episodicDays).toBe(0);
    expect(body.counts.gatePending).toBe(0);
  });

  it('GET /memory/curated 三层文件全文；GET /memory/episodic 空 entries', async () => {
    const curated = await req('GET', '/memory/curated');
    expect(curated.status).toBe(200);
    const curatedBody = (await curated.json()) as { entries: { key: string; path: string; content: string }[] };
    expect(curatedBody.entries.length).toBeGreaterThanOrEqual(1);
    expect(curatedBody.entries.every((e) => typeof e.content === 'string' && e.path.length > 0)).toBe(true);

    const episodic = await req('GET', '/memory/episodic');
    expect(episodic.status).toBe(200);
    expect((await episodic.json()) as { entries: unknown[] }).toEqual({ entries: [] });
  });

  it('GET /memory/search 缺 q → 400；带 q → results 标 layer', async () => {
    expect((await req('GET', '/memory/search')).status).toBe(400);

    const res = await req('GET', '/memory/search?q=任意内容&limit=3');
    expect(res.status).toBe(200);
    expect((await res.json()) as { results: unknown[] }).toEqual({ results: [] }); // 空 episodic
  });

  it('GET /memory/gate：六来源阈值 + 空 recentDecisions', async () => {
    const res = await req('GET', '/memory/gate');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      thresholds: Record<string, number>;
      recentDecisions: { pending: unknown[]; approved: unknown[] };
    };
    expect(body.thresholds).toEqual({
      owner_direct: 1,
      owner_derived: 2,
      tool_output: 3,
      web_search: 4,
      agent_inferred: 5,
      system: -1,
    });
    expect(body.recentDecisions).toEqual({ pending: [], approved: [] });
  });

  it('POST /memory/dream → 202 即走即忘；POST /memory/init 幂等 200', async () => {
    const dream = await req('POST', '/memory/dream');
    expect(dream.status).toBe(202);
    expect((await dream.json()) as { accepted: boolean }).toEqual({ accepted: true });

    const init = await req('POST', '/memory/init');
    expect(init.status).toBe(200);
    expect((await init.json()) as { initialized: boolean }).toEqual({ initialized: true });
    const again = await req('POST', '/memory/init');
    expect(again.status).toBe(200);
  });
});

// ===== 9. vision 组（P2）=====

describe('vision 组（GET /vision、POST /vision/test）', () => {
  it('GET /vision 探测链状态：无 Key → available:false + reason；假 Key → available:true', async () => {
    // 清空回退链两处 Key（models 组 PUT active 可能已写入 model.apiKey）
    await req('PUT', '/config/model.apiKey', { value: '' });
    await req('PUT', '/config/vision.apiKey', { value: '' });

    const off = await req('GET', '/vision');
    expect(off.status).toBe(200);
    const offBody = (await off.json()) as { available: boolean; provider: string; model: string; reason?: string };
    expect(offBody.available).toBe(false); // vision.enabled=true（config 组置位）但无 Key
    expect(offBody.reason).toContain('API Key');
    expect(offBody.provider).toBeTruthy();
    expect(offBody.model).toBeTruthy(); // 回退主模型名

    // 置假 Key → 探测链只查存在性 → available:true 且无 reason
    await req('PUT', '/config/vision.apiKey', { value: 'sk-vision-fake-key' });
    const on = await req('GET', '/vision');
    expect(on.status).toBe(200);
    const onBody = (await on.json()) as { available: boolean; reason?: string };
    expect(onBody.available).toBe(true);
    expect(onBody.reason).toBeUndefined();

    // 恢复：删除假 Key
    await req('DELETE', '/config/vision.apiKey');
  });

  it('POST /vision/test 无 Key → 200 ok:false + error（诊断语义，不触网）', async () => {
    await req('PUT', '/config/vision.apiKey', { value: '' });
    const res = await req('POST', '/vision/test');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; latencyMs: number; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('API Key');
    expect(body.latencyMs).toBe(0);
  });
});

// ===== 10. doctor 组（P2）=====

describe('doctor 组（GET /doctor）', () => {
  it('GET /doctor → 6 项检查结构完整；单项失败不失败端点', async () => {
    const res = await req('GET', '/doctor');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      checks: { name: string; ok: boolean; level?: string; detail: string }[];
    };
    expect(body.checks.length).toBe(6);
    for (const c of body.checks) {
      expect(typeof c.name).toBe('string');
      expect(typeof c.ok).toBe('boolean');
      expect(typeof c.detail).toBe('string');
    }
    const names = body.checks.map((c) => c.name);
    expect(names).toEqual([
      '主模型 apiKey', '主模型名称', '全局配置文件', '工作空间配置文件', '全局 skills 目录', '工作空间 skills 目录',
    ]);
    // ok 总开关与 blocker 项一致性：存在 !ok && level==='blocker' 则总体 ok 必为 false
    const hasBlocker = body.checks.some((c) => !c.ok && c.level === 'blocker');
    expect(body.ok).toBe(!hasBlocker);
    // 检查项展示清单固定 → level 仅在 !ok 时出现
    expect(body.checks.every((c) => c.ok || c.level !== undefined)).toBe(true);
  });
});
