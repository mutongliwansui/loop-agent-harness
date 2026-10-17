/**
 * raw 上传端点测试（Task-20261017-001 §3.1b / WebUI P0）
 *
 * 测试内容（验收 6.2b）：
 * 1. POST /uploads/raw 正常路径：201、时间戳前缀命名、文件真实落盘 uploadsRoot/<sessionId>/、
 *    contextNote 真实格式（[文件上传] 文件名 / 上传路径 / 大小）、中文文件名经 encodeURIComponent 往返
 * 2. 同秒同名冲突链：第二个同名文件追加毫秒段，两者不同名且均落盘
 * 3. 防路径穿越：X-File-Name 含 ../ 段 → 仅保留末段，落盘在会话目录内
 * 4. 404：会话不存在
 * 5. 400：缺 X-File-Name / 非法 encodeURIComponent / 文件名为 .. 或空
 * 6. 413：body 超过 100MB 上限（readRawBody 排空后返回，客户端可收到 413）
 * 7. 既有路由不变：POST /uploads（服务器路径复制）行为不受 raw 路由影响
 *
 * 夹具与 api-endpoints.test.ts 一致：runtime 只注入 uploadsRoot（Partial），port 0 真实 http server。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { SessionStore } from '../src/session/store.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-api-uploads-raw');
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

  store = new SessionStore(TEST_WORKSPACE, 3, false, join(TEST_DIR, 'sessions'));
  await store.init();

  config = { ...config, api: { ...config.api, port: 0 } };

  const api = createApiServer({
    runAgent: async () => { throw new Error('本套件不触达 runAgent'); },
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

/** raw 上传：body 为原始字节，X-File-Name 为 encodeURIComponent 后的文件名 */
async function reqRaw(fileName: string, bytes: Uint8Array, sessionIdOverride?: string): Promise<Res> {
  return fetch(`${base}/uploads/raw?sessionId=${sessionIdOverride ?? sessionId}`, {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent(fileName) },
    body: bytes,
  });
}

interface RawEntry {
  originalPath: string;
  targetPath: string;
  fileName: string;
  bytes: number;
}

// ===== 正常路径 =====

describe('POST /uploads/raw 正常路径', () => {
  it('201：时间戳前缀命名 + 字节真实落盘 + contextNote 真实格式', async () => {
    const content = Buffer.from('raw upload content 中文内容', 'utf-8');
    const res = await reqRaw('需求清单.txt', content);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      sessionId: string;
      entries: RawEntry[];
      contextNote: string;
    };
    expect(body.sessionId).toBe(sessionId);
    expect(body.entries).toHaveLength(1);
    const entry = body.entries[0];
    expect(entry.originalPath).toBe(''); // raw 上传无源路径
    expect(entry.fileName).toMatch(/^\d{8}-\d{6}-需求清单\.txt$/);
    expect(entry.bytes).toBe(content.length);
    // 文件真实落盘且字节一致
    expect(existsSync(entry.targetPath)).toBe(true);
    expect(readFileSync(entry.targetPath)).toEqual(content);
    // contextNote 真实格式（与 buildContextNote 一致）
    expect(body.contextNote).toBe(
      `[文件上传] ${entry.fileName}\n  上传路径: ${entry.targetPath}\n  大小: ${entry.bytes}B`,
    );
  });

  it('同秒同名冲突链：第二个同名文件追加毫秒段，两者均落盘', async () => {
    const a = await reqRaw('conflict.log', Buffer.from('first'));
    const b = await reqRaw('conflict.log', Buffer.from('second'));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const ea = (((await a.json()) as { entries: RawEntry[] }).entries)[0];
    const eb = (((await b.json()) as { entries: RawEntry[] }).entries)[0];
    expect(ea.fileName).not.toBe(eb.fileName);
    expect(ea.fileName).toContain('conflict.log');
    expect(eb.fileName).toContain('conflict.log');
    expect(existsSync(ea.targetPath)).toBe(true);
    expect(existsSync(eb.targetPath)).toBe(true);
    // 同秒 → 第二个名含第一个的时间戳前缀
    expect(eb.fileName.startsWith(ea.fileName.slice(0, 15))).toBe(true);
  });

  it('防路径穿越：X-File-Name 含 ../ 段 → 仅保留末段，落盘在会话目录内', async () => {
    const res = await reqRaw('../../escape.txt', Buffer.from('safe'));
    expect(res.status).toBe(201);
    const entry = (((await res.json()) as { entries: RawEntry[] }).entries)[0];
    expect(entry.fileName).toMatch(/^\d{8}-\d{6}-escape\.txt$/);
    expect(entry.targetPath.startsWith(join(TEST_UPLOADS, sessionId))).toBe(true);
  });
});

// ===== 错误路径 =====

describe('POST /uploads/raw 错误路径', () => {
  it('会话不存在 → 404', async () => {
    const res = await reqRaw('a.txt', Buffer.from('x'), 'sess_unknown');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('缺 X-File-Name → 400', async () => {
    const res = await fetch(`${base}/uploads/raw?sessionId=${sessionId}`, {
      method: 'POST',
      body: Buffer.from('x'),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toContain('X-File-Name');
  });

  it('X-File-Name 非法 encodeURIComponent → 400', async () => {
    const res = await fetch(`${base}/uploads/raw?sessionId=${sessionId}`, {
      method: 'POST',
      headers: { 'x-file-name': '%ZZ' },
      body: Buffer.from('x'),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');
  });

  it('文件名归一后为空或 .. → 400', async () => {
    for (const name of ['..', '%2F']) {
      const res = await fetch(`${base}/uploads/raw?sessionId=${sessionId}`, {
        method: 'POST',
        headers: { 'x-file-name': name },
        body: Buffer.from('x'),
      });
      expect(res.status).toBe(400);
    }
  });

  it('body 超过 100MB 上限 → 413（连接正常返回，非重置）', async () => {
    const big = Buffer.alloc(100 * 1024 * 1024 + 1, 0x61);
    const res = await reqRaw('big.bin', big);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('payload_too_large');
    expect(body.error.message).toContain('100.0MB');
    // 落盘未发生
    const list = await req('GET', `/uploads?sessionId=${sessionId}`);
    const entries = ((await list.json()) as { entries: { fileName: string }[] }).entries;
    expect(entries.some((e) => e.fileName.includes('big.bin'))).toBe(false);
  }, 30_000);
});

// ===== 既有路由兼容 =====

describe('既有 uploads 路由不受 raw 路由影响', () => {
  it('POST /uploads（服务器路径复制）仍正常 201', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const dir = mkdtempSync(join(TEST_DIR, 'src-'));
    const src = join(dir, 'legacy.txt');
    writeFileSync(src, 'legacy path upload', 'utf-8');
    const res = await req('POST', '/uploads', { sessionId, paths: [src] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { entries: { originalPath: string }[] };
    expect(body.entries[0].originalPath).toBe(src);
  });

  it('GET /uploads 列出 raw 与 path 两种来源的文件', async () => {
    const list = await req('GET', `/uploads?sessionId=${sessionId}`);
    expect(list.status).toBe(200);
    const entries = ((await list.json()) as { entries: { fileName: string }[] }).entries;
    expect(entries.some((e) => e.fileName.includes('需求清单.txt'))).toBe(true);
    expect(entries.some((e) => e.fileName.includes('legacy.txt'))).toBe(true);
  });
});
