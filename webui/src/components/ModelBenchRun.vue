<script setup lang="ts">
// 详情抽屉内联测速（需求 20261111-001 · 对齐原型 D6「测速在抽屉内闭环」）
//
// 只跑单个模型、固定标准档位（3 轮 × 2 提示词 · max 256），运行中展示进度与四项实时指标；
// 完成/失败后由父级重新拉历史，结果直接回流到抽屉的「性能」区与卡片 pill。
// 端点与 BenchDrawer 一致：POST /models/bench → GET /models/bench/:id/stream → POST /models/bench/:id/stop
import { computed, onBeforeUnmount, ref } from 'vue';
import { api } from '../api/client';
import { sseGet } from '../api/sse';
import { showToast } from '../toast';
import { errText } from '../utils';
import { fmtMs, fmtTps, promptLabel, pulseBars } from '../bench-format';

const props = defineProps<{
  /** 被测模型别名 */
  alias: string;
}>();
const emit = defineEmits<{ (e: 'finished'): void }>();

const running = ref(false);
const completedRounds = ref(0);
const planTotal = ref(0);
const currentPrompt = ref('short');
const liveTokens = ref(0);
const liveTtft = ref<number | null>(null);
const liveElapsed = ref(0);
const intervals = ref<number[]>([]);
const lastElapsed = ref(0);
const roundStartedAt = ref(0);

let runId: string | null = null;
let abortCtl: AbortController | null = null;
let tickTimer: number | null = null;

const progressPct = computed(() =>
  planTotal.value > 0 ? Math.min(100, (completedRounds.value / planTotal.value) * 100) : 0,
);
const liveTps = computed(() =>
  liveElapsed.value > 0 && liveTokens.value > 0 ? liveTokens.value / (liveElapsed.value / 1000) : null,
);
const pulse = computed(() => pulseBars(intervals.value, 480, 46));
const liveWait = computed(() => liveTtft.value === null);

function stopTick(): void {
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

function startTick(): void {
  stopTick();
  tickTimer = window.setInterval(() => {
    if (roundStartedAt.value > 0) liveElapsed.value = Date.now() - roundStartedAt.value;
  }, 100);
}

function resetLive(): void {
  liveTokens.value = 0;
  liveTtft.value = null;
  liveElapsed.value = 0;
  intervals.value = [];
  lastElapsed.value = 0;
  roundStartedAt.value = 0;
}

function onEvent(ev: { event: string; data: unknown }): void {
  const d = ev.data as Record<string, unknown>;
  switch (ev.event) {
    case 'start':
      planTotal.value = Number(d.planTotal ?? 0);
      break;
    case 'round_start':
      currentPrompt.value = String(d.prompt ?? 'short');
      resetLive();
      roundStartedAt.value = Date.now();
      break;
    case 'first_token':
      liveTtft.value = Number(d.ms ?? 0);
      break;
    case 'token': {
      const el = Number(d.elapsedMs ?? 0);
      liveTokens.value = Number(d.outTokens ?? 0);
      liveElapsed.value = el;
      if (el >= lastElapsed.value) intervals.value = [...intervals.value, el - lastElapsed.value];
      lastElapsed.value = el;
      break;
    }
    case 'round_end':
      completedRounds.value += 1;
      break;
    default:
      break;
  }
}

/** 按标准档位开跑；运行中重复调用直接忽略 */
async function start(): Promise<void> {
  if (running.value) return;
  running.value = true;
  completedRounds.value = 0;
  planTotal.value = 0;
  resetLive();
  startTick();
  try {
    const res = await api<{ runId: string; plan: { planTotal: number } }>('/models/bench', {
      method: 'POST',
      json: {
        aliases: [props.alias],
        tier: 'standard',
        prompts: ['short', 'medium'],
        rounds: 3,
        maxTokens: 256,
        timeoutMs: 60_000,
        bustCache: true,
      },
    });
    runId = res.runId;
    planTotal.value = res.plan.planTotal;
    abortCtl = new AbortController();
    await sseGet(`/models/bench/${res.runId}/stream`, onEvent, abortCtl.signal);
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) {
      showToast(`测速失败：${errText(e)}`, 'error');
    }
  } finally {
    abortCtl = null;
    runId = null;
    stopTick();
    running.value = false;
    emit('finished');
  }
}

/** 中断：服务端收到 stop 后结束流，finally 统一收尾 */
async function stop(): Promise<void> {
  if (!runId) return;
  try {
    await api(`/models/bench/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
  } catch (e) {
    showToast(`中断失败：${errText(e)}`, 'error');
  }
}

onBeforeUnmount(() => {
  stopTick();
  abortCtl?.abort();
});

defineExpose({ start, stop });
</script>

<template>
  <div v-if="running" class="mv-run">
    <div class="prog-head">
      <span>
        正在测速 · 第 {{ Math.min(completedRounds + 1, planTotal || 1) }} / {{ planTotal || '?' }} 轮 ·
        {{ promptLabel(currentPrompt) }}
      </span>
      <span class="spacer"></span>
      <button class="mv-btn sm danger" @click="stop">中断</button>
    </div>
    <div class="prog-track">
      <div class="prog-bar" :style="{ width: progressPct + '%' }"></div>
    </div>
    <div class="live-grid">
      <div class="live-cell" :class="liveWait ? 'wait' : 'hit'">
        <div class="k">{{ liveWait ? '等待首 token' : '首 token' }}</div>
        <div class="v">{{ liveWait ? '—' : fmtMs(liveTtft) }}</div>
      </div>
      <div class="live-cell">
        <div class="k">已生成</div>
        <div class="v">{{ liveTokens }} tok</div>
      </div>
      <div class="live-cell">
        <div class="k">当前速度</div>
        <div class="v">{{ fmtTps(liveTps) }}</div>
      </div>
      <div class="live-cell">
        <div class="k">已用时</div>
        <div class="v">{{ (liveElapsed / 1000).toFixed(1) }}s</div>
      </div>
    </div>
    <div class="pulse-box">
      <div class="cap">token 到达节奏（每根竖条 = 一个非空 chunk，间隔越匀越顺）</div>
      <svg class="pulse" viewBox="0 0 480 46" preserveAspectRatio="none">
        <rect
          v-for="(b, i) in pulse"
          :key="i"
          :x="b.x"
          :y="b.y"
          :width="b.w"
          :height="b.h"
          rx="1"
          fill="var(--brand)"
        />
      </svg>
    </div>
    <p class="cfg-hint">每轮注入随机 nonce 破坏前缀缓存，避免多轮平均被缓存命中率污染。</p>
  </div>
</template>
