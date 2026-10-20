/**
 * WebUI 静态托管测试（Task-20261017-001 §3.2 / D3 / 验收 6.3）
 *
 * 测试内容：
 * 1. 已构建 webRoot：GET / 回落 index.html（no-cache）、普通静态 200 + max-age=300、
 *    /assets/ 深路径 immutable 缓存、不存在扩展名路径回落 API 404（JSON）、
 *    无扩展名路径回落 API 404、路径穿越 403、HEAD 200 空体、POST / 回落 API
 * 2. 未构建 webRoot（无 index.html）：整体降级，GET / 与静态路径均回落 API 404
 * 3. token 模式：静态页免鉴权（GET / 无 Authorization 仍 200）、
 *    已注册 API 需 Bearer（401）、未注册路径回落未命中保持鉴权语义（401 优先于 404）
 *
 * 夹具：三个独立 server 实例（无 token 已构建 / 无 token 未构建 / 有 token），webRoot 注入临时目录。
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { createEmbeddedStaticHandler, type StaticHandler } from '../src/api/static.js';
import { SessionStore } from '../src/session/store.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';

// mock process.getBuiltinModule('node:sea')：embeddedAssets 非空模拟 SEA 运行时
// （static.ts 运行时经 getBuiltinModule 取 node:sea；getAsset 缺失资源抛错，语义同真实 API）
const embeddedAssets = new Map<string, Buffer>();
function mockGetBuiltinModule(id: string): object | undefined {
  if (id !== 'node:sea') return undefined;
  return {
    isSea: (): boolean => embeddedAssets.size > 0,
    getAsset: (key: string): ArrayBuffer => {
      const buf = embeddedAssets.get(key);
      if (!buf) throw new Error(`Asset not found: ${key}`);
      const ab = new ArrayBuffer(buf.length);
      new Uint8Array(ab).set(buf);
      return ab;
    },
  };
}

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-api-static');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');
const WEB_ROOT = join(TEST_DIR, 'web');
const EMPTY_ROOT = join(TEST_DIR, 'empty-web');

const INDEX_HTML = '<!doctype html><html lang="zh-CN"><body>webui-ok</body></html>';
const APP_CSS = 'body { margin: 0; }';
const ASSET_JS = 'console.log("asset");';

async function makeServer(getConfig: () => AgentConfig): Promise<{ server: ApiServer; base: string }> {
  const store = new SessionStore(TEST_WORKSPACE, false, join(TEST_DIR, 'sessions'));
  await store.init();
  const api = createApiServer({
    runAgent: async () => { throw new Error('本套件不触达 runAgent'); },
    sessionStore: store,
    getConfig,
    version: 'test-0.0.0',
  });
  const { port } = await api.start();
  return { server: api, base: `http://127.0.0.1:${port}` };
}

let base = ''; // 无 token + 已构建 webRoot
let baseEmpty = ''; // 无 token + 未构建 webRoot
let baseToken = ''; // 有 token + 已构建 webRoot
const servers: ApiServer[] = [];

beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(WEB_ROOT, { recursive: true });
  mkdirSync(join(WEB_ROOT, 'assets'), { recursive: true });
  mkdirSync(EMPTY_ROOT, { recursive: true });
  mkdirSync(TEST_WORKSPACE, { recursive: true });
  writeFileSync(join(WEB_ROOT, 'index.html'), INDEX_HTML, 'utf-8');
  writeFileSync(join(WEB_ROOT, 'app.css'), APP_CSS, 'utf-8');
  writeFileSync(join(WEB_ROOT, 'assets', 'app-abc123.js'), ASSET_JS, 'utf-8');

  const cfg = (over: Partial<AgentConfig['api']> = {}): AgentConfig => ({
    ...structuredClone(DEFAULT_CONFIG),
    api: { ...DEFAULT_CONFIG.api, port: 0, ...over },
  });

  const a = await makeServer(() => cfg({ webRoot: WEB_ROOT }));
  base = a.base;
  servers.push(a.server);
  const b = await makeServer(() => cfg({ webRoot: EMPTY_ROOT }));
  baseEmpty = b.base;
  servers.push(b.server);
  const c = await makeServer(() => cfg({ webRoot: WEB_ROOT, token: 'tok-static' }));
  baseToken = c.base;
  servers.push(c.server);
});

afterAll(async () => {
  for (const s of servers) await s.close();
});

describe('静态托管（已构建 webRoot）', () => {
  it('GET / → 200 index.html（no-cache）', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it('GET /app.css → 200 text/css + max-age=300', async () => {
    const res = await fetch(`${base}/app.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await res.text()).toBe(APP_CSS);
  });

  it('GET /assets/app-abc123.js → 200 immutable 缓存', async () => {
    const res = await fetch(`${base}/assets/app-abc123.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ASSET_JS);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('GET /missing.css（扩展名但不存在）→ 回落 API 404 JSON', async () => {
    const res = await fetch(`${base}/missing.css`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('GET /nope（无扩展名）→ 回落 API 404 JSON', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('路径穿越（%2f 编码斜杠绕过 URL 归一化）→ 服务端 403', async () => {
    // WHATWG URL 会消解 /../ 段，但 /..%2fsecret.txt 中 %2f 保留到 handler 内 decode → 越界
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(base);
      const r = http.request({ host: u.hostname, port: u.port, path: '/..%2fsecret.txt', method: 'GET' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      r.on('error', reject);
      r.end();
    });
    expect(status).toBe(403);
  });

  it('HEAD / → 200 空 body', async () => {
    const res = await fetch(`${base}/`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('POST /（非 GET/HEAD）→ 回落 API 404 JSON', async () => {
    const res = await fetch(`${base}/`, { method: 'POST' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});

describe('静态托管（未构建 webRoot 降级）', () => {
  it('GET / 与 /app.css 均回落 API 404 JSON', async () => {
    for (const p of ['/', '/app.css']) {
      const res = await fetch(`${baseEmpty}${p}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    }
  });
});

describe('静态托管（token 模式：静态页免鉴权）', () => {
  it('GET / 无 Authorization → 200（静态不鉴权）', async () => {
    const res = await fetch(`${baseToken}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it('GET /health 无 Authorization → 401；带 Bearer → 200', async () => {
    const noAuth = await fetch(`${baseToken}/health`);
    expect(noAuth.status).toBe(401);
    const ok = await fetch(`${baseToken}/health`, { headers: { authorization: 'Bearer tok-static' } });
    expect(ok.status).toBe(200);
  });

  it('GET /nope（无扩展名 + 无 token）→ 401（回落未命中保持鉴权语义）', async () => {
    const res = await fetch(`${baseToken}/nope`);
    expect(res.status).toBe(401);
  });
});

describe('SEA 内嵌资源托管（mock node:sea）', () => {
  const EMB_INDEX = '<!doctype html><html lang="zh-CN"><body>sea-webui</body></html>';
  const EMB_CSS = 'body { color: red; }';
  const EMB_JS = 'console.log("sea");';
  const servers: http.Server[] = [];

  /** 用内嵌 handler 起独立 http server（未命中回落 404 JSON，模拟 API 层语义） */
  async function makeEmbeddedServer(): Promise<string> {
    const handler = createEmbeddedStaticHandler() as StaticHandler;
    expect(handler).not.toBeNull();
    const srv = http.createServer((req, res) => {
      void handler(req, res).then((hit) => {
        if (!hit && !res.writableEnded) {
          res.statusCode = 404;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: { code: 'not_found' } }));
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    servers.push(srv);
    const addr = srv.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  beforeAll(async () => {
    vi.spyOn(process, 'getBuiltinModule').mockImplementation(
      ((id: string) => mockGetBuiltinModule(id)) as never,
    );
    embeddedAssets.set('index.html', Buffer.from(EMB_INDEX, 'utf-8'));
    embeddedAssets.set('app.css', Buffer.from(EMB_CSS, 'utf-8'));
    embeddedAssets.set('assets/app-sea123.js', Buffer.from(EMB_JS, 'utf-8'));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    embeddedAssets.clear(); // 还原非 SEA 语义，避免影响其他文件用例
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  });

  it('非 SEA 运行时（无内嵌 index.html）→ handler 为 null（降级）', () => {
    const saved = new Map(embeddedAssets);
    embeddedAssets.clear();
    expect(createEmbeddedStaticHandler()).toBeNull();
    for (const [k, v] of saved) embeddedAssets.set(k, v);
  });

  it('GET / → 200 内嵌 index.html（no-cache）', async () => {
    const base = await makeEmbeddedServer();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe(EMB_INDEX);
  });

  it('GET /app.css → 200 text/css + max-age=300', async () => {
    const base = await makeEmbeddedServer();
    const res = await fetch(`${base}/app.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
    expect(await res.text()).toBe(EMB_CSS);
  });

  it('GET /assets/app-sea123.js → 200 immutable 缓存', async () => {
    const base = await makeEmbeddedServer();
    const res = await fetch(`${base}/assets/app-sea123.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(EMB_JS);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('GET /missing.css → 回落 404 JSON', async () => {
    const base = await makeEmbeddedServer();
    const res = await fetch(`${base}/missing.css`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('GET /nope（无扩展名）→ 回落 404 JSON', async () => {
    const base = await makeEmbeddedServer();
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it('HEAD / → 200 空 body', async () => {
    const base = await makeEmbeddedServer();
    const res = await fetch(`${base}/`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('POST / → 回落 404 JSON', async () => {
    const base = await makeEmbeddedServer();
    const res = await fetch(`${base}/`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('路径穿越 → 拒绝（%2e%2e 被 URL 规范化消除，反斜杠/绝对路径 403）', async () => {
    const base = await makeEmbeddedServer();
    // %2e%2e 在 new URL 规范化时即被当作 .. 段消耗 → /secret.txt 不存在的 key 回落 API 404
    const dotdot = await fetch(`${base}/%2e%2e/secret.txt`);
    expect(dotdot.status).toBe(404);
    // 反斜杠编码 / 绝对路径编码 → handler 403
    for (const p of ['/a%5Cb.js', '/%2fsecret.css']) {
      const res = await fetch(`${base}${p}`);
      expect(res.status, p).toBe(403);
    }
  });
});
