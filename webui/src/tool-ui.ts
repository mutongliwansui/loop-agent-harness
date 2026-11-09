// 工具页纯逻辑（原型-20261109-003 · D1–D9）
// 可单测部分：来源分段 / 状态分段 / 排序 / 家族分类 / 统计 / MCP 状态合并 / Schema 解析

export type ToolSource = 'builtin' | 'mcp';
export type ToolState = 'enabled' | 'disabled' | 'mcp-bad';
export type ToolTab = 'all' | 'builtin' | 'mcp' | 'disabled';
export type ToolSort = 'name' | 'family' | 'disabled';

/** GET /tools 列表项（后端原样） */
export interface ToolRow { name: string; description: string; enabled: boolean; source: ToolSource }

/** GET /mcp/servers 项（合并读取用于 MCP 工具失败判定） */
export interface McpServerRow {
  name: string; state?: string; status?: string;
}

export interface ToolCounts {
  total: number; builtin: number; mcp: number; disabled: number; mcpBad: number;
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
export type ToolFamily = 'file' | 'cmd' | 'session' | 'memory' | 'vision' | 'http' | 'skill' | 'other' | 'mcp';
const FAMILY_LABEL: Record<ToolFamily, string> = {
  file: '文件', cmd: '命令', session: '会话', memory: '记忆',
  vision: '视觉', http: 'HTTP', skill: '技能', other: '其他', mcp: 'MCP',
};
export const FAMILY_ORDER: ToolFamily[] = ['file','cmd','session','memory','vision','http','skill','other','mcp'];
export const FAMILY_TILE: Record<ToolFamily, string> = {
  file: 'file', cmd: 'cmd', session: 'session', memory: 'memory',
  vision: 'vision', http: 'http', skill: 'skill', other: 'other', mcp: 'other',
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

/** 家族判定：MCP 工具按工具名前缀推断（postgres__ → file？其实应该展示 server 名更合理，但保持原型） */
export function classifyFamily(name: string, source: ToolSource): ToolFamily {
  if (source === 'mcp') return 'mcp';
  return BUILTIN_FAMILY[name] || 'other';
}

export function familyLabel(f: ToolFamily): string {
  return FAMILY_LABEL[f];
}

/** 从 server__tool 解析 server 名 */
export function mcpServerOf(name: string): string | null {
  const i = name.indexOf('__');
  return i > 0 ? name.slice(0, i) : null;
}

/** 合并 MCP server 状态（只读 server__ 前缀）：bad = pending/failed/connecting 态之外的连接失败判定简化为 state=failed 或 status=disconnected 且 state 非 pending */
export function mergeMcpState(
  rows: ToolRow[],
  mcpServers: McpServerRow[],
): Array<ToolRow & { family: ToolFamily; mcpBad?: boolean; mcpServer?: string }> {
  const mcpMap = new Map<string, McpServerRow>();
  for (const s of mcpServers) mcpMap.set(s.name, s);
  return rows.map((r) => {
    const family = classifyFamily(r.name, r.source);
    if (r.source !== 'mcp') return { ...r, family };
    const server = mcpServerOf(r.name);
    const srv = server ? mcpMap.get(server) : undefined;
    // 连接失败：显式 state=failed，或 status=disconnected 且 state 不是 pending/connecting（保守）
    const bad = !!(srv && (srv.state === 'failed' || (srv.status === 'disconnected' && srv.state !== 'connecting')));
    return { ...r, family, mcpBad: bad, mcpServer: server ?? undefined };
  });
}

/** 统计：total / builtin / mcp / disabled / mcpBad */
export function toolCounts(list: ReturnType<typeof mergeMcpState>): ToolCounts {
  const c: ToolCounts = { total: list.length, builtin: 0, mcp: 0, disabled: 0, mcpBad: 0 };
  for (const t of list) {
    if (t.source === 'builtin') { c.builtin += 1; if (!t.enabled) c.disabled += 1; }
    else { c.mcp += 1; if (t.mcpBad) c.mcpBad += 1; }
  }
  return c;
}

/** 分段 + 搜索过滤（返回原顺序；排序由 sortTools 负责） */
export function filterTools(
  list: ReturnType<typeof mergeMcpState>,
  query: string,
  tab: ToolTab,
): ReturnType<typeof mergeMcpState> {
  const q = query.trim().toLowerCase();
  const tabOk = (t: ReturnType<typeof mergeMcpState>[number]) => {
    if (tab === 'builtin') return t.source === 'builtin';
    if (tab === 'mcp') return t.source === 'mcp';
    if (tab === 'disabled') return !t.enabled;
    return true;
  };
  const match = (t: ReturnType<typeof mergeMcpState>[number]) => {
    if (!q) return true;
    const hay = t.name + ' ' + (t.description || '') + (t.source === 'mcp' && t.mcpServer ? ' ' + t.mcpServer : '');
    return hay.toLowerCase().includes(q);
  };
  return list.filter((t) => tabOk(t) && match(t));
}

/** 排序：按 family 顺序（工具名字典序稳定）/ 禁用优先（禁用顶到最上）/ 名字 A→Z */
export function sortTools(
  list: ReturnType<typeof mergeMcpState>,
  mode: ToolSort,
): ReturnType<typeof mergeMcpState> {
  const copy = [...list];
  if (mode === 'name') return copy.sort((a, b) => a.name.localeCompare(b.name));
  if (mode === 'family') {
    return copy.sort((a, b) => {
      const ia = FAMILY_ORDER.indexOf(a.family);
      const ib = FAMILY_ORDER.indexOf(b.family);
      return (ia !== ib ? ia - ib : a.name.localeCompare(b.name));
    });
  }
  // disabled: 禁用 → MCP 失败 → 已启用
  return copy.sort((a, b) => {
    const rank = (t: typeof copy[number]) => {
      if (t.source === 'builtin' && !t.enabled) return 0;
      if (t.source === 'mcp' && t.mcpBad) return 1;
      return 2;
    };
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
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

/** 抽屉「禁用」操作是否对该工具可用：builtin 非门控时可开关 */
export function canToggle(t: ToolRow): boolean {
  return t.source === 'builtin';
}

/** 名称 → 图标两字 */
export function toolInitials(name: string): string {
  const clean = String(name).replace(/[^0-9A-Za-z]/g, '');
  if (clean) return clean.slice(0, 2).toUpperCase();
  return String(name).slice(0, 2) || '?';
}
