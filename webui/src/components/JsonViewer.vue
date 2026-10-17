<script setup lang="ts">
// JSON 折叠查看器（§3.6 错误边界）：大 JSON 默认收起
import { computed } from 'vue';

const props = defineProps<{
  value: unknown;
  label?: string;
  open?: boolean;
}>();

const text = computed<string>(() => {
  try {
    return JSON.stringify(props.value, null, 2);
  } catch {
    return String(props.value);
  }
});

const size = computed(() => text.value.length);
</script>

<template>
  <details class="jv" :open="open">
    <summary>{{ label ?? 'JSON' }} <span class="muted">（{{ size }} 字符）</span></summary>
    <pre>{{ text }}</pre>
  </details>
</template>
