/**
 * 0 会话空间可见性收敛（需求 20261113-002 P1：D5 + D8）
 *
 * D5：`GET /workspaces`（侧栏数据源）不再返回 0 会话空间——幽灵空壳（只有 meta.json）
 *     不得出现在侧栏；`listAllWorkspaces()` 自身语义不变（它是 `/fs/*` 白名单来源，
 *     收紧会误伤「已建空间未建会话」的文件浏览）。
 * D8：`/fs/*` 白名单 = 已注册空间 ∪ 已装载 runtime。D1 之后新建空间在首次建会话前
 *     没有 meta.json，仅按已注册空间判定会 403，导致「打开空间 → 立刻浏览文件」断链。
 *
 * 目录全部注入临时 userDir（不触碰 ~/.loop-agent）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { WorkspaceRegistry } from '../src/api/workspace-runtime.js';
import { ConfigLoader } from '../src/config/loader.js';
import { ConfigWriter } from '../src/config/writer.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import { canonicalWorkspacePath } from '../src/session/path-utils.js';
import { workspaceId } from '../src/session/index.js';
import type { AgentOptions, AgentResult } from '../src/types.js';

const ROOT = join(tmpdir(), 'loop-agent-tests', 'test-ws-visibility');
const USER_DIR = join(ROOT, 'user');
const WS_REAL = join(ROOT, 'ws-real');
const WS_LOADED = join(ROOT, 'ws-loaded');
const WS_UNKNOWN = join(ROOT, 'ws-unknown');

let registry: WorkspaceRegistry;
let server: ApiServer;
let base = '';

const fakeRunAgent = async (_sid: string, input: string): Promise<AgentResult> => ({
  answer: `回复:${input}`,
  steps: [],
  iterations: 1,
  messages: [
    { role: 'user', content: input },
    { role: 'assistant', content: `回复:${input}` },
  ],
});

const req = (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** 手写一份幽灵目录：仅 meta.json，无任何会话体/索引——旧版启动预装的产物形态 */
async function makeGhost(wsPath: string): Promise<string> {
  const root = await canonicalWorkspacePath(wsPath);
  const dir = join(USER_DIR, 'sessions', workspaceId(root));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({
      workspacePath: root,
      workspaceName: 'ghost',
      createdAt: '2020-01-01T00:00:00.000Z',
      lastAccessedAt: '2020-01-01T00:00:00.000Z',
    }),
    'utf-8',
  );
  return root;
}

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  for (const d of [WS_REAL, WS_LOADED, WS_UNKNOWN]) mkdirSync(d, { recursive: true });
  mkdirSync(USER_DIR, { recursive: true });
  // 浏览用样本文件（D8 用例读它）
  writeFileSync(join(WS_LOADED, 'note.txt'), 'loaded ws\n', 'utf-8');

  registry = new WorkspaceRegistry({ userDir: USER_DIR, evictIntervalMs: 0 });
  const rt = await registry.get(WS_REAL);
  const cfg: AgentConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    api: { ...DEFAULT_CONFIG.api, port: 0 },
  };
  const loader = new ConfigLoader(USER_DIR);
  server = createApiServer({
    runAgent: fakeRunAgent,
    sessionStore: rt.store,
    sessions: rt.sessions,
    getConfig: () => cfg,
    version: 'test-0.0.0',
    runtime: {
      configLoader: loader,
      configWriter: new ConfigWriter(USER_DIR, loader),
      createMemoryKit: () => rt.getMemoryKit(),
    },
    registry,
  });
  const { port } = await server.start();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
  registry.reset();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // Windows 目录句柄释放延迟：残留临时目录不影响结论
  }
});

describe('D5：0 会话空间不进 GET /workspaces', () => {
  it('幽灵空壳（仅 meta.json）不出现在 /workspaces，但 listAllWorkspaces 仍可见', async () => {
    const ghostRoot = await makeGhost(join(ROOT, 'ws-ghost'));
    // 前置：store 层仍能看到它（/fs/* 白名单依赖这个口径）
    const rt = await registry.get(WS_REAL);
    const all = await rt.store.listAllWorkspaces();
    expect(all.some((w) => w.path === ghostRoot && w.sessions.length === 0)).toBe(true);

    const body = (await (await req('GET', '/workspaces')).json()) as {
      workspaces: { path: string; sessions: unknown[] }[];
    };
    // 关键断言：handler 层把它滤掉
    expect(body.workspaces.some((w) => w.path === ghostRoot)).toBe(false);
    // 且返回的每一项都非空（不是「碰巧没有」而是「全部非空」）
    expect(body.workspaces.every((w) => w.sessions.length > 0)).toBe(true);
  });

  it('真实会话建成后该空间出现在 /workspaces（过滤只针对 0 会话）', async () => {
    const rootReal = await canonicalWorkspacePath(WS_REAL);
    const created = await req('POST', '/sessions', { title: '真实会话', workspacePath: WS_REAL });
    expect(created.status).toBe(201);

    const body = (await (await req('GET', '/workspaces')).json()) as {
      workspaces: { path: string; sessions: { id: string }[] }[];
    };
    const hit = body.workspaces.find((w) => w.path === rootReal);
    expect(hit).toBeTruthy();
    expect(hit!.sessions.length).toBeGreaterThan(0);
  });
});

describe('D8：/fs/* 白名单 ∪ 已装载 runtime', () => {
  it('已装载 runtime 但无 meta.json 的空间：/fs/tree 放行（打开空间即可浏览）', async () => {
    // 装载 runtime：D1 之后这一步不产生任何磁盘痕迹（无 meta.json / 无目录）
    await registry.get(WS_LOADED);
    const rt = await registry.get(WS_REAL);
    const all = await rt.store.listAllWorkspaces();
    const rootLoaded = await canonicalWorkspacePath(WS_LOADED);
    // 前置：它确实还没进「已注册空间」（无会话就没有 meta.json）
    expect(all.some((w) => w.path === rootLoaded)).toBe(false);

    const res = await req('GET', `/fs/tree?ws=${encodeURIComponent(WS_LOADED)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tree?: { name: string }[]; path?: string };
    const names = JSON.stringify(body);
    expect(names).toContain('note.txt');
  });

  it('既未注册也未装载的空间仍 403（白名单未被放宽）', async () => {
    const res = await req('GET', `/fs/tree?ws=${encodeURIComponent(WS_UNKNOWN)}`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
  });

  it('已注册空间（有会话）照旧放行', async () => {
    await req('POST', '/sessions', { title: 'D8 注册', workspacePath: WS_REAL });
    const res = await req('GET', `/fs/tree?ws=${encodeURIComponent(WS_REAL)}`);
    expect(res.status).toBe(200);
  });
});
