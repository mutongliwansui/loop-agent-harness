/**
 * GET /uploads/view 端点测试（20261028-006 P1 验收 6.2）
 *
 * 覆盖：
 * 1. disp=file 正常路径：200、响应与 /fs/file 同构（path/name/bytes/truncated/content）
 * 2. disp=file >512KB 截断（truncated=true、content 截至上限）
 * 3. disp=file 二进制拒绝（含 NUL → 400）
 * 4. disp=raw 原始字节：Content-Type 按扩展名、字节一致
 * 5. 越界：`..` 穿越 → 403；ws 外绝对路径 → 403
 * 6. 不存在 → 404
 * 7. 缺 path → 400
 * 8. 布局约定：会话目录 <sessionId>/<file> 落盘于 uploadsRoot（与 raw 上传同构）
 *
 * 夹具与 api-uploads-raw.test.ts 一致：runtime 只注入 uploadsRoot，port 0 真实 http server。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { SessionStore } from '../src/session/store.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-api-uploads-view');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');
const TEST_UPLOADS = join(TEST_DIR, 'uploads');

type Res = Awaited<ReturnType<typeof fetch>>;

let config: AgentConfig = structuredClone(DEFAULT_CONFIG);
let store: SessionStore;
let server: ApiServer;
let base = '';
let sessionId = '';

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
    runtime: { uploadsRoot: TEST_UPLOADS },
  });
  server = api;
  const { port } = await api.start();
  base = `http://127.0.0.1:${port}`;

  const res = await req('POST', '/sessions');
  sessionId = ((await res.json()) as { id: string }).id;

  // 会话 uploads 目录内造两类文件：文本 + 图片字节（disp=raw 用）
  const dir = join(TEST_UPLOADS, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'note.md'), '# 上传说明\n\n第一行\n', 'utf-8');
  writeFileSync(join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]));
  // >512KB 文本（截断用）
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(512 * 1024 + 100), 'utf-8');
  // 二进制文本位（disp=file NUL 拒绝用）
  writeFileSync(join(dir, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
  // uploads 根外越界探针（确认放行边界）
  mkdirSync(join(TEST_UPLOADS, '..', 'outside'), { recursive: true });
  writeFileSync(join(TEST_UPLOADS, '..', 'outside', 'secret.txt'), 'secret', 'utf-8');
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

interface FileResp {
  path: string;
  name: string;
  bytes: number;
  truncated: boolean;
  content: string;
}

describe('GET /uploads/view?disp=file：文本预览（与 /fs/file 同构）', () => {
  it('正常路径：相对 uploads 根，结构同构、内容一致', async () => {
    const res = await req('GET', `/uploads/view?path=${encodeURIComponent(`${sessionId}/note.md`)}&disp=file`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FileResp;
    expect(body.name).toBe('note.md');
    expect(body.bytes).toBe('# 上传说明\n\n第一行\n'.length * 3 > 0 ? Buffer.byteLength('# 上传说明\n\n第一行\n', 'utf-8') : 0);
    expect(body.truncated).toBe(false);
    expect(body.content).toBe('# 上传说明\n\n第一行\n');
    expect(body.path).toBe(`${sessionId}/note.md`);
  });

  it('绝对路径（位于 uploads 根内）与相对路径等价', async () => {
    const abs = join(TEST_UPLOADS, sessionId, 'note.md');
    const res = await req('GET', `/uploads/view?path=${encodeURIComponent(abs)}&disp=file`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FileResp;
    expect(body.content).toBe('# 上传说明\n\n第一行\n');
  });

  it('>512KB 截断：truncated=true，content 截至上限', async () => {
    const res = await req('GET', `/uploads/view?path=${encodeURIComponent(`${sessionId}/big.txt`)}&disp=file`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FileResp;
    expect(body.truncated).toBe(true);
    expect(body.bytes).toBe(512 * 1024 + 100);
    expect(body.content.length).toBe(512 * 1024);
  });

  it('含 NUL 二进制 → 400', async () => {
    const res = await req('GET', `/uploads/view?path=${encodeURIComponent(`${sessionId}/bin.dat`)}&disp=file`);
    expect(res.status).toBe(400);
  });
});

describe('GET /uploads/view?disp=raw：原始字节', () => {
  it('图片字节直显，Content-Type 按扩展名', async () => {
    const res = await req('GET', `/uploads/view?path=${encodeURIComponent(`${sessionId}/pic.png`)}&disp=raw`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('未知扩展名回落 application/octet-stream', async () => {
    const res = await req('GET', `/uploads/view?path=${encodeURIComponent(`${sessionId}/bin.dat`)}&disp=raw`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });
});

describe('GET /uploads/view：校验链', () => {
  it('`..` 穿越 → 403', async () => {
    const res = await req(
      'GET',
      `/uploads/view?path=${encodeURIComponent(`${sessionId}/../../outside/secret.txt`)}&disp=file`,
    );
    expect(res.status).toBe(403);
  });

  it('uploads 根外绝对路径 → 403', async () => {
    const res = await req('GET', `/uploads/view?path=${encodeURIComponent('C:\\Windows\\win.ini')}&disp=file`);
    expect(res.status).toBe(403);
  });

  it('不存在 → 404', async () => {
    const res = await req('GET', `/uploads/view?path=${encodeURIComponent(`${sessionId}/nope.md`)}&disp=file`);
    expect(res.status).toBe(404);
  });

  it('缺 path → 400', async () => {
    const res = await req('GET', '/uploads/view?disp=file');
    expect(res.status).toBe(400);
  });
});
