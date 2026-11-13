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
import { canonicalWorkspacePath } from '../src/session/path-utils.js';
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
  const testLoader = new ConfigLoader(TEST_GLOBAL_DIR);
  const testWriter = new ConfigWriter(TEST_GLOBAL_DIR, testLoader);

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

/**
 * 需求 20261113-001 D7：`/fs/*` 端点已改为「缺 ws 一律 400」，不再隐式回落最近使用空间。
 * 这里统一注入 ws=TEST_WORKSPACE，用例本身不逐条补参——
 * 逐例手工补 55 处极易漏改，且漏改者会因「回归到 400」而**静默变形**（测试仍绿但语义已变）。
 * 已显式带 ws 的调用（如 `?ws=B`）原样透传，不覆盖。
 */
const DEFAULT_WS = `ws=${encodeURIComponent(TEST_WORKSPACE)}`;
function withWs(path: string): string {
  if (!path.startsWith('/fs/') || /[?&]ws=/.test(path)) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}${DEFAULT_WS}`;
}

async function req(path: string): Promise<Res> {
  return fetch(`${base}${withWs(path)}`);
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

describe('GET /fs/search（文件名 / 目录名 / 内容）', () => {
  /** 搜索响应体（kind 为 20261028-004 新增） */
  type SearchBody = {
    query: string;
    truncated: boolean;
    results: { path: string; name: string; line: number; text: string; kind: string }[];
  };

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

  /* ---- 文件名 / 目录名匹配（20261028-004） ---- */

  it('文件名命中：kind=name、line=0、text 为空', async () => {
    const res = await req('/fs/search?q=' + encodeURIComponent('grep-me'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchBody;
    expect(body.results).toEqual([
      { path: 'src/grep-me.txt', name: 'grep-me.txt', line: 0, text: '', kind: 'name' },
    ]);
  });

  it('目录名命中：kind=dir，且不把其下文件逐个当目录命中列出', async () => {
    const body = (await (await req('/fs/search?q=' + encodeURIComponent('api'))).json()) as SearchBody;
    const dirs = body.results.filter((r) => r.kind === 'dir');
    expect(dirs.map((r) => r.path)).toContain('src/api');
    expect(dirs.every((r) => r.line === 0 && r.text === '')).toBe(true);
    // 目录命中只有目录自身一条，不展开其下 router.ts
    expect(dirs.some((r) => r.path === 'src/api/router.ts')).toBe(false);
  });

  it('名称命中整体排在内容命中之前', async () => {
    const body = (await (await req('/fs/search?q=' + encodeURIComponent('deep'))).json()) as SearchBody;
    const kinds = body.results.map((r) => r.kind);
    const firstContent = kinds.indexOf('content');
    expect(kinds).toContain('dir');
    expect(firstContent).toBeGreaterThan(0); // 至少一条名称命中排在最前
    expect(kinds.slice(firstContent).every((k) => k === 'content')).toBe(true);
  });

  it('恒排除目录自身的名字也不参与匹配', async () => {
    for (const q of ['node_modules', '__pycache__']) {
      const body = (await (await req('/fs/search?q=' + encodeURIComponent(q))).json()) as SearchBody;
      expect(body.results).toEqual([]);
    }
  });

  it('二进制与大文件可被文件名命中，但不产生内容命中', async () => {
    const blob = (await (await req('/fs/search?q=' + encodeURIComponent('blob'))).json()) as SearchBody;
    expect(blob.results).toEqual([
      { path: 'blob.bin', name: 'blob.bin', line: 0, text: '', kind: 'name' },
    ]);
    const big = (await (await req('/fs/search?q=' + encodeURIComponent('big'))).json()) as SearchBody;
    expect(big.results).toEqual([
      { path: 'big.log', name: 'big.log', line: 0, text: '', kind: 'name' },
    ]);
  });

  it('hidden=0 时 dot 目录与其下名称均不参与匹配；hidden=1 参与', async () => {
    const off = (await (await req('/fs/search?q=' + encodeURIComponent('secret'))).json()) as SearchBody;
    expect(off.results).toEqual([]);
    const on = (await (await req('/fs/search?q=' + encodeURIComponent('secret') + '&hidden=1')).json()) as SearchBody;
    expect(on.results.map((r) => `${r.kind}:${r.path}`)).toEqual(['name:.hidden/secret.txt']);
    // dot 目录名本身也参与匹配
    const dirOn = (await (await req('/fs/search?q=' + encodeURIComponent('hidden') + '&hidden=1')).json()) as SearchBody;
    expect(dirOn.results.some((r) => r.kind === 'dir' && r.path === '.hidden')).toBe(true);
  });
});

// ===== 4. /fs/*?ws=（文件面板跟随活跃会话所属空间） =====

describe('GET /fs/*?ws=（显式指定工作空间根）', () => {
  const WS_B = join(TEST_DIR, 'workspace-b');
  const wsQuery = `&ws=${encodeURIComponent(WS_B)}`;

  beforeAll(async () => {
    mkdirSync(join(WS_B, 'sub'), { recursive: true });
    writeFileSync(join(WS_B, 'ONLY_B.md'), '# B\n\nonly b needle\n', 'utf-8');
    writeFileSync(join(WS_B, 'sub', 'b.txt'), 'B_SPACE_NEEDLE\n', 'utf-8');
    // 第二空间落 meta.json → 进入 listAllWorkspaces，成为「已注册工作空间」
    await new SessionStore(WS_B, false, join(TEST_DIR, 'sessions')).init();
  });

  it('?ws=B：树根切到 B，只列 B 的条目', async () => {
    const res = await req('/fs/tree?ws=' + encodeURIComponent(WS_B));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { root: string; name: string; children: FsNode[] };
    expect(body.root).toBe(await canonicalWorkspacePath(WS_B));
    expect(body.name).toBe('workspace-b');
    const names = body.children.map((n) => n.name);
    expect(names).toContain('ONLY_B.md');
    expect(names).toContain('sub');
    expect(names).not.toContain('README.md');
  });

  it('?ws=B：path 相对 B 解析，跨空间文件 404', async () => {
    const sub = (await (
      await req('/fs/tree?path=' + encodeURIComponent('sub') + wsQuery)
    ).json()) as { children: FsNode[] };
    expect(sub.children.map((n) => n.name)).toEqual(['b.txt']);

    const hit = await req('/fs/file?path=' + encodeURIComponent('ONLY_B.md') + wsQuery);
    expect(hit.status).toBe(200);
    expect(((await hit.json()) as { content: string }).content).toContain('only b needle');
    // 启动空间的文件在 B 根下不存在
    expect((await req('/fs/file?path=' + encodeURIComponent('README.md') + wsQuery)).status).toBe(404);
  });

  it('?ws=B：搜索与 raw 同样以 B 为根', async () => {
    const search = await req('/fs/search?q=' + encodeURIComponent('B_SPACE_NEEDLE') + wsQuery);
    expect(search.status).toBe(200);
    const body = (await search.json()) as { results: { path: string }[] };
    expect(body.results.map((r) => r.path)).toEqual(['sub/b.txt']);

    const raw = await req('/fs/raw?path=' + encodeURIComponent('ONLY_B.md') + wsQuery);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toContain('only b needle');
  });

  it('未知空间 → 403 forbidden（存在但未注册的目录同样拒绝）', async () => {
    const outsider = join(TEST_DIR, 'not-a-workspace');
    mkdirSync(outsider, { recursive: true });
    const res = await req('/fs/tree?ws=' + encodeURIComponent(outsider));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('forbidden');
    expect(body.error.message).toContain('未知工作空间');
  });

  it('缺 ?ws= → 400 bad_request（需求 20261113-001 D2：不再隐式回落）', async () => {
    // 直接用 fetch 绕过 withWs，验证「真的没有 ws」时的行为
    const res = await fetch(`${base}/fs/tree`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toContain('ws');
  });
});

// ===== 5. /fs/fingerprint =====

describe('GET /fs/fingerprint（目录变更指纹）', () => {
  interface FpBody {
    root: string;
    dirs: { path: string; sig: string | null }[];
  }

  async function fp(paths: string[], extra = ''): Promise<FpBody> {
    const q = paths.map((p) => `path=${encodeURIComponent(p)}`).join('&');
    const res = await req(`/fs/fingerprint?${q}${extra}`);
    expect(res.status).toBe(200);
    return (await res.json()) as FpBody;
  }
  const sigOf = (body: FpBody, path: string): string | null =>
    body.dirs.find((d) => d.path === path)?.sig ?? null;

  it('缺 path → 400；越界路径 → 403', async () => {
    expect((await req('/fs/fingerprint')).status).toBe(400);
    expect((await req('/fs/fingerprint?path=' + encodeURIComponent('../outside'))).status).toBe(403);
  });

  it('各目录返回 sha1 指纹；文件与不存在路径为 null', async () => {
    const body = await fp(['', 'src', 'README.md', 'no-such-dir']);
    expect(body.root).toBe(TEST_WORKSPACE);
    expect(sigOf(body, '')).toMatch(/^[0-9a-f]{40}$/);
    expect(sigOf(body, 'src')).toMatch(/^[0-9a-f]{40}$/);
    expect(sigOf(body, 'src')).not.toBe(sigOf(body, ''));
    expect(sigOf(body, 'README.md')).toBeNull();
    expect(sigOf(body, 'no-such-dir')).toBeNull();
  });

  it('新增/删除文件：本目录指纹变化，父目录只受直接子项影响', async () => {
    const before = await fp(['', 'src']);
    const srcBefore = sigOf(before, 'src');
    const rootBefore = sigOf(before, '');

    const added = join(TEST_WORKSPACE, 'src', 'fp-new.txt');
    writeFileSync(added, 'fp needle\n', 'utf-8');
    const afterAdd = await fp(['', 'src']);
    expect(sigOf(afterAdd, 'src')).not.toBe(srcBefore);
    expect(sigOf(afterAdd, '')).toBe(rootBefore); // 根的直接子项（src）未变

    rmSync(added);
    expect(sigOf(await fp(['', 'src']), 'src')).toBe(srcBefore);
  });

  it('文件改写（大小变化）→ 所在目录指纹变化', async () => {
    const file = join(TEST_WORKSPACE, 'README.md');
    const original = '# Workspace\n\nhello fs browser\n';
    writeFileSync(file, original, 'utf-8');
    const before = await fp(['']);
    writeFileSync(file, `${original}appended line\n`, 'utf-8');
    const after = await fp(['']);
    expect(sigOf(after, '')).not.toBe(sigOf(before, ''));
    writeFileSync(file, original, 'utf-8');
  });

  it('恒排除目录不参与指纹：node_modules 内容变化不影响根', async () => {
    const before = await fp(['']);
    writeFileSync(join(TEST_WORKSPACE, 'node_modules', 'pkg', 'index.js'), 'NEEDLE in node_modules changed\n', 'utf-8');
    expect(sigOf(await fp(['']), '')).toBe(sigOf(before, ''));
  });

  it('?ws=B：指纹以 B 为根', async () => {
    const wsB = join(TEST_DIR, 'workspace-b');
    const body = await fp(['', 'sub'], `&ws=${encodeURIComponent(wsB)}`);
    expect(body.root).toBe(await canonicalWorkspacePath(wsB));
    expect(sigOf(body, 'sub')).toMatch(/^[0-9a-f]{40}$/);
    // B 根下没有启动空间的 README.md
    expect(sigOf(await fp(['README.md'], `&ws=${encodeURIComponent(wsB)}`), 'README.md')).toBeNull();
  });
});

// ===== 6. 写操作与下载（优化建议 20261021-005） =====

/** JSON / 无体请求辅助（/fs/* 统一注入 ws，见 withWs） */
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  return fetch(`${base}${withWs(path)}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 最小 zip 解析：从 EOCD → 中央目录 → 本地头，取出条目名与存储数据 */
function zipEntries(buf: Buffer): { name: string; dir: boolean; size: number; data: Buffer }[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out: { name: string; dir: boolean; size: number; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(off)).toBe(0x02014b50);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    expect(buf.readUInt32LE(localOff)).toBe(0x04034b50);
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    out.push({ name, dir: name.endsWith('/'), size, data: buf.subarray(dataStart, dataStart + size) });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('DELETE /fs/entry（删除）', () => {
  it('删除文件：返回类型与路径，文件消失', async () => {
    const file = join(TEST_WORKSPACE, 'del-me.txt');
    writeFileSync(file, 'bye\n', 'utf-8');
    const res = await call('DELETE', '/fs/entry?path=del-me.txt');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: 'del-me.txt', type: 'file' });
    expect((await call('DELETE', '/fs/entry?path=del-me.txt')).status).toBe(404);
  });

  it('删除目录：未带 recursive → 400；recursive=1 → 200 且递归清除', async () => {
    mkdirSync(join(TEST_WORKSPACE, 'del-dir', 'inner'), { recursive: true });
    writeFileSync(join(TEST_WORKSPACE, 'del-dir', 'inner', 'x.txt'), 'x\n', 'utf-8');
    expect((await call('DELETE', '/fs/entry?path=del-dir')).status).toBe(400);
    expect((await call('DELETE', '/fs/entry?path=del-dir&recursive=1')).status).toBe(200);
    expect((await req('/fs/tree?path=' + encodeURIComponent('del-dir'))).status).toBe(404);
  });

  it('保护与越界：根、.git、.loop-agent、../ 一律拒绝', async () => {
    expect((await call('DELETE', '/fs/entry?path=')).status).toBe(403);
    for (const p of ['.git', 'src/.git', '.loop-agent', 'src/.loop-agent/config']) {
      expect((await call('DELETE', '/fs/entry?path=' + encodeURIComponent(p))).status).toBe(403);
    }
    expect((await call('DELETE', '/fs/entry?path=' + encodeURIComponent('../outside'))).status).toBe(403);
  });
});

