/**
 * WorkspaceRegistry 与 API 组装联调测试（Task-20261021-010-01 验收 6.2.4 / 6.2.5）
 *
 * 覆盖：
 * - 6.2.4 bootstrap 收编后 /sessions、/workspaces、/fs/dirs 响应字段与改造前完全一致
 *         （对照改造前实现的字段清单做形状断言，不多不少）
 * - 6.2.5 switchWorkspace 仍按原六步工作：chdir + rebind + setWorkspacePath + reset + scaffold + reinit
 * - registry 提供的 runtime 与 server 注入的 deps 指向同一 root（无两份缓存分叉）
 *
 * 目录全部注入临时路径（userDir 覆盖 ~/.loop-agent）；chdir 后必在 finally 恢复，
 * 避免污染同进程内其他用例的相对路径语义。
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

/** 改造前 /workspaces 单项字段（真实实现的返回值形状，6.2.4 快照基线） */
const WORKSPACE_KEYS = [
  'id',
  'name',
  'path',
  'current',
  'createdAt',
  'lastAccessedAt',
  'sessions',
].sort();

/** 改造前 /sessions/:id 顶层字段 */
const SESSION_DETAIL_KEYS = ['meta', 'messages', 'run', 'lastRun', 'workspace'].sort();

let registry: WorkspaceRegistry;
let server: ApiServer;
let base = '';
let reinitCalls: string[] = [];

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
    reinitMemory: async (cwd) => {
      reinitCalls.push(cwd);
    },
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

afterEach(() => {
  reinitCalls = [];
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

    const current = body.workspaces.find((w) => w.current === true)!;
    expect(current).toBeTruthy();
    expect(Object.keys(current).sort()).toEqual(WORKSPACE_KEYS);
    expect(current.path).toBe(await canonicalWorkspacePath(WS_A));
    expect(current.id).toBe(workspaceId(await canonicalWorkspacePath(WS_A)));

    const sessions = current.sessions as Record<string, unknown>[];
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

describe('6.2.5 switchWorkspace 仍按原六步工作', () => {
  it('异空间创建会话：chdir + rebind + 配置跟随 + reinit 均发生', async () => {
    const rtA = registry.peek(await canonicalWorkspacePath(WS_A))!;
    const prevCwd = process.cwd();
    try {
      const res = await req('POST', '/sessions', { title: '跨空间', workspacePath: WS_B });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { workspace: { path: string; switched: boolean } };

      const rootB = await canonicalWorkspacePath(WS_B);
      expect(body.workspace.switched).toBe(true);
      expect(body.workspace.path).toBe(rootB);

      // 1) chdir
      expect(await canonicalWorkspacePath(process.cwd())).toBe(rootB);
      // 2) store 原地重绑（仍是同一个 runtime 里的 store 实例，L1 阶段语义）
      expect(rtA.store.path).toBe(rootB);
      expect(rtA.store.id).toBe(workspaceId(rootB));
      // 3) 配置分层跟随
      expect(await canonicalWorkspacePath(rtA.configLoader.workspacePath ?? rootB)).toBe(rootB);
      // 4) scaffold 初始化（两级 skills 目录存在）
      expect(existsSync(join(rootB, '.loop-agent'))).toBe(true);
      // 5) 记忆/池重建回调
      expect(reinitCalls).toContain(rootB);
    } finally {
      // 复原：chdir 回原目录 + store 重绑回 WS_A（后续用例仍以 WS_A 为当前空间）
      process.chdir(prevCwd);
      await rtA.store.rebindWorkspace(await canonicalWorkspacePath(WS_A));
      rtA.configLoader.setWorkspacePath(await canonicalWorkspacePath(WS_A));
      rtA.configWriter.setWorkspacePath(await canonicalWorkspacePath(WS_A));
    }
  });

  it('同空间创建会话：不触发切换（switched=false）', async () => {
    const rootA = await canonicalWorkspacePath(WS_A);
    const res = await req('POST', '/sessions', { title: '同空间', workspacePath: `${rootA}` });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: { switched: boolean; path: string } };
    expect(body.workspace.switched).toBe(false);
    expect(body.workspace.path).toBe(rootA);
    expect(reinitCalls).toHaveLength(0);
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
    expect(registry.list().length).toBe(1);
  });
});
