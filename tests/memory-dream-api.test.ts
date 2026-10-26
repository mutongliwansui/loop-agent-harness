/**
 * Task-20261026-003-01 单测：/memory/dream 定时与历史端点（方案 D9）
 *
 * 覆盖：
 * - GET  /memory/dream/preview：合法 cron → ok+next[5]+describe；非法 → ok:false+fieldIndex；缺参 → ok:false
 * - PUT  /memory/dream/schedule：合法 → 200 且落 workspace 配置 + reschedule 生效（nextRunAt 变化）
 * - PUT  /memory/dream/schedule：非法 cron → 400，且**不改动**已有配置与既有排期（D9 边界）
 * - PUT  /memory/dream/schedule：enabled=false → scheduleEnabled=false；grace 越界 / 类型错 → 400
 * - GET  /memory/dream/history：空列表 / 预置文件可读 / limit 收窄 / 损坏容错
 * - DELETE /memory/dream/history：返回 deleted 条数并把列表清空
 *
 * 起 port 0 真实 http server（沿用 api-endpoints.test.ts 的注入方式），fetch 断言。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { DreamScheduler } from '../src/api/dream-scheduler.js';
import { SessionStore } from '../src/session/store.js';
import { ConfigLoader } from '../src/config/loader.js';
import { ConfigWriter } from '../src/config/writer.js';
import { createMemoryKit } from '../src/api/memory-kit.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import type { WorkspaceRuntime, WorkspaceRegistry } from '../src/api/workspace-runtime.js';
import { DEFAULT_MEMORY_CONFIG } from '../src/memory/types.js';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-memory-dream-api');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');
const TEST_GLOBAL_DIR = join(TEST_DIR, 'global');
const MEMORY_DIR = join(TEST_DIR, 'memory', 'ws-test');
const RUNS_FILE = join(MEMORY_DIR, '.dreaming-runs.json');
const WORKSPACE_CONFIG = join(TEST_WORKSPACE, '.loop-agent', '.agent-config.json');

let server: ApiServer;
let base = '';
let loader: ConfigLoader;

/** 读 workspace 配置文件（未落盘时返回 null） */
function readWorkspaceConfig(): Record<string, unknown> | null {
  if (!existsSync(WORKSPACE_CONFIG)) return null;
  return JSON.parse(readFileSync(WORKSPACE_CONFIG, 'utf-8')) as Record<string, unknown>;
}

/** 取 workspace 配置里 memory.dreaming.schedule 段 */
function readSchedule(): Record<string, unknown> | undefined {
  const cfg = readWorkspaceConfig() as {
    memory?: { dreaming?: { schedule?: Record<string, unknown> } };
  } | null;
  return cfg?.memory?.dreaming?.schedule;
}

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_WORKSPACE, { recursive: true });
  mkdirSync(TEST_GLOBAL_DIR, { recursive: true });
  mkdirSync(MEMORY_DIR, { recursive: true });

  const store = new SessionStore(TEST_WORKSPACE, false, join(TEST_DIR, 'sessions'));
  await store.init();

  loader = new ConfigLoader(TEST_WORKSPACE, TEST_GLOBAL_DIR);
  const writer = new ConfigWriter(TEST_WORKSPACE, TEST_GLOBAL_DIR, loader);

  // 假 runtime：configLoader 指向真实的临时 workspace 配置，使 PUT 落盘后调度器能读到新值
  const kit = {
    dream: {
      async getState() {
        return { lastProcessedDay: '' };
      },
      async run() {
        return { promoted: [], skipped: [], errors: [] };
      },
      async recordRun() {},
    },
    episodic: { getMemoryDir: () => MEMORY_DIR },
  };
  const rt = {
    root: TEST_WORKSPACE,
    id: 'ws-test',
    configLoader: loader,
    sessions: { hasInFlight: () => false },
    getMemoryKit: async () => kit,
  } as unknown as WorkspaceRuntime;
  const registry = {
    peek: (root: string) => (root === TEST_WORKSPACE ? rt : undefined),
    list: () => [rt],
  } as unknown as WorkspaceRegistry;

  const dreamScheduler = new DreamScheduler({
    registry,
    // 进程级配置与 workspace 配置同源，模拟「PUT 落盘 → 重读即生效」
    getConfig: () => loader.load().config,
    log: () => {},
  });
  dreamScheduler.start();

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
    dreamScheduler,
    runtime: {
      configLoader: loader,
      configWriter: writer,
      uploadsRoot: join(TEST_DIR, 'uploads'),
      createMemoryKit: () =>
        createMemoryKit(TEST_WORKSPACE, loader, { memoryRoot: join(TEST_DIR, 'memory') }),
    },
  });
  server = api;
  const { port } = await api.start();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
  // Windows 上 SQLite / 历史文件句柄可能尚未释放，重试清理；清不掉也不让套件失败（目录在系统临时区）
  try {
    rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* 临时目录残留不影响断言结果 */
  }
});