describe('POST /fs/rename（重命名 / 移动）', () => {
  it('同目录改名：旧名消失、新名内容不变', async () => {
    writeFileSync(join(TEST_WORKSPACE, 'old-name.txt'), 'rename body\n', 'utf-8');
    const res = await call('POST', '/fs/rename', { from: 'old-name.txt', to: 'new-name.txt' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ from: 'old-name.txt', to: 'new-name.txt', type: 'file' });
    expect((await req('/fs/file?path=' + encodeURIComponent('new-name.txt'))).status).toBe(200);
    expect((await req('/fs/file?path=' + encodeURIComponent('old-name.txt'))).status).toBe(404);
  });

  it('跨目录移动：目录节点同样可改名', async () => {
    mkdirSync(join(TEST_WORKSPACE, 'mv-src'), { recursive: true });
    writeFileSync(join(TEST_WORKSPACE, 'mv-src', 'm.txt'), 'm\n', 'utf-8');
    const res = await call('POST', '/fs/rename', { from: 'mv-src', to: 'src/mv-dst' });
    expect(res.status).toBe(200);
    expect((await req('/fs/file?path=' + encodeURIComponent('src/mv-dst/m.txt'))).status).toBe(200);
    await call('DELETE', '/fs/entry?path=' + encodeURIComponent('src/mv-dst') + '&recursive=1');
  });

  it('校验：缺参数 400、源不存在 404、目标已存在 409、父目录缺失 404、根与保护名 403', async () => {
    expect((await call('POST', '/fs/rename', {})).status).toBe(400);
    expect((await call('POST', '/fs/rename', { from: 'nope.txt', to: 'x.txt' })).status).toBe(404);
    expect((await call('POST', '/fs/rename', { from: 'README.md', to: 'src' })).status).toBe(409);
    expect((await call('POST', '/fs/rename', { from: 'README.md', to: 'no-dir/x.txt' })).status).toBe(404);
    expect((await call('POST', '/fs/rename', { from: 'README.md', to: '' })).status).toBe(400);
    expect((await call('POST', '/fs/rename', { from: '', to: 'x.txt' })).status).toBe(400);
    expect((await call('POST', '/fs/rename', { from: 'README.md', to: '.git/x' })).status).toBe(403);
    expect((await call('POST', '/fs/rename', { from: 'README.md', to: '../x' })).status).toBe(403);
  });
});

