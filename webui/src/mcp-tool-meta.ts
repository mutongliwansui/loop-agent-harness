// MCP 工具展示元信息注册表（需求 20261104-001，D10/D11/D12）
//
// 设计约束：
// - 纯数据 + 纯函数，零 DOM、零 vue 依赖（root vitest 直接断言）；
// - 拉取与响应式 bump 在 mcp-tool-meta-loader.ts，本文件不碰 vue；
// - 未命中元信息时所有函数都返回可渲染的安全值（英文名/齿轮/空摘要），调用方无需判空。
//
// 消费方：tool-meta.ts 的 toolDisplay/toolParamRows/toolSummary（MCP 分支）。

import type { ToolIconKey } from './tool-meta.js';

/** 展示名来源（与后端同构） */
export type McpNameSource = 'title' | 'cjk' | 'translate' | 'none';
/** 翻译状态（与后端同构） */
export type McpTranslateState = 'idle' | 'pending' | 'done' | 'failed' | 'skipped';

/** 与后端 McpToolMeta 同构（GET /mcp/tool-meta 的 tools[] 元素） */
export interface McpToolMeta {
  fullName: string;
  server: string;
  tool: string;
  title: string;
  description: string;
  paramDesc: Record<string, string>;
  required: string[];
  zhName: string;
  zhParams: Record<string, string>;
  nameSource: McpNameSource;
  translate: McpTranslateState;
  translateError?: string;
}

/**
 * 卡片展示名最大字数（超出截断）。
 * 后端本地提炼上限是 12 字（meta.ts 的 ZH_NAME_MAX），但协议 title 原文与 LLM 译名可能更长，
 * 故卡片层放宽到 14 字再截断，留出少量余量。
 */
export const MCP_NAME_MAX = 14;
/** 摘要里单个参数值最大长度 */
const BRIEF_VALUE_MAX = 24;
/** 摘要最多取几个必填参数 */
const BRIEF_PARAM_COUNT = 2;

/** fullName → 元信息 */
let table = new Map<string, McpToolMeta>();

/** 覆盖注册表（loader 拉到新数据时调用；传入非法值时清空） */
export function setMcpToolMeta(list: McpToolMeta[] | null | undefined): void {
  const next = new Map<string, McpToolMeta>();
  if (Array.isArray(list)) {
    for (const m of list) {
      if (m && typeof m.fullName === 'string' && m.fullName) next.set(m.fullName, m);
    }
  }
  table = next;
}

/** 查某个工具（server__tool）的元信息；未采集到返回 undefined */
export function mcpMetaOf(tool: string): McpToolMeta | undefined {
  return table.get(tool);
}

/** 注册表快照（调试/测试用） */
export function mcpToolMetaSize(): number {
  return table.size;
}

/**
 * 名字分词美化（D1 末位兜底）：
 * - `shortestPath` → `Shortest Path`
 * - `get_edge_label` → `Get Edge Label`
 * - 已含空格/中文的原样返回
 */
export function prettifyName(raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/\s/.test(s) || /[\u3400-\u9fff]/.test(s)) return s;
  // 先按下划线/中横线切词，再处理驼峰
  const words = s
    .split(/[_\-.]+/)
    .filter(Boolean)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .filter(Boolean);
  if (words.length === 0) return s;
  return words
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * 关键词 → 图标（D11）：先看工具名，再看必填参数名，最后回落 `gear`。
 * 词典按顺序匹配，越靠前优先级越高（delete/write 等强语义动作放前面）。
 */
const ICON_RULES: Array<{ re: RegExp; icon: ToolIconKey }> = [
  { re: /(delete|remove|drop|clear)/i, icon: 'stop' },
  { re: /(write|save|create|add|update|set|insert|edit|modify|patch)/i, icon: 'pencil' },
  { re: /(search|query|find|lookup|greps?|match)/i, icon: 'search' },
  { re: /(fetch|get|read|list|info|view|detail|describe|show)/i, icon: 'book' },
  { re: /(run|exec|execute|command|shell|script)/i, icon: 'terminal' },
  { re: /(edge|node|vertex|path|graph|label|traversal|cypher)/i, icon: 'lines' },
  { re: /(image|vision|ocr|photo|picture)/i, icon: 'image' },
  { re: /(chart|json|table|csv|excel|extract)/i, icon: 'table' },
  { re: /(skill|plugin|extension)/i, icon: 'puzzle' },
  { re: /(help|question|ask|explain)/i, icon: 'help' },
  { re: /(time|date|clock|schedule|timer)/i, icon: 'clock' },
];

