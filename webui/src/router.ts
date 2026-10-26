// hash 路由（D4：不引 vue-router，window.location.hash 自管理）
//
// 20261026-004 D1：hash 支持 query（`#/memory?tab=l2&ws=<id>`）——
// currentPath 只保留路径段（路由表匹配与导航高亮均用路径段），
// query 段经 hashQuery 暴露给视图做可还原的页面状态（刷新/分享不丢）。
import { ref, computed, type Component } from 'vue';
import ChatView from './views/ChatView.vue';
import ConfigView from './views/ConfigView.vue';
import ModelsView from './views/ModelsView.vue';
import ToolsView from './views/ToolsView.vue';
import McpView from './views/McpView.vue';
import SkillsView from './views/SkillsView.vue';
import MemoryView from './views/MemoryView.vue';
import DoctorView from './views/DoctorView.vue';

export interface NavItem {
  path: string;
  label: string;
  icon: string;
}

/** 底部「管理」分组 7 项（原型-20261018-001：聊天即主页由「新建对话」+ 会话列表承载） */
export const adminItems: readonly NavItem[] = [
  { path: '#/config', label: '配置', icon: '⚙️' },
  { path: '#/models', label: '模型', icon: '🤖' },
  { path: '#/tools', label: '工具', icon: '🔧' },
  { path: '#/mcp', label: 'MCP 服务器', icon: '🔌' },
  { path: '#/skills', label: '技能', icon: '🧩' },
  { path: '#/memory', label: '记忆', icon: '🧠' },
  { path: '#/doctor', label: '诊断', icon: '🩺' },
];

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

/** 路由表：8 项全量（P0 聊天 + P1 管理台 7 视图）；按路径段匹配，query 不参与 */
const routes: Record<string, Component> = {
  '#/chat': ChatView,
  '#/config': ConfigView,
  '#/models': ModelsView,
  '#/tools': ToolsView,
  '#/mcp': McpView,
  '#/skills': SkillsView,
  '#/memory': MemoryView,
  '#/doctor': DoctorView,
};

export const currentView = computed<Component>(() => routes[currentPath.value] ?? ChatView);
