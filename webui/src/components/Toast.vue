<script setup lang="ts">
// 全局 Toast 容器：渲染 toasts 队列（fixed 右下角）
import { toasts } from '../toast';
</script>

<template>
  <div class="toast-box">
    <TransitionGroup name="toast">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-box {
  position: fixed;
  right: 16px;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 1000;
  max-width: 380px;
}
.toast {
  padding: 9px 14px;
  border-radius: 10px;
  background: var(--panel);
  border: 1px solid var(--line);
  box-shadow: 0 6px 20px rgb(0 0 0 / 12%);
  word-break: break-all;
}
.toast.success { border-color: var(--brand); color: var(--brand); }
.toast.error { border-color: var(--danger); color: var(--danger); }
.toast-enter-active, .toast-leave-active { transition: all 0.25s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(8px); }
</style>
