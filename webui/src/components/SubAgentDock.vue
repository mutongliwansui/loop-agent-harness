<script setup lang="ts">
// 后台子任务常驻指示器（需求 20261107-008 G1）
//
// 为什么需要它：后台任务状态原本只存在于消息流的卡片里，滚走、切页、刷新后就看不见了，
// 用户反馈「提交后前台完全无感知、结束也不知道」。本组件常驻在输入区上方，
// 数据源是轮询快照（subAgentTasksOf），**不依赖 SSE**——主 run 结束、SSE 关闭后依然有效。
import { computed, onUnmounted, ref, watch } from 'vue';
import { subAgentTasksOf, type SubAgentTaskVM } from '../chat-stream.js';

const props = defineProps<{ sessionId: string | null }>();

const expanded = ref(false);
/** 实时耗时刷新（每秒）：仅在有运行中任务时走表，避免空转 */
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

const tasks = computed<SubAgentTaskVM[]>(() => subAgentTasksOf(props.sessionId));
const running = computed(() => tasks.value.filter((t) => t.status === 'running'));
const done = computed(() => tasks.value.filter((t) => t.status !== 'running'));

/** 有运行中任务才显示；已完成的任务在时间线里有结果卡片，这里只在展开时列出 */
const visible = computed(() => running.value.length > 0);

watch(
  () => running.value.length > 0,
  (on) => {
    if (on && !timer) {
      timer = setInterval(() => {
        now.value = Date.now();
      }, 1000);
    } else if (!on && timer) {
      clearInterval(timer);
      timer = null;
      if (expanded.value) expanded.value = false;
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  if (timer) clearInterval(timer);
  timer = null;
});

function elapsed(t: SubAgentTaskVM): string {
  const ms = t.status === 'running' ? now.value - (t.startedAt ?? now.value) : (t.elapsedMs ?? 0);
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

function label(t: SubAgentTaskVM): string {
  switch (t.status) {
    case 'running':
      return '运行中';
    case 'done':
      return '完成';
    case 'failed':
      return '失败';
    case 'aborted':
      return '已取消';
    default:
      return '已中断';
  }
}

function tone(t: SubAgentTaskVM): string {
  if (t.status === 'running') return 'run';
  if (t.status === 'failed') return 'bad';
  if (t.status === 'done') return 'ok';
  return 'dim';
}

function brief(s: string): string {
  const one = (s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > 90 ? `${one.slice(0, 90)}…` : one || '（无描述）';
}
</script>

<template>
  <div v-if="visible" class="sad">
    <button
      type="button"
      class="sad-head"
      :aria-expanded="expanded"
      :title="expanded ? '收起任务列表' : '展开任务列表'"
      @click="expanded = !expanded"
    >
      <span class="sad-dot" aria-hidden="true"></span>
      <span class="sad-count">后台子任务运行中 {{ running.length }}</span>
      <span class="sad-sum">
        <span v-for="t in running.slice(0, 2)" :key="t.taskId" class="sad-item-brief">
          {{ brief(t.task) }} · {{ elapsed(t) }}
        </span>
      </span>
      <svg class="sad-chev" :class="{ open: expanded }" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
        <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
    </button>

    <ul v-if="expanded" class="sad-list">
      <li v-for="t in [...running, ...done]" :key="t.taskId" class="sad-row" :class="tone(t)">
        <span class="sad-pill" :class="tone(t)">{{ label(t) }}</span>
        <span class="sad-id">{{ t.taskId }}</span>
        <span class="sad-task" :title="t.task">{{ brief(t.task) }}</span>
        <span class="sad-dur">⏱ {{ elapsed(t) }}<template v-if="t.iterations"> · {{ t.iterations }} 轮</template></span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.sad {
  margin: 0 auto 8px;
  width: 100%;
  max-width: 820px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--brand);
  border-radius: var(--radius-card);
  background: var(--panel);
  overflow: hidden;
}

.sad-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 12px;
  font: inherit;
  font-size: 12.5px;
  color: var(--text);
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
}
.sad-head:hover { background: var(--hover, rgba(127, 127, 127, 0.06)); }

.sad-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--brand);
  animation: sad-pulse 1.4s ease-in-out infinite;
}
@keyframes sad-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.8); }
}

.sad-count { flex: none; font-weight: 600; color: var(--brand); }

.sad-sum {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 12px;
  overflow: hidden;
  white-space: nowrap;
}
.sad-item-brief {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
}
.sad-chev { flex: none; color: var(--muted); transition: transform 0.15s; }
.sad-chev.open { transform: rotate(180deg); }

.sad-list {
  margin: 0;
  padding: 2px 12px 8px;
  list-style: none;
  border-top: 1px solid var(--line-soft);
}
.sad-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: 12px;
  border-bottom: 1px solid var(--line-soft);
}
.sad-row:last-child { border-bottom: none; }

.sad-pill {
  flex: none;
  font-size: 11px;
  line-height: 1;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid;
}
.sad-pill.run { color: var(--brand); border-color: var(--brand); }
.sad-pill.ok { color: var(--ok); border-color: var(--ok); }
.sad-pill.bad { color: var(--danger); border-color: var(--danger); }
.sad-pill.dim { color: var(--muted); border-color: var(--line-strong); }

.sad-id { flex: none; font-family: var(--mono); font-size: 11px; color: var(--muted); }
.sad-task {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sad-dur { flex: none; font-family: var(--mono); font-size: 11px; color: var(--muted); }

@media (max-width: 720px) {
  .sad-sum { display: none; }
}
</style>
