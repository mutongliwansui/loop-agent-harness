/**
 * 需求 20261026-004 后端单测：/memory/workspaces + ?ws= 跨空间读取 + history ?scope=all 聚合
 *
 * 覆盖：
 * - memory-workspaces 纯函数：listMemoryWorkspaces（并集/孤儿/名称映射）、
 *   aggregateRunHistory（聚合/排序/损坏容错/only 单空间）、clearRunHistory（按 id 清空）
 * - GET /memory/workspaces：聚合 sessions 索引 ∪ memory 目录
 * - GET /memory/episodic?ws=<绝对路径>：按空间读取（跨空间直读）
 * - GET /memory/episodic?ws=<非法形态>：400
 * - GET /memory/dream/history?scope=all：跨空间聚合 + 空间字段附带
 * - DELETE /memory/dream/history?scope=all：遍历清空
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { SessionStore } from '../src/session/store.js';
import { ConfigLoader } from '../src/config/loader.js';
import { ConfigWriter } from '../src/config/writer.js';
import { createMemoryKit } from '../src/api/memory-kit.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import { workspaceId } from '../src/session/store.js';
import type { WorkspaceRegistry } from '../src/api/workspace-runtime.js';
import {
  listMemoryWorkspaces,
  aggregateRunHistory,
  clearRunHistory,
} from '../src/api/memory-workspaces.js';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-memory-ws-004');
const TEST_WORKSPACE = join(TEST_DIR, 'ws-alpha');
const TEST_OTHER = join(TEST_DIR, 'ws-beta'); // 第二个空间（无会话，只有记忆 = 孤儿空间）
const USER_DIR = join(TEST_DIR, 'user'); // 模拟 ~/.loop-agent（ctx.userDir 注入）
const SESSIONS_DIR = join(USER_DIR, 'sessions');
const MEMORY_DIR = join(USER_DIR, 'memory');

const WS_A_ID = workspaceId(TEST_WORKSPACE);
const WS_B_ID = workspaceId(TEST_OTHER);

/** 按「今天往回第 n 天」算日期（episodic.readRecentDays 从今天往回读，种子须用动态日期才稳定） */
function dayN(n = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

let server: ApiServer;
let base = '';

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 写一个 sessions 索引目录（meta.json） */
function seedSession(wsId: string, name: string, path: string): void {
  const dir = join(SESSIONS_DIR, wsId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ workspaceName: name, workspacePath: path }), 'utf-8');
}

/** 写一个空间的记忆目录（daily note + 可选 run 历史） */
function seedMemory(
  wsId: string,
  files: Record<string, string>,
  runs?: { startedAt: string; promoted: number }[],
): void {
  const dir = join(MEMORY_DIR, wsId);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf-8');
  }
  if (runs) {
    writeFileSync(
      join(dir, '.dreaming-runs.json'),
      JSON.stringify({ version: 1, runs: runs.map((r) => ({ ...r, ok: true, errors: 0 })) }),
      'utf-8',
    );
  }
}

beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_WORKSPACE, { recursive: true });
  mkdirSync(TEST_OTHER, { recursive: true });
  mkdirSync(join(TEST_DIR, 'sessions-store'), { recursive: true });

  // 种子数据：A = 有会话有记忆；B = 孤儿空间（只有记忆）；C = 有会话无记忆（仅索引）
  seedSession(WS_A_ID, 'alpha-proj', TEST_WORKSPACE);
  seedSession('c'.repeat(16), 'gamma-proj', join(TEST_DIR, 'ws-gamma'));
  seedMemory(WS_A_ID, {
    [`${dayN(0)}.md`]: `## [${new Date().toISOString()}] [sessionId: s1] [scope: session] [tag: tool]\nalpha 内容\n`,
  }, [
    { startedAt: '2026-10-26T01:00:00.000Z', promoted: 1 },
    { startedAt: '2026-10-26T03:00:00.000Z', promoted: 2 },
  ]);
  seedMemory(WS_B_ID, {
    [`${dayN(1)}.md`]: `## [${new Date(Date.now() - 86400000).toISOString()}] [scope: global] [tag: note]\nbeta 内容\n`,
  }, [{ startedAt: '2026-10-26T02:00:00.000Z', promoted: 5 }]);

  const store = new SessionStore(TEST_WORKSPACE, false, join(TEST_DIR, 'sessions-store'));
  await store.init();

  const loader = new ConfigLoader(TEST_WORKSPACE, join(TEST_DIR, 'global'));
  const writer = new ConfigWriter(TEST_WORKSPACE, join(TEST_DIR, 'global'), loader);

  // 最小 fake registry：只为 ensureRoot 提供目录校验（?ws= 绝对路径形态用）；
  // peek 返回 undefined 表示「目标空间未装载」——跨空间端点不依赖 runtime 装载。
  const registry = {
    ensureRoot: async (input: string) => {
      const { canonicalWorkspacePath } = await import('../src/session/path-utils.js');
      const root = await canonicalWorkspacePath(input);
      if (!existsSync(root)) throw new Error(`目录不存在: ${root}`);
      return root;
    },
    peek: () => undefined,
    list: () => [],
  } as unknown as WorkspaceRegistry;

  const config: AgentConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    api: { ...DEFAULT_CONFIG.api, port: 0 },
  };
  const api = createApiServer({
    runAgent: async () => {
      throw new Error('本套件不触达 runAgent');
    },
    sessionStore: store,
    getConfig: () => config,
    version: 'test-0.0.0',
    registry, // fake registry：仅 ensureRoot 校验目录存在（绝对路径形态用）
    runtime: {
      configLoader: loader,
      configWriter: writer,
      uploadsRoot: join(TEST_DIR, 'uploads'),
      benchRoot: join(TEST_DIR, 'bench'),
      userDir: USER_DIR, // 关键注入：让跨空间端点扫描临时目录而非真实 ~/.loop-agent
      createMemoryKit: () => createMemoryKit(TEST_WORKSPACE, loader, { memoryRoot: join(MEMORY_DIR, WS_A_ID) }),
    },
  });
  server = api;
  const { port } = await api.start();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
  try {
    rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* 临时目录残留不影响断言 */
  }
});

