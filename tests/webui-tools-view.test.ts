/**
 * 工具页纯逻辑测试（原型-20261109-003 · D1/D2/D3/D5/D9）
 *
 * 覆盖 webui/src/tool-ui.ts：
 * - classifyFamily / familyLabel：内置工具家族分类表 + MCP 统一归类
 * - mcpServerOf：server__tool 前缀解析
 * - mergeMcpState：合并 GET /tools + GET /mcp/servers → bad 判定
 * - toolCounts：total / builtin / mcp / disabled / mcpBad
 * - filterTools：tab 分段（all / builtin / mcp / disabled）+ query 搜索
 * - sortTools：按 name / family / disabled-优先
 * - parseSchemaParams：OpenAI function schema → 参数表
 * - canToggle：builtin 可开关 / mcp 禁用
 * - toolInitials：名字 → 图标两字
 */
import { describe, it, expect } from 'vitest';
import {
  canToggle,
  classifyFamily,
  familyLabel,
  filterTools,
  mergeMcpState,
  mcpServerOf,
  parseSchemaParams,
  sortTools,
  toolCounts,
  toolInitials,
  type McpServerRow,
  type ToolRow,
} from '../webui/src/tool-ui.js';

/* ===== fixture ===== */
const builtinRows: ToolRow[] = [
  { name: 'commandRun', description: 'Run a shell command', enabled: true, source: 'builtin' },
  { name: 'commandStatus', description: 'Check command status', enabled: true, source: 'builtin' },
  { name: 'fileRead', description: 'Read file content', enabled: true, source: 'builtin' },
  { name: 'fileWrite', description: 'Write a file', enabled: true, source: 'builtin' },
  { name: 'grep', description: 'Search with regex', enabled: false, source: 'builtin' },
  { name: 'editFile', description: 'Edit a file with patches', enabled: true, source: 'builtin' },
  { name: 'ask_image', description: 'Ask about an image', enabled: true, source: 'builtin' },
  { name: 'describe_image', description: 'Describe an image', enabled: true, source: 'builtin' },
  { name: 'memoryWrite', description: 'Write to memory', enabled: true, source: 'builtin' },
  { name: 'memoryRead', description: 'Read from memory', enabled: false, source: 'builtin' },
  { name: 'memorySearch', description: 'Search memory', enabled: true, source: 'builtin' },
  { name: 'sessionHistory', description: 'Get session history', enabled: true, source: 'builtin' },
  { name: 'skillRun', description: 'Run a skill', enabled: true, source: 'builtin' },
  { name: 'httpRequest', description: 'Make HTTP request', enabled: true, source: 'builtin' },
];
const mcpRows: ToolRow[] = [
  { name: 'postgres__query', description: 'Run SQL', enabled: true, source: 'mcp' },
  { name: 'postgres__list', description: 'List tables', enabled: true, source: 'mcp' },
  { name: 'grafana__dashboards', description: 'List dashboards', enabled: true, source: 'mcp' },
  { name: 'grafana__annotations', description: 'Add annotation', enabled: true, source: 'mcp' },
  { name: 'filesystem__read', description: 'Remote read', enabled: true, source: 'mcp' },
];
const allRows: ToolRow[] = [...builtinRows, ...mcpRows];

const servers: McpServerRow[] = [
  { name: 'postgres', state: 'connected' },
  { name: 'grafana', state: 'failed' },
  { name: 'filesystem', state: 'connecting' },
];

const merged = mergeMcpState(allRows, servers);

describe('classifyFamily / familyLabel', () => {
  it('内置工具硬编码覆盖', () => {
    expect(classifyFamily('commandRun', 'builtin')).toBe('cmd');
    expect(classifyFamily('fileRead', 'builtin')).toBe('file');
    expect(classifyFamily('editFile', 'builtin')).toBe('file');
    expect(classifyFamily('ask_image', 'builtin')).toBe('vision');
    expect(classifyFamily('describe_image', 'builtin')).toBe('vision');
    expect(classifyFamily('memoryWrite', 'builtin')).toBe('memory');
    expect(classifyFamily('memoryRead', 'builtin')).toBe('memory');
    expect(classifyFamily('sessionHistory', 'builtin')).toBe('session');
    expect(classifyFamily('skillRun', 'builtin')).toBe('skill');
    expect(classifyFamily('httpRequest', 'builtin')).toBe('http');
  });
  it('未知内置工具归 other', () => {
    expect(classifyFamily('unknownTool', 'builtin')).toBe('other');
  });
  it('MCP 统一归类 mcp', () => {
    expect(classifyFamily('postgres__query', 'mcp')).toBe('mcp');
    expect(classifyFamily('grafana__dashboards', 'mcp')).toBe('mcp');
  });
  it('家族中文名', () => {
    expect(familyLabel('file')).toBe('文件');
    expect(familyLabel('cmd')).toBe('命令');
    expect(familyLabel('vision')).toBe('视觉');
    expect(familyLabel('memory')).toBe('记忆');
    expect(familyLabel('mcp')).toBe('MCP');
    expect(familyLabel('other')).toBe('其他');
  });
});

