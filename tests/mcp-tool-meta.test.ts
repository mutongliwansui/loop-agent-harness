// MCP 展示元信息单测（需求 20261104-001，P0/P1）
// 覆盖：采集 / CJK 判定 / 中文短名提炼 / 指纹 / 本地填充 / 缓存读写 / 翻译解析与批量翻译
import { mkdtemp, rm, writeFile as writeFileAsync, readFile as readFileAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyLocalNames,
  collectMcpMeta,
  distillParamLabel,
  distillZhName,
  hasCjk,
  metaFingerprint,
  ZH_NAME_MAX,
  type McpToolMeta,
} from '../src/tools/mcp/meta.js';
import {
  emptyMetaCache,
  loadMetaCache,
  pruneMetaCache,
  saveMetaEntry,
  type MetaCacheFile,
} from '../src/tools/mcp/meta-store.js';
import {
  parseTranslationJson,
  prepareServerMeta,
  resetTranslateInflight,
  translateServerMeta,
} from '../src/tools/mcp/translator.js';
import type { LLMClient } from '../src/llm/client.js';

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-meta-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetTranslateInflight();
});

/** 构造一个可用于翻译流程的元信息（默认待翻译） */
function pendingMeta(over: Partial<McpToolMeta> = {}): McpToolMeta {
  return {
    fullName: 'demo__web_search',
    server: 'demo',
    tool: 'web_search',
    title: '',
    description: 'Purpose: Perform web searches and return results',
    paramDesc: { objective: 'Natural-language description of what the search is trying to find' },
    required: ['objective'],
    zhName: '',
    zhParams: {},
    nameSource: 'none',
    translate: 'pending',
    ...over,
  };
}

describe('collectMcpMeta：从原始 tool 采集展示素材', () => {
  it('读取顶层 title 与 annotations.title，顶层优先', () => {
    const [a] = collectMcpMeta('srv', [
      { name: 't1', title: '顶层名', annotations: { title: '注解名' } },
    ]);
    expect(a.title).toBe('顶层名');
    expect(a.fullName).toBe('srv__t1');
    expect(a.server).toBe('srv');
    expect(a.tool).toBe('t1');

    const [b] = collectMcpMeta('srv', [{ name: 't2', annotations: { title: '注解名' } }]);
    expect(b.title).toBe('注解名');
  });

  it('title 为空白串视为无 title', () => {
    const [m] = collectMcpMeta('srv', [
      { name: 't', title: '   ', annotations: { title: '  ' } },
    ]);
    expect(m.title).toBe('');
  });

  it('采集参数描述与 required，过滤非法项', () => {
    const [m] = collectMcpMeta('srv', [
      {
        name: 'shortestPath',
        description: '在指定的图实例下，查询两个节点之间的最短路径',
        inputSchema: {
          properties: {
            graph: { description: '图实例' },
            noDesc: { type: 'string' },
            blankDesc: { description: '   ' },
          },
          required: ['graph', 5, null],
        },
      },
    ]);
    expect(m.paramDesc).toEqual({ graph: '图实例' });
    expect(m.required).toEqual(['graph']);
    expect(m.zhName).toBe('');
    expect(m.nameSource).toBe('none');
    expect(m.translate).toBe('idle');
  });

  it('inputSchema 缺失/非对象不抛错', () => {
    const [a] = collectMcpMeta('srv', [{ name: 'x' }]);
    expect(a.paramDesc).toEqual({});
    expect(a.required).toEqual([]);
    expect(a.description).toBe('');

    const [b] = collectMcpMeta('srv', [
      { name: 'y', inputSchema: 'oops' as unknown as Record<string, unknown> },
    ]);
    expect(b.paramDesc).toEqual({});
    expect(b.required).toEqual([]);
  });
});

describe('hasCjk：中文判定', () => {
  it('中文/中英混排为 true，纯英文为 false', () => {
    expect(hasCjk('在指定的图实例下')).toBe(true);
    expect(hasCjk('Purpose: Perform web searches')).toBe(false);
    expect(hasCjk('查询 graph 实例')).toBe(true);
    expect(hasCjk('')).toBe(false);
  });
});

