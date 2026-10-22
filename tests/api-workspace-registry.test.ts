/**
 * WorkspaceRegistry 与 API 组装联调测试（Task-20261021-010-01 / 010-03 验收）
 *
 * 覆盖：
 * - 6.2.4 bootstrap 收编后 /sessions、/workspaces、/fs/dirs 响应字段与改造前完全一致
 *         （对照改造前实现的字段清单做形状断言，不多不少）
 * - 6.2.5（task-03 重写）目标空间解析退化为"最近使用指针刷新"：
 *         零 process.chdir、零 store 原地重绑、零 setWorkspacePath、不触发记忆/池重建；
 *         目标空间由 registry 懒建独立 runtime，旧空间 runtime 保持不可变
 * - registry 提供的 runtime 与 server 注入的 deps 指向同一 root（无两份缓存分叉）
 *
 * 目录全部注入临时路径（userDir 覆盖 ~/.loop-agent）。
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { WorkspaceRegistry } from '../src/api/workspace-runtime.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import { canonicalWorkspacePath } from '../src/session/path-utils.js';
import { workspaceId } from '../src/session/index.js';
import type { AgentOptions, AgentResult } from '../src/types.js';

const ROOT = join(tmpdir(), 'loop-agent-tests', 'test-registry-api');
const USER_DIR = join(ROOT, 'user');
const WS_A = join(ROOT, 'ws-a');
const WS_B = join(ROOT, 'ws-b');

/** /workspaces 单项字段（真实实现的返回值形状，6.2.4 快照基线） */
const WORKSPACE_KEYS = [
  'id',
  'name',
  'path',
  'createdAt',
  'lastAccessedAt',
  'sessions',
].sort();

/** 改造前 /sessions/:id 顶层字段 */
const SESSION_DETAIL_KEYS = ['meta', 'messages', 'run', 'lastRun', 'workspace'].sort();

let registry: WorkspaceRegistry;
let server: ApiServer;
let base = '';

const fakeRunAgent = async (_sid: string, input: string, _options: AgentOptions): Promise<AgentResult> => ({
  answer: `回复:${input}`,
  steps: [],
  iterations: 1,
  messages: [
    { role: 'user', content: input },
    { role: 'assistant', content: `回复:${input}` },
  ],
});

/** 按 bootstrap.ts 的方式组装：deps 六项全部从 runtime 解构 */
async function startServer(workspace: string): Promise<void> {
  const rt = await registry.get(workspace);
  const cfg: AgentConfig = { ...structuredClone(DEFAULT_CONFIG), api: { ...DEFAULT_CONFIG.api, port: 0 } };
  server = createApiServer({
    runAgent: fakeRunAgent,
    sessionStore: rt.store,
    sessions: rt.sessions,
    getConfig: () => cfg,
    version: 'test-0.0.0',
    runtime: {
      configLoader: rt.configLoader,
      configWriter: rt.configWriter,
      createMemoryKit: () => rt.getMemoryKit(),
    },
    registry,
  });
  const { port } = await server.start();
  base = `http://127.0.0.1:${port}`;
}

const req = (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(WS_A, { recursive: true });
  mkdirSync(WS_B, { recursive: true });
  registry = new WorkspaceRegistry({ userDir: USER_DIR });
  await startServer(WS_A);
});

afterAll(async () => {
  await server.close();
  registry.reset();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // Windows 目录句柄释放有延迟：残留临时目录不影响测试结果
  }
});

