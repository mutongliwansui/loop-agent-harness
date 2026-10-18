<script setup lang="ts">
// 应用壳：左侧菜单（logo + 新建对话 + 会话列表 + 底部管理分组，主题切换并入管理）+ 右侧视图（hash 路由见 router.ts）
// 结构对齐原型-20261018-001：会话列表并入左侧菜单（搜索过滤 + 工作空间分组 + 删除二次确认），
// 原独立会话侧栏取消；管理 7 项 + 主题默认收起，主题跟随系统、手动选择经 localStorage 记忆
import { onMounted, ref, watch } from 'vue';
import { adminItems, currentPath, currentView } from './router';
import {
  sessKw,
  activeId,
  delArmedId,
  chatStreaming,
  filteredGroups,
  collapsedWs,
  wsColor,
  fmtTime,
  toggleWs,
  clickSession,
  onDelSession,
  requestNewChat,
} from './sessions';
import TokenGate from './components/TokenGate.vue';
import Toast from './components/Toast.vue';

// 管理分组默认收起；位于管理页时自动展开（否则活动项不可见）
const mgrpOpen = ref(currentPath.value !== '#/chat');
watch(currentPath, (p) => {
  if (p !== '#/chat') mgrpOpen.value = true;
});

function toggleTheme(): void {
  const root = document.documentElement;
  const cur = root.dataset.theme
    ? root.dataset.theme
    : matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  localStorage.setItem('theme', next);
}

onMounted(() => {
  const saved = localStorage.getItem('theme');
  if (saved === 'dark' || saved === 'light') document.documentElement.dataset.theme = saved;
});
</script>

<template>
  <div class="app">
    <aside class="nav">
      <div class="logo"><span class="dot">L</span><span class="name">Loop Agent</span></div>
      <button class="new-chat" :disabled="chatStreaming" title="新建会话" @click="requestNewChat">
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
            <span v-if="w.current" class="cur">当前</span>
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
              <div class="n">{{ s.title || '新会话' }}</div>
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
        <div class="grp" :class="{ open: mgrpOpen }">
          <div class="grp-head" title="展开 / 收起管理菜单" @click="mgrpOpen = !mgrpOpen">
            <span class="ico">🗂️</span><span class="lbl">管理</span><span class="arrow">▸</span>
          </div>
          <div class="grp-body">
            <a
              v-for="item in adminItems"
              :key="item.path"
              :href="item.path"
              :class="{ active: currentPath === item.path }"
            >
              <span class="ico">{{ item.icon }}</span><span class="lbl">{{ item.label }}</span>
            </a>
            <button class="theme-item" title="切换深浅色" @click="toggleTheme">
              <span class="ico">🌗</span><span class="lbl">主题</span>
            </button>
          </div>
        </div>
      </div>
    </aside>
    <main class="main">
      <component :is="currentView" />
    </main>
  </div>
  <TokenGate />
  <Toast />
</template>
