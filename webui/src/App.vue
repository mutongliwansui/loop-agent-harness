<script setup lang="ts">
// 应用壳：左侧菜单（logo + 新建对话 + 会话列表 + 底部「设置与管理」入口）+ 右侧视图（hash 路由见 router.ts）
// 结构对齐原型-20261018-001：会话列表并入左侧菜单（搜索过滤 + 工作空间分组 + 删除二次确认），
// 原独立会话侧栏取消；20261028-002 把「管理 7 项 + 主题」折叠组换成单行入口 + 向上浮层面板，
// 主题改为面板内「跟随 / 浅色 / 深色」三态，仍经 localStorage 记忆。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { currentPath, currentView } from './router';
import {
  ADMIN_GROUPS,
  APPEAR_MODES,
  MENU_LABEL,
  navIconSvg,
  pageLabel,
  resolveThemeAttr,
  type ThemePref,
} from './nav-menu';
import {
  sessKw,
  activeId,
  delArmedId,
  filteredGroups,
  collapsedWs,
  wsColor,
  fmtTime,
  toggleWs,
  clickSession,
  onDelSession,
  requestNewChat,
  loadSessions,
} from './sessions';
import {
  isRunning,
  isUnread,
  onRunFinished,
  runningCount,
  unreadCount,
  handleRemoteRunStarted,
  handleRemoteRunFinished,
  markReadRemote,
  drop,
} from './chat-stream';
import { onTab } from './tab-sync';
import TokenGate from './components/TokenGate.vue';
import Toast from './components/Toast.vue';

// 运行中 / 有未读时给浏览器标签加前缀，便于在其他页面察觉后台完成
const BASE_TITLE = document.title;
watch(
  [runningCount, unreadCount],
  ([r, u]) => {
    const parts: string[] = [];
    if (r > 0) parts.push(`● ${r}`);
    if (u > 0) parts.push(`✉ ${u}`);
    document.title = parts.length > 0 ? `(${parts.join(' ')}) ${BASE_TITLE}` : BASE_TITLE;
  },
  { immediate: true },
);

// ===== 底部「设置与管理」入口 + 向上浮层面板（需求 20261028-002）=====
// 常驻只有入口一行（36px），面板是 position:absolute 浮层，不参与文档流，
// 因此管理项再多也不会挤压会话列表（改造前展开态 337.3px）。
const panelOpen = ref(false);
const entryEl = ref<HTMLButtonElement | null>(null);
const panelEl = ref<HTMLElement | null>(null);
/** 入口右侧常驻页名（D7：让「我在哪」可见） */
const currentLabel = computed(() => pageLabel(currentPath.value));

/** 面板内可导航项（role=menuitem；外观三段按钮不参与方向键循环） */
function menuItems(): HTMLElement[] {
  if (!panelEl.value) return [];
  return Array.from(panelEl.value.querySelectorAll<HTMLElement>('[role="menuitem"]'));
}

function openPanel(): void {
  panelOpen.value = true;
  // 打开后焦点落到当前页项，键盘用户可直接方向键切换（D11）。
  // 多等一帧：面板由 visibility:hidden → visible 后元素才真正可聚焦，
  // 只在 nextTick 里 focus() 会被浏览器忽略（实测 activeElement 停在 body）。
  void nextTick(() => {
    requestAnimationFrame(() => {
      const items = menuItems();
      const cur = items.find((el) => el.getAttribute('aria-current') === 'page');
      (cur ?? items[0])?.focus({ preventScroll: true });
    });
  });
}

function closePanel(restoreFocus = false): void {
  panelOpen.value = false;
  if (restoreFocus) entryEl.value?.focus();
}

function togglePanel(): void {
  if (panelOpen.value) closePanel();
  else openPanel();
}

/** 选中管理项：锚点照常跳转，仅收起面板并把焦点交回入口 */
function onPick(): void {
  closePanel(true);
}

function onEntryKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openPanel();
  }
}

function onPanelKey(e: KeyboardEvent): void {
  const items = menuItems();
  if (items.length === 0) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    items[i < 0 ? 0 : (i + 1) % items.length]?.focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    items[i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length]?.focus();
  } else if (e.key === 'Home') {
    e.preventDefault();
    items[0]?.focus();
  } else if (e.key === 'End') {
    e.preventDefault();
    items[items.length - 1]?.focus();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePanel(true);
  }
}

/** 点击面板与入口之外的任何位置收起（D11） */
function onDocPointerDown(e: PointerEvent): void {
  if (!panelOpen.value) return;
  const t = e.target as Node | null;
  if (panelEl.value?.contains(t) || entryEl.value?.contains(t)) return;
  closePanel();
}

// 路由变化（含浏览器前进/后退、面板项点击）一律收起面板
watch(currentPath, () => {
  if (panelOpen.value) closePanel();
});

// ===== 外观：跟随 / 浅色 / 深色三态（D6，替代原单按钮循环盲切）=====
// 语义不变：显式选择写 localStorage 的 theme（原值仍为 light/dark，新增 auto），
// auto 时删除 data-theme，交回系统 prefers-color-scheme。
const themePref = ref<ThemePref>('auto');

function setTheme(pref: ThemePref): void {
  themePref.value = pref;
  const root = document.documentElement;
  const attr = resolveThemeAttr(pref);
  if (attr) root.dataset.theme = attr;
  else delete root.dataset.theme;
  localStorage.setItem('theme', pref);
}

// run 结束（含后台完成的会话）后刷新侧栏列表：messageCount / 运行中标记随之后更新
let offRunFinished: (() => void) | null = null;
// 跨标签页广播反注册（Task-20261021-002-07）
let offTab: (() => void) | null = null;

