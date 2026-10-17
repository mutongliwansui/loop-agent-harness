<script setup lang="ts">
// 状态徽章（§3.3 复用组件）：ok/warn/err/brand/dim 五种色调
defineProps<{ kind?: 'ok' | 'warn' | 'err' | 'brand' | 'dim' }>();
</script>

<template>
  <span class="badge" :class="kind ?? 'dim'"><slot /></span>
</template>
