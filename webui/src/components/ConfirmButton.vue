<script setup lang="ts">
// 危险操作按钮（D6 动词即确认）：首次点击进入 armed 态（红底「确认…？」），2.6s 未再点自动复位
// 需求 20261029-004：新增默认作用域插槽（暴露 armed），使图标按钮也能复用同一套确认语义；
// 不传插槽内容时渲染行为与旧版逐字节一致（默认内容即原 label / armedLabel 文本）。
import { onBeforeUnmount, ref } from 'vue';

const props = defineProps<{
  label?: string;
  armedLabel?: string;
  disabled?: boolean;
  /** 悬停提示（未进入 armed 态时） */
  title?: string;
  /** 进入 armed 态后的悬停提示，缺省沿用 title */
  armedTitle?: string;
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
    :title="armed ? (armedTitle ?? title) : title"
    @click="onClick"
  ><slot :armed="armed">{{ armed ? (armedLabel ?? '确认执行？') : (label ?? '删除') }}</slot></button>
</template>
