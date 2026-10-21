<script setup lang="ts">
// 流式阶段状态行：思考中 / 生成工具参数 / 工具执行中
// 内部自带 500ms 时钟：即使长时间没有 SSE 事件到达，耗时也会继续走，避免看起来像卡死。
// 文案与 CLI（src/agent/logger.ts）保持一致。
import { computed, onUnmounted, ref } from 'vue';

type LivePhase =
  | { kind: 'thinking'; iteration?: number; since: number }
  | { kind: 'arg_gen'; tool: string; bytes: number; since: number }
  | { kind: 'tool_run'; tool: string; elapsedMs: number; since: number };

const props = defineProps<{ live: LivePhase | null; lastEventAt?: number }>();

const MAX_TOOL_LABEL = 24;
/** 超过该时长没有收到任何 SSE 事件时追加提示 */
const STALL_MS = 15000;

const now = ref(Date.now());
const timer = setInterval(() => {
  now.value = Date.now();
}, 500);
onUnmounted(() => clearInterval(timer));

function shortName(n: string): string {
  return n.length > MAX_TOOL_LABEL ? `${n.slice(0, MAX_TOOL_LABEL - 1)}…` : n;
}

function secs(ms: number): string {
  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

const text = computed(() => {
  const l = props.live;
  if (!l) return '';
  if (l.kind === 'thinking') {
    const head =
      l.iteration != null && l.iteration > 0 ? `思考中…（第 ${l.iteration} 轮）` : '思考中…';
    return `${head} · ${secs(now.value - l.since)}`;
  }
  if (l.kind === 'arg_gen') {
    const size = l.bytes < 1024 ? `${l.bytes}B` : `${(l.bytes / 1024).toFixed(1)}KB`;
    return `生成参数：${shortName(l.tool)}…（${size} / ${secs(now.value - l.since)}）`;
  }
  // 执行期以服务端心跳的 elapsedMs 为准，本地时钟兜底
  const elapsed = Math.max(l.elapsedMs, now.value - l.since);
  return `执行中：${shortName(l.tool)}…（${secs(elapsed)}）`;
});

const stalled = computed(() => {
  const t = props.lastEventAt;
  return props.live !== null && t !== undefined && now.value - t > STALL_MS;
});
</script>

<template>
  <div v-if="live" class="live-status">
    <span class="ls-spin"></span>
    <span class="ls-text">{{ text }}</span>
    <span v-if="stalled" class="ls-hint">（模型仍在响应…）</span>
  </div>
</template>

<style scoped>
.live-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--muted);
}
.ls-spin {
  width: 12px;
  height: 12px;
  flex: none;
  border: 2px solid var(--muted);
  border-top-color: transparent;
  border-radius: 50%;
  animation: ls-rotate 0.8s linear infinite;
}
@keyframes ls-rotate {
  to {
    transform: rotate(360deg);
  }
}
.ls-text {
  font-variant-numeric: tabular-nums;
}
.ls-hint {
  color: var(--muted);
  opacity: 0.8;
}
</style>
