// 侧边栏底部「设置与管理」菜单数据源（需求 20261028-002 · 方案 D2/D4/D5/D6/D7）
//
// 本模块不 import 任何 .vue 与 DOM API，是纯数据 + 纯函数，便于在 Node 下直测。
// 图标为自绘 16×16 线性 SVG（viewBox 0 0 16 16 / stroke 1.6 / currentColor / 圆头圆角），
// 与 tool-meta.ts 的 TOOL_ICON_PATHS、chart-box.ts 的 ICON 同源，零新依赖。
// 其中 gear / wrench / puzzle 三条路径与 TOOL_ICON_PATHS 逐字节一致（由单测锁定，防漂移）。

export type NavIconKey =
  | 'gear' // 配置
  | 'chip' // 模型
  | 'wrench' // 工具
  | 'link' // MCP
  | 'puzzle' // 技能
  | 'stack' // 记忆
  | 'pulse' // 诊断
  | 'sliders' // 入口
  | 'caret'; // 面板展开指示

/** 16×16 线性图标的 inner SVG（外层属性由 navIconSvg() 统一给） */
export const NAV_ICON_PATHS: Record<NavIconKey, string> = {
  // 与 tool-meta.ts TOOL_ICON_PATHS.gear 一致
  gear: '<circle cx="8" cy="8" r="2.1"/><path d="M8 1.9v1.7M8 12.4v1.7M1.9 8h1.7M12.4 8h1.7M3.7 3.7l1.2 1.2M11.1 11.1l1.2 1.2M12.3 3.7l-1.2 1.2M4.9 11.1l-1.2 1.2"/>',
  // 芯片：外框 + 内芯（模型）
  chip: '<rect x="3.4" y="3.4" width="9.2" height="9.2" rx="2"/><rect x="6.3" y="6.3" width="3.4" height="3.4" rx=".9"/>',
  // 与 tool-meta.ts TOOL_ICON_PATHS.wrench 一致
  wrench:
    '<path d="M10.6 2.6a3.1 3.1 0 0 0-3.7 4L2.7 10.8a1.45 1.45 0 0 0 2.05 2.05l4.2-4.2a3.1 3.1 0 0 0 3.9-3.7l-1.9 1.9-1.7-.45-.45-1.7z"/>',
  // 连接：两端节点 + 斜线（MCP）
  link: '<circle cx="4.6" cy="11.4" r="1.7"/><circle cx="11.4" cy="4.6" r="1.7"/><path d="M5.9 10.1 10.1 5.9"/>',
  // 与 tool-meta.ts TOOL_ICON_PATHS.puzzle 一致
  puzzle:
    '<path d="M5.1 2.7h2.1a1.4 1.4 0 1 1 1.7 0h2a.6.6 0 0 1 .6.6v2.1a1.4 1.4 0 1 0 0 1.7v2.1a.6.6 0 0 1-.6.6H8.9a1.4 1.4 0 1 0-1.7 0H5.1a.6.6 0 0 1-.6-.6V7.1a1.4 1.4 0 1 0 0-1.7V3.3a.6.6 0 0 1 .6-.6z"/>',
  // 分层堆栈（记忆 L1/L2/L3）
  stack:
    '<path d="M8 2.4 13 5 8 7.6 3 5z"/><path d="M3 8.2 8 10.8 13 8.2"/><path d="M3 11.2 8 13.8 13 11.2"/>',
  // 心律波形（诊断）
  pulse: '<path d="M1.8 8h2.5l1.5-3.6L8.5 12l1.5-4h4.2"/>',
  // 双滑杆（入口：设置与管理）
  sliders:
    '<path d="M3 5.2h10M3 10.8h10"/><circle cx="6" cy="5.2" r="1.7"/><circle cx="10.4" cy="10.8" r="1.7"/>',
  // 上折箭头（面板展开后 rotate 180deg 变下折）
  caret: '<path d="M4 9.6 8 5.6 12 9.6"/>',
};

/** 完整 `<svg>` 串：供 `v-html` 渲染（尺寸由 CSS 控制） */
export function navIconSvg(key: NavIconKey, strokeWidth = 1.6): string {
  const d = NAV_ICON_PATHS[key] ?? NAV_ICON_PATHS.gear;
  return (
    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${strokeWidth}"` +
    ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
  );
}

/** 一个管理项：label 为全称（title / aria），short 为 2 列网格内的短标签（D4） */
export interface AdminItem {
  path: string;
  label: string;
  short: string;
  icon: NavIconKey;
}

/** 分组：按「改运行参数 / 装扩展能力 / 看数据与排障」的心智切分（D5） */
export interface AdminGroup {
  cap: string;
  items: readonly AdminItem[];
}

export const ADMIN_GROUPS: readonly AdminGroup[] = [
  {
    cap: '运行',
    items: [
      { path: '#/config', label: '配置', short: '配置', icon: 'gear' },
      { path: '#/models', label: '模型', short: '模型', icon: 'chip' },
      { path: '#/tools', label: '工具', short: '工具', icon: 'wrench' },
    ],
  },
  {
    cap: '扩展',
    items: [
      // 2 列格宽约 93px 放不下「MCP 服务器」，短标签用 MCP，全称进 title（D4）
      { path: '#/mcp', label: 'MCP 服务器', short: 'MCP', icon: 'link' },
      { path: '#/skills', label: '技能', short: '技能', icon: 'puzzle' },
    ],
  },
  {
    cap: '数据与排查',
    items: [
      { path: '#/memory', label: '记忆', short: '记忆', icon: 'stack' },
      { path: '#/doctor', label: '诊断', short: '诊断', icon: 'pulse' },
    ],
  },
];

/** 扁平项列表（顺序 = 分组顺序，供路由侧与测试复用） */
export const ADMIN_ITEMS: readonly AdminItem[] = ADMIN_GROUPS.flatMap((g) => g.items);

/** 入口行文案（D7：入口常驻，右侧另显示当前页名） */
export const MENU_LABEL = '设置与管理';

/** 聊天页（无对应管理项）的页名 */
export const CHAT_LABEL = '对话';

/**
 * 当前 hash 路径 → 页名（入口右侧常驻徽标，D7）。
 * 管理项命中用短标签（MCP 而非「MCP 服务器」，受 62px 宽度限制）；未命中一律回「对话」。
 */
export function pageLabel(path: string): string {
  const hit = ADMIN_ITEMS.find((it) => it.path === path);
  return hit ? hit.short : CHAT_LABEL;
}

/** 外观三态（D6）：auto 跟随系统，light / dark 显式覆盖 */
export type ThemePref = 'auto' | 'light' | 'dark';

export const APPEAR_MODES: readonly { v: ThemePref; label: string }[] = [
  { v: 'auto', label: '跟随' },
  { v: 'light', label: '浅色' },
  { v: 'dark', label: '深色' },
];

/**
 * 外观偏好 → `<html data-theme>` 取值。
 * auto 返回 null（删除 data-theme，交回系统 prefers-color-scheme 决定）。
 */
export function resolveThemeAttr(pref: ThemePref): 'light' | 'dark' | null {
  return pref === 'auto' ? null : pref;
}
