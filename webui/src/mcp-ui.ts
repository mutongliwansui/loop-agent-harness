// MCP 页纯逻辑（原型-20261109-002 D1–D9）
// 只放可单测的纯函数：状态归一、统计、搜索/筛选/排序、倒计时、登记表单解析、工具展示映射。
// 视图层（McpView.vue）只负责渲染与 API 调用，不重复实现这些规则。

import { mcpNameOf, prettifyName, type McpToolMeta } from './mcp-tool-meta.js';

export type McpState = 'pending' | 'connecting' | 'connected' | 'failed';
/** 配置只剩全局一份（需求 20261112-008），scope 字段保留恒 'global' 以兼容旧响应 */
export type McpScope = 'global';
export type McpTab = 'all' | 'ok' | 'bad';
export type McpSort = 'status' | 'name' | 'tools';

/** GET /mcp/servers 列表项（state / scope 为 D9 增量） */
export interface McpServerRow {
  name: string;
  transport: string;
  status: string;
  toolCount: number;
  state?: McpState | string;
  lastError?: string;
  nextRetryAt?: number;
  scope?: McpScope | string;
}

/** GET /config 的 tools.mcpServers[name]（secret 已被后端遮蔽） */
export interface McpTargetCfg {
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface McpCounts {
  total: number;
  connected: number;
  failed: number;
  pending: number;
  connecting: number;
  tools: number;
}

export interface StateMeta {
  label: string;
  /** 与 pill 类名一致：ok / warn / err / idle */
  tone: 'ok' | 'warn' | 'err' | 'idle';
}

const STATE_META: Record<McpState, StateMeta> = {
  pending: { label: '待连接', tone: 'idle' },
  connecting: { label: '连接中', tone: 'warn' },
  connected: { label: '已连接', tone: 'ok' },
  failed: { label: '连接失败', tone: 'err' },
};

/** state 合法值直接采用；缺失时按 status 回落（connected → 已连接，其余 → 待连接） */
export function normalizeState(row: Pick<McpServerRow, 'state' | 'status'>): McpState {
  const s = row.state;
  if (s === 'pending' || s === 'connecting' || s === 'connected' || s === 'failed') return s;
  return row.status === 'connected' ? 'connected' : 'pending';
}

export function stateMeta(state: McpState): StateMeta {
  return STATE_META[state];
}

/** 连接目标：stdio 拼 command + args，远程取 url；缺失返回 — */
export function serverTarget(cfg: McpTargetCfg | undefined): string {
  if (!cfg) return '—';
  if (cfg.command) return [cfg.command, ...(cfg.args ?? [])].join(' ');
  return cfg.url || '—';
}

/** 统计口径：异常只计 failed；pending / connecting 不算异常（D2） */
export function mcpCounts(rows: McpServerRow[]): McpCounts {
  const counts: McpCounts = { total: rows.length, connected: 0, failed: 0, pending: 0, connecting: 0, tools: 0 };
  for (const row of rows) {
    const state = normalizeState(row);
    if (state === 'connected') counts.connected += 1;
    else if (state === 'failed') counts.failed += 1;
    else if (state === 'connecting') counts.connecting += 1;
    else counts.pending += 1;
    counts.tools += row.toolCount || 0;
  }
  return counts;
}

/** 名称或连接目标不区分大小写匹配；空查询恒为真 */
export function matchServer(row: McpServerRow, target: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return row.name.toLowerCase().includes(q) || target.toLowerCase().includes(q);
}

/** 状态分段 + 关键字过滤（保持入参顺序，排序由 sortServers 负责） */
export function filterServers(
  rows: McpServerRow[],
  targets: Record<string, McpTargetCfg | undefined>,
  query: string,
  tab: McpTab,
): McpServerRow[] {
  return rows.filter((row) => {
    const state = normalizeState(row);
    if (tab === 'ok' && state !== 'connected') return false;
    if (tab === 'bad' && state !== 'failed') return false;
    return matchServer(row, serverTarget(targets[row.name]), query);
  });
}

/** status：异常 → 连接中 → 待连接 → 已连接，同级按名称；tools：工具数降序再按名称 */
export function sortServers(rows: McpServerRow[], mode: McpSort): McpServerRow[] {
  const copy = [...rows];
  if (mode === 'name') return copy.sort((a, b) => a.name.localeCompare(b.name));
  if (mode === 'tools') {
    return copy.sort((a, b) => (b.toolCount || 0) - (a.toolCount || 0) || a.name.localeCompare(b.name));
  }
  const rank: Record<McpState, number> = { failed: 0, connecting: 1, pending: 2, connected: 3 };
  return copy.sort((a, b) => rank[normalizeState(a)] - rank[normalizeState(b)] || a.name.localeCompare(b.name));
}

/** 重试倒计时 mm:ss（向上取整；已到期或缺失返回 00:00） */
export function fmtCountdown(nextRetryAt: number | undefined, now: number): string {
  if (!nextRetryAt) return '00:00';
  const sec = Math.max(0, Math.ceil((nextRetryAt - now) / 1000));
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 卡片渐变图标文字：优先取字母数字前两位；纯中文名取前两位；空名返回 ? */
export function mcpInitials(name: string): string {
  const clean = String(name ?? '').replace(/[^0-9A-Za-z]/g, '');
  if (clean) return clean.slice(0, 2).toUpperCase();
  const raw = String(name ?? '').trim();
  return raw ? raw.slice(0, 2) : '?';
}

/** textarea「每行一个」→ 非空行数组 */
export function parseLines(text: string): string[] {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** textarea「每行 KEY=VALUE」→ 对象；无有效行返回空对象 */
export function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of parseLines(text)) {
    const i = line.indexOf('=');
    if (i > 0 && line.slice(0, i).trim()) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** 全局配置文件路径（MCP 配置只剩全局一份，登记/移除/抽屉展示统一用它） */
export const MCP_CONFIG_PATH = '~/.loop-agent/config.json';

export interface McpToolView {
  /** 中文展示名（缺元信息时回落名字美化） */
  zh: string;
  /** 原始工具名（去掉 server__ 前缀） */
  en: string;
  desc: string;
  required: string[];
  /** 名字来源徽标：title / 中文 / 译 / 原文 */
  badge: string;
  failed: boolean;
}

/** 工具清单展示项：GET /mcp/servers/:name 的 { name, description } + GET /mcp/tool-meta 合并 */
export function describeMcpTool(
  fullName: string,
  rawDesc: string,
  meta: McpToolMeta | undefined,
  server?: string,
): McpToolView {
  const prefix = server && fullName.startsWith(`${server}__`) ? `${server}__`.length : 0;
  const en = meta?.tool || fullName.slice(prefix);
  const zh = meta ? mcpNameOf(meta).name || prettifyName(en) : prettifyName(en) || en;
  const desc = (meta?.description || rawDesc || meta?.title || '').trim() || '无描述';
  const failed = meta?.translate === 'failed';
  let badge = '原文';
  if (!failed) {
    if (meta?.nameSource === 'title') badge = 'title';
    else if (meta?.nameSource === 'cjk') badge = '中文';
    else if (meta?.nameSource === 'translate') badge = '译';
  }
  return { zh: zh || en, en, desc, required: meta?.required ?? [], badge, failed };
}
