/**
 * 工作空间文件浏览器端点测试（原型-20261018-001）
 *
 * 测试内容：
 * 1. GET /fs/tree：目录优先排序、'/' 分隔相对路径、node_modules/__pycache__ 恒排除、
 *    dot 条目默认隐藏 / hidden=1 可见、truncated 标记
 * 2. GET /fs/file：嵌套路径内容、utf-8、缺 path 400、目录/不存在 404、
 *    越界（../ 与绝对路径）403、二进制（含 NUL）400、>512KB 截断
 * 3. GET /fs/search：大小写不敏感命中、行号、跳过 node_modules 与二进制、
 *    dot 文件默认跳过 / hidden=1 命中、缺 q 400
 *
 * 夹具：与 api-endpoints.test.ts 同模式——临时目录 SessionStore + 临时配置层，
 * 起 port 0 真实 http server，fetch 断言。工作空间根即 sessionStore.path。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { SessionStore } from '../src/session/store.js';
import { ConfigLoader } from '../src/config/loader.js';
import { ConfigWriter } from '../src/config/writer.js';
import { MCPManager } from '../src/config/mcp-manager.js';
import { createMemoryKit } from '../src/api/memory-kit.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-fs-endpoints');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');
const TEST_GLOBAL_DIR = join(TEST_DIR, 'global');
const TEST_UPLOADS = join(TEST_DIR, 'uploads');

type Res = Awaited<ReturnType<typeof fetch>>;

let server: ApiServer;
let base = '';

beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_GLOBAL_DIR, { recursive: true });

  // 工作空间夹具：src/ 嵌套 + 根文件 + node_modules + dot 目录 + 二进制 + 大文件
  mkdirSync(join(TEST_WORKSPACE, 'src', 'api'), { recursive: true });
  mkdirSync(join(TEST_WORKSPACE, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(TEST_WORKSPACE, '__pycache__'), { recursive: true });
  mkdirSync(join(TEST_WORKSPACE, '.hidden'), { recursive: true });
  writeFileSync(join(TEST_WORKSPACE, 'README.md'), '# Workspace\n\nhello fs browser\n', 'utf-8');
  writeFileSync(join(TEST_WORKSPACE, 'src', 'api', 'router.ts'), 'export const ROUTER_NEEDLE = 1;\n', 'utf-8');
  writeFileSync(join(TEST_WORKSPACE, 'src', 'grep-me.txt'), 'line one\nFind NEEDLE Here\nline three\n', 'utf-8');
  writeFileSync(join(TEST_WORKSPACE, 'node_modules', 'pkg', 'index.js'), 'NEEDLE in node_modules\n', 'utf-8');
  writeFileSync(join(TEST_WORKSPACE, '__pycache__', 'x.pyc'), 'NEEDLE in pycache\n', 'utf-8');
  writeFileSync(join(TEST_WORKSPACE, '.hidden', 'secret.txt'), 'NEEDLE in hidden dir\n', 'utf-8');
  writeFileSync(join(TEST_WORKSPACE, 'blob.bin'), Buffer.from([0x4e, 0x55, 0x00, 0x4c, 0x4c]));
  writeFileSync(join(TEST_WORKSPACE, 'big.log'), `${'x'.repeat(600 * 1024)}\n`, 'utf-8');
  // 12 层深目录：验证懒加载无深度上限（递归 /fs/tree 在 8 层处截断）
  const deep = join(TEST_WORKSPACE, 'deep', ...Array.from({ length: 11 }, (_, i) => `d${i + 1}`));
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, 'leaf.txt'), 'deep leaf\n', 'utf-8');

  const store = new SessionStore(TEST_WORKSPACE, false, join(TEST_DIR, 'sessions'));
  await store.init();

  const config: AgentConfig = { ...structuredClone(DEFAULT_CONFIG), api: { ...DEFAULT_CONFIG.api, port: 0 } };
  const testLoader = new ConfigLoader(TEST_WORKSPACE, TEST_GLOBAL_DIR);
  const testWriter = new ConfigWriter(TEST_WORKSPACE, TEST_GLOBAL_DIR, testLoader);

  const api = createApiServer({
    runAgent: async () => { throw new Error('本套件不触达 runAgent'); },
    sessionStore: store,
    getConfig: () => config,
    version: 'test-0.0.0',
    runtime: {
      configLoader: testLoader,
      configWriter: testWriter,
      uploadsRoot: TEST_UPLOADS,
      mcpManager: new MCPManager(testLoader),
      createMemoryKit: () => createMemoryKit(TEST_WORKSPACE, testLoader, {
        memoryRoot: join(TEST_DIR, 'memory'),
        globalCuratedDir: join(TEST_GLOBAL_DIR, 'curated'),
      }),
    },
  });
  server = api;
  const { port } = await api.start();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
});

async function req(path: string): Promise<Res> {
  return fetch(`${base}${path}`);
}

interface FsNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  children?: FsNode[];
}

function findNode(nodes: FsNode[], path: string): FsNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n;
    const hit = n.children ? findNode(n.children, path) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

// ===== 1. /fs/tree =====

describe('GET /fs/tree（工作空间文件树）', () => {
  it('默认：dot 条目隐藏，node_modules/__pycache__ 恒排除，目录在前、路径 / 分隔', async () => {
    const res = await req('/fs/tree');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      root: string; name: string; hidden: boolean; truncated: boolean; children: FsNode[];
    };
    expect(body.root).toBe(TEST_WORKSPACE);
    expect(body.name).toBe('workspace');
    expect(body.hidden).toBe(false);
    expect(body.truncated).toBe(false);

    const names = body.children.map((n) => n.name);
    expect(names).toContain('src');
    expect(names).toContain('README.md');
    expect(names).toContain('big.log');
    expect(names).not.toContain('.hidden');
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('__pycache__');
    expect(names).not.toContain('blob.bin' + '.hidden'); // sanity

    // 目录在前
    expect(body.children.findIndex((n) => n.type === 'dir')).toBeLessThan(
      body.children.findIndex((n) => n.type === 'file'),
    );

    // 嵌套节点：路径 '/' 分隔、文件带 size
    const router = findNode(body.children, 'src/api/router.ts');
    expect(router).toMatchObject({ name: 'router.ts', type: 'file' });
    expect(router?.size).toBeGreaterThan(0);
    expect(findNode(body.children, 'src/api')).toMatchObject({ type: 'dir' });
  });

  it('hidden=1：dot 目录可见且递归展开', async () => {
    const res = await req('/fs/tree?hidden=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hidden: boolean; children: FsNode[] };
    expect(body.hidden).toBe(true);
    expect(findNode(body.children, '.hidden')).toMatchObject({ type: 'dir' });
    expect(findNode(body.children, '.hidden/secret.txt')).toMatchObject({ type: 'file' });
    // 重目录仍排除
    expect(findNode(body.children, 'node_modules')).toBeUndefined();
  });
});

// ===== 1b. /fs/tree?path=（懒加载单层目录） =====

describe('GET /fs/tree?path=（懒加载单层目录）', () => {
  it('只返回直接子项，不递归展开，目录节点不带 children', async () => {
    const res = await req('/fs/tree?path=' + encodeURIComponent('src'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string; truncated: boolean; children: FsNode[];
    };
    expect(body.path).toBe('src');
    expect(body.truncated).toBe(false);
    expect(body.children.map((n) => n.name)).toEqual(['api', 'grep-me.txt']);
    expect(body.children.find((n) => n.name === 'api')?.children).toBeUndefined();
  });

  it('任意深度可逐层拉取（突破递归模式的 8 层上限）', async () => {
    let path = 'deep';
    for (let i = 1; i <= 11; i++) {
      const res = await req('/fs/tree?path=' + encodeURIComponent(path));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { children: FsNode[] };
      const next = body.children.find((n) => n.name === `d${i}`);
      expect(next).toMatchObject({ type: 'dir' });
      path = next!.path;
    }
    const body = (await (await req('/fs/tree?path=' + encodeURIComponent(path))).json()) as { children: FsNode[] };
    const leaf = body.children.find((n) => n.name === 'leaf.txt');
    expect(leaf).toMatchObject({ type: 'file', path: `${path}/leaf.txt` });
    expect(leaf?.size).toBeGreaterThan(0);
  });

  it('校验：不存在/非目录 → 404，越界 → 403', async () => {
    expect((await req('/fs/tree?path=' + encodeURIComponent('no-such-dir'))).status).toBe(404);
    expect((await req('/fs/tree?path=' + encodeURIComponent('README.md'))).status).toBe(404);
    expect((await req('/fs/tree?path=' + encodeURIComponent('../outside'))).status).toBe(403);
  });

  it('hidden 开关对单层列表同样生效', async () => {
    const plain = (await (await req('/fs/tree?path=')).json()) as { children: FsNode[] };
    expect(plain.children.map((n) => n.name)).not.toContain('.hidden');
    const hidden = (await (await req('/fs/tree?path=&hidden=1')).json()) as { children: FsNode[] };
    expect(hidden.children.map((n) => n.name)).toContain('.hidden');
  });
});

// ===== 2. /fs/file =====

describe('GET /fs/file（文件预览）', () => {
  it('相对路径读文件：内容 utf-8、path 归一化 / 分隔、bytes 为真实大小', async () => {
    const res = await req('/fs/file?path=' + encodeURIComponent('src/grep-me.txt'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; name: string; bytes: number; truncated: boolean; content: string };
    expect(body.path).toBe('src/grep-me.txt');
    expect(body.name).toBe('grep-me.txt');
    expect(body.bytes).toBe('line one\nFind NEEDLE Here\nline three\n'.length);
    expect(body.truncated).toBe(false);
    expect(body.content).toContain('NEEDLE');
  });

  it('缺 path → 400；目录 → 404；不存在 → 404', async () => {
    expect((await req('/fs/file')).status).toBe(400);
    expect((await req('/fs/file?path=' + encodeURIComponent('src'))).status).toBe(404);
    expect((await req('/fs/file?path=' + encodeURIComponent('no-such.txt'))).status).toBe(404);
  });

  it('越界路径 → 403：.. 逃逸与工作空间外绝对路径', async () => {
    const outside = join(TEST_DIR, 'outside.txt');
    writeFileSync(outside, 'secret', 'utf-8');
    expect((await req('/fs/file?path=' + encodeURIComponent('../outside.txt'))).status).toBe(403);
    expect((await req('/fs/file?path=' + encodeURIComponent(outside))).status).toBe(403);
  });

  it('含 NUL 的二进制 → 400 bad_request', async () => {
    const res = await req('/fs/file?path=' + encodeURIComponent('blob.bin'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toContain('二进制');
  });

  it('>512KB 截断：truncated:true 且 content 不超上限', async () => {
    const res = await req('/fs/file?path=' + encodeURIComponent('big.log'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bytes: number; truncated: boolean; content: string };
    expect(body.bytes).toBe(600 * 1024 + 1);
    expect(body.truncated).toBe(true);
    expect(Buffer.byteLength(body.content, 'utf-8')).toBe(512 * 1024);
  });
});

// ===== 3. /fs/search =====

describe('GET /fs/search（全文搜索）', () => {
  it('大小写不敏感命中，返回 相对路径/行号/文本；跳过 node_modules 与 __pycache__', async () => {
    const res = await req('/fs/search?q=' + encodeURIComponent('needle here'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      query: string; truncated: boolean;
      results: { path: string; name: string; line: number; text: string }[];
    };
    expect(body.query).toBe('needle here');
    expect(body.truncated).toBe(false);
    const paths = body.results.map((r) => r.path);
    expect(paths).toContain('src/grep-me.txt');
    expect(paths.some((p) => p.startsWith('node_modules'))).toBe(false);
    expect(paths.some((p) => p.startsWith('__pycache__'))).toBe(false);
    expect(paths).not.toContain('.hidden/secret.txt'); // 默认跳过 dot 目录

    const hit = body.results.find((r) => r.path === 'src/grep-me.txt')!;
    expect(hit.line).toBe(2);
    expect(hit.text).toBe('Find NEEDLE Here');
  });

  it('hidden=1：dot 目录文件参与搜索', async () => {
    const res = await req('/fs/search?q=' + encodeURIComponent('needle') + '&hidden=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { path: string }[] };
    expect(body.results.map((r) => r.path)).toContain('.hidden/secret.txt');
  });

  it('缺 q → 400；无命中 → 空 results', async () => {
    expect((await req('/fs/search')).status).toBe(400);
    const res = await req('/fs/search?q=' + encodeURIComponent('no-such-token-xyz'));
    expect(res.status).toBe(200);
    expect((await res.json()) as { results: unknown[] }).toEqual({ query: 'no-such-token-xyz', truncated: false, results: [] });
  });

  it('二进制文件不参与搜索', async () => {
    const res = await req('/fs/search?q=' + encodeURIComponent('NULL'));
    const body = (await res.json()) as { results: { path: string }[] };
    expect(body.results.map((r) => r.path)).not.toContain('blob.bin');
  });
});