describe('POST /fs/mkdir（新建目录）', () => {
  it('新建目录：201、树中可见；重复创建 409', async () => {
    const res = await call('POST', '/fs/mkdir', { path: 'made-dir' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ path: 'made-dir', type: 'dir' });
    const tree = (await (await req('/fs/tree?path=')).json()) as { children: FsNode[] };
    expect(tree.children.map((n) => n.name)).toContain('made-dir');
    expect((await call('POST', '/fs/mkdir', { path: 'made-dir' })).status).toBe(409);
    await call('DELETE', '/fs/entry?path=made-dir&recursive=1');
  });

  it('校验：空/根 400、父目录缺失 404、保护名 403', async () => {
    expect((await call('POST', '/fs/mkdir', {})).status).toBe(400);
    expect((await call('POST', '/fs/mkdir', { path: '' })).status).toBe(400);
    expect((await call('POST', '/fs/mkdir', { path: 'no-parent/child' })).status).toBe(404);
    expect((await call('POST', '/fs/mkdir', { path: '.git' })).status).toBe(403);
    expect((await call('POST', '/fs/mkdir', { path: '../outside' })).status).toBe(403);
  });
});

describe('POST /fs/upload（原始字节上传）', () => {
  async function upload(
    targetDir: string,
    fileName: string,
    data: Buffer | string,
    extra: { rel?: string; conflict?: string; ws?: string } = {},
  ): Promise<Res> {
    const headers: Record<string, string> = { 'x-file-name': encodeURIComponent(fileName) };
    if (extra.rel) headers['x-relative-path'] = encodeURIComponent(extra.rel);
    if (extra.conflict) headers['x-conflict'] = extra.conflict;
    // 缺省注入当前测试空间；显式 extra.ws（如 ws=B 用例）优先
    const ws = `&ws=${encodeURIComponent(extra.ws ?? TEST_WORKSPACE)}`;
    return fetch(`${base}/fs/upload?path=${encodeURIComponent(targetDir)}${ws}`, {
      method: 'POST',
      headers,
      body: data,
    });
  }

  it('上传到根目录：201、路径与字节数正确、内容可读', async () => {
    const res = await upload('', 'up.txt', 'upload body\n');
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ path: 'up.txt', bytes: 12, skipped: false });
    const file = (await (await req('/fs/file?path=' + encodeURIComponent('up.txt'))).json()) as { content: string };
    expect(file.content).toBe('upload body\n');
  });

  it('冲突策略：rename 生成 `name (1).ext`、overwrite 覆盖、skip 跳过', async () => {
    const r1 = await upload('', 'dup.txt', 'first\n', { conflict: 'rename' });
    const r2 = await upload('', 'dup.txt', 'second\n', { conflict: 'rename' });
    expect(await r2.json()).toMatchObject({ path: 'dup (1).txt', skipped: false });
    expect(r1.status).toBe(201);

    const over = await upload('', 'dup.txt', 'third\n', { conflict: 'overwrite' });
    expect(over.status).toBe(201);
    const content = (await (await req('/fs/file?path=' + encodeURIComponent('dup.txt'))).json()) as { content: string };
    expect(content.content).toBe('third\n');

    const skip = await upload('', 'dup.txt', 'ignored\n', { conflict: 'skip' });
    expect(skip.status).toBe(200);
    expect(await skip.json()).toEqual({ path: 'dup.txt', bytes: 8, skipped: true });
    const after = (await (await req('/fs/file?path=' + encodeURIComponent('dup.txt'))).json()) as { content: string };
    expect(after.content).toBe('third\n');
  });

  it('目录上传：X-Relative-Path 嵌套层级 + 父目录自动创建', async () => {
    const res = await upload('', 'a.txt', 'nested\n', { rel: 'uploaded/sub/a.txt' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ path: 'uploaded/sub/a.txt' });
    expect((await req('/fs/file?path=' + encodeURIComponent('uploaded/sub/a.txt'))).status).toBe(200);

    const into = await upload('uploaded', 'a.txt', 'into sub\n', { rel: 'sub/a.txt', conflict: 'overwrite' });
    expect(into.status).toBe(201);
  });

  it('校验：缺 X-File-Name 400、目标目录不存在 404、相对路径非法 400/403', async () => {
    const noName = await fetch(`${base}/fs/upload?path=&${DEFAULT_WS}`, { method: 'POST', body: 'x' });
    expect(noName.status).toBe(400);
    expect(((await noName.json()) as { error: { message: string } }).error.message).toContain('X-File-Name');
    expect((await upload('no-such-dir', 'a.txt', 'x')).status).toBe(404);
    expect(
      (await upload('', 'a.txt', 'x', { rel: '../escape.txt', conflict: 'rename' })).status,
    ).toBe(400);
    expect((await upload('', 'a.txt', 'x', { rel: 'C:/escape.txt' })).status).toBe(400);
    expect((await upload('', 'a.txt', 'x', { rel: '.git/a.txt' })).status).toBe(403);
  });

  it('?ws=B：上传落到指定工作空间而非启动空间', async () => {
    const wsB = join(TEST_DIR, 'workspace-b');
    const res = await upload('', 'in-b.txt', 'b space\n', { ws: wsB });
    expect(res.status).toBe(201);
    expect((await req('/fs/file?path=' + encodeURIComponent('in-b.txt') + `&ws=${encodeURIComponent(wsB)}`)).status).toBe(200);
    expect((await req('/fs/file?path=' + encodeURIComponent('in-b.txt'))).status).toBe(404);
    await call('DELETE', `/fs/entry?path=in-b.txt&ws=${encodeURIComponent(wsB)}`);
  });
});

