<script setup lang="ts">
// 应用壳：左侧导航 + 右侧视图（hash 路由见 router.ts）+ Token 门 + Toast
import { navItems, currentPath, currentView } from './router';
import TokenGate from './components/TokenGate.vue';
import Toast from './components/Toast.vue';
</script>

<template>
  <div class="app">
    <aside class="nav">
      <div class="logo"><span class="dot">L</span><span>loop-agent</span></div>
      <a
        v-for="item in navItems"
        :key="item.path"
        :href="item.path"
        :class="{ active: currentPath === item.path }"
      >
        <span class="ico">{{ item.icon }}</span><span>{{ item.label }}</span>
      </a>
    </aside>
    <main class="main">
      <component :is="currentView" />
    </main>
  </div>
  <TokenGate />
  <Toast />
</template>