describe('distillZhName：从中文描述提炼短展示名', () => {
  it('真实 atlasGraphMcp 描述产出 4~12 字短名', () => {
    // 剔除状语分句 + 动词宾语压缩：丢掉的必须是「之间」这类虚词，宾语要保住
    expect(distillZhName('在指定的图实例下，查询两个节点之间的最短路径')).toBe('查询最短路径');
    expect(distillZhName('在指定的图实例下，查询两个节点之间的全部路径')).toBe('查询全部路径');
    expect(distillZhName('在指定的图实例下，查询指定节点的邻居节点')).toBe('查询指定节点的邻居节点');
    expect(distillZhName('在指定的图实例下，执行cypher图查询语言')).toBe('执行cypher图查询');
  });

  it('泛化宾语拼对象名词，避免 get*Info 撞名', () => {
    expect(distillZhName('获取图库里指定图实例的详细信息')).toBe('获取图实例详细信息');
    expect(distillZhName('获取指定图实例下指定关系label的详细信息，包含字段列表')).toBe(
      '获取关系详细信息',
    );
    expect(distillZhName('获取指定图实例下指定节点label的详细信息，包含字段列表')).toBe(
      '获取节点详细信息',
    );
  });

  it('取首个主句而非末个分句（末尾常是补充说明）', () => {
    expect(distillZhName('在指定的图实例下，根据主键查询指定label的节点，可以一次查多个')).toBe(
      '查询节点',
    );
    expect(distillZhName('在指定的图实例下，根据属性查询指定label的节点列表')).toBe('查询节点列表');
  });

  it('剥离括号内操作提示', () => {
    const desc =
      '在指定的图实例下，指定中心节点进行k层展开（查邻居节点优先用queryAdjacentNodes，指定起终点的路径查找优先用shortestPath和allPath）';
    expect(distillZhName(desc)).toBe('指定中心节点进行k层展开');
  });

  it('英文宾语不压缩（压出来会丢限定语），退回「的」前截断', () => {
    expect(distillZhName('获取指定图实例下所有关系的label')).toBe('获取指定图实例下所有关系');
    expect(distillZhName('获取指定图实例下所有节点的label')).toBe('获取指定图实例下所有节点');
  });

  it('短描述与空描述', () => {
    expect(distillZhName('查询图实例信息')).toBe('查询图实例信息');
    expect(distillZhName('')).toBe('');
    expect(distillZhName('   ')).toBe('');
  });

  it('剥离 Markdown 标记后再提炼', () => {
    expect(distillZhName('**查询** 节点\n\n详情见下文')).toBe('查询 节点 详情见下文');
  });

  it('产出恒不为空、不超长（脏输入不抛错）', () => {
    for (const d of ['在', '的', '，', '在指定的图实例下', 'a', '（只有括号）']) {
      const out = distillZhName(d);
      expect(out.length <= ZH_NAME_MAX).toBe(true);
    }
  });
});

describe('distillParamLabel：参数描述 → 短标签', () => {
  it('取首分句并限长', () => {
    expect(distillParamLabel('图实例')).toBe('图实例');
    expect(distillParamLabel('节点id列表，格式：id1,id2,id3')).toBe('节点id列表');
    expect(distillParamLabel('关系label')).toBe('关系label');
    expect(distillParamLabel('averylongparamdescription')).toBe('averylon');
  });
});

describe('metaFingerprint：内容指纹', () => {
  it('同输入恒同值，description 改一字即变值', () => {
    const a = pendingMeta();
    const b = pendingMeta();
    expect(metaFingerprint(a)).toBe(metaFingerprint(b));
    expect(metaFingerprint(a)).toHaveLength(32);
    const c = pendingMeta({ description: `${a.description}!` });
    expect(metaFingerprint(c)).not.toBe(metaFingerprint(a));
  });

  it('参数描述键序不影响指纹（稳定序列化）', () => {
    const a = pendingMeta({ paramDesc: { x: '一', y: '二' } });
    const b = pendingMeta({ paramDesc: { y: '二', x: '一' } });
    expect(metaFingerprint(a)).toBe(metaFingerprint(b));
  });
});

describe('applyLocalNames：本地判定（不调 LLM）', () => {
  it('有 title → nameSource=title、translate=skipped', () => {
    const m = pendingMeta({ title: '网页搜索' });
    expect(applyLocalNames(m)).toBe(false);
    expect(m.zhName).toBe('网页搜索');
    expect(m.nameSource).toBe('title');
    expect(m.translate).toBe('skipped');
  });

  it('中文描述 → 本地提炼，translate=skipped（D3 省 LLM）', () => {
    const m = pendingMeta({
      description: '在指定的图实例下，查询两个节点之间的最短路径',
      paramDesc: { graph: '图实例' },
    });
    expect(applyLocalNames(m, 'auto')).toBe(false);
    expect(m.zhName).toBe('查询最短路径');
    expect(m.nameSource).toBe('cjk');
    expect(m.zhParams).toEqual({ graph: '图实例' });
    expect(m.translate).toBe('skipped');
  });

  it('英文描述 → translate=pending 需要翻译', () => {
    const m = pendingMeta();
    expect(applyLocalNames(m, 'auto')).toBe(true);
    expect(m.translate).toBe('pending');
    expect(m.zhName).toBe('');
  });

  it('mode=always 下中文描述也走翻译', () => {
    const m = pendingMeta({ description: '查询指定节点的邻居节点' });
    expect(applyLocalNames(m, 'always')).toBe(true);
    expect(m.translate).toBe('pending');
  });

  it('英文 title → 仍走翻译（D16：目标语言优先于协议字面优先级）', () => {
    const m = pendingMeta({ title: 'Web search' });
    expect(applyLocalNames(m, 'auto')).toBe(true);
    expect(m.translate).toBe('pending');
    expect(m.zhName).toBe('');
    // title 原文保留，供翻译失败时前端回落
    expect(m.title).toBe('Web search');
  });

  it('英文 title + 中文描述 → 用中文描述提炼（比英文 title 更贴合中文界面）', () => {
    const m = pendingMeta({ title: 'Query vertex', description: '在指定的图实例下，根据属性查询节点列表' });
    expect(applyLocalNames(m, 'auto')).toBe(false);
    expect(m.nameSource).toBe('cjk');
    expect(m.zhName.length).toBeGreaterThan(0);
  });
});