// ---------- preview ----------

describe('GET /memory/dream/preview', () => {
  it('合法 cron → ok:true，describe + 5 个 ISO 时刻', async () => {
    const res = await req('GET', `/memory/dream/preview?cron=${encodeURIComponent('0 3 * * *')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      describe: string;
      next: string[];
      timezoneOffsetMin: number;
    };
    expect(body.ok).toBe(true);
    expect(body.describe).toBe('每天 03:00');
    expect(body.next).toHaveLength(5);
    for (const t of body.next) expect(new Date(t).getHours()).toBe(3);
    expect(body.timezoneOffsetMin).toBe(-new Date().getTimezoneOffset());
  });

  it('非法 cron → 200 且 ok:false（输入期预览不属错误请求），带 fieldIndex', async () => {
    const res = await req('GET', `/memory/dream/preview?cron=${encodeURIComponent('0 25 * * *')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error: string; fieldIndex: number };
    expect(body.ok).toBe(false);
    expect(body.fieldIndex).toBe(1);
    expect(body.error).toContain('0-23');
  });

  it('缺 cron 参数 → ok:false 且提示缺参', async () => {
    const res = await req('GET', '/memory/dream/preview');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean; error: string }).error).toContain('cron');
  });

  it('永不触发的表达式 → ok:false', async () => {
    const res = await req('GET', `/memory/dream/preview?cron=${encodeURIComponent('0 3 30 2 *')}`);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('不会触发');
  });
});

// ---------- PUT schedule ----------

