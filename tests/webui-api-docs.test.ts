/**
 * 开发者中心 · 前端纯函数测试（需求 20261104-002 · 方案 D10）
 *
 * 覆盖 webui/src/api-docs-ui.ts：
 * - 过滤：方法 / 路径 / 说明三路关键词匹配，方法筛选，组内顺序不重排（路由注册顺序即语义）
 * - 统计：total / documented / undocumented / byMethod
 * - 路径：splitPath 拆段与 `:param` 标记、templatedPath 占位替换
 * - curl：有 example 时注入 base、无 example 时合成最小示例（D9：base 由 location.origin 传入）
 * - 静态内容：模块顺序（第一个是 API 接口文档）、token 三态、错误码、SSE 事件表
 */
import { describe, expect, it } from 'vitest';
import {
  AUTH_MODES,
  buildCurl,
  DEV_TABS,
  ERROR_CODES,
  filterDocs,
  docCounts,
  METHOD_FILTERS,
  methodTone,
  resolveTab,
  splitPath,
  SSE_EVENTS,
  SSE_SNIPPET,
  templatedPath,
  type ApiDocItem,
  type ApiDocsPayload,
} from '../webui/src/api-docs-ui.js';

function item(over: Partial<ApiDocItem> = {}): ApiDocItem {
  return {
    method: 'GET',
    path: '/sessions',
    summary: '列出会话',
    documented: true,
    stream: false,
    scope: 'read',
    params: [],
    ...over,
  };
}

function payload(): ApiDocsPayload {
  return {
    version: '0.1.0',
    groups: [
      {
        key: 'core',
        title: '会话与系统',
        desc: '核心',
        items: [
          item({ method: 'GET', path: '/sessions', summary: '列出会话' }),
          item({ method: 'POST', path: '/sessions', summary: '创建会话', scope: 'write' }),
          item({ method: 'GET', path: '/sessions/:id', summary: '会话详情' }),
        ],
      },
      {
        key: 'memory',
        title: '记忆',
        desc: '记忆',
        items: [item({ method: 'GET', path: '/memory/status', summary: '记忆状态' })],
      },
      {
        key: 'other',
        title: '其他',
        desc: '未归组',
        items: [item({ path: '/brand-new', summary: '', documented: false })],
      },
    ],
    stats: { total: 5, documented: 4, undocumented: ['GET /brand-new'] },
  };
}

