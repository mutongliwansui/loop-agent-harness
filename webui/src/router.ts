// hash 路由（D4：不引 vue-router，window.location.hash 自管理）
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

function normalizeHash(h: string): string {
  if (!h || !h.startsWith('#/')) return '#/chat';
  return h;
}

export const currentPath = ref(normalizeHash(location.hash));

window.addEventListener('hashchange', () => {
  currentPath.value = normalizeHash(location.hash);
});

/** 路由表：8 项全量（P0 聊天 + P1 管理台 7 视图） */
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
