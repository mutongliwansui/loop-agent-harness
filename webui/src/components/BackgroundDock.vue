<script setup lang="ts">
// 后台任务常驻指示器（需求 20261112-006：命令任务 + 后台子 Agent 任务统一展示）
//
// 原为「后台子任务常驻指示器」（需求 20261107-008 G1）。统一的读模型上线后，
// 数据源改为 /sessions/:id/jobs 轮询快照（jobsOf），一次覆盖两类任务；
// 不依赖 SSE——主 run 结束、SSE 关闭后依然有效。
//
// 展示规则：
// - 收起态用「#序号 + 实时耗时」chips + 聚合耗时；
// - 展开行以任务标题为主，kind 徽标区分「命令 / 子任务」；
// - 命令任务可停止（canStop），子任务本期不提供停止；
// - 失败行附一行错误摘要。
import { computed, onUnmounted, ref, watch } from 'vue';
import { jobsOf, type JobTaskVM } from '../chat-stream.js';
import {
  dockChips,
  dockErrorLine,
  dockOverflow,
  dockShortTitle,
  dockStatusLabel,
  dockTaskElapsed,
  dockTaskTitle,
  dockTotalElapsed,
  formatDockElapsed,
} from '../subagent-dock.js';
import { api } from '../api/client.js';
import { showToast } from '../toast.js';

const props = defineProps<{ sessionId: string | null }>();

const expanded = ref(false);
/** 实时耗时刷新（每秒）：仅在有运行中任务时走表，避免空转 */
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

const tasks = computed<JobTaskVM[]>(() => jobsOf(props.sessionId));
const running = computed(() => tasks.value.filter((t) => t.status === 'running'));
const done = computed(() => tasks.value.filter((t) => t.status !== 'running'));

/** 有运行中任务才显示；已完成的任务在时间线里有结果卡片，这里只在展开时列出 */
const visible = computed(() => running.value.length > 0);

const chips = computed(() => dockChips(running.value, now.value));
const overflow = computed(() => dockOverflow(running.value.length));
/** 单任务时在 chip 里补一个任务短名，宽屏才显示（窄屏由 CSS 隐藏） */
const shortName = computed(() =>
  running.value.length === 1 ? dockShortTitle(running.value[0].task) : '',
);
const totalText = computed(() => formatDockElapsed(dockTotalElapsed(running.value, now.value)));
/** 展开列表：运行中在前，终态在后 */
const rows = computed(() => [...running.value, ...done.value]);

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

function elapsedOf(t: SubAgentTaskVM): string {
  return formatDockElapsed(dockTaskElapsed(t, now.value));
}

async function copyId(taskId: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(taskId);
    showToast('任务 ID 已复制', 'success');
  } catch {
    showToast('复制失败：需 https 或 localhost 环境', 'error');
  }
}