onMounted(() => {
  const saved = localStorage.getItem('theme');
  // 仅显式 light/dark 才写 data-theme；'auto' 或未设置 → 交回系统 prefers-color-scheme
  if (saved === 'light' || saved === 'dark') setTheme(saved);
  document.addEventListener('pointerdown', onDocPointerDown);
  // 侧栏是全局组件，数据加载不能依赖 ChatView 挂载：
  // 否则停留在 #/mcp、#/models 等管理页（服务重启后刷新常停在上次路由）时列表恒为空
  void loadSessions();
  offRunFinished = onRunFinished(() => void loadSessions());
  // 他页派生状态同步（Task-20261021-002-07）：只做「唤醒 + 对齐」，内容以服务端为准（方案 D8）
  offTab = onTab((m) => {
    switch (m.t) {
      case 'run-started':
        handleRemoteRunStarted(m.id);
        break;
      case 'run-finished':
        handleRemoteRunFinished(m.id);
        break;
      case 'unread-cleared':
        markReadRemote(m.id);
        break;
      case 'session-dropped':
        drop(m.id);
        break;
    }
    void loadSessions(); // 侧栏运行点/未读点/列表随广播事件即时刷新
  });
});

onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocPointerDown);
  offRunFinished?.();
  offRunFinished = null;
  offTab?.();
  offTab = null;
});
</script>

<template>
  <div class="app">
    <aside class="nav">
      <div class="logo"><span class="dot">L</span><span class="name">Loop Agent</span></div>
      <button class="new-chat" title="新建会话" @click="requestNewChat">
        <span class="ico">＋</span><span class="lbl">新建对话</span>
      </button>
      <div class="sess-list">
        <div class="sess-filter">
          <span class="ico">🔍</span>
          <input v-model="sessKw" type="text" placeholder="搜索会话 / 工作空间" />
        </div>
        <div
          v-for="w in filteredGroups"
          :key="w.id"
          class="ws-group"
          :class="{ collapsed: collapsedWs.has(w.id) }"
        >
          <div class="ws-head" :title="w.path" @click="toggleWs(w.id)">
            <span class="arrow">▼</span>
            <span class="dot" :style="{ background: wsColor(w.name) }"></span>
            <span class="nm">{{ w.name }}</span>
            <span class="cnt">{{ w.sessions.length }}</span>
          </div>
          <div
            v-for="s in w.sessions"
            :key="s.id"
            class="sess"
            :class="{ active: s.id === activeId }"
            @click="clickSession(s.id)"
          >
            <div class="t">
              <div class="n">
                <span
                  v-if="isRunning(s.id) || s.running"
                  class="run-dot"
                  title="运行中"
                ></span>
                <span v-else-if="s.lastRun?.status === 'interrupted'" class="warn-mark" title="上次运行被中断（服务已重启）">⚠</span>
                <span v-else-if="isUnread(s.id)" class="unread-dot" title="已完成，有未读内容"></span>
                {{ s.title || '新会话' }}
              </div>
              <div class="s">{{ s.messageCount }} 条 · {{ fmtTime(s.updatedAt) }}</div>
            </div>
            <button
              class="del"
              :class="{ armed: delArmedId === s.id }"
              :title="delArmedId === s.id ? '再次点击确认删除' : '删除会话'"
              @click.stop="onDelSession(s)"
            >
              {{ delArmedId === s.id ? '确认？' : '🗑' }}
            </button>
          </div>
        </div>
        <div v-if="filteredGroups.length === 0" class="sess-empty">
          {{ sessKw.trim() ? '无匹配会话' : '暂无会话' }}
        </div>
      </div>
      <div class="nav-bottom">
        <!-- 向上浮层面板：覆盖在会话列表之上，不占布局高度（D1/D3/D5）；收起时 visibility:hidden 使其不可聚焦 -->
        <div
          id="nav-mgr-panel"
          ref="panelEl"
          class="panel"
          :class="{ open: panelOpen }"
          role="menu"
          aria-label="设置与管理"
          @keydown="onPanelKey"
        >
          <template v-for="g in ADMIN_GROUPS" :key="g.cap">
            <div class="p-cap">{{ g.cap }}</div>
            <div class="p-grid">
              <a
                v-for="item in g.items"
                :key="item.path"
                class="p-item"
                role="menuitem"
                :href="item.path"
                :title="item.label"
                :aria-current="currentPath === item.path ? 'page' : undefined"
                @click="onPick"
              >
                <span class="ico" v-html="navIconSvg(item.icon)"></span>
                <!-- 单列后每行 187px，直接显示全称（双列时代此处是 short） -->
                <span class="txt">{{ item.label }}</span>
              </a>
            </div>
          </template>
          <div class="p-appear">
            <span class="pa-lbl">外观</span>
            <div class="seg" role="group" aria-label="外观主题">
              <button
                v-for="m in APPEAR_MODES"
                :key="m.v"
                type="button"
                :aria-pressed="themePref === m.v"
                @click="setTheme(m.v)"
              >
                {{ m.label }}
              </button>
            </div>
          </div>
        </div>
        <button
          ref="entryEl"
          class="entry"
          :aria-expanded="panelOpen"
          aria-haspopup="menu"
          aria-controls="nav-mgr-panel"
          :title="panelOpen ? '收起设置与管理' : '展开设置与管理'"
          @click="togglePanel"
          @keydown="onEntryKey"
        >
          <span class="ico" v-html="navIconSvg('sliders')"></span>
          <span class="lbl">{{ MENU_LABEL }}</span>
          <span class="cur">{{ currentLabel }}</span>
          <span class="caret" v-html="navIconSvg('caret', 1.8)"></span>
        </button>
      </div>
    </aside>
    <main class="main">
      <component :is="currentView" />
    </main>
  </div>
  <TokenGate />
  <Toast />
</template>
