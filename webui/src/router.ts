// hash 路由（D4：不引 vue-router，window.location.hash 自管理）
//
// 20261026-004 D1：hash 支持 query（`#/memory?tab=l2&ws=<id>`）——
// currentPath 只保留路径段（路由表匹配与导航高亮均用路径段），
// query 段经 hashQuery 暴露给视图做可还原的页面状态（刷新/分享不丢）。
import { ref, computed, type Component } from 'vue';
import { ADMIN_ITEMS, type AdminItem } from './nav-menu';
import ChatView from './views/ChatView.vue';
import ConfigView from './views/ConfigView.vue';
import ModelsView from './views/ModelsView.vue';
import ToolsView from './views/ToolsView.vue';
import McpView from './views/McpView.vue';
import SkillsView from './views/SkillsView.vue';
import MemoryView from './views/MemoryView.vue';
import DoctorView from './views/DoctorView.vue';
import DevView from './views/DevView.vue';

/**
 * 底部「设置与管理」8 项（原型-20261018-001 建立；20261028-002 重设计；20261104-002 增开发者中心）。
 * 数据源迁到 nav-menu.ts（分组 + SVG 图标 key + 短标签），此处保留同名导出以兼容旧引用。
 */
export type NavItem = AdminItem;

export const adminItems: readonly NavItem[] = ADMIN_ITEMS;

/** 拆 hash：路径段 + query 段（`#/memory?tab=l2` → base `#/memory`，query `tab=l2`） */
function parseHash(h: string): { base: string; query: string } {
  if (!h || !h.startsWith('#/')) return { base: '#/chat', query: '' };
  const i = h.indexOf('?');
  return i < 0 ? { base: h, query: '' } : { base: h.slice(0, i), query: h.slice(i + 1) };
}

/** 写 hash query（保留路径段；params 值为空串/undefined 的键删除）。用 replaceState 不产生历史记录 */
export function replaceHashQuery(params: Record<string, string | undefined>): void {
  const { base, query } = parseHash(location.hash);
  const sp = new URLSearchParams(query);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') sp.delete(k);
    else sp.set(k, v);
  }
  const qs = sp.toString();
  const next = qs ? `${base}?${qs}` : base;
  if (next === location.hash) return;
  history.replaceState(null, '', next);
  // replaceState 不触发 hashchange：手动同步路由状态
  syncFromHash();
}

function syncFromHash(): void {
  const { base, query } = parseHash(location.hash);
  currentPath.value = base;
  hashQuery.value = new URLSearchParams(query);
}

export const currentPath = ref(parseHash(location.hash).base);
/** 当前 hash 的 query（响应式；视图用它还原/同步页面状态） */
export const hashQuery = ref(new URLSearchParams(parseHash(location.hash).query));

window.addEventListener('hashchange', syncFromHash);

/** 路由表：9 项全量（P0 聊天 + P1/P2 管理台 8 视图）；按路径段匹配，query 不参与 */
const routes: Record<string, Component> = {
  '#/chat': ChatView,
  '#/config': ConfigView,
  '#/models': ModelsView,
  '#/tools': ToolsView,
  '#/mcp': McpView,
  '#/skills': SkillsView,
  '#/memory': MemoryView,
  '#/doctor': DoctorView,
  // 需求 20261104-002：开发者中心（多模块 tabs，首模块为 API 接口文档）
  '#/dev': DevView,
};

export const currentView = computed<Component>(() => routes[currentPath.value] ?? ChatView);