describe('GET /fs/download（文件附件 / 目录 zip）', () => {
  it('文件：返回原始字节与附件头（中文名 RFC5987）', async () => {
    writeFileSync(join(TEST_WORKSPACE, '下载样例.txt'), 'download me\n', 'utf-8');
    const res = await req('/fs/download?path=' + encodeURIComponent('下载样例.txt'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toContain("attachment; filename=");
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).toContain(encodeURIComponent('下载样例.txt'));
    expect(await res.text()).toBe('download me\n');
    rmSync(join(TEST_WORKSPACE, '下载样例.txt'));
  });

  it('目录：zip 可解析，层级与内容正确、中文名 UTF-8、跳过 node_modules', async () => {
    mkdirSync(join(TEST_WORKSPACE, 'zipcase', 'inner', 'empty'), { recursive: true });
    writeFileSync(join(TEST_WORKSPACE, 'zipcase', 'top.txt'), 'TOP\n', 'utf-8');
    writeFileSync(join(TEST_WORKSPACE, 'zipcase', 'inner', '中文.txt'), '中文内容\n', 'utf-8');
    mkdirSync(join(TEST_WORKSPACE, 'zipcase', 'node_modules'), { recursive: true });
    writeFileSync(join(TEST_WORKSPACE, 'zipcase', 'node_modules', 'skip.js'), 'SKIP\n', 'utf-8');

    const res = await req('/fs/download?path=' + encodeURIComponent('zipcase'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain(encodeURIComponent('zipcase.zip'));

    const entries = zipEntries(Buffer.from(await res.arrayBuffer()));
    const names = entries.map((e) => e.name);
    expect(names).toEqual([
      'inner/',
      'inner/empty/',
      'inner/中文.txt',
      'top.txt',
    ]);
    expect(entries.find((e) => e.name === 'top.txt')?.data.toString('utf8')).toBe('TOP\n');
    expect(entries.find((e) => e.name === 'inner/中文.txt')?.data.toString('utf8')).toBe('中文内容\n');
    expect(names.some((n) => n.startsWith('node_modules'))).toBe(false); // ALWAYS_SKIP 恒排除
    expect(entries.find((e) => e.name === 'inner/')?.dir).toBe(true);

    await call('DELETE', '/fs/entry?path=zipcase&recursive=1');
  });

  it('校验：不存在 404、保护路径 403', async () => {
    expect((await req('/fs/download?path=' + encodeURIComponent('no-such.txt'))).status).toBe(404);
    expect((await req('/fs/download?path=' + encodeURIComponent('../outside'))).status).toBe(403);
  });
});
