<script setup lang="ts">
// 危险操作按钮（D6 动词即确认）：首次点击进入 armed 态（红底「确认…？」），2.6s 未再点自动复位
import { onBeforeUnmount, ref } from 'vue';

const props = defineProps<{
  label?: string;
  armedLabel?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ confirm: [] }>();

const armed = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

function onClick(): void {
  if (props.disabled) return;
  clearTimeout(timer);
  if (armed.value) {
    armed.value = false;
    emit('confirm');
    return;
  }
  armed.value = true;
  timer = setTimeout(() => { armed.value = false; }, 2600);
}

onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <button
    class="confirm-btn"
    :class="{ armed }"
    :disabled="disabled"
    @click="onClick"
  >{{ armed ? (armedLabel ?? '确认执行？') : (label ?? '删除') }}</button>
</template>
