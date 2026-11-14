<!--
  后台任务卡片（需求 20261104-005）
  ------------------------------------------------------------------
  设计定稿：docs/prototypes/2026-11-04/原型-20261104-005+后台任务卡片.html
  - 头部：图标 + 命令（单行截断，title 全文）+ 停止（二次确认）
  - 摘要：状态 pill / 耗时 / 退出码 / 日志大小
  - 日志：默认收起，展开拉最后 20 行 / 2KB；运行中每 2s 刷新（页面隐藏 15s）
  - 终态停止轮询；404 转「记录已清理」dim 态
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api, ApiError } from '../api/client.js';
import {
  formatBytes,
  formatDuration,
  isActive,
  pollDelay,
  statusLabel,
  statusTone,
} from '../background-task-card.js';
import ConfirmButton from './ConfirmButton.vue';

interface TaskInitial {
  status: string;
  exitCode?: number | null;
  startedAt?: number;
  finishedAt?: number | null;
}

interface TaskSnapshot {
  taskId: string;
  command: string;
  status: string;
  exitCode?: number | null;
  startedAt: number;
  finishedAt?: number | null;
  durationMs: number;
  logSize: number;
}

interface LogResponse {
  taskId: string;
  tail: string;
  size: number;
  truncated: boolean;
  cleaned: boolean;
}

const props = defineProps<{ taskId: string; command: string; initial?: TaskInitial }>();

const status = ref(props.initial?.status ?? 'running');
const exitCode = ref<number | null>(props.initial?.exitCode ?? null);
const startedAt = ref(props.initial?.startedAt ?? Date.now());
const finishedAt = ref<number | null>(props.initial?.finishedAt ?? null);
const logSize = ref(0);
const expanded = ref(isActive(props.initial?.status ?? 'running'));
const logTail = ref('');
const logLoading = ref(false);
const logTruncated = ref(false);
const cleaned = ref(false);
const missing = ref(false);
const error = ref('');
const stopping = ref(false);
const now = ref(Date.now());
const hidden = ref(document.hidden);

let pollTimer: ReturnType<typeof setTimeout> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;

const tone = computed(() => statusTone(status.value, exitCode.value));
const label = computed(() => statusLabel(status.value, exitCode.value));
const active = computed(() => isActive(status.value) && !missing.value);
const durationMs = computed(() =>
  (finishedAt.value ?? now.value) - startedAt.value,
);

function clearTimers(): void {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = undefined; }
  if (tickTimer) { clearInterval(tickTimer); tickTimer = undefined; }
}

function schedule(): void {
  if (pollTimer) clearTimeout(pollTimer);
  const delay = pollDelay(status.value, document.hidden);
  if (delay <= 0) return;
  pollTimer = setTimeout(() => { void refresh(); }, delay);
}

function startTicker(): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => { now.value = Date.now(); }, 1000);
}

function applySnapshot(s: TaskSnapshot): void {
  status.value = s.status;
  exitCode.value = s.exitCode ?? null;
  startedAt.value = s.startedAt;
  finishedAt.value = s.finishedAt ?? null;
  logSize.value = s.logSize;
  missing.value = false;
  if (isActive(s.status)) startTicker();
}

async function refresh(): Promise<void> {
  if (document.hidden && !active.value) return;
  try {
    const s = await api<TaskSnapshot>(`/background/${encodeURIComponent(props.taskId)}`);
    applySnapshot(s);
    if (expanded.value && !cleaned.value) await fetchLog();
    error.value = '';
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      // 任务/日志被清理：转 dim 态并停止轮询（3.4）
      missing.value = true;
      cleaned.value = true;
      clearTimers();
      return;
    }
    // 网络抖动：保留现有状态，下一轮继续
  }
  schedule();
}

async function fetchLog(): Promise<void> {
  logLoading.value = true;
  try {
    const r = await api<LogResponse>(
      `/background/${encodeURIComponent(props.taskId)}/logs?tail=1`,
    );
    logTail.value = r.tail;
    logSize.value = r.size;
    logTruncated.value = r.truncated;
    cleaned.value = r.cleaned;
    await scrollToBottom();
  } catch {
    /* 读日志失败不改变卡片状态 */
  } finally {
    logLoading.value = false;
  }
}

const logEl = ref<HTMLElement | null>(null);
async function scrollToBottom(): Promise<void> {
  await Promise.resolve();
  const el = logEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

async function toggleLog(): Promise<void> {
  expanded.value = !expanded.value;
  if (expanded.value && !logTail.value && !cleaned.value) await fetchLog();
}

async function stop(): Promise<void> {
  stopping.value = true;
  error.value = '';
  try {
    await api(`/background/${encodeURIComponent(props.taskId)}/stop`, { method: 'POST' });
    status.value = 'killed';
    finishedAt.value = Date.now();
    await refresh();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '停止失败，请重试';
    stopping.value = false;
  }
}

function onVisibility(): void {
  hidden.value = document.hidden;
  if (!document.hidden) void refresh();
  else schedule();
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility);
  if (status.value === 'running' || status.value === 'orphaned-running') {
    startTicker();
    void refresh();
  } else {
    // 历史卡：仅静态渲染，不主动补拉（D8）
    if (props.initial?.startedAt && props.initial?.finishedAt) {
      logSize.value = 0;
    }
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility);
  clearTimers();
});