describe('meta-store：翻译缓存读写', () => {
  it('文件缺失返回空表，不抛错', async () => {
    const cache = await loadMetaCache(join(dir, 'not-exist.json'));
    expect(cache).toEqual(emptyMetaCache());
  });

  it('损坏 JSON / 字段非法 → 空表或过滤', async () => {
    const bad = join(dir, 'bad.json');
    await writeFileAsync(bad, '{ not json', 'utf-8');
    expect(await loadMetaCache(bad)).toEqual(emptyMetaCache());

    const partial = join(dir, 'partial.json');
    await writeFileAsync(
      partial,
      JSON.stringify({
        version: 1,
        translations: {
          ok: { server: 's', tool: 't', zhName: '名称', zhParams: { a: '甲' }, model: 'm', at: '2026-01-01T00:00:00.000Z' },
          broken: { server: 's' },
        },
      }),
      'utf-8',
    );
    const cache = await loadMetaCache(partial);
    expect(Object.keys(cache.translations)).toEqual(['ok']);
  });

  it('写入后读得回，且原子覆盖旧文件', async () => {
    const file = join(dir, 'save.json');
    await saveMetaEntry(
      'fp1',
      { server: 's', tool: 't', zhName: '甲', zhParams: {}, model: 'm', at: '2026-01-01T00:00:00.000Z' },
      file,
    );
    await saveMetaEntry(
      'fp2',
      { server: 's', tool: 't2', zhName: '乙', zhParams: {}, model: 'm', at: '2026-01-02T00:00:00.000Z' },
      file,
    );
    const cache = await loadMetaCache(file);
    expect(Object.keys(cache.translations).sort()).toEqual(['fp1', 'fp2']);
    expect(cache.translations.fp2.zhName).toBe('乙');
    // 落盘内容可 JSON 解析（无残留半个文件）
    const text = await readFileAsync(file, 'utf-8');
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('pruneMetaCache 按 at 保留最近 N 条', () => {
    const mk = (n: number, at: string) => ({ server: 's', tool: `t${n}`, zhName: `名${n}`, zhParams: {}, model: 'm', at });
    const cache: MetaCacheFile = {
      version: 1,
      translations: {
        a: mk(1, '2026-01-01T00:00:00.000Z'),
        b: mk(2, '2026-01-03T00:00:00.000Z'),
        c: mk(3, '2026-01-02T00:00:00.000Z'),
      },
    };
    const pruned = pruneMetaCache(cache, 2);
    expect(Object.keys(pruned.translations).sort()).toEqual(['b', 'c']);
  });
});

/** 极简 LLMClient 替身：只提供 chat() */
function fakeClient(content: string | Error): { client: LLMClient; calls: number[] } {
  const calls: number[] = [];
  const chat = vi.fn(async () => {
    calls.push(1);
    if (content instanceof Error) throw content;
    return { content, finish_reason: 'stop' };
  });
  return { client: { chat } as unknown as LLMClient, calls };
}

describe('parseTranslationJson：模型返回容错', () => {
  it('直接 JSON / 代码围栏 / 前后噪声三种都能解析', () => {
    expect(parseTranslationJson('{"a":{"zh":"甲"}}')).toEqual({ a: { zh: '甲' } });
    expect(parseTranslationJson('```json\n{"a":{"zh":"甲"}}\n```')).toEqual({ a: { zh: '甲' } });
    expect(parseTranslationJson('好的，结果如下：{"a":{"zh":"甲"}} 以上。')).toEqual({ a: { zh: '甲' } });
  });

  it('非法内容返回 null', () => {
    expect(parseTranslationJson('')).toBeNull();
    expect(parseTranslationJson('完全不是 JSON')).toBeNull();
    expect(parseTranslationJson('[1,2,3]')).toBeNull();
  });
});

describe('translateServerMeta：批量翻译', () => {
  it('翻译成功写回 zhName/zhParams 并落盘缓存', async () => {
    const file = join(dir, 'tr-ok.json');
    const { client, calls } = fakeClient(
      '{"web_search":{"zh":"网页搜索","params":{"objective":"检索目标"}}}',
    );
    const metas = [pendingMeta()];
    const out = await translateServerMeta(metas, { llm: client, cacheFile: file, model: 'test-model' });

    expect(calls).toHaveLength(1);
    expect(out.translated).toBe(1);
    expect(out.failed).toBe(0);
    expect(metas[0].zhName).toBe('网页搜索');
    expect(metas[0].zhParams.objective).toBe('检索目标');
    expect(metas[0].nameSource).toBe('translate');
    expect(metas[0].translate).toBe('done');

    const cache = await loadMetaCache(file);
    expect(Object.keys(cache.translations)).toHaveLength(1);
  });

  it('二次调用命中指纹缓存：零 LLM 调用', async () => {
    const file = join(dir, 'tr-cache.json');
    const { client, calls } = fakeClient('{"web_search":{"zh":"网页搜索","params":{}}}');
    await translateServerMeta([pendingMeta()], { llm: client, cacheFile: file, model: 'm' });
    expect(calls).toHaveLength(1);

    const again = [pendingMeta()];
    const out2 = await translateServerMeta(again, { llm: client, cacheFile: file, model: 'm' });
    expect(calls).toHaveLength(1); // 没有第二次调用
    expect(out2.cached).toBe(1);
    expect(again[0].zhName).toBe('网页搜索');
    expect(again[0].translate).toBe('done');
  });

  it('模型抛错 → 记 failed + translateError，不抛出', async () => {
    const file = join(dir, 'tr-err.json');
    const { client } = fakeClient(new Error('连接超时'));
    const metas = [pendingMeta()];
    const out = await translateServerMeta(metas, { llm: client, cacheFile: file, model: 'm' });
    expect(out.failed).toBe(1);
    expect(metas[0].translate).toBe('failed');
    expect(metas[0].translateError).toContain('连接超时');
    expect(out.errors.length).toBeGreaterThan(0);
  });

  it('模型返回非 JSON → 记 failed 且保留原文片段', async () => {
    const file = join(dir, 'tr-bad.json');
    const { client } = fakeClient('抱歉我无法完成');
    const metas = [pendingMeta()];
    const out = await translateServerMeta(metas, { llm: client, cacheFile: file, model: 'm' });
    expect(out.failed).toBe(1);
    expect(metas[0].translateError).toContain('不是合法 JSON');
  });

  it('部分成功：map 缺项的工具回落 failed，其余正常', async () => {
    const file = join(dir, 'tr-part.json');
    const { client } = fakeClient('{"a":{"zh":"甲"}}');
    const metas = [
      pendingMeta({ tool: 'a', fullName: 'demo__a' }),
      pendingMeta({ tool: 'b', fullName: 'demo__b', description: 'other desc' }),
    ];
    const out = await translateServerMeta(metas, { llm: client, cacheFile: file, model: 'm' });
    expect(out.translated).toBe(1);
    expect(out.failed).toBe(1);
    expect(metas[0].zhName).toBe('甲');
    expect(metas[1].zhName).toBe('');
  });

  it('没有 pending 项时零调用', async () => {
    const { client, calls } = fakeClient('{}');
    const out = await translateServerMeta([pendingMeta({ translate: 'done', zhName: '甲' })], {
      llm: client,
      cacheFile: join(dir, 'tr-none.json'),
    });
    expect(calls).toHaveLength(0);
    expect(out.translated).toBe(0);
  });
});

describe('prepareServerMeta：连接后统一入口', () => {
  it('中文描述 server 零 LLM 调用（D3）', async () => {
    const { client, calls } = fakeClient('{}');
    const metas = [
      pendingMeta({
        description: '在指定的图实例下，查询两个节点之间的最短路径',
        paramDesc: { graph: '图实例' },
        translate: 'idle',
      }),
    ];
    const out = await prepareServerMeta(metas, {
      llm: client,
      cacheFile: join(dir, 'prep-cjk.json'),
      mode: 'auto',
      enabled: true,
    });
    expect(calls).toHaveLength(0);
    expect(out.translated).toBe(0);
    expect(metas[0].zhName).toBe('查询最短路径');
    expect(metas[0].translate).toBe('skipped');
  });

  it('enabled=false → 不翻译且状态回落 skipped', async () => {
    const { client, calls } = fakeClient('{}');
    const metas = [pendingMeta({ translate: 'idle' })];
    await prepareServerMeta(metas, {
      llm: client,
      cacheFile: join(dir, 'prep-off.json'),
      enabled: false,
    });
    expect(calls).toHaveLength(0);
    expect(metas[0].translate).toBe('skipped');
  });
});