// ---------- 纯函数：listMemoryWorkspaces ----------

describe('listMemoryWorkspaces', () => {
  it('并集 = 有会话 ∪ 有记忆，孤儿空间带 hasSession:false', async () => {
    const list = await listMemoryWorkspaces({ sessionsDir: SESSIONS_DIR, memoryDir: MEMORY_DIR });
    const byId = new Map(list.map((w) => [w.id, w]));

    // A：有会话有记忆
    expect(byId.get(WS_A_ID)).toMatchObject({
      name: 'alpha-proj',
      path: TEST_WORKSPACE,
      hasMemory: true,
      hasSession: true,
    });
    // B：孤儿空间（只有记忆）
    expect(byId.get(WS_B_ID)).toMatchObject({ hasMemory: true, hasSession: false });
    // C：有会话无记忆
    expect(byId.get('c'.repeat(16))).toMatchObject({ name: 'gamma-proj', hasMemory: false, hasSession: true });
    expect(list).toHaveLength(3);
  });

  it('sessions 目录缺失 → 只剩 memory 孤儿；memory 缺失 → 只剩会话空间', async () => {
    const emptyDir = join(TEST_DIR, 'empty');
    mkdirSync(emptyDir, { recursive: true });
    const onlyMemory = await listMemoryWorkspaces({ sessionsDir: join(emptyDir, 'nope'), memoryDir: MEMORY_DIR });
    expect(onlyMemory.map((w) => w.hasSession).every((v) => v === false)).toBe(true);
    const onlySession = await listMemoryWorkspaces({ sessionsDir: SESSIONS_DIR, memoryDir: join(emptyDir, 'nope') });
    expect(onlySession.map((w) => w.hasMemory).every((v) => v === false)).toBe(true);
  });
});

// ---------- 纯函数：aggregateRunHistory / clearRunHistory ----------

describe('aggregateRunHistory / clearRunHistory', () => {
  it('跨空间聚合 + 全局时间新→旧排序 + 附带空间字段', () => {
    const runs = aggregateRunHistory({ memoryDir: MEMORY_DIR, sessionsDir: SESSIONS_DIR });
    // A(03:00) > B(02:00) > A(01:00)
    expect(runs.map((r) => r.startedAt)).toEqual([
      '2026-10-26T03:00:00.000Z',
      '2026-10-26T02:00:00.000Z',
      '2026-10-26T01:00:00.000Z',
    ]);
    expect(runs[0]).toMatchObject({ workspaceId: WS_A_ID, workspaceName: 'alpha-proj', promoted: 2 });
    expect(runs[1]).toMatchObject({ workspaceId: WS_B_ID, promoted: 5 });
    expect(runs[1].workspaceName).toBe(WS_B_ID.slice(0, 8)); // 孤儿空间名回落
  });

  it('损坏的历史文件不致 500（该空间按无记录）', () => {
    writeFileSync(join(MEMORY_DIR, WS_B_ID, '.dreaming-runs.json'), '{{{', 'utf-8');
    const runs = aggregateRunHistory({ memoryDir: MEMORY_DIR, sessionsDir: SESSIONS_DIR });
    expect(runs.every((r) => r.workspaceId !== WS_B_ID)).toBe(true);
    // 还原，供后续用例
    writeFileSync(
      join(MEMORY_DIR, WS_B_ID, '.dreaming-runs.json'),
      JSON.stringify({ version: 1, runs: [{ startedAt: '2026-10-26T02:00:00.000Z', promoted: 5, ok: true, errors: 0 }] }),
      'utf-8',
    );
  });

  it('clearRunHistory：文件保留内容清空，返回删除条数', () => {
    const deleted = clearRunHistory({ memoryDir: MEMORY_DIR, wsIds: [WS_A_ID, WS_B_ID, 'nonexistent-id'] });
    expect(deleted).toBe(3);
    for (const id of [WS_A_ID, WS_B_ID]) {
      const f = join(MEMORY_DIR, id, '.dreaming-runs.json');
      expect(existsSync(f)).toBe(true);
      expect((JSON.parse(readFileSync(f, 'utf-8')) as { runs: unknown[] }).runs).toEqual([]);
    }
  });
});