/** 停止命令任务（子任务 canStop=false，不渲染按钮） */
async function stopTask(t: JobTaskVM): Promise<void> {
  if (t.stopping) return;
  t.stopping = true;
  try {
    await api(`/background/${encodeURIComponent(t.taskId)}/stop`, { method: 'POST' });
    showToast(`已请求停止 ${t.taskId}`, 'success');
  } catch (e) {
    showToast(e instanceof Error ? e.message : '停止失败', 'error');
  } finally {
    t.stopping = false;
  }
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
      <!-- 图标徽标：与 ToolCard 的图标同形制，运行状态由右下角呼吸点表达 -->
      <span class="sad-ico" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M5.1 2.7h2.1a1.4 1.4 0 1 1 1.7 0h2a.6.6 0 0 1 .6.6v2.1a1.4 1.4 0 1 0 0 1.7v2.1a.6.6 0 0 1-.6.6H8.9a1.4 1.4 0 1 0-1.7 0H5.1a.6.6 0 0 1-.6-.6V7.1a1.4 1.4 0 1 0 0-1.7V3.3a.6.6 0 0 1 .6-.6z" />
        </svg>
      </span>
      <span class="sad-title">后台任务</span>
      <span class="sad-count">{{ running.length }} 运行中</span>

      <span class="sad-chips">
        <span v-for="c in chips" :key="c.taskId" class="sad-chip" :title="c.title">
          <i class="sad-cd" aria-hidden="true"></i>
          <span class="sad-cn">#{{ c.index }}</span>
          <span class="sad-ct">{{ c.elapsed }}</span>
        </span>
        <span v-if="shortName" class="sad-chip more sad-short" :title="dockTaskTitle(running[0].task)">
          {{ shortName }}
        </span>
        <span v-if="overflow > 0" class="sad-chip more">+{{ overflow }}</span>
      </span>

      <span class="sad-total">共 {{ totalText }}</span>
      <svg class="sad-chev" :class="{ open: expanded }" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
        <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
    </button>

    <ul v-if="expanded" class="sad-list">
      <li v-for="(t, i) in rows" :key="t.taskId" class="sad-row" :data-s="t.status">
        <i class="sad-dot" aria-hidden="true"></i>
        <div class="sad-main">
          <div class="sad-line">
            <span class="sad-n">#{{ i + 1 }}</span>
            <span class="sad-kind" :data-k="t.kind">{{ t.kind === 'command' ? '命令' : '子任务' }}</span>
            <span class="sad-task" :title="dockTaskTitle(t.task)">{{ dockTaskTitle(t.task) }}</span>
          </div>
          <div class="sad-meta">
            <span class="sad-m">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <circle cx="8" cy="8" r="5.4" /><path d="M8 4.9V8l2.2 1.4" />
              </svg>
              {{ elapsedOf(t) }}
            </span>
            <span v-if="t.iterations" class="sad-m">{{ t.iterations }} 轮</span>
            <button
              type="button"
              class="sad-id"
              :title="`复制任务 ID：${t.taskId}`"
              @click.stop="copyId(t.taskId)"
            >
              {{ t.taskId }}
            </button>
            <button
              v-if="t.canStop"
              type="button"
              class="sad-stop"
              :disabled="t.stopping"
              title="停止该后台命令任务"
              @click.stop="stopTask(t)"
            >
              {{ t.stopping ? '停止中…' : '停止' }}
            </button>
          </div>
          <div v-if="t.status === 'failed' && dockErrorLine(t.error)" class="sad-err">
            {{ dockErrorLine(t.error) }}
          </div>
        </div>
        <span class="sad-st">{{ dockStatusLabel(t.status) }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.sad {
  position: relative;
  margin: 0 auto 8px;
  width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--panel);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
  overflow: hidden;
}

/* 顶部 2px 呼吸线：表达「仍在跑」；不做假进度百分比（后端没有总步数） */
.sad::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--brand), transparent);
  background-size: 40% 100%;
  opacity: 0.5;
  animation: sad-slide 1.8s ease-in-out infinite;
}
@keyframes sad-slide {
  0% { background-position: -40% 0; }
  100% { background-position: 140% 0; }
}

.sad-head {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 12px 8px 10px;
  font: inherit;
  font-size: 12.5px;
  color: var(--text);
  background: none;
  border: 0;
  cursor: pointer;
  text-align: left;
}
.sad-head:hover { background: var(--hover); }
.sad-head:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }

/* 图标徽标（24×24 / 6px 圆角 / 与 ToolCard 同形制） + 右下角呼吸点 */
.sad-ico {
  position: relative;
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  background: var(--bg);
  border: 1px solid var(--line-soft, var(--line));
  color: var(--muted);
}
.sad-ico svg { width: 14px; height: 14px; }
.sad-ico::after {
  content: '';
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--brand);
  box-shadow: 0 0 0 2px var(--panel);
  animation: sad-pulse 1.5s ease-in-out infinite;
}
@keyframes sad-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.sad-title { flex: none; font-size: 12.5px; font-weight: 600; color: var(--text); }
.sad-count {
  flex: none;
  font-size: 11px;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 999px;
  color: var(--brand);
  background: var(--brand-weak);
  border: 1px solid var(--line);
  font-variant-numeric: tabular-nums;
}

