<script setup lang="ts">
// ConfirmDialog：通用二次确认框（需求 20261106-005 D11/D13）
// 用途：手动压缩、中间轮次重试等破坏性操作的确认；Esc / 点遮罩 = 取消，执行中（busy）不可关闭。
import { onUnmounted, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
    busy?: boolean;
  }>(),
  { confirmText: '确定', cancelText: '取消', danger: false, busy: false },
);

const emit = defineEmits<{ cancel: []; confirm: [] }>();

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || props.busy) return;
  e.preventDefault();
  emit('cancel');
}

watch(
  () => props.open,
  (open) => {
    if (typeof window === 'undefined') return;
    if (open) window.addEventListener('keydown', onKeydown);
    else window.removeEventListener('keydown', onKeydown);
  },
  { immediate: true },
);

onUnmounted(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div v-if="open" class="cd-mask" @click.self="!busy && emit('cancel')">
    <div class="cd-card" role="dialog" aria-modal="true" :aria-label="title">
      <div class="cd-head">
        <b>{{ title }}</b>
      </div>
      <p class="cd-msg">{{ message }}</p>
      <div class="cd-foot">
        <button class="cd-btn cancel" :disabled="busy" @click="emit('cancel')">
          {{ cancelText }}
        </button>
        <button
          class="cd-btn confirm"
          :class="{ danger }"
          :disabled="busy"
          @click="emit('confirm')"
        >
          <span v-if="busy" class="cd-spin"></span>
          {{ busy ? '处理中…' : confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cd-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.42);
}
.cd-card {
  width: min(420px, calc(100vw - 40px));
  background: var(--panel);
  color: var(--fg, inherit);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
  padding: 18px 20px 16px;
}
.cd-head b {
  font-size: 15px;
}
.cd-msg {
  margin: 10px 0 18px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--muted);
  white-space: pre-wrap;
}
.cd-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.cd-btn {
  padding: 7px 16px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
}
.cd-btn:hover:not(:disabled) {
  color: var(--fg, inherit);
  border-color: var(--brand);
}
.cd-btn.confirm {
  border-color: var(--brand);
  background: var(--brand);
  color: #fff;
}
.cd-btn.confirm.danger {
  border-color: var(--danger);
  background: var(--danger);
  color: #fff;
}
.cd-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.cd-spin {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 6px;
  vertical-align: -2px;
  border: 1.6px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: cd-spin 0.8s linear infinite;
}
@keyframes cd-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
