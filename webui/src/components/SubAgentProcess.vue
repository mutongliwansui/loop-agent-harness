<script setup lang="ts">
// 子 Agent 过程区（需求 20261107-003）：默认收起，展开逐轮查看。
// 同步 delegate 卡片与后台结果卡片共用；数据整形与文案在 subagent-process.ts（纯函数可单测）。
import { computed, ref } from 'vue';
import {
  fmtSecs,
  groupProcessIterations,
  processFinal,
  processMeta,
  type ProcessStatus,
  type ProcessTrace,
} from '../subagent-process.js';

const props = defineProps<{
  trace: ProcessTrace;
  /** 卡片级状态（后台结果卡片的中断态覆盖 trace.status） */
  status?: ProcessStatus;
  /** 卡片总耗时；缺省用 trace.startedAt 现算 */
  elapsedMs?: number;
  /** 结论文本回退（后台结果卡片用 info.answer） */
  answer?: string;
  /** 失败原因（后台结果卡片用 info.error） */
  error?: string;
  defaultOpen?: boolean;
}>();

const open = ref(props.defaultOpen === true);
const thinkOpen = ref<Record<string, boolean>>({});
const toolOpen = ref<Record<string, boolean>>({});

const effectiveStatus = computed<ProcessStatus>(
  () => (props.status ?? (props.trace.status as ProcessStatus)),
);
const iterations = computed(() => groupProcessIterations(props.trace, effectiveStatus.value));
const meta = computed(() => processMeta(props.trace, props.elapsedMs));
const finalText = computed(() => processFinal(props.trace, props.answer));
const hasContent = computed(() => {
  const t = props.trace;
  return t.think.length > 0 || t.tools.length > 0 || !!finalText.value;
});

function toggleTool(key: string): void {
  toolOpen.value = { ...toolOpen.value, [key]: !toolOpen.value[key] };
}
function toggleThink(key: string): void {
  thinkOpen.value = { ...thinkOpen.value, [key]: !thinkOpen.value[key] };
}
</script>

<template>
  <div class="sproc" :class="{ open }">
    <button type="button" class="sproc-h" :aria-expanded="open" @click.stop="open = !open">
      <span class="sproc-chev" :class="{ open }">›</span>
      <span class="sproc-t">子 Agent 过程</span>
      <span class="sproc-meta">{{ meta }}</span>
      <span class="sproc-act">{{ open ? '收起过程' : '展开过程' }}</span>
    </button>

    <div v-if="open" class="sproc-body">
      <div v-if="!hasContent" class="sproc-empty">暂无过程事件</div>

      <template v-for="iter in iterations" :key="iter.n">
        <div v-if="iter.think.length || iter.tools.length" class="sproc-iter">第 {{ iter.n }} 轮</div>

        <div v-for="th in iter.think" :key="th.key" class="sproc-think">
          <span class="sproc-think-bar"></span>
          <div class="sproc-think-wrap">
            <div class="sproc-think-txt" :class="{ expanded: thinkOpen[th.key] }">{{ th.text }}</div>
            <button
              v-if="th.long"
              type="button"
              class="sproc-more"
              @click.stop="toggleThink(th.key)"
            >
              {{ thinkOpen[th.key] ? '收起思考' : '展开思考' }}
            </button>
          </div>
        </div>

        <div v-for="tl in iter.tools" :key="tl.key" class="sproc-tool-block">
          <button
            type="button"
            class="sproc-row"
            :data-state="tl.state"
            :data-expandable="tl.result ? 'true' : 'false'"
            @click.stop="tl.result && toggleTool(tl.key)"
          >
            <span class="sproc-dot"></span>
            <!-- eslint-disable-next-line vue/no-v-html — 图标为内置 SVG 常量，非用户输入 -->
            <span class="sproc-ico" v-html="tl.iconSvg"></span>
            <span class="sproc-name">{{ tl.zh }}</span>
            <span class="sproc-brief">{{ tl.brief }}</span>
            <span v-if="tl.elapsedMs != null" class="sproc-ms">{{ fmtSecs(tl.elapsedMs) }}</span>
            <span v-if="tl.result" class="sproc-chev" :class="{ open: toolOpen[tl.key] }">›</span>
          </button>
          <div v-if="toolOpen[tl.key]" class="sproc-out">{{ tl.result || '（无输出）' }}</div>
        </div>
      </template>

      <div v-if="finalText" class="sproc-final">
        <div class="sproc-final-h">结论</div>
        <div class="sproc-final-t">{{ finalText }}</div>
      </div>
      <div v-else-if="effectiveStatus === 'failed' && error" class="sproc-error">{{ error }}</div>
      <div v-if="effectiveStatus === 'interrupted'" class="sproc-note">进程重启，后台子任务未完成</div>
      <div v-else-if="effectiveStatus === 'aborted'" class="sproc-note">已取消</div>
    </div>
  </div>
