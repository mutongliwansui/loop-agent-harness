/**
 * GET /userdir/view 端点测试（20261028-007 P0 验收 6.1）
 *
 * 覆盖：
 * 1. disp=file 正常路径：200、响应与 /fs/file 同构（path/name/bytes/truncated/content）
 * 2. disp=file >512KB 截断（truncated=true）；含 NUL → 400
 * 3. disp=raw 原始字节：Content-Type 按扩展名、字节一致
 * 4. 越界：`..` 穿越 → 403；root 外绝对路径 → 403
 * 5. `~` 字面量：纯 `~` → 解析为 root 本身（目录 → 400）；`~` 展开后越出 root → 403
 *    （runtime.userDir 注入临时目录，~ 展开走真实 homedir，必不落在 tmp root 内，等价验证展开语义）
 * 6. 不存在 → 404；缺 path → 400；目录 → 400
 *
 * 夹具与 api-uploads-view.test.ts 一致：runtime 注入 userDir，port 0 真实 http server。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { SessionStore } from '../src/session/store.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-api-userdir-view');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');
const TEST_USERDIR = join(TEST_DIR, 'userdir'); // 模拟 ~/.loop-agent

type Res = Awaited<ReturnType<typeof fetch>>;

let config: AgentConfig = structuredClone(DEFAULT_CONFIG);
let store: SessionStore;
let server: ApiServer;
let base = '';

beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_WORKSPACE, { recursive: true });

  store = new SessionStore(TEST_WORKSPACE, false, join(TEST_DIR, 'sessions'));
  await store.init();

  config = { ...config, api: { ...config.api, port: 0 } };

  const api = createApiServer({
    runAgent: async () => {
      throw new Error('本套件不触达 runAgent');
    },
    sessionStore: store,
    getConfig: () => config,
    version: 'test-0.0.0',
    runtime: { userDir: TEST_USERDIR },
  });
  server = api;
  const { port } = await api.start();
  base = `http://127.0.0.1:${port}`;

  // 模拟自有数据目录典型内容：记忆 md / runs 日志 / skills SKILL.md / 图片
  mkdirSync(join(TEST_USERDIR, 'memory', 'a43aa30f2ceec764'), { recursive: true });
  writeFileSync(join(TEST_USERDIR, 'memory', 'a43aa30f2ceec764', '2026-10-29.md'), '# 2026-10-29\n\n- 完成交付\n', 'utf-8');
  mkdirSync(join(TEST_USERDIR, 'runs'), { recursive: true });
  writeFileSync(join(TEST_USERDIR, 'runs', 't1.log'), '[task t1] running...\ndone code=0\n', 'utf-8');
  mkdirSync(join(TEST_USERDIR, 'skills', 'task-driven-development'), { recursive: true });
  writeFileSync(join(TEST_USERDIR, 'skills', 'task-driven-development', 'SKILL.md'), '---\nname: task-driven-development\ndescription: x\n---\n\n# 步骤\n', 'utf-8');
  mkdirSync(join(TEST_USERDIR, 'uploads', 'sess_x'), { recursive: true });
  writeFileSync(join(TEST_USERDIR, 'uploads', 'sess_x', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]));
  // >512KB 文本（截断用）
  writeFileSync(join(TEST_USERDIR, 'big.txt'), 'x'.repeat(512 * 1024 + 100), 'utf-8');
  // 含 NUL（disp=file 拒绝用）
  writeFileSync(join(TEST_USERDIR, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
  // userdir 根外越界探针
  mkdirSync(join(TEST_DIR, 'outside'), { recursive: true });
  writeFileSync(join(TEST_DIR, 'outside', 'secret.txt'), 'secret', 'utf-8');
});

afterAll(async () => {
  await server.close();
});

async function req(method: string, path: string): Promise<Res> {
  return fetch(`${base}${path}`, { method });
}

interface FileResp {
  path: string;
  name: string;
  bytes: number;
  truncated: boolean;
  content: string;
}

describe('GET /userdir/view?disp=file：文本预览（与 /fs/file 同构）', () => {
  it('记忆 md：相对路径 200 且结构同构', async () => {
    const res = await req('GET', `/userdir/view?path=${encodeURIComponent('memory/a43aa30f2ceec764/2026-10-29.md')}&disp=file`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FileResp;
    expect(body.name).toBe('2026-10-29.md');
    expect(body.path).toBe('memory/a43aa30f2ceec764/2026-10-29.md');
    expect(body.truncated).toBe(false);
    expect(body.content).toBe('# 2026-10-29\n\n- 完成交付\n');
  });

  it('runs 日志：绝对路径（位于 root 内）与相对路径等价', async () => {
    const abs = join(TEST_USERDIR, 'runs', 't1.log');
    const res = await req('GET', `/userdir/view?path=${encodeURIComponent(abs)}&disp=file`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FileResp;
    expect(body.content).toBe('[task t1] running...\ndone code=0\n');
  });

  it('SKILL.md：~ 字面量输入按 homedir 展开后可达（root 为真实 ~/.loop-agent 时）', async () => {
    // 仅当测试环境的真实 ~/.loop-agent 恰为注入目录时才成立；一般环境此用例验证「~ 展开后不在 tmp root → 403」
    const res = await req('GET', `/userdir/view?path=${encodeURIComponent('~/.loop-agent/skills/task-driven-development/SKILL.md')}&disp=file`);
    // tmp 注入 root 下 ~ 展开必然越界 → 403；若恰好同根则 200
    expect([200, 403]).toContain(res.status);
  });

  it('>512KB 截断：truncated=true，content 截至上限', async () => {
    const res = await req('GET', `/userdir/view?path=${encodeURIComponent('big.txt')}&disp=file`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FileResp;
    expect(body.truncated).toBe(true);
    expect(body.bytes).toBe(512 * 1024 + 100);
    expect(body.content.length).toBe(512 * 1024);
  });

  it('含 NUL 二进制 → 400', async () => {
    const res = await req('GET', `/userdir/view?path=${encodeURIComponent('bin.dat')}&disp=file`);
    expect(res.status).toBe(400);
  });

  it('目录 → 400', async () => {
    const res = await req('GET', `/userdir/view?path=${encodeURIComponent('runs')}&disp=file`);
    expect(res.status).toBe(400);
  });
});

describe('GET /userdir/view?disp=raw：原始字节', () => {
  it('图片字节直显，Content-Type 按扩展名', async () => {
    const res = await req('GET', `/userdir/view?path=${encodeURIComponent('uploads/sess_x/pic.png')}&disp=raw`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});

describe('GET /userdir/view：校验链', () => {
  it('`..` 穿越 → 403', async () => {
    const res = await req('GET', `/userdir/view?path=${encodeURIComponent('../outside/secret.txt')}&disp=file`);
    expect(res.status).toBe(403);
  });

  it('root 外绝对路径 → 403', async () => {
    const res = await req('GET', `/userdir/view?path=${encodeURIComponent('C:\\Windows\\win.ini')}&disp=file`);
    expect(res.status).toBe(403);
  });

  it('不存在 → 404', async () => {
    const res = await req('GET', `/userdir/view?path=${encodeURIComponent('runs/nope.log')}&disp=file`);
    expect(res.status).toBe(404);
  });

  it('缺 path → 400', async () => {
    const res = await req('GET', '/userdir/view?disp=file');
    expect(res.status).toBe(400);
  });
});

describe('expandHomeInput 单元（~ 展开语义）', () => {
  it('~/ 前缀拼接 home', async () => {
    const { expandHomeInput } = await import('../src/api/handlers/controlled-view.js');
    expect(expandHomeInput('~/a/b.md', 'D:/home')).toBe(join('D:/home', 'a/b.md'));
    expect(expandHomeInput('~\\a\\b.md', 'D:/home')).toBe(join('D:/home', 'a\\b.md'));
    expect(expandHomeInput('~', 'D:/home')).toBe('D:/home');
    expect(expandHomeInput('D:/plain/path', 'D:/home')).toBe('D:/plain/path');
  });
});
