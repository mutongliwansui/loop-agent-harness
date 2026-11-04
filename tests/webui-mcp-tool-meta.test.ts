// MCP 展示元信息前端注册表单测（需求 20261104-001，P0）
// 纯函数无 DOM / 无 vue 依赖，Node vitest 直测
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clipName,
  MCP_NAME_MAX,
  mcpBrief,
  mcpIconFor,
  mcpMetaOf,
  mcpNameOf,
  mcpParamLabel,
  mcpToolMetaSize,
  prettifyName,
  setMcpToolMeta,
  type McpToolMeta,
} from '../webui/src/mcp-tool-meta.js';
import { toolDisplay, toolParamRows, toolSummary } from '../webui/src/tool-meta.js';

function meta(over: Partial<McpToolMeta> = {}): McpToolMeta {
  return {
    fullName: 'atlasGraphMcp__shortestPath',
    server: 'atlasGraphMcp',
    tool: 'shortestPath',
    title: '',
    description: '在指定的图实例下，查询两个节点之间的最短路径',
    paramDesc: { graph: '图实例', startIds: '起始节点id列表' },
    required: ['graph', 'startIds'],
    zhName: '最短路径',
    zhParams: { graph: '图实例', startIds: '起始节点' },
    nameSource: 'cjk',
    translate: 'skipped',
    ...over,
  };
}

beforeEach(() => {
  setMcpToolMeta([]);
});

describe('setMcpToolMeta / mcpMetaOf：注册表', () => {
  it('写入后可查，非法入参清空', () => {
    setMcpToolMeta([meta()]);
    expect(mcpToolMetaSize()).toBe(1);
    expect(mcpMetaOf('atlasGraphMcp__shortestPath')?.server).toBe('atlasGraphMcp');
    expect(mcpMetaOf('nope')).toBeUndefined();

    setMcpToolMeta(null);
    expect(mcpToolMetaSize()).toBe(0);
    setMcpToolMeta([{ bad: true } as unknown as McpToolMeta]);
    expect(mcpToolMetaSize()).toBe(0);
  });
});

describe('prettifyName：名字分词美化', () => {
  it('驼峰 / 下划线 / 已含空格', () => {
    expect(prettifyName('shortestPath')).toBe('Shortest Path');
    expect(prettifyName('get_edge_label')).toBe('Get Edge Label');
    expect(prettifyName('web_search')).toBe('Web Search');
    expect(prettifyName('Already Has Space')).toBe('Already Has Space');
    expect(prettifyName('')).toBe('');
  });

  it('缩写保持大写', () => {
    expect(prettifyName('getURLInfo')).toBe('Get URLInfo');
  });

  it('中文原样返回', () => {
    expect(prettifyName('最短路径')).toBe('最短路径');
  });
});

describe('mcpIconFor：关键词词典 → 图标 key', () => {
  it('按工具名匹配', () => {
    expect(mcpIconFor(meta({ tool: 'web_search' }))).toBe('search');
    expect(mcpIconFor(meta({ tool: 'web_fetch' }))).toBe('book');
    expect(mcpIconFor(meta({ tool: 'shortestPath' }))).toBe('lines');
    expect(mcpIconFor(meta({ tool: 'dropVertex' }))).toBe('stop');
    expect(mcpIconFor(meta({ tool: 'addVertex' }))).toBe('pencil');
    expect(mcpIconFor(meta({ tool: 'runShell' }))).toBe('terminal');
  });

  it('未命中回落 gear，meta 缺失也返回 gear', () => {
    expect(mcpIconFor(meta({ tool: 'zzz', required: [], paramDesc: {} }))).toBe('gear');
    expect(mcpIconFor(undefined)).toBe('gear');
  });
});