</template>

<style scoped>
.sproc {
  margin: 4px 0 9px;
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  background: var(--code-bg);
  overflow: hidden;
}
.sproc-h {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 5px 9px;
  background: transparent;
  border: 0;
  cursor: pointer;
  text-align: left;
}
.sproc-h:hover { background: var(--hover); }
.sproc-chev { flex: none; color: var(--muted); transition: transform 0.15s; font-size: 12px; }
.sproc-chev.open { transform: rotate(90deg); }
.sproc-t { flex: none; font-size: 11.5px; font-weight: 600; color: var(--text); }
.sproc-meta {
  flex: none;
  font: 11px/1 var(--mono);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.sproc-act { margin-left: auto; flex: none; font-size: 11.5px; color: var(--brand); }
.sproc-body { padding: 2px 9px 9px; border-top: 1px solid var(--line-soft); }
.sproc-empty { padding: 6px 0; font-size: 11.5px; color: var(--muted); }

.sproc-iter {
  margin: 7px 0 3px;
  font: 500 10.5px/1.4 var(--mono);
  color: var(--muted);
  letter-spacing: 0.04em;
}

.sproc-think { display: flex; gap: 8px; margin: 3px 0 6px; }
.sproc-think-bar { flex: none; width: 2px; border-radius: 2px; background: var(--line-strong); }
.sproc-think-wrap { flex: 1 1 auto; min-width: 0; }
.sproc-think-txt {
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.sproc-think-txt.expanded { display: block; }
.sproc-more {
  margin-top: 2px;
  padding: 0;
  background: none;
  border: 0;
  font: inherit;
  font-size: 11px;
  color: var(--brand);
  cursor: pointer;
}
.sproc-more:hover { text-decoration: underline; }

.sproc-tool-block { min-width: 0; }
.sproc-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 4px 5px;
  background: transparent;
  border: 0;
  border-radius: 6px;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}
.sproc-row[data-expandable='false'] { cursor: default; }
.sproc-row:hover { background: var(--hover); }
.sproc-dot { flex: none; width: 5px; height: 5px; border-radius: 50%; background: var(--ok); }
.sproc-row[data-state='fail'] .sproc-dot { background: var(--danger); }
.sproc-row[data-state='run'] .sproc-dot { background: var(--warn); animation: sproc-pulse 1.1s infinite; }
@keyframes sproc-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}
.sproc-ico { flex: none; display: grid; place-items: center; width: 17px; height: 17px; color: var(--muted); }
.sproc-ico :deep(svg) { width: 15px; height: 15px; }
.sproc-name { flex: none; font-size: 12px; font-weight: 500; color: var(--text); }
.sproc-brief {
  flex: 1 1 auto;
  min-width: 0;
  font: 11.5px/1.5 var(--mono);
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sproc-ms { flex: none; font: 10.5px/1 var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.sproc-row .sproc-chev { font-size: 12px; }
.sproc-out {
  margin: 3px 0 7px 49px;
  padding: 7px 9px;
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  background: var(--panel);
  font: 11.5px/1.55 var(--mono);
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 168px;
  overflow: auto;
}

.sproc-final { margin-top: 8px; padding: 9px 10px; border: 1px solid var(--line-soft); border-radius: 7px; background: var(--panel); }
.sproc-final-h { margin-bottom: 4px; font-size: 11px; font-weight: 600; color: var(--muted); letter-spacing: 0.04em; }
.sproc-final-t {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow: auto;
}
.sproc-error {
  margin-top: 8px;
  padding: 9px 10px;
  border: 1px solid var(--danger);
  border-radius: 7px;
  background: var(--danger-weak);
  font-size: 12.5px;
  color: var(--danger);
  white-space: pre-wrap;
  word-break: break-word;
}
.sproc-note {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px dashed var(--line-strong);
  border-radius: 7px;
  font-size: 12px;
  color: var(--muted);
}

@media (max-width: 720px) {
  .sproc-meta { display: none; }
  .sproc-out { margin-left: 0; }
}
</style>