describe('mcpServerOf', () => {
  it('server__tool 格式返回 server', () => {
    expect(mcpServerOf('postgres__query')).toBe('postgres');
    expect(mcpServerOf('grafana__dashboards')).toBe('grafana');
  });
  it('无 __ 返回 null / 空串边界', () => {
    expect(mcpServerOf('fileRead')).toBeNull();
    expect(mcpServerOf('__double')).toBeNull(); // indexOf=0, i>0 不成立
    expect(mcpServerOf('x__')).toBe('x'); // server 名允许空 tool 名
  });
});

describe('mergeMcpState', () => {
  it('合并后保留 builtin 不变，补充 family 字段', () => {
    const builtin = merged.find((r) => r.name === 'fileRead');
    expect(builtin).toBeTruthy();
    expect(builtin!.source).toBe('builtin');
    expect(builtin!.family).toBe('file');
    expect((builtin as any).mcpBad).toBeUndefined();
    expect((builtin as any).mcpServer).toBeUndefined();
  });
  it('MCP 工具补充 family=mcp + mcpServer', () => {
    const pg = merged.find((r) => r.name === 'postgres__query') as any;
    expect(pg.family).toBe('mcp');
    expect(pg.mcpServer).toBe('postgres');
  });
  it('state=failed → mcpBad=true', () => {
    const gf = merged.find((r) => r.name === 'grafana__dashboards') as any;
    expect(gf.mcpBad).toBe(true);
  });
  it('state=connected / connecting → mcpBad=false', () => {
    const pg = merged.find((r) => r.name === 'postgres__query') as any;
    expect(pg.mcpBad).toBe(false);
    const fs = merged.find((r) => r.name === 'filesystem__read') as any;
    expect(fs.mcpBad).toBe(false);
  });
});

describe('toolCounts', () => {
  it('total / builtin / mcp', () => {
    const c = toolCounts(merged);
    expect(c.total).toBe(allRows.length);
    expect(c.builtin).toBe(builtinRows.length);
    expect(c.mcp).toBe(mcpRows.length);
  });
  it('disabled 只计 builtin 禁用', () => {
    const c = toolCounts(merged);
    expect(c.disabled).toBe(2); // grep + memoryRead
  });
  it('mcpBad 计 state=failed 的 MCP', () => {
    const c = toolCounts(merged);
    expect(c.mcpBad).toBe(2); // grafana__dashboards + grafana__annotations
  });
  it('空列表全零', () => {
    const c = toolCounts(mergeMcpState([], []));
    expect(c).toEqual({ total: 0, builtin: 0, mcp: 0, disabled: 0, mcpBad: 0 });
  });
});

describe('filterTools', () => {
  it('tab=all 返回全部', () => {
    expect(filterTools(merged, '', 'all').length).toBe(merged.length);
  });
  it('tab=builtin 只返回 builtin', () => {
    const r = filterTools(merged, '', 'builtin');
    expect(r.every((t) => t.source === 'builtin')).toBe(true);
    expect(r.length).toBe(builtinRows.length);
  });
  it('tab=mcp 只返回 mcp', () => {
    const r = filterTools(merged, '', 'mcp');
    expect(r.every((t) => t.source === 'mcp')).toBe(true);
    expect(r.length).toBe(mcpRows.length);
  });
  it('tab=disabled 只返回 enabled=false 的 builtin', () => {
    const r = filterTools(merged, '', 'disabled');
    expect(r.every((t) => t.source === 'builtin' && !t.enabled)).toBe(true);
    expect(r.length).toBe(2);
  });
  it('query 按 name + desc + mcpServer 匹配（忽略大小写）', () => {
    const r = filterTools(merged, 'sql', 'all');
    expect(r.length).toBe(1);
    expect(r[0].name).toBe('postgres__query');
    const r2 = filterTools(merged, 'postgres', 'all');
    expect(r2.length).toBe(2); // mcpServer 含 postgres
    const r3 = filterTools(merged, 'File', 'all');
    expect(r3.some((t) => t.name === 'fileRead')).toBe(true);
  });
  it('query + tab 组合', () => {
    const r = filterTools(merged, 'postgres', 'builtin');
    expect(r).toEqual([]);
    const r2 = filterTools(merged, 'image', 'mcp');
    expect(r2).toEqual([]);
    const r3 = filterTools(merged, 'image', 'builtin');
    expect(r3.length).toBe(2);
  });
});