// ---------- HTTP：GET /memory/workspaces ----------

describe('GET /memory/workspaces', () => {
  it('返回聚合清单（含孤儿空间与徽标字段）', async () => {
    const res = await req('GET', '/memory/workspaces');
    expect(res.status).toBe(200);
    const { workspaces } = (await res.json()) as {
      workspaces: { id: string; name: string; hasMemory: boolean; hasSession: boolean }[];
    };
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    expect(byId.get(WS_A_ID)?.hasSession).toBe(true);
    expect(byId.get(WS_B_ID)?.hasSession).toBe(false);
    expect(workspaces).toHaveLength(3);
  });
});

// ---------- HTTP：GET /memory/episodic?ws= ----------

describe('GET /memory/episodic?ws=', () => {
  it('缺省（无 ws）→ 启动空间行为不变', async () => {
    const res = await req('GET', '/memory/episodic?limit=7');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { day: string }[]; ws?: unknown };
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.ws).toBeUndefined();
  });

  it('ws=绝对路径（目标空间目录）→ 读到该空间记忆', async () => {
    const res = await req('GET', `/memory/episodic?limit=7&ws=${encodeURIComponent(TEST_WORKSPACE)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { day: string; content: string }[]; ws: { id: string } };
    expect(body.ws.id).toBe(WS_A_ID);
    expect(body.entries.map((e) => e.content).join('\n')).toContain('alpha 内容');
  });

  it('ws=非法形态 → 400', async () => {
    const res = await req('GET', '/memory/episodic?ws=../etc');
    expect(res.status).toBe(400);
  });

  it('ws=未知 id（无记忆数据）→ 404', async () => {
    const res = await req('GET', `/memory/episodic?ws=${'d'.repeat(16)}`);
    expect(res.status).toBe(404);
  });

  it('孤儿空间（有记忆无索引映射）→ episodic 仍可读（404 只发生在 curated 维度）', async () => {
    const res = await req('GET', `/memory/episodic?limit=7&ws=${WS_B_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { day: string; content: string }[] };
    expect(body.entries.map((e) => e.content).join('\n')).toContain('beta 内容');
  });
});

// ---------- HTTP：history ?scope=all ----------

describe('GET /memory/dream/history?scope=', () => {
  it('scope=all → 聚合多空间并附带空间字段（修复恒读启动空间）', async () => {
    const res = await req('GET', '/memory/dream/history?scope=all');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scope: string;
      runs: { workspaceId: string; workspaceName: string; startedAt: string }[];
    };
    expect(body.scope).toBe('all');
    // 上个 describe 已清空；这里重新种入两条再断言
    seedMemory(WS_A_ID, {}, [
      { startedAt: '2026-10-26T05:00:00.000Z', promoted: 1 },
    ]);
    seedMemory(WS_B_ID, {}, [
      { startedAt: '2026-10-26T06:00:00.000Z', promoted: 2 },
    ]);
    const all = (await (await req('GET', '/memory/dream/history?scope=all')).json()) as typeof body;
    expect(all.runs.map((r) => r.startedAt)).toEqual([
      '2026-10-26T06:00:00.000Z',
      '2026-10-26T05:00:00.000Z',
    ]);
    expect(all.runs[0]).toMatchObject({ workspaceId: WS_B_ID, workspaceName: WS_B_ID.slice(0, 8) });
    expect(all.runs[1]).toMatchObject({ workspaceId: WS_A_ID, workspaceName: 'alpha-proj' });
  });

  it('scope=ws（缺省）→ 启动空间行为不变', async () => {
    const res = await req('GET', '/memory/dream/history');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scope: string; runs: unknown[] };
    expect(body.scope).toBe('ws');
    expect(Array.isArray(body.runs)).toBe(true);
  });
});

describe('DELETE /memory/dream/history?scope=', () => {
  it('scope=all → 遍历清空各空间（文件保留）', async () => {
    const res = await req('DELETE', '/memory/dream/history?scope=all');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number; scope: string };
    expect(body.scope).toBe('all');
    expect(body.deleted).toBe(2);
    for (const id of [WS_A_ID, WS_B_ID]) {
      const f = join(MEMORY_DIR, id, '.dreaming-runs.json');
      expect(existsSync(f)).toBe(true);
      expect((JSON.parse(readFileSync(f, 'utf-8')) as { runs: unknown[] }).runs).toEqual([]);
    }
  });

  it('scope=ws（缺省）→ 仅清启动空间（现行为不变）', async () => {
    // A（启动空间）再种一条，B 保持空
    seedMemory(WS_A_ID, {}, [{ startedAt: '2026-10-26T07:00:00.000Z', promoted: 0 }]);
    const res = await req('DELETE', '/memory/dream/history');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number; scope: string };
    expect(body.scope).toBe('ws');
    expect(body.deleted).toBeGreaterThanOrEqual(1);
    expect(((await (await req('GET', '/memory/dream/history')).json()) as { runs: unknown[] }).runs).toEqual([]);
  });
});
