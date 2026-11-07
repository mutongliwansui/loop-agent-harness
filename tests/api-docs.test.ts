/**
 * 开发者中心 · API 接口文档 后端一致性测试（需求 20261104-002）
 *
 * 固化的不变量：
 * 1. **反射不漏端点**：端点全集 = createRoutes()，stats.total 与路由条数一致（非硬编码）；
 * 2. **元数据不静默漂移**：路由表里每个端点都有非空中文 summary（documented === total），
 *    且 API_DOC_ENTRIES 不含路由表里不存在的「幽灵键」（改名/删端点后忘删元数据也会失败）；
 * 3. **缺口可观测**：临时加一条无元数据路由时 documented:false 并进 stats.undocumented（D3）；
 * 4. **分组归属**：按路径段最长前缀匹配，`/fs/dirs` 归核心组、`/fs/tree` 归文件组、
 *    `/model` 与 `/models` 都归模型组，且不产生兜底 other 组；
 * 5. **端点可用**：GET /dev/api-docs 经 devRoutes() 的 handler 返回 200 与合法 payload。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoutes } from '../src/api/router.js';
import { createApiServer, type ApiServer } from '../src/api/server.js';
import { SessionStore } from '../src/session/store.js';
import { ConfigLoader } from '../src/config/loader.js';
import { ConfigWriter } from '../src/config/writer.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import {
  API_DOC_ENTRIES,
  API_DOC_GROUPS,
  collectApiDocs,
  groupOfPath,
  OTHER_GROUP,
  type ApiDocsPayload,
} from '../src/api/api-docs.js';
import { devRoutes } from '../src/api/handlers/dev.js';

const routes = createRoutes().map((r) => ({ method: r.method, path: r.path }));
const keyOf = (r: { method: string; path: string }): string => `${r.method} ${r.path}`;
const payload: ApiDocsPayload = collectApiDocs(routes, '9.9.9');

/** 是否含中日韩文字（用于断言 summary 是中文说明而非空串或纯英文占位） */
const hasCjk = (s: string): boolean => /[\u4e00-\u9fa5]/.test(s);