describe('sortTools', () => {
  it('name 字典序：任意相邻项 a.localeCompare(b) ≤ 0', () => {
    const r = sortTools(merged, 'name');
    for (let i = 1; i < r.length; i++) {
      expect(r[i - 1].name.localeCompare(r[i].name)).toBeLessThanOrEqual(0);
    }
  });
  it('family 分组（file→cmd→session→...→mcp），组内名字典序', () => {
    const r = sortTools(merged, 'family');
    let lastIdx = -1;
    for (const t of r) {
      const idx = ['file','cmd','session','memory','vision','http','skill','other','mcp'].indexOf(t.family);
      expect(idx).toBeGreaterThanOrEqual(lastIdx);
      lastIdx = idx;
    }
    const mcpGroup = r.filter((t) => t.family === 'mcp');
    expect(mcpGroup.length).toBeGreaterThan(0);
    expect(mcpGroup[0].name.localeCompare(mcpGroup[mcpGroup.length - 1].name)).toBeLessThanOrEqual(0);
  });
  it('disabled 优先：builtin disabled → mcpBad → enabled', () => {
    const r = sortTools(merged, 'disabled');
    const head = r.slice(0, 6);
    const tail = r.slice(-6);
    const headRanks = head.map((t) => {
      if (t.source === 'builtin' && !t.enabled) return 0;
      if (t.source === 'mcp' && (t as any).mcpBad) return 1;
      return 2;
    });
    const tailRanks = tail.map((t) => {
      if (t.source === 'builtin' && !t.enabled) return 0;
      if (t.source === 'mcp' && (t as any).mcpBad) return 1;
      return 2;
    });
    expect(Math.max(...headRanks)).toBeLessThanOrEqual(Math.min(...tailRanks));
  });
});

describe('parseSchemaParams', () => {
  it('null / undefined / 非 object → []', () => {
    expect(parseSchemaParams(null)).toEqual([]);
    expect(parseSchemaParams(undefined)).toEqual([]);
    expect(parseSchemaParams(42)).toEqual([]);
  });
  it('无 properties → []', () => {
    expect(parseSchemaParams({ type: 'object' })).toEqual([]);
  });
  it('正常 schema 提取 name / type / required / desc', () => {
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' },
        maxSize: { type: 'integer', description: 'Max bytes' },
        encoding: { type: 'string' },
      },
      required: ['path'],
    };
    const params = parseSchemaParams(schema);
    expect(params.length).toBe(3);
    expect(params[0]).toEqual({ name: 'path', type: 'string', required: true, desc: 'File path to read' });
    expect(params[1]).toEqual({ name: 'maxSize', type: 'integer', required: false, desc: 'Max bytes' });
    expect(params[2]).toEqual({ name: 'encoding', type: 'string', required: false, desc: '' });
  });
  it('type 缺失 → 空字符串', () => {
    const schema = { properties: { a: { description: 'x' } } };
    const params = parseSchemaParams(schema);
    expect(params[0].type).toBe('');
  });
});

describe('canToggle', () => {
  it('builtin 可开关', () => {
    expect(canToggle({ name: 'fileRead', description: '', enabled: true, source: 'builtin' })).toBe(true);
    expect(canToggle({ name: 'fileRead', description: '', enabled: false, source: 'builtin' })).toBe(true);
  });
  it('mcp 不可开关', () => {
    expect(canToggle({ name: 'pg__x', description: '', enabled: true, source: 'mcp' })).toBe(false);
  });
});

describe('toolInitials', () => {
  it('驼峰/下划线 → 清理后前两字大写', () => {
    expect(toolInitials('fileRead')).toBe('FI');
    expect(toolInitials('ask_image')).toBe('AS');
    expect(toolInitials('commandRun')).toBe('CO');
    expect(toolInitials('httpRequest')).toBe('HT');
    expect(toolInitials('postgres__query')).toBe('PO'); // 清理掉__
  });
  it('单字 / 空字符串', () => {
    expect(toolInitials('x')).toBe('X');
    expect(toolInitials('')).toBe('?');
  });
  it('数字名', () => {
    expect(toolInitials('123')).toBe('12');
  });
});