describe('mcpNameOf / clipName：展示名与截断', () => {
  it('有中文名用中文名，原文 title 保留', () => {
    expect(mcpNameOf(meta({ title: '最短路径查询' }))).toEqual({
      name: '最短路径',
      raw: '最短路径查询',
    });
  });

  it('无中文名回落美化名', () => {
    expect(mcpNameOf(meta({ zhName: '' }))).toEqual({ name: 'Shortest Path', raw: '' });
    expect(mcpNameOf(undefined)).toEqual({ name: '', raw: '' });
  });

  it('有英文 title 但无中文名 → 回落 title 原文（D16，翻译失败也不丢信息）', () => {
    expect(mcpNameOf(meta({ zhName: '', title: 'Web search' }))).toEqual({
      name: 'Web search',
      raw: 'Web search',
    });
  });

  it('超长名截断加省略号', () => {
    expect(clipName('这是一个非常非常长的工具展示名称', 6)).toBe('这是一个非常…');
    expect(clipName('短名')).toBe('短名');
    expect(MCP_NAME_MAX).toBe(14);
  });
});

describe('mcpBrief：语义摘要', () => {
  it('取 required 前 2 参数拼 键=值', () => {
    const s = mcpBrief(
      meta(),
      JSON.stringify({ graph: 'wzgs_zb', startIds: 'a,b', unrelated: 'x' }),
    );
    expect(s).toBe('图实例=wzgs_zb · 起始节点=a,b');
  });

  it('无 required 命中时取参数对象头两个键', () => {
    const s = mcpBrief(meta({ required: [] }), JSON.stringify({ p: '1', q: '2', r: '3' }));
    expect(s).toBe('p=1 · q=2');
  });

  it('值超 24 字截断；无参数/坏 JSON 返回空串', () => {
    const long = 'x'.repeat(40);
    const s = mcpBrief(meta({ required: ['graph'] }), JSON.stringify({ graph: long }));
    expect(s).toBe(`图实例=${'x'.repeat(24)}…`);
    expect(mcpBrief(meta(), '')).toBe('');
    expect(mcpBrief(meta(), '{}')).toBe('');
    expect(mcpBrief(meta(), 'not json')).toBe('');
    expect(mcpBrief(undefined, '{"a":1}')).toBe('');
  });
});

describe('mcpParamLabel：参数中文标签', () => {
  it('有中文标签用中文，缺项美化键名，无元信息保留原键', () => {
    expect(mcpParamLabel(meta(), 'graph')).toBe('图实例');
    expect(mcpParamLabel(meta(), 'startIds')).toBe('起始节点');
    expect(mcpParamLabel(meta(), 'nodeLabel')).toBe('Node Label');
    // 无元信息时不做美化：必须与 20261024-001 的一致性行为（英文原键）逐字节一致
    expect(mcpParamLabel(undefined, 'nodeLabel')).toBe('nodeLabel');
  });
});

describe('tool-meta 三函数 MCP 分支', () => {
  it('toolDisplay：有元信息 → 语义图标 + 中文名 + server 徽标信息', () => {
    setMcpToolMeta([meta()]);
    expect(toolDisplay('atlasGraphMcp__shortestPath')).toEqual({
      icon: 'lines',
      name: '最短路径',
      known: false,
      mcp: { server: 'atlasGraphMcp', title: '', zh: true },
    });
  });

  it('toolDisplay：无元信息 → 与改动前完全一致（gear + 原名 + known:false）', () => {
    expect(toolDisplay('atlasGraphMcp__shortestPath')).toEqual({
      icon: 'gear',
      name: 'atlasGraphMcp__shortestPath',
      known: false,
    });
  });

  it('toolParamRows：标签与顺序正确', () => {
    setMcpToolMeta([meta()]);
    const rows = toolParamRows('atlasGraphMcp__shortestPath', JSON.stringify({ graph: 'g1' }));
    expect(rows).toEqual([{ key: 'graph', zh: '图实例', text: 'g1' }]);
  });

  it('toolSummary：MCP 工具用必填参数拼摘要，坏 JSON 回落紧凑 JSON', () => {
    setMcpToolMeta([meta()]);
    expect(toolSummary('atlasGraphMcp__shortestPath', JSON.stringify({ graph: 'g1' }))).toBe(
      '图实例=g1',
    );
    expect(toolSummary('atlasGraphMcp__shortestPath', '')).toBe('');
  });
});
