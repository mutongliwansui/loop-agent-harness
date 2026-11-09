// 工具页纯逻辑（原型-20261109-003 · 仅内置工具）
// 可单测部分：家族分类 / 统计 / 分段筛选 / 排序 / Schema 解析
// MCP 工具不在本页展示，统一归 MCP 服务器页管理。

export type ToolSource = 'builtin' | 'mcp';
export type ToolTab = 'all' | 'enabled' | 'disabled';
export type ToolSort = 'name' | 'family' | 'disabled';

/** GET /tools 列表项（后端原样；页面仅取 source=builtin 的行） */
export interface ToolRow { name: string; description: string; enabled: boolean; source: ToolSource }

export interface ToolCounts {
  total: number; enabled: number; disabled: number;
}

/** OpenAI function calling schema 的 properties 结构（简化） */
export interface ToolSchemaProperty {
  type?: string;
  description?: string;
  [key: string]: unknown;
}
export interface ToolSchema {
  type?: string;
  properties?: Record<string, ToolSchemaProperty>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolParamRow { name: string; type: string; required: boolean; desc: string }

/** 家族分类 & 图标 */
export type ToolFamily = 'file' | 'cmd' | 'session' | 'memory' | 'vision' | 'http' | 'skill' | 'other';
const FAMILY_LABEL: Record<ToolFamily, string> = {
  file: '文件', cmd: '命令', session: '会话', memory: '记忆',
  vision: '视觉', http: 'HTTP', skill: '技能', other: '其他',
};
export const FAMILY_ORDER: ToolFamily[] = ['file','cmd','session','memory','vision','http','skill','other'];
export const FAMILY_TILE: Record<ToolFamily, string> = {
  file: 'file', cmd: 'cmd', session: 'session', memory: 'memory',
  vision: 'vision', http: 'http', skill: 'skill', other: 'other',
};

/** 内置工具 → 家族分类（硬编码，覆盖全部 BUILTIN_TOOL_MAP；未知 → other） */
const BUILTIN_FAMILY: Record<string, ToolFamily> = {
  commandRun:'cmd', commandStatus:'cmd', commandLogs:'cmd', commandStop:'cmd',
  fileRead:'file', fileWrite:'file', editFile:'file', grep:'file', listFiles:'file',
  createFile:'file', deleteFile:'file',
  ask_image:'vision', describe_image:'vision', extract_json:'vision', ocr_image:'vision',
  memoryWrite:'memory', memoryRead:'memory', memorySearch:'memory',
  sessionHistory:'session', skillRun:'skill',
  httpRequest:'http',
};

/** 内置工具 → 家族分类（未知 → other） */
export function classifyFamily(name: string): ToolFamily {
  return BUILTIN_FAMILY[name] || 'other';
}

export function familyLabel(f: ToolFamily): string {
  return FAMILY_LABEL[f];
}

/** 页面仅管理内置工具：过滤掉 source=mcp 的行（MCP 工具在 MCP 服务器页管理） */
export function builtinTools(rows: ToolRow[]): ToolRow[] {
  return rows.filter((r) => r.source === 'builtin');
}

/** 附加 family 字段（供图标/排序使用） */
export type FamilyTool = ToolRow & { family: ToolFamily };
export function withFamily(rows: ToolRow[]): FamilyTool[] {
  return rows.map((r) => ({ ...r, family: classifyFamily(r.name) }));
}

/** 统计：total / enabled / disabled */
export function toolCounts(list: ToolRow[]): ToolCounts {
  const c: ToolCounts = { total: list.length, enabled: 0, disabled: 0 };
  for (const t of list) {
    if (t.enabled) c.enabled += 1;
    else c.disabled += 1;
  }
  return c;
}

/** 分段 + 搜索过滤（返回原顺序；排序由 sortTools 负责） */
export function filterTools(
  list: FamilyTool[],
  query: string,
  tab: ToolTab,
): FamilyTool[] {
  const q = query.trim().toLowerCase();
  const tabOk = (t: FamilyTool) => {
    if (tab === 'enabled') return t.enabled;
    if (tab === 'disabled') return !t.enabled;
    return true;
  };
  const match = (t: FamilyTool) => {
    if (!q) return true;
    const hay = t.name + ' ' + (t.description || '');
    return hay.toLowerCase().includes(q);
  };
  return list.filter((t) => tabOk(t) && match(t));
}

/** 排序：按 family 顺序（工具名字典序稳定）/ 禁用优先（禁用顶到最上）/ 名字 A→Z */
export function sortTools(
  list: FamilyTool[],
  mode: ToolSort,
): FamilyTool[] {
  const copy = [...list];
  if (mode === 'name') return copy.sort((a, b) => a.name.localeCompare(b.name));
  if (mode === 'family') {
    return copy.sort((a, b) => {
      const ia = FAMILY_ORDER.indexOf(a.family);
      const ib = FAMILY_ORDER.indexOf(b.family);
      return (ia !== ib ? ia - ib : a.name.localeCompare(b.name));
    });
  }
  // disabled: 禁用优先
  return copy.sort((a, b) => Number(a.enabled) - Number(b.enabled) || a.name.localeCompare(b.name));
}

/** Schema → 参数表行；空 schema 返回 [] */
export function parseSchemaParams(schema: unknown): ToolParamRow[] {
  const sch = schema as ToolSchema | null | undefined;
  if (!sch || typeof sch !== 'object') return [];
  const props = sch.properties;
  if (!props) return [];
  const required = new Set(sch.required || []);
  return Object.entries(props).map(([name, p]) => ({
    name,
    type: typeof p?.type === 'string' ? p.type : '',
    required: required.has(name),
    desc: (p?.description || '') as string,
  }));
}

/** 名称 → 图标两字 */
export function toolInitials(name: string): string {
  const clean = String(name).replace(/[^0-9A-Za-z]/g, '');
  if (clean) return clean.slice(0, 2).toUpperCase();
  return String(name).slice(0, 2) || '?';
}
