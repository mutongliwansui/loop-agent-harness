/**
 * 工具页纯逻辑测试（原型-20261109-003 · 仅内置工具）
 *
 * 覆盖 webui/src/tool-ui.ts：
 * - builtinTools：仅保留 source=builtin 的行（MCP 工具归 MCP 服务器页）
 * - classifyFamily / familyLabel / withFamily：内置工具家族分类表
 * - toolCounts：total / enabled / disabled
 * - filterTools：tab 分段（all / enabled / disabled）+ query 搜索
 * - sortTools：按 name / family / disabled-优先
 * - parseSchemaParams：OpenAI function schema → 参数表
 * - toolInitials：名字 → 图标两字
 */
import { describe, it, expect } from 'vitest';
import {
  builtinTools,
  classifyFamily,
  familyLabel,
  filterTools,
  parseSchemaParams,
  sortTools,
  toolCounts,
  toolInitials,
  withFamily,
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
  { name: 'grafana__dashboards', description: 'List dashboards', enabled: true, source: 'mcp' },
];
const allRows: ToolRow[] = [...builtinRows, ...mcpRows];

const merged = withFamily(builtinTools(allRows));

describe('builtinTools', () => {
  it('只保留 source=builtin 的行', () => {
    const r = builtinTools(allRows);
    expect(r.length).toBe(builtinRows.length);
    expect(r.every((t) => t.source === 'builtin')).toBe(true);
  });
  it('空列表 → 空数组', () => {
    expect(builtinTools([])).toEqual([]);
  });
});

describe('classifyFamily / familyLabel', () => {
  it('内置工具硬编码覆盖', () => {
    expect(classifyFamily('commandRun')).toBe('cmd');
    expect(classifyFamily('fileRead')).toBe('file');
    expect(classifyFamily('editFile')).toBe('file');
    expect(classifyFamily('ask_image')).toBe('vision');
    expect(classifyFamily('describe_image')).toBe('vision');
    expect(classifyFamily('memoryWrite')).toBe('memory');
    expect(classifyFamily('memoryRead')).toBe('memory');
    expect(classifyFamily('sessionHistory')).toBe('session');
    expect(classifyFamily('skillRun')).toBe('skill');
    expect(classifyFamily('httpRequest')).toBe('http');
  });
  it('未知内置工具归 other', () => {
    expect(classifyFamily('unknownTool')).toBe('other');
  });
  it('家族中文名', () => {
    expect(familyLabel('file')).toBe('文件');
    expect(familyLabel('cmd')).toBe('命令');
    expect(familyLabel('vision')).toBe('视觉');
    expect(familyLabel('memory')).toBe('记忆');
    expect(familyLabel('other')).toBe('其他');
  });
});

describe('withFamily', () => {
  it('每行补充 family 字段', () => {
    const fr = merged.find((r) => r.name === 'fileRead');
    expect(fr).toBeTruthy();
    expect(fr!.family).toBe('file');
    const vision = merged.find((r) => r.name === 'ask_image');
    expect(vision!.family).toBe('vision');
  });
});

describe('toolCounts', () => {
  it('total / enabled / disabled', () => {
    const c = toolCounts(merged);
    expect(c.total).toBe(builtinRows.length);
    expect(c.disabled).toBe(2); // grep + memoryRead
    expect(c.enabled).toBe(builtinRows.length - 2);
  });
  it('空列表全零', () => {
    expect(toolCounts([])).toEqual({ total: 0, enabled: 0, disabled: 0 });
  });
});

describe('filterTools', () => {
  it('tab=all 返回全部', () => {
    expect(filterTools(merged, '', 'all').length).toBe(merged.length);
  });
  it('tab=enabled 只返回启用', () => {
    const r = filterTools(merged, '', 'enabled');
    expect(r.every((t) => t.enabled)).toBe(true);
    expect(r.length).toBe(builtinRows.length - 2);
  });
  it('tab=disabled 只返回禁用', () => {
    const r = filterTools(merged, '', 'disabled');
    expect(r.every((t) => !t.enabled)).toBe(true);
    expect(r.length).toBe(2);
  });
  it('query 按 name + desc 匹配（忽略大小写）', () => {
    const r = filterTools(merged, 'sql', 'all');
    expect(r).toEqual([]); // 内置工具无 SQL 描述
    const r2 = filterTools(merged, 'regex', 'all');
    expect(r2.length).toBe(1);
    expect(r2[0].name).toBe('grep');
    const r3 = filterTools(merged, 'File', 'all');
    expect(r3.some((t) => t.name === 'fileRead')).toBe(true);
  });
  it('query + tab 组合', () => {
    const r = filterTools(merged, 'grep', 'enabled');
    expect(r).toEqual([]);
    const r2 = filterTools(merged, 'grep', 'disabled');
    expect(r2.length).toBe(1);
    const r3 = filterTools(merged, 'image', 'enabled');
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
  it('family 分组（file→cmd→session→...→other），组内名字典序', () => {
    const r = sortTools(merged, 'family');
    let lastIdx = -1;
    for (const t of r) {
      const idx = ['file','cmd','session','memory','vision','http','skill','other'].indexOf(t.family);
      expect(idx).toBeGreaterThanOrEqual(lastIdx);
      lastIdx = idx;
    }
  });
  it('disabled 优先：禁用顶到最上，其余按名字典序', () => {
    const r = sortTools(merged, 'disabled');
    const disabledCount = r.filter((t) => !t.enabled).length;
    expect(r.slice(0, disabledCount).every((t) => !t.enabled)).toBe(true);
    expect(r.slice(disabledCount).every((t) => t.enabled)).toBe(true);
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

describe('toolInitials', () => {
  it('驼峰/下划线 → 清理后前两字大写', () => {
    expect(toolInitials('fileRead')).toBe('FI');
    expect(toolInitials('ask_image')).toBe('AS');
    expect(toolInitials('commandRun')).toBe('CO');
    expect(toolInitials('httpRequest')).toBe('HT');
  });
  it('单字 / 空字符串', () => {
    expect(toolInitials('x')).toBe('X');
    expect(toolInitials('')).toBe('?');
  });
  it('数字名', () => {
    expect(toolInitials('123')).toBe('12');
  });
});
