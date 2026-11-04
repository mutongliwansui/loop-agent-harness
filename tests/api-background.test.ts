// 需求 20261104-005：后台任务 HTTP 端点（状态 / 日志尾部 / 停止）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import { SessionStore } from '../src/session/store.js';
import { backgroundTasks, setRunsDirForTest } from '../src/tools/background-tasks.js';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-api-background');
const RUNS_DIR = join(TEST_DIR, 'runs');

let server: ApiServer;
let store: SessionStore;
let base = '';
let config: AgentConfig = structuredClone(DEFAULT_CONFIG);

async function req(method: string, path: string): Promise<Response> {
  return fetch(`${base}${path}`, { method });
}

beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(RUNS_DIR, { recursive: true });
  store = new SessionStore(join(TEST_DIR, 'workspace'), false, TEST_DIR);
  await store.init();
  setRunsDirForTest(RUNS_DIR);

  config = { ...config, api: { ...config.api, port: 0 } };
  server = createApiServer({
    runAgent: async () => { throw new Error('not used'); },
    sessionStore: store,
    getConfig: () => config,
  });
  const { port } = await server.start();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
  setRunsDirForTest(undefined);
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('GET /background/:taskId', () => {
  it('返回状态快照；非法 / 不存在 taskId 404', async () => {
    const logPath = join(RUNS_DIR, 'bg_aaaa1111_1700000000.log');
    writeFileSync(logPath, 'hello\n');
    backgroundTasks.start({
      taskId: 'bg_aaaa1111_1700000000',
      command: 'npm run dev',
      cwd: TEST_DIR,
      logPath,
      startedAt: Date.now(),
    });

    const res = await req('GET', '/background/bg_aaaa1111_1700000000');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.taskId).toBe('bg_aaaa1111_1700000000');
    expect(body.status).toBe('running');
    expect(body.logSize).toBe(6);
    expect(body.exitCode).toBeNull();

    expect((await req('GET', '/background/bg_zzzz1111_1700000000')).status).toBe(404);
    expect((await req('GET', '/background/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
  });
});

describe('GET /background/:taskId/logs?tail=1', () => {
  it('返回尾部文本并限制行数', async () => {
    const taskId = 'bg_bbbb2222_1700000001';
    const logPath = join(RUNS_DIR, `${taskId}.log`);
    // 30 行，超过 tail 20 行上限
    writeFileSync(logPath, Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n'));
    backgroundTasks.start({
      taskId,
      command: 'tail test',
      cwd: TEST_DIR,
      logPath,
      startedAt: Date.now(),
    });
    const res = await req('GET', `/background/${taskId}/logs?tail=1`);
    expect(res.status).toBe(200);
    const body = await res.json() as { tail: string; truncated: boolean; cleaned: boolean };
    expect(body.tail).toContain('line-29');
    expect(body.tail).not.toContain('line-0\n');
    expect(body.truncated).toBe(true);
    expect(body.cleaned).toBe(false);
  });

  it('日志已清理时 cleaned=true', async () => {
    // 仅磁盘 JSON、无 .log（模拟清理后的历史任务）
    const taskId = 'bg_cccc3333_1700000002';
    writeFileSync(join(RUNS_DIR, `${taskId}.json`), JSON.stringify({
      taskId,
      command: 'gone',
      cwd: TEST_DIR,
      logPath: join(RUNS_DIR, `${taskId}.log`),
      startedAt: Date.now(),
      status: 'exited',
      exitCode: 0,
      finishedAt: Date.now(),
      cursor: 0,
    }));
    const res = await req('GET', `/background/${taskId}/logs?tail=1`);
    expect(res.status).toBe(200);
    const body = await res.json() as { cleaned: boolean };
    expect(body.cleaned).toBe(true);
  });
});

describe('POST /background/:taskId/stop', () => {
  it('运行中任务 → stopped=true；重复调用幂等', async () => {
    const taskId = 'bg_dddd4444_1700000003';
    const logPath = join(RUNS_DIR, `${taskId}.log`);
    writeFileSync(logPath, 'run\n');
    backgroundTasks.start({
      taskId,
      command: 'stop me',
      cwd: TEST_DIR,
      logPath,
      startedAt: Date.now(),
    });

    const first = await req('POST', `/background/${taskId}/stop`);
    expect(first.status).toBe(200);
    const body1 = await first.json() as { stopped: boolean; status: string };
    expect(body1.stopped).toBe(true);
    expect(body1.status).toBe('killed');

    const second = await req('POST', `/background/${taskId}/stop`);
    expect(second.status).toBe(200);
    const body2 = await second.json() as { stopped: boolean; alreadyStopped: boolean };
    expect(body2.stopped).toBe(false);
    expect(body2.alreadyStopped).toBe(true);
  });

  it('不存在任务返回 404', async () => {
    const res = await req('POST', '/background/bg_eeee5555_1700000004/stop');
    expect(res.status).toBe(404);
  });
});