describe('PUT /memory/dream/schedule', () => {
  it('合法 cron → 200，落 workspace 配置，返回 nextRunAt/nextRunTimes/describe', async () => {
    const res = await req('PUT', '/memory/dream/schedule', { cron: '30 4 * * *', misfireGraceMin: 30 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      enabled: boolean;
      cron: string;
      describe: string;
      misfireGraceMin: number;
      nextRunAt: string;
      nextRunTimes: string[];
      intervalMode: string;
    };
    expect(body.ok).toBe(true);
    expect(body.cron).toBe('30 4 * * *');
    expect(body.describe).toBe('每天 04:30');
    expect(body.misfireGraceMin).toBe(30);
    expect(body.intervalMode).toBe('cron');
    expect(body.nextRunAt).toBeDefined();
    expect(new Date(body.nextRunAt).getHours()).toBe(4);
    expect(new Date(body.nextRunAt).getMinutes()).toBe(30);
    expect(body.nextRunTimes).toHaveLength(3);

    // 落盘校验
    expect(readSchedule()).toMatchObject({ cron: '30 4 * * *', misfireGraceMin: 30, enabled: true });
  });

  it('非法 cron → 400，且**不改动**已落盘配置（D9 边界：不打断现有排期）', async () => {
    const before = readSchedule();
    const res = await req('PUT', '/memory/dream/schedule', { cron: '0 25 * * *' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toContain('0-23');
    expect(readSchedule()).toEqual(before);

    // 排期未被打断：status 仍报上次合法 cron
    const st = await req('GET', '/memory/status');
    const dreaming = ((await st.json()) as { dreaming?: { cron?: string } }).dreaming;
    expect(dreaming?.cron).toBe('30 4 * * *');
  });

  it('永不触发的 cron → 400', async () => {
    const res = await req('PUT', '/memory/dream/schedule', { cron: '0 3 30 2 *' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toContain('不会触发');
  });

  it('misfireGraceMin 越界 / 非整数 → 400', async () => {
    expect((await req('PUT', '/memory/dream/schedule', { misfireGraceMin: 1441 })).status).toBe(400);
    expect((await req('PUT', '/memory/dream/schedule', { misfireGraceMin: -1 })).status).toBe(400);
    expect((await req('PUT', '/memory/dream/schedule', { misfireGraceMin: 1.5 })).status).toBe(400);
  });

  it('enabled 非布尔 / cron 非字符串 → 400', async () => {
    expect((await req('PUT', '/memory/dream/schedule', { enabled: 'yes' })).status).toBe(400);
    expect((await req('PUT', '/memory/dream/schedule', { cron: 3 })).status).toBe(400);
  });

  it('enabled=false → 200 且 scheduleEnabled=false（清定时器）', async () => {
    const res = await req('PUT', '/memory/dream/schedule', { enabled: false });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false);
    const st = await req('GET', '/memory/status');
    const dreaming = (
      (await st.json()) as { dreaming?: { scheduleEnabled?: boolean; nextRunAt?: string } }
    ).dreaming;
    expect(dreaming?.scheduleEnabled).toBe(false);
    expect(dreaming?.nextRunAt).toBeUndefined();
    // 恢复开启，供后续用例
    expect((await req('PUT', '/memory/dream/schedule', { enabled: true })).status).toBe(200);
  });

  it('只改 grace 不改 cron → cron 保持原值', async () => {
    const res = await req('PUT', '/memory/dream/schedule', { misfireGraceMin: 90 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cron: string }).cron).toBe('30 4 * * *');
    expect(readSchedule()).toMatchObject({ cron: '30 4 * * *', misfireGraceMin: 90 });
  });
});

// ---------- history ----------

describe('GET / DELETE /memory/dream/history', () => {
  it('无记录 → runs 为空数组', async () => {
    const res = await req('GET', '/memory/dream/history');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { runs: unknown[] }).runs).toEqual([]);
  });

  it('预置历史文件 → 可读出并按 limit 收窄', async () => {
    const runs = Array.from({ length: 5 }, (_, i) => ({
      startedAt: new Date(Date.UTC(2026, 9, 26, 19, 0, i)).toISOString(),
      finishedAt: new Date(Date.UTC(2026, 9, 26, 19, 2, i)).toISOString(),
      durationMs: 1000 + i,
      reason: 'schedule',
      ok: true,
      daysBack: 3,
      promoted: i,
      skipped: 0,
      errors: 0,
    }));
    writeFileSync(RUNS_FILE, JSON.stringify({ version: 1, runs }), 'utf-8');

    const all = (await (await req('GET', '/memory/dream/history')).json()) as { runs: unknown[] };
    expect(all.runs).toHaveLength(5);

    const two = (await (await req('GET', '/memory/dream/history?limit=2')).json()) as {
      runs: unknown[];
    };
    expect(two.runs).toHaveLength(2);
  });

  it('DELETE → 返回 deleted 条数并清空', async () => {
    const res = await req('DELETE', '/memory/dream/history');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deleted: number }).deleted).toBe(5);

    const after = (await (await req('GET', '/memory/dream/history')).json()) as { runs: unknown[] };
    expect(after.runs).toEqual([]);
  });

  it('损坏的历史文件 → runs 为空数组（不 500）', async () => {
    writeFileSync(RUNS_FILE, '{{{ 坏文件', 'utf-8');
    const res = await req('GET', '/memory/dream/history');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { runs: unknown[] }).runs).toEqual([]);
  });
});

// ---------- status 扩展 ----------

describe('GET /memory/status 的 dreaming 扩展字段（D14）', () => {
  it('暴露 cron/describe/nextRunTimes/timezoneOffsetMin/misfireGraceMin，并保留 deprecated 字段', async () => {
    const res = await req('GET', '/memory/status');
    expect(res.status).toBe(200);
    const dreaming = ((await res.json()) as { dreaming?: Record<string, unknown> }).dreaming;
    expect(dreaming).toBeDefined();
    expect(dreaming).toMatchObject({
      cron: '30 4 * * *',
      cronValid: true,
      describe: '每天 04:30',
      intervalMode: 'cron',
      misfireGraceMin: 90,
      // deprecated 一版保留（D14）
      intervalHours: DEFAULT_MEMORY_CONFIG.dreaming.schedule.intervalHours,
      startupDelayMin: DEFAULT_MEMORY_CONFIG.dreaming.schedule.startupDelayMin,
    });
    expect(Array.isArray(dreaming?.nextRunTimes)).toBe(true);
    expect(typeof dreaming?.timezoneOffsetMin).toBe('number');
  });
});