describe('api-docs：反射全集（D1）', () => {
  it('stats.total 等于 createRoutes() 实际条数', () => {
    expect(payload.stats.total).toBe(routes.length);
    // 86 = 85 + 20261107-002 新增 GET /sessions/:id/subagents
    expect(payload.stats.total).toBe(86);
  });

  it('路由表无重复的 METHOD + path（重复会导致文档条目被覆盖）', () => {
    const keys = routes.map(keyOf);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('version 透传自调用方', () => {
    expect(payload.version).toBe('9.9.9');
  });

  it('分组展开后条目集合等于路由全集，且组内保持路由表相对顺序', () => {
    const flat = payload.groups.flatMap((g) => g.items.map(keyOf));
    expect(flat).toHaveLength(routes.length);
    // 跨组顺序由分组定义决定（不追求与路由表全局同序），集合必须完全一致
    expect([...flat].sort()).toEqual(routes.map(keyOf).sort());
    // 组内顺序 = 路由表中该组端点的相对顺序（前端不做二次排序，保证「静态段先于 :param」的语义可见）
    for (const g of payload.groups) {
      const expected = routes.filter((r) => groupOfPath(r.path) === g.key).map(keyOf);
      expect(g.items.map(keyOf), `分组 ${g.key} 组内顺序漂移`).toEqual(expected);
    }
  });
});

describe('api-docs：元数据覆盖（D2 / D3）', () => {
  it('全部端点都有非空中文 summary（documented === total，缺口为 0）', () => {
    expect(payload.stats.undocumented).toEqual([]);
    expect(payload.stats.documented).toBe(payload.stats.total);
    for (const g of payload.groups) {
      for (const it of g.items) {
        expect(it.documented, `${it.method} ${it.path} 未登记说明`).toBe(true);
        expect(it.summary.trim().length, `${it.method} ${it.path} summary 为空`).toBeGreaterThan(0);
        expect(hasCjk(it.summary), `${it.method} ${it.path} summary 不是中文说明`).toBe(true);
      }
    }
  });

  it('元数据表不含路由表里不存在的键（防改名/删端点后遗留幽灵条目）', () => {
    const routeKeys = new Set(routes.map(keyOf));
    const ghosts = Object.keys(API_DOC_ENTRIES).filter((k) => !routeKeys.has(k));
    expect(ghosts).toEqual([]);
  });

  it('元数据字段合法：params 的 in / name 非空，scope 只有 read|write', () => {
    for (const [k, e] of Object.entries(API_DOC_ENTRIES)) {
      expect(['read', 'write', undefined]).toContain(e.scope);
      for (const p of e.params ?? []) {
        expect(['path', 'query', 'body'], `${k} 参数位置非法`).toContain(p.in);
        expect(p.name.trim().length, `${k} 参数名为空`).toBeGreaterThan(0);
        expect(p.desc.trim().length, `${k} 参数 ${p.name} 缺少说明`).toBeGreaterThan(0);
      }
      // curl 示例里不写 base URL（方案 D9：前端用 location.origin 拼接）
      if (e.example) expect(e.example, `${k} 的 example 不应自带 http(s) base`).not.toMatch(/https?:\/\//);
    }
  });

  it('缺口可观测：临时新增无元数据端点 → documented:false 且进 undocumented', () => {
    const synthetic = [...routes, { method: 'GET', path: '/brand-new-thing' }];
    const p = collectApiDocs(synthetic);
    expect(p.stats.undocumented).toEqual(['GET /brand-new-thing']);
    expect(p.stats.documented).toBe(payload.stats.documented);
    const other = p.groups.find((g) => g.key === OTHER_GROUP);
    expect(other, '未命中分组的端点应落入 other 组').toBeTruthy();
    expect(other!.items[0]).toMatchObject({
      method: 'GET',
      path: '/brand-new-thing',
      summary: '',
      documented: false,
      scope: 'read',
      stream: false,
    });
  });

  it('scope / stream 缺省派生：GET 默认 read，非 GET 默认 write，SSE 端点标记 stream', () => {
    const flat = payload.groups.flatMap((g) => g.items);
    const post = flat.find((it) => it.method === 'POST' && !API_DOC_ENTRIES[`POST ${it.path}`]?.scope);
    if (post) expect(post.scope).toBe('write');
    const sse = flat.find((it) => keyOf(it) === 'POST /sessions/:id/messages')!;
    expect(sse.stream).toBe(true);
  });
});

describe('api-docs：分组归属（最长前缀匹配）', () => {
  it('分组定义顺序与前缀均非空', () => {
    expect(API_DOC_GROUPS.map((g) => g.key)).toEqual([
      'core',
      'files',
      'config',
      'tools',
      'models',
      'extensions',
      'memory',
      'insight',
      'dev',
    ]);
    for (const g of API_DOC_GROUPS) {
      expect(g.title.trim().length).toBeGreaterThan(0);
      expect(g.desc.trim().length).toBeGreaterThan(0);
      expect(g.prefixes.length).toBeGreaterThan(0);
    }
  });

  it('路径段精确匹配：/fs/dirs 归 core，/fs/tree 归 files，/model* 归 models', () => {
    expect(groupOfPath('/fs/dirs')).toBe('core');
    expect(groupOfPath('/fs/tree')).toBe('files');
    expect(groupOfPath('/fs/file')).toBe('files');
    expect(groupOfPath('/model')).toBe('models');
    expect(groupOfPath('/models')).toBe('models');
    expect(groupOfPath('/models/bench/:runId/stream')).toBe('models');
    expect(groupOfPath('/sessions/:id/messages')).toBe('core');
    expect(groupOfPath('/memory/dream/history')).toBe('memory');
    expect(groupOfPath('/dev/api-docs')).toBe('dev');
    expect(groupOfPath('/uploads/view')).toBe('files');
    expect(groupOfPath('/terminal/info')).toBe('insight');
  });

  it('不产生兜底分组（每个端点都有归属）', () => {
    expect(payload.groups.some((g) => g.key === OTHER_GROUP)).toBe(false);
    for (const g of payload.groups) expect(g.items.length).toBeGreaterThan(0);
  });
});

describe('api-docs：GET /dev/api-docs handler（D4）', () => {
  /** 最小假 res：只实现 sendJson 用到的三个方法 */
  function fakeRes(): { status: () => number; body: () => string } & Record<string, unknown> {
    let code = 0;
    let text = '';
    const res = {
      status: () => code,
      body: () => text,
      setHeader: () => undefined,
      writeHead: (c: number) => {
        code = c;
        return res;
      },
      write: (chunk: string) => {
        text += chunk;
        return true;
      },
      end: (chunk?: string) => {
        if (chunk) text += chunk;
        return res;
      },
    };
    return res;
  }

  it('返回 200 与可序列化 payload，total 与路由条数一致', async () => {
    const route = devRoutes(() => routes).find((r) => r.path === '/dev/api-docs')!;
    expect(route.method).toBe('GET');
    const res = fakeRes();
    await route.handler(
      { version: '1.2.3' } as never,
      {} as never,
      res as never,
      {} as never,
    );
    expect(res.status()).toBe(200);
    const body = JSON.parse(res.body()) as ApiDocsPayload;
    expect(body.version).toBe('1.2.3');
    expect(body.stats.total).toBe(routes.length);
    expect(body.stats.undocumented).toEqual([]);
    expect(Array.isArray(body.groups)).toBe(true);
    // 响应可被 JSON 完整序列化（无 undefined 造成的字段丢失以外的异常形态）
    expect(body.groups.every((g) => typeof g.key === 'string' && Array.isArray(g.items))).toBe(true);
  });

  it('元数据缺省时仍返回 200（不因缺口失败端点）', async () => {
    const route = devRoutes(() => [{ method: 'GET', path: '/unknown-only' }]).find((r) => r.path === '/dev/api-docs')!;
    const res = fakeRes();
    await route.handler({ version: '' } as never, {} as never, res as never, {} as never);
    expect(res.status()).toBe(200);
    const body = JSON.parse(res.body()) as ApiDocsPayload;
    expect(body.stats).toEqual({ total: 1, documented: 0, undocumented: ['GET /unknown-only'] });
  });
});

describe('api-docs：/dev/api-docs 沿用既有鉴权（D4）', () => {
  // 真起 port 0 http server，覆盖「配置 api.token 后必须带 Bearer」这条既有策略，
  // 避免新端点绕过 server.ts 的统一鉴权前置。
  let dir = '';
  let server: ApiServer | null = null;
  let base = '';
  let cfg: AgentConfig;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'loop-agent-api-docs-'));
    mkdirSync(join(dir, 'workspace'), { recursive: true });
    mkdirSync(join(dir, 'global'), { recursive: true });
    const store = new SessionStore(join(dir, 'workspace'), false, join(dir, 'sessions'));
    await store.init();
    const loader = new ConfigLoader(join(dir, 'workspace'), join(dir, 'global'));
    cfg = structuredClone(DEFAULT_CONFIG);
    cfg.api = { ...cfg.api, port: 0, token: 'secret-token' };
    server = createApiServer({
      runAgent: async () => {
        throw new Error('本套件不触达 runAgent');
      },
      sessionStore: store,
      getConfig: () => cfg,
      version: 'auth-0.0.0',
      runtime: {
        configLoader: loader,
        configWriter: new ConfigWriter(join(dir, 'workspace'), join(dir, 'global'), loader),
        uploadsRoot: join(dir, 'uploads'),
      },
    });
    const { port } = await server.start();
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('无 Authorization → 401（token 已配置）', async () => {
    const res = await fetch(`${base}/dev/api-docs`);
    expect(res.status).toBe(401);
  });

  it('Bearer 错误 → 401；Bearer 正确 → 200 且 total 与路由条数一致', async () => {
    const bad = await fetch(`${base}/dev/api-docs`, { headers: { authorization: 'Bearer nope' } });
    expect(bad.status).toBe(401);
    const ok = await fetch(`${base}/dev/api-docs`, { headers: { authorization: 'Bearer secret-token' } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as ApiDocsPayload;
    expect(body.stats.total).toBe(routes.length);
    expect(body.version).toBe('auth-0.0.0');
  });
});