describe('api-docs-ui：过滤（三路匹配 + 方法筛选）', () => {
  it('空关键词且 all → 原样返回（组与条目顺序不变）', () => {
    const out = filterDocs(payload());
    expect(out.groups.map((g) => g.key)).toEqual(['core', 'memory', 'other']);
    expect(out.groups[0].items.map((i) => i.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('关键词命中路径 / 说明 / 方法三路，且丢弃空组', () => {
    expect(filterDocs(payload(), { kw: '/memory' }).groups.map((g) => g.key)).toEqual(['memory']);
    expect(filterDocs(payload(), { kw: '创建' }).groups[0].items).toHaveLength(1);
    // 'post' 命中方法
    const byMethod = filterDocs(payload(), { kw: 'post' });
    expect(byMethod.groups).toHaveLength(1);
    expect(byMethod.groups[0].items).toHaveLength(1);
    // 大小写不敏感 + 前后空白忽略
    expect(filterDocs(payload(), { kw: '  MEMORY ' }).groups).toHaveLength(1);
  });

  it('方法筛选只保留该方法的条目（all 不筛选）', () => {
    const all = filterDocs(payload(), { method: 'all' });
    expect(docCounts(all).total).toBe(5);
    const gets = filterDocs(payload(), { method: 'GET' });
    expect(docCounts(gets).total).toBe(4);
    expect(docCounts(filterDocs(payload(), { method: 'POST' })).total).toBe(1);
    expect(filterDocs(payload(), { method: 'DELETE' }).groups).toEqual([]);
  });

  it('关键词与方法同时生效（且关系）', () => {
    const out = filterDocs(payload(), { kw: '/sessions', method: 'POST' });
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].items).toHaveLength(1);
    expect(out.groups[0].items[0].method).toBe('POST');
  });

  it('METHOD_FILTERS 首项为 all，其后为常见方法', () => {
    expect(METHOD_FILTERS[0]).toBe('all');
    expect(METHOD_FILTERS.slice(1)).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  });
});

describe('api-docs-ui：统计', () => {
  it('total / documented / undocumented / byMethod', () => {
    const c = docCounts(payload());
    expect(c).toEqual({ total: 5, documented: 4, undocumented: 1, byMethod: { GET: 4, POST: 1 } });
  });

  it('过滤后的统计只算命中项', () => {
    expect(docCounts(filterDocs(payload(), { kw: 'memory' })).total).toBe(1);
  });

  it('methodTone 映射五色后缀，未知方法回落 other', () => {
    expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(methodTone)).toEqual(['get', 'post', 'put', 'patch', 'del']);
    expect(methodTone('HEAD')).toBe('other');
    expect(methodTone('get')).toBe('get');
  });
});

describe('api-docs-ui：路径与 curl', () => {
  it('splitPath 拆段并标记 :param', () => {
    expect(splitPath('/sessions/:id/messages')).toEqual([
      { text: '/sessions', param: false },
      { text: '/:id', param: true },
      { text: '/messages', param: false },
    ]);
    expect(splitPath('/health')).toEqual([{ text: '/health', param: false }]);
    // 路径里形如 :alias 的段也算参数
    expect(splitPath('/models/:alias/test')[1]).toEqual({ text: '/:alias', param: true });
  });

  it('templatedPath 把 :x 换成 <x>', () => {
    expect(templatedPath('/sessions/:id/messages')).toBe('/sessions/<id>/messages');
    expect(templatedPath('/models/:alias/test')).toBe('/models/<alias>/test');
    expect(templatedPath('/health')).toBe('/health');
  });

  it('buildCurl：有 example 时给路径 token 补 base（含引号包裹的路径）', () => {
    expect(buildCurl(item({ example: 'curl /health' }), 'http://localhost:3000')).toBe(
      'curl http://localhost:3000/health',
    );
    expect(buildCurl(item({ example: 'curl -N "/sessions/<id>/stream?cursor=0"' }), 'http://localhost:3000')).toBe(
      'curl -N "http://localhost:3000/sessions/<id>/stream?cursor=0"',
    );
    // 非路径 token（-X / 头部）保持不变
    const out = buildCurl(item({ example: 'curl -X POST /sessions -H "Content-Type: application/json"' }), 'http://h:1');
    expect(out).toBe('curl -X POST http://h:1/sessions -H "Content-Type: application/json"');
  });

  it('buildCurl：无 example 时按方法合成最小示例，GET 不带 -X', () => {
    expect(buildCurl(item({ method: 'GET', path: '/sessions/:id' }), 'http://h:1')).toBe('curl http://h:1/sessions/<id>');
    expect(buildCurl(item({ method: 'DELETE', path: '/sessions/:id' }), 'http://h:1')).toBe(
      'curl -X DELETE http://h:1/sessions/<id>',
    );
  });

  it('buildCurl：base 末尾斜杠被归一（避免出现 //path）', () => {
    expect(buildCurl(item({ example: 'curl /health' }), 'http://h:1/')).toBe('curl http://h:1/health');
  });

  it('buildCurl：不改变 method 大小写以外的内容', () => {
    const out = buildCurl(item({ method: 'POST', path: '/a' }), 'https://x.example');
    expect(out.startsWith('curl -X POST https://x.example/a')).toBe(true);
  });
});

describe('api-docs-ui：模块与静态内容', () => {
  it('第一个模块是 API 接口文档（用户明确要求），共三个模块', () => {
    expect(DEV_TABS[0].key).toBe('api');
    expect(DEV_TABS[0].label).toBe('API 接口文档');
    expect(DEV_TABS.map((t) => t.key)).toEqual(['api', 'auth', 'sse']);
    for (const t of DEV_TABS) {
      expect(t.label.trim().length).toBeGreaterThan(0);
      expect(t.hint.trim().length).toBeGreaterThan(0);
    }
  });

  it('resolveTab：非法值回落 api，合法值原样返回', () => {
    expect(resolveTab('auth')).toBe('auth');
    expect(resolveTab('sse')).toBe('sse');
    expect(resolveTab('api')).toBe('api');
    expect(resolveTab(null)).toBe('api');
    expect(resolveTab('')).toBe('api');
    expect(resolveTab('nope')).toBe('api');
  });

  it('token 三态覆盖：无 token 本机 / 无 token 非本机 / 有 token / 非回环无 token 拒启动', () => {
    expect(AUTH_MODES.map((m) => m.key)).toEqual(['token-empty', 'token-empty-remote', 'token-set', 'bind-nonloopback']);
    for (const m of AUTH_MODES) {
      expect(m.when.trim().length).toBeGreaterThan(0);
      expect(m.behavior.trim().length).toBeGreaterThan(0);
      expect(m.failure.trim().length).toBeGreaterThan(0);
    }
    // 关键状态码出现在失败语义里
    expect(AUTH_MODES.map((m) => m.failure).join(' ')).toContain('403');
    expect(AUTH_MODES.map((m) => m.failure).join(' ')).toContain('401');
  });

  it('错误码表覆盖 400/401/403/404/405/409/413/500/502', () => {
    expect(ERROR_CODES.map((e) => e.code)).toEqual([400, 401, 403, 404, 405, 409, 413, 500, 502]);
    for (const e of ERROR_CODES) {
      expect(e.key).toMatch(/^[a-z_]+$/);
      expect(e.desc.trim().length).toBeGreaterThan(0);
    }
  });

  it('SSE 事件表：名称唯一、含合成终态 done/fatal/reset、载荷为花括号对象', () => {
    const names = SSE_EVENTS.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const e of SSE_EVENTS) {
      expect(e.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(e.payload.startsWith('{')).toBe(true);
      expect(e.desc.trim().length).toBeGreaterThan(0);
      expect(['frame', 'synthesized']).toContain(e.kind);
    }
    expect(names).toContain('llm_stream');
    expect(names).toContain('done');
    const done = SSE_EVENTS.find((e) => e.name === 'done')!;
    expect(done.kind).toBe('synthesized');
    expect(SSE_EVENTS.filter((e) => e.kind === 'synthesized').map((e) => e.name)).toEqual(['done', 'fatal', 'reset']);
  });

  it('接入片段使用 fetch 流式读取（带鉴权头）', () => {
    expect(SSE_SNIPPET).toContain('fetch(');
    expect(SSE_SNIPPET).toContain('getReader()');
    expect(SSE_SNIPPET).toContain('authorization');
  });
});