/** 按元信息挑图标：工具名优先，其次必填参数名，最后 `gear` */
export function mcpIconFor(meta: McpToolMeta | undefined): ToolIconKey {
  if (!meta) return 'gear';
  for (const { re, icon } of ICON_RULES) {
    if (re.test(meta.tool || '')) return icon;
  }
  const paramText = `${(meta.required ?? []).join(' ')} ${Object.keys(meta.paramDesc ?? {}).join(' ')}`;
  if (paramText.trim()) {
    for (const { re, icon } of ICON_RULES) {
      if (re.test(paramText)) return icon;
    }
  }
  return 'gear';
}

/** 展示名（含 source，供卡片标题用）；未采集到返回空串 */
export function mcpNameOf(meta: McpToolMeta | undefined): { name: string; raw: string } {
  if (!meta) return { name: '', raw: '' };
  const zh = (meta.zhName || '').trim();
  if (zh) return { name: zh, raw: meta.title || zh };
  // D16：翻译未就绪/失败时回落协议 title 原文，最后才是名字美化
  const title = (meta.title || '').trim();
  if (title) return { name: title, raw: title };
  return { name: prettifyName(meta.tool), raw: '' };
}

/** 按 MCP_NAME_MAX 截断展示名（D12） */
export function clipName(name: string, max: number = MCP_NAME_MAX): string {
  return name.length > max ? `${name.slice(0, max)}…` : name;
}

/** 单个参数值 → 摘要片段（字符串原样、对象紧凑、统一截断） */
function briefValue(v: unknown): string {
  let text: string;
  if (typeof v === 'string') text = v;
  else if (typeof v === 'number' || typeof v === 'boolean') text = String(v);
  else {
    try {
      text = JSON.stringify(v) ?? '';
    } catch {
      text = String(v);
    }
  }
  return text.length > BRIEF_VALUE_MAX ? `${text.slice(0, BRIEF_VALUE_MAX)}…` : text;
}

/**
 * 语义摘要（D12）：取 `required` 里的前 2 个参数拼 `键=值`；
 * 必填参数都没传时退化为参数对象的头两个键；无参数返回空串（调用方回退紧凑 JSON）。
 */
export function mcpBrief(meta: McpToolMeta | undefined, argsJson: string): string {
  if (!meta) return '';
  const raw = String(argsJson ?? '').trim();
  if (!raw) return '';
  let args: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return '';
    args = v as Record<string, unknown>;
  } catch {
    return '';
  }
  const keys = Object.keys(args);
  if (keys.length === 0) return '';
  const picked: string[] = [];
  for (const k of meta.required ?? []) {
    if (k in args) picked.push(k);
    if (picked.length >= BRIEF_PARAM_COUNT) break;
  }
  if (picked.length === 0) {
    for (const k of keys) {
      picked.push(k);
      if (picked.length >= BRIEF_PARAM_COUNT) break;
    }
  }
  return picked
    .map((k) => {
      const keyLabel = meta.zhParams?.[k] || k;
      return `${keyLabel}=${briefValue(args[k])}`;
    })
    .join(' · ');
}

/**
 * 参数中文标签：元信息里有就用，否则美化键名（MCP 分支用）。
 *
 * 无元信息时**必须返回原键**：这是 20261024-001 的既有行为（MCP 工具参数表用英文键），
 * 美化只针对「确认是 MCP 工具但缺该项翻译」的场景，否则会静默改变存量会话的展示。
 */
export function mcpParamLabel(meta: McpToolMeta | undefined, key: string): string {
  if (!meta) return key;
  const zh = meta.zhParams?.[key];
  if (zh && zh.trim()) {
    return zh.length > 9 ? `${zh.slice(0, 9)}…` : zh;
  }
  return prettifyName(key);
}