.sad-chips {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
}
.sad-chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--line-soft, var(--line));
  background: var(--code-bg);
  font-size: 11px;
  color: var(--text-2);
}
.sad-cd {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--brand);
  animation: sad-pulse 1.5s infinite;
}
.sad-cn { font-family: var(--mono); font-weight: 600; font-size: 10.5px; color: var(--muted); }
.sad-ct { font-family: var(--mono); font-size: 11px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.sad-chip.more { color: var(--muted); border-style: dashed; }
.sad-short { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.sad-total { flex: none; font-family: var(--mono); font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.sad-chev { flex: none; color: var(--muted); transition: transform 0.18s; }
.sad-chev.open { transform: rotate(180deg); }

.sad-list {
  margin: 0;
  padding: 2px 10px 8px;
  list-style: none;
  border-top: 1px solid var(--line-soft, var(--line));
}

.sad-row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 7px 4px;
  border-bottom: 1px solid var(--line-soft, var(--line));
}
.sad-row:last-child { border-bottom: 0; }

/* 状态点位：运行中呼吸，终态静态；颜色只作用于点位与状态词 */
.sad-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-top: 6px;
  background: var(--muted);
}
.sad-row[data-s='running'] .sad-dot { background: var(--brand); animation: sad-pulse 1.5s infinite; }
.sad-row[data-s='done'] .sad-dot { background: var(--ok); }
.sad-row[data-s='failed'] .sad-dot { background: var(--danger); }
.sad-row[data-s='aborted'] .sad-dot,
.sad-row[data-s='interrupted'] .sad-dot { background: var(--line-strong); }

.sad-main { flex: 1; min-width: 0; }
.sad-line { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.sad-n { flex: none; font-family: var(--mono); font-weight: 600; font-size: 10.5px; color: var(--muted); }
/* 任务类型徽标：命令 / 子任务 */
.sad-kind {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10px;
  line-height: 16px;
  color: var(--text-2);
  background: var(--code-bg);
  border: 1px solid var(--line-soft, var(--line));
}
.sad-kind[data-k='subagent'] { color: var(--brand); background: var(--brand-weak); }
.sad-task {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-word;
}

.sad-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--muted);
}
.sad-m { display: inline-flex; align-items: center; gap: 4px; font-variant-numeric: tabular-nums; }
.sad-m svg { width: 11px; height: 11px; opacity: 0.8; }
.sad-id {
  padding: 0;
  border: 0;
  background: none;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--muted);
  opacity: 0.75;
  cursor: pointer;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sad-id:hover { opacity: 1; text-decoration: underline; }

/* 停止按钮：仅命令任务出现，弱化成链接样式，避免抢状态词视觉 */
.sad-stop {
  padding: 0;
  border: 0;
  background: none;
  font-size: 10.5px;
  color: var(--danger);
  cursor: pointer;
}
.sad-stop:hover { text-decoration: underline; }
.sad-stop:disabled { opacity: .5; cursor: not-allowed; text-decoration: none; }

.sad-st { flex: none; align-self: center; font-size: 11px; color: var(--muted); }
.sad-row[data-s='running'] .sad-st { color: var(--brand); }
.sad-row[data-s='failed'] .sad-st { color: var(--danger); }

.sad-err {
  margin-top: 2px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--danger);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  word-break: break-word;
}

/* 窄屏：保留图标 / 标题 / 计数 / 聚合耗时 / chevron，chips 整体隐藏 */
@media (max-width: 720px) {
  .sad-chips { display: none; }
  .sad-task { -webkit-line-clamp: 3; }
}
/* 单任务短名需要额外横向空间，窄屏（<480px）隐藏 */
@media (max-width: 480px) {
  .sad-short { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .sad::before,
  .sad-ico::after,
  .sad-cd,
  .sad-row[data-s='running'] .sad-dot { animation: none; }
}
</style>
