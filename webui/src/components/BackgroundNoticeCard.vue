<script setup lang="ts">
// 后台任务完成通知卡片（需求 20261105-001 D5/D6/D7）
// 一次性系统通知（非任务详情卡）：无轮询、无停止按钮；日志默认折叠。
import { computed, ref } from 'vue';
import { formatDuration } from '../background-task-card.js';
import { noticeLabel, noticeTone, type BackgroundNoticeInfo } from '../background-notice.js';

const props = defineProps<{ info: BackgroundNoticeInfo }>();

const expanded = ref(false);
const tone = computed(() => noticeTone(props.info));
const label = computed(() => noticeLabel(props.info));
const duration = computed(() =>
  props.info.durationSec != null ? formatDuration(props.info.durationSec * 1000) : '',
);
</script>

<template>
  <div class="bnc" :class="tone">
    <div class="bnc-head">
      <svg class="bnc-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
        <path d="M8 2a4.5 4.5 0 0 0-4.5 4.5v2.6L2 12h12l-1.5-2.9V6.5A4.5 4.5 0 0 0 8 2Z" />
        <path d="M6.4 14a1.7 1.7 0 0 0 3.2 0" />
      </svg>
      <span class="bnc-tag">后台任务</span>
      <span class="pill" :class="tone">{{ label }}</span>
      <span v-if="duration" class="bnc-dur">⏱ {{ duration }}</span>
    </div>
    <div v-if="info.command" class="bnc-cmd" :title="info.command">{{ info.command }}</div>
    <template v-if="info.logTail">
      <button type="button" class="bnc-log-toggle" :class="{ open: expanded }" @click="expanded = !expanded">
        <span class="caret">▸</span>{{ expanded ? '收起日志' : `查看日志尾部（${info.logLines} 行）` }}
      </button>
      <pre v-if="expanded" class="bnc-log">{{ info.logTail }}</pre>
    </template>
  </div>
</template>

<style scoped>
.bnc {
  width: 100%;
  max-width: 640px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--ok);
  border-radius: var(--radius-card);
  background: var(--panel);
  padding: 8px 12px;
}
.bnc.warn { border-left-color: var(--warn); }
.bnc.danger { border-left-color: var(--danger); }
.bnc.dim { border-left-color: var(--line-strong); }

.bnc-head { display: flex; align-items: center; gap: 8px; font-size: 13px; flex-wrap: wrap; }
.bnc-ico { flex: none; width: 15px; height: 15px; color: var(--muted); }
.bnc-tag { color: var(--muted); font-size: 12px; }
.bnc-dur { margin-left: auto; color: var(--muted); font-family: var(--mono); font-size: 12px; }

.pill { flex: none; font-size: 11px; line-height: 1; padding: 3px 8px; border-radius: 999px; border: 1px solid; }
.pill.ok { color: var(--ok); background: var(--ok-weak); border-color: var(--ok); }
.pill.warn { color: var(--warn); background: var(--warn-weak); border-color: var(--warn); }
.pill.danger { color: var(--danger); background: var(--danger-weak); border-color: var(--danger); }
.pill.dim { color: var(--muted); background: transparent; border-color: var(--line-strong); }

.bnc-cmd {
  margin-top: 4px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bnc-log-toggle {
  margin-top: 6px;
  font: inherit;
  font-size: 12px;
  color: var(--brand);
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.bnc-log-toggle:hover { text-decoration: underline; }
.bnc-log-toggle .caret { transition: transform 0.15s; }
.bnc-log-toggle.open .caret { transform: rotate(90deg); }

.bnc-log {
  margin: 6px 0 0;
  padding: 8px 10px;
  background: var(--code-bg);
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow: auto;
}

@media (max-width: 720px) {
  .bnc-dur { margin-left: 0; width: 100%; }
}
</style>
