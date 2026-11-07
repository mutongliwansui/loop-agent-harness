<script setup lang="ts">
// 后台子任务结果卡片（需求 20261107-002 D8）
// 展示专用消息（kind='subagent_result'）：完成时由服务端主动落盘，不进入 LLM 历史。
import { computed, ref } from 'vue';
import type { SubAgentResultVM } from '../chat-stream.js';
import SubAgentProcess from './SubAgentProcess.vue';

const props = defineProps<{ info: SubAgentResultVM }>();

const expanded = ref(false);
const tone = computed(() => {
  switch (props.info.status) {
    case 'failed':
      return 'danger';
    case 'aborted':
    case 'interrupted':
    case 'running':
      return 'dim';
    default:
      return 'ok';
  }
});
const label = computed(() => {
  switch (props.info.status) {
    case 'failed':
      return '失败';
    case 'aborted':
      return '已取消';
    case 'interrupted':
      return '已中断';
    case 'running':
      return '运行中';
    default:
      return '完成';
  }
});
const duration = computed(() => `${Math.round(props.info.elapsedMs / 1000)}s`);
const text = computed(() => {
  if (props.info.status === 'running') return '任务执行中…';
  return props.info.answer || props.info.error || '（空结果）';
});
const long = computed(() => text.value.split('\n').length > 8 || text.value.length > 500);
</script>

<template>
  <div class="sarc" :class="tone">
    <div class="sarc-head">
      <svg class="sarc-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
        <circle cx="8" cy="8" r="5.2" />
        <path d="M5.6 8.3l1.7 1.7L10.6 6.6" />
      </svg>
      <span class="sarc-tag">后台子任务</span>
      <span class="pill" :class="tone">{{ label }}</span>
      <span class="sarc-id">{{ info.taskId }}</span>
      <span class="sarc-dur">⏱ {{ duration }} · {{ info.iterations }} 轮</span>
    </div>
    <div v-if="info.task" class="sarc-task" :title="info.task">{{ info.task }}</div>
    <!-- 过程区（20261107-003）：刷新后从 m.sub 恢复；有轨迹时结论由过程区承载 -->
    <SubAgentProcess
      v-if="info.trace"
      :trace="info.trace"
      :status="info.status"
      :elapsed-ms="info.elapsedMs"
      :answer="info.answer"
      :error="info.error"
    />
    <pre v-else class="sarc-body" :class="{ big: expanded }">{{ text }}</pre>
    <button v-if="!info.trace && long" type="button" class="sarc-more" @click="expanded = !expanded">
      {{ expanded ? '收起结论' : '展开全部结论' }}
    </button>
  </div>
</template>

<style scoped>
.sarc {
  width: 100%;
  max-width: 680px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--ok);
  border-radius: var(--radius-card);
  background: var(--panel);
  padding: 8px 12px;
}
.sarc.danger { border-left-color: var(--danger); }
.sarc.dim { border-left-color: var(--line-strong); }

.sarc-head { display: flex; align-items: center; gap: 8px; font-size: 13px; flex-wrap: wrap; }
.sarc-ico { flex: none; width: 15px; height: 15px; color: var(--muted); }
.sarc-tag { color: var(--muted); font-size: 12px; }
.sarc-id { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.sarc-dur { margin-left: auto; color: var(--muted); font-family: var(--mono); font-size: 12px; }

.pill { flex: none; font-size: 11px; line-height: 1; padding: 3px 8px; border-radius: 999px; border: 1px solid; }
.pill.ok { color: var(--ok); background: var(--ok-weak); border-color: var(--ok); }
.pill.danger { color: var(--danger); background: var(--danger-weak); border-color: var(--danger); }
.pill.dim { color: var(--muted); background: transparent; border-color: var(--line-strong); }

.sarc-task {
  margin-top: 4px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sarc-body {
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
.sarc-body.big { max-height: 460px; }

.sarc-more {
  margin-top: 6px;
  font: inherit;
  font-size: 12px;
  color: var(--brand);
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
}
.sarc-more:hover { text-decoration: underline; }

@media (max-width: 720px) {
  .sarc-dur { margin-left: 0; width: 100%; }
}
</style>