// 初始状态为运行中时，展开日志并立刻拉一次尾部
watch(expanded, (open) => { if (open && !logTail.value && !cleaned.value) void fetchLog(); });
</script>

<template>
  <div class="bgc" :data-tone="tone">
    <div class="bgc-top">
      <span class="bgc-ico" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
          <rect x="2" y="3" width="12" height="10" rx="1.6" />
          <path d="M4.4 6.2 6.4 8l-2 1.8M8.2 9.8h3.2" />
        </svg>
      </span>
      <span class="bgc-cmd" :title="command">{{ command || taskId }}</span>
      <span class="bgc-actions">
        <ConfirmButton
          v-if="active && !missing"
          class="stop-btn"
          label="停止"
          armed-label="确认停止？"
          :disabled="stopping"
          title="停止该后台任务（二次确认）"
          @confirm="stop"
        />
        <span class="bgc-id" :title="taskId">{{ taskId }}</span>
      </span>
    </div>

    <div class="bgc-meta">
      <span class="pill" :class="tone"><span class="dot"></span>{{ missing ? '记录已清理' : label }}</span>
      <span class="kv">耗时 <b>{{ formatDuration(durationMs) }}</b></span>
      <span v-if="exitCode !== null" class="kv">退出码 <b>{{ exitCode }}</b></span>
      <span class="kv">日志 <b>{{ formatBytes(logSize) }}</b></span>
      <span class="bgc-spacer"></span>
      <button
        v-if="!cleaned && !missing"
        type="button"
        class="link-btn"
        :aria-expanded="expanded"
        @click="toggleLog"
      >
        {{ expanded ? '收起日志' : '展开日志' }}
      </button>
    </div>

    <p v-if="error" class="bgc-err">{{ error }}</p>

    <div v-if="cleaned || missing" class="bgc-empty">该任务日志已按保留策略清理，仅保留状态记录</div>
    <div v-else-if="expanded" class="bgc-log">
      <div class="bgc-log-head">
        <span>最后 20 行 · tail 2KB<template v-if="logTruncated">（已截断）</template></span>
        <span class="spacer"></span>
        <span>{{ active ? (hidden ? '页面隐藏，15s 刷新' : '每 2s 刷新') : logLoading ? '加载中…' : '已停止刷新' }}</span>
      </div>
      <pre ref="logEl" class="bgc-log-body">{{ logTail || (logLoading ? '读取中…' : '(无输出)') }}</pre>
    </div>
  </div>
</template>

<style scoped>
.bgc { display: grid; gap: 8px; }
.bgc-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.bgc-ico { flex: none; display: grid; place-items: center; color: var(--text-2); }
.bgc-ico svg { width: 15px; height: 15px; }
.bgc-cmd {
  flex: 1 1 auto;
  min-width: 0;
  font: 12px/1.5 ui-monospace, Consolas, monospace;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bgc-actions { flex: none; display: flex; align-items: center; gap: 6px; }
.bgc-id {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 10.5px/1.4 ui-monospace, Consolas, monospace;
  color: var(--muted);
}
.stop-btn { font-size: 11.5px; padding: 2px 8px; }

.bgc-meta { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; font-size: 12px; color: var(--muted); }
.kv b { color: var(--text-2); font-weight: 600; font-variant-numeric: tabular-nums; }
.bgc-spacer { flex: 1 1 auto; }
.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  font: 600 11.5px/1.5 ui-monospace, Consolas, monospace;
}
.pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pill.run { color: var(--brand); background: var(--brand-weak); border-color: var(--brand); }
.pill.run .dot { animation: bgc-pulse 1.4s ease-in-out infinite; }
.pill.ok { color: var(--ok); background: var(--ok-weak); border-color: var(--ok); }
.pill.warn { color: var(--warn); background: var(--warn-weak); border-color: var(--warn); }
.pill.danger { color: var(--danger); background: var(--danger-weak); border-color: var(--danger); }
.pill.dim { color: var(--muted); background: transparent; border-color: var(--line-strong); }
@keyframes bgc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }

.link-btn {
  border: 0;
  background: transparent;
  color: var(--brand);
  font-size: 11.5px;
  cursor: pointer;
  padding: 0;
}
.link-btn:hover { text-decoration: underline; }

.bgc-log { border: 1px solid var(--line-soft); border-radius: 8px; overflow: hidden; }
.bgc-log-head {
  display: flex;
  gap: 8px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--muted);
  border-bottom: 1px solid var(--line-soft);
}
.bgc-log-head .spacer { flex: 1; }
.bgc-log-body {
  margin: 0;
  padding: 8px;
  max-height: 190px;
  overflow: auto;
  background: var(--code-bg);
  font: 11.5px/1.55 ui-monospace, Consolas, monospace;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
.bgc-empty {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--code-bg);
  color: var(--muted);
  font-size: 11.5px;
}
.bgc-err { margin: 0; color: var(--danger); font-size: 11.5px; }

@media (max-width: 720px) {
  .bgc-top { flex-wrap: wrap; }
  .bgc-cmd { flex: 1 0 100%; white-space: normal; }
  .bgc-actions { order: 3; margin-left: auto; }
}
</style>