describe('6.2.4 响应字段快照（registry 收编后与改造前一致）', () => {
  it('GET /sessions 返回 { sessions: [{ id,title,createdAt,updatedAt,messageCount,file }] }', async () => {
    const created = await req('POST', '/sessions', { title: '形状校验' });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Record<string, unknown>;
    expect(Object.keys(createdBody).sort()).toEqual(
      ['id', 'title', 'createdAt', 'updatedAt', 'messageCount', 'workspace'].sort(),
    );
    expect(createdBody.workspace).toEqual({
      path: registry.peek(await canonicalWorkspacePath(WS_A))!.root,
      id: workspaceId(await canonicalWorkspacePath(WS_A)),
      switched: false,
    });

    const res = await req('GET', '/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Record<string, unknown>[] };
    expect(Object.keys(body)).toEqual(['sessions']);
    const one = body.sessions.find((s) => s.id === createdBody.id)!;
    expect(one).toBeTruthy();
    expect(Object.keys(one).sort()).toEqual(
      ['id', 'title', 'createdAt', 'updatedAt', 'messageCount', 'file'].sort(),
    );
  });

  it('GET /workspaces 保持 WorkspaceSummary 字段清单（含 sessions 内 running/lastRun）', async () => {
    const res = await req('GET', '/workspaces');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Record<string, unknown>[] };
    expect(Object.keys(body)).toEqual(['workspaces']);
    expect(body.workspaces.length).toBeGreaterThan(0);

    const canonicalA = await canonicalWorkspacePath(WS_A);
    const ws = body.workspaces.find((w) => w.path === canonicalA)!;
    expect(ws).toBeTruthy();
    expect(Object.keys(ws).sort()).toEqual(WORKSPACE_KEYS);
    expect(ws.id).toBe(workspaceId(canonicalA));

    const sessions = ws.sessions as Record<string, unknown>[];
    expect(sessions.length).toBeGreaterThan(0);
    // running / lastRun 由 handler 注入（改造前既有行为）
    expect(Object.keys(sessions[0]).sort()).toEqual(
      ['id', 'title', 'createdAt', 'updatedAt', 'messageCount', 'file', 'running', 'lastRun'].sort(),
    );
  });

  it('GET /fs/dirs 返回 { path, parent, dirs, drives }，缺省指向当前空间', async () => {
    const res = await req('GET', '/fs/dirs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      parent: string | null;
      dirs: { name: string }[];
      drives: string[];
    };
    expect(Object.keys(body).sort()).toEqual(['dirs', 'drives', 'parent', 'path'].sort());
    expect(body.path).toBe(await canonicalWorkspacePath(WS_A));
    expect(isAbsolute(body.path)).toBe(true);
    expect(Array.isArray(body.dirs)).toBe(true);
    expect(Array.isArray(body.drives)).toBe(true);
  });

  it('GET /sessions/:id 保持 { meta, messages, run, lastRun, workspace }', async () => {
    const created = await req('POST', '/sessions', { title: '详情形状' });
    const { id } = (await created.json()) as { id: string };
    const res = await req('GET', `/sessions/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(SESSION_DETAIL_KEYS);
  });
});

describe('6.2.5 目标空间解析只刷新最近使用指针（零 chdir / 零原地重绑）', () => {
  it('异空间创建会话：cwd 不变、旧空间 runtime 不变、新空间 runtime 懒建、指针整体切换（task-04：switched 恒 false）', async () => {
    const rootA = await canonicalWorkspacePath(WS_A);
    const rootB = await canonicalWorkspacePath(WS_B);
    const rtA = registry.peek(rootA)!;
    const prevCwd = process.cwd();

    const res = await req('POST', '/sessions', { title: '跨空间', workspacePath: WS_B });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; workspace: { path: string; switched: boolean } };
    // task-04（L2）：switched 字段保留但恒 false；会话 id 含目标空间命名空间段（D5）
    expect(body.workspace.switched).toBe(false);
    expect(body.workspace.path).toBe(rootB);
    expect(body.id.startsWith(`sess_${workspaceId(rootB).slice(0, 8)}_`)).toBe(true);

    // 1) 零 chdir：进程目录不随空间切换变化
    expect(process.cwd()).toBe(prevCwd);
    // 2) 旧空间 runtime 不被原地改写（store / 配置层构造期定根，实例不可变）
    expect(rtA.store.path).toBe(rootA);
    expect(rtA.store.id).toBe(workspaceId(rootA));
    // 3) 新空间由 registry 懒建独立 runtime（与 A 的实例不同）
    const rtB = registry.peek(rootB)!;
    expect(rtB).toBeTruthy();
    expect(rtB).not.toBe(rtA);
    expect(rtB.store).not.toBe(rtA.store);
    expect(rtB.store.path).toBe(rootB);
    expect(rtB.store.id).toBe(workspaceId(rootB));
    // 4) scaffold 初始化（两级 skills 目录存在）
    expect(existsSync(join(rootB, '.loop-agent'))).toBe(true);
    // 5) /config（workspace 层）读写落到当前空间（6.2.5）
    const cfgPath = (await (await req('GET', '/config/path')).json()) as {
      workspacePath: string;
      workspaceExists: boolean;
    };
    expect(cfgPath.workspacePath).toBe(join(rootB, '.loop-agent', '.agent-config.json'));
    expect(cfgPath.workspaceExists).toBe(true);

    // 复原最近使用指针（后续用例仍以 WS_A 为当前空间）：同样零 chdir（task-04：switched 恒 false）
    const back = await req('POST', '/sessions', { title: '切回', workspacePath: rootA });
    expect(back.status).toBe(201);
    const backBody = (await back.json()) as { workspace: { path: string; switched: boolean } };
    expect(backBody.workspace.switched).toBe(false);
    expect(backBody.workspace.path).toBe(rootA);
    expect(process.cwd()).toBe(prevCwd);
  });

  it('同空间创建会话：不触发切换（switched=false）', async () => {
    const rootA = await canonicalWorkspacePath(WS_A);
    const res = await req('POST', '/sessions', { title: '同空间', workspacePath: `${rootA}` });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: { switched: boolean; path: string } };
    expect(body.workspace.switched).toBe(false);
    expect(body.workspace.path).toBe(rootA);
  });

  it('目标目录不存在：not_found（错误码与文案沿用改造前）', async () => {
    const res = await req('POST', '/sessions', { workspacePath: join(ROOT, 'no-such-ws') });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toContain('目录不存在');
  });
});

describe('deps 与 registry 单一真源', () => {
  it('server 注入的 store 与 runtime.store 是同一实例（无两份缓存）', async () => {
    const rt = registry.peek(await canonicalWorkspacePath(WS_A))!;
    const res = await req('POST', '/sessions', { title: '单一真源' });
    const { id } = (await res.json()) as { id: string };
    // 会话被写进该 runtime 的 store，说明 server 用的就是它的实例
    const list = await rt.store.listSessions();
    expect(list.some((s) => s.id === id)).toBe(true);
    // Task-20261021-010-03：切换过的空间各自保留独立 runtime（A + B 并存，LRU 未淘汰）
    expect(registry.list().length).toBe(2);
    expect(registry.list().map((r) => r.root).sort()).toEqual(
      [await canonicalWorkspacePath(WS_A), await canonicalWorkspacePath(WS_B)].sort(),
    );
  });
});
