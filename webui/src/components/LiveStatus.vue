<script setup lang="ts">
// 流式阶段状态行：思考中 / 生成工具参数 / 工具执行中
// 内部自带 500ms 时钟：即使长时间没有 SSE 事件到达，耗时也会继续走，避免看起来像卡死。
// Task-20261022-001：工具名映射为中文（tool-meta），运行态附带摘要短语（live.brief，chat-stream 预计算）。
import { computed, onUnmounted, ref } from 'vue';
import { toolDisplay } from '../tool-meta.js';
import { metaRev } from '../mcp-tool-meta-loader.js';

type LivePhase =
  | { kind: 'thinking'; iteration?: number; since: number }
  | { kind: 'arg_gen'; tool: string; bytes: number; since: number }
  | { kind: 'tool_run'; tool: string; elapsedMs: number; since: number; brief?: string };

const props = defineProps<{ live: LivePhase | null; lastEventAt?: number }>();

/** 摘要短语在状态行内的最大长度 */
const BRIEF_MAX = 48;
/** 超过该时长没有收到任何 SSE 事件时追加提示 */
const STALL_MS = 15000;

const now = ref(Date.now());
const timer = setInterval(() => {
  now.value = Date.now();
}, 500);
onUnmounted(() => clearInterval(timer));

function shortText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function secs(ms: number): string {
  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

const text = computed(() => {
  void metaRev.value; // 20261104-001：MCP 元信息非响应式，需显式依赖才能显示中文名
  const l = props.live;
  if (!l) return '';
  if (l.kind === 'thinking') {
    const head =
      l.iteration != null && l.iteration > 0 ? `思考中…（第 ${l.iteration} 轮）` : '思考中…';
    return `${head} · ${secs(now.value - l.since)}`;
  }
  if (l.kind === 'arg_gen') {
    const size = l.bytes < 1024 ? `${l.bytes}B` : `${(l.bytes / 1024).toFixed(1)}KB`;
    return `生成参数：${toolDisplay(l.tool).name}…（${size} / ${secs(now.value - l.since)}）`;
  }
  // 执行期以服务端心跳的 elapsedMs 为准，本地时钟兜底；brief 为 chat-stream 预计算的摘要短语
  const elapsed = Math.max(l.elapsedMs, now.value - l.since);
  const brief = l.brief ? ` ${shortText(l.brief, BRIEF_MAX)}` : '';
  return `执行中：${toolDisplay(l.tool).name}${brief}…（${secs(elapsed)}）`;
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
