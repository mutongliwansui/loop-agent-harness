<script setup lang="ts">
// 模型性能测试抽屉（需求 20261027-003 / 原型 docs/designs/原型-20261027-003+…html）
//
// 四态：empty（无历史）/ config（配置）/ running（运行中）/ done（含失败大卡）
// 数据来源：
// - POST /models/bench              建 run，202 返回 runId
// - GET  /models/bench/:id/stream   SSE 进度（round_start/first_token/token/round_end/model_done/done）
// - POST /models/bench/:id/stop     中断
// - GET  /models/bench/history      历史（?alias= 取单模型）
//
// 关键约定：
// - 「测速」与「测试」并存：前者发完整流按输出计费，后者只收首块就断（近免费）
// - 服务端串行跑多模型，前端只负责展示，不在浏览器侧计时（浏览器测量会把渲染抖动算进 TTFT）
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../api/client';
import { sseGet } from '../api/sse';
import { showToast } from '../toast';
import { errText } from '../utils';
import StatusBadge from './StatusBadge.vue';
import {
  barPct,
  changePct,
  configSummary,
  dominantError,
  errorLabel,
  estimateTokens,
  fmtMs,
  fmtP,
  fmtPct,
  fmtTps,
  fmtWhen,
  promptLabel,
  pulseBars,
  sortResults,
  sparkPoints,
  successTone,
  tpsTone,
  ttftTone,
  verdictText,
  type BenchHistoryEntryVM,
  type BenchModelResultVM,
  type BenchRunConfigVM,
  type BenchSampleVM,
  type SortKey,
} from '../bench-format';

const props = defineProps<{
  open: boolean;
  /** 从表格行点进来的模型别名 */
  alias: string | null;
  /** 当前可选的模型别名（对比下拉用） */
  aliases: string[];
}>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'finished'): void }>();

type UiState = 'empty' | 'config' | 'running' | 'done' | 'error';
type Tier = 'quick' | 'standard' | 'custom';

const state = ref<UiState>('empty');
const loading = ref(false);

// ---- 配置 ----
const selAliases = ref<string[]>([]);
const tier = ref<Tier>('standard');
const prompts = ref<string[]>(['short', 'medium']);
const rounds = ref(3);
const maxTokens = ref(256);
const timeoutMs = ref(60_000);
const bustCache = ref(true);

// ---- 运行 ----
const runId = ref<string | null>(null);
const completedRounds = ref(0);
const planTotal = ref(0);
const currentPrompt = ref('short');
const currentAlias = ref('');
const roundStartedAt = ref(0);
const nowTick = ref(Date.now());
const liveTokens = ref(0);
const liveTtft = ref<number | null>(null);
const liveElapsed = ref(0);
const intervals = ref<number[]>([]);
const lastElapsed = ref(0);
const results = ref<BenchModelResultVM[]>([]);
const runError = ref<string | null>(null);
const aborted = ref(false);

// ---- 结果 ----
const history = ref<BenchHistoryEntryVM[]>([]);
const sortBy = ref<SortKey>('ttft');
const focusAlias = ref<string>('');
const runConfig = ref<BenchRunConfigVM | null>(null);

let timer: number | null = null;
let abortCtl: AbortController | null = null;

const PROMPT_OPTIONS = [
  { key: 'short', label: '短问答 ~20 字' },
  { key: 'medium', label: '中文写作 ~300 字' },
  { key: 'code', label: '代码改写 ~40 行' },
];

const cfg = computed<BenchRunConfigVM>(() => ({
  ...(tier.value === 'custom' ? {} : { tier: tier.value }),
  prompts: [...prompts.value],
  rounds: rounds.value,
  maxTokens: maxTokens.value,
  bustCache: bustCache.value,
  timeoutMs: timeoutMs.value,
}));

const cfgText = computed(() => configSummary(runConfig.value ?? cfg.value));
const estimate = computed(() => estimateTokens(selAliases.value.length, prompts.value.length, rounds.value, maxTokens.value));
const progressPct = computed(() => (planTotal.value > 0 ? Math.min(100, (completedRounds.value / planTotal.value) * 100) : 0));
const liveTps = computed(() => (liveElapsed.value > 0 && liveTokens.value > 0 ? liveTokens.value / (liveElapsed.value / 1000) : null));
const pulse = computed(() => pulseBars(intervals.value, 480, 46));
const liveWait = computed(() => liveTtft.value === null);

const shownResult = computed<BenchModelResultVM | null>(() => {
  if (results.value.length === 0) return null;
  return results.value.find((r) => r.alias === focusAlias.value) ?? results.value[0];
});
const shownSummary = computed(() => shownResult.value?.summary ?? null);
const errTitle = computed(() => dominantError(shownSummary.value?.errorKinds));
const allFailed = computed(() => state.value === 'error');

const cmpRows = computed(() => {
  const sorted = sortResults(results.value, sortBy.value);
  const first = sorted[0];
  const bestVal = !first
    ? null
    : sortBy.value === 'ttft'
      ? first.summary.ttft.p50
      : first.summary.decodeTps.p50;
  return sorted.map((r) => {
    const v = sortBy.value === 'ttft' ? r.summary.ttft.p50 : r.summary.decodeTps.p50;
    return {
      alias: r.alias,
      pct: barPct(v, bestVal, sortBy.value),
      txt: sortBy.value === 'ttft' ? fmtMs(v) : `${fmtTps(v)} tok/s`,
      best: v !== null && v === bestVal,
    };
  });
});

interface DetailRow extends BenchSampleVM {
  alias: string;
}
const detailRows = computed<DetailRow[]>(() => {
  const rows: DetailRow[] = [];
  for (const r of results.value) {
    for (const s of r.summary.samples ?? []) rows.push({ alias: r.alias, ...s });
  }
  return rows;
});

const historyRows = computed(() =>
  history.value.map((h, i) => {
    const prev = history.value[i + 1];
    const okSamples = (h.summary.samples ?? []).filter((s) => s.ok);
    return {
      key: `${h.runId}-${h.startedAt}`,
      when: fmtWhen(h.startedAt),
      value: fmtMs(h.summary.ttft.p50),
      ttftSpark: sparkPoints(okSamples.map((s) => s.ttftMs ?? 0), 96, 18),
      tpsSpark: sparkPoints(okSamples.map((s) => s.decodeTps ?? 0), 96, 18),
      delta: changePct(prev?.summary.ttft.p50, h.summary.ttft.p50),
      first: i === 0,
    };
  }),
);

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function startTimer(): void {
  stopTimer();
  timer = window.setInterval(() => {
    nowTick.value = Date.now();
    if (roundStartedAt.value > 0) liveElapsed.value = nowTick.value - roundStartedAt.value;
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

function setTier(t: Tier): void {
  tier.value = t;
  if (t === 'quick') {
    prompts.value = ['short'];
    rounds.value = 1;
  } else if (t === 'standard') {
    prompts.value = ['short', 'medium'];
    rounds.value = 3;
  }
}

function togglePrompt(key: string): void {
  if (prompts.value.includes(key)) {
    if (prompts.value.length === 1) {
      showToast('至少保留一个提示词档位', 'error');
      return;
    }
    prompts.value = prompts.value.filter((p) => p !== key);
  } else {
    prompts.value = [...prompts.value, key];
  }
  tier.value = 'custom';
}

function toggleAlias(alias: string): void {
  if (selAliases.value.includes(alias)) {
    if (selAliases.value.length === 1) {
      showToast('至少保留一个被测模型', 'error');
      return;
    }
    selAliases.value = selAliases.value.filter((a) => a !== alias);
  } else {
    if (selAliases.value.length >= 4) {
      showToast('一次最多对比 4 个模型', 'error');
      return;
    }
    selAliases.value = [...selAliases.value, alias];
  }
}

function addAlias(e: Event): void {
  const el = e.target as HTMLSelectElement;
  const v = el.value;
  el.value = '';
  if (v && !selAliases.value.includes(v)) {
    selAliases.value = [...selAliases.value, v];
  }
}

const remainingAliases = computed(() => props.aliases.filter((a) => !selAliases.value.includes(a)));

/** 载入某模型的历史；有记录则直接进完成态（打开抽屉先看到「上次有多快」） */
async function loadHistory(alias: string | null, enterDone: boolean): Promise<void> {
  if (!alias) {
    history.value = [];
    return;
  }
  try {
    const res = await api<{ runs: BenchHistoryEntryVM[] }>(`/models/bench/history?alias=${encodeURIComponent(alias)}&limit=8`);
    history.value = res.runs;
    if (enterDone && res.runs.length > 0 && results.value.length === 0) {
      const latest = res.runs[0];
      runConfig.value = latest.config;
      results.value = [{ alias: latest.alias, model: latest.model, baseUrlHost: latest.baseUrlHost, summary: latest.summary }];
      focusAlias.value = latest.alias;
      state.value = (latest.summary.okCount ?? 0) > 0 ? 'done' : 'error';
    }
  } catch (e) {
    history.value = [];
    showToast(`读取测速历史失败：${errText(e)}`, 'error');
  }
}

async function openFor(alias: string | null): Promise<void> {
  // E2E 实测缺陷修正：这里必须把 state 复位成 empty。否则「关闭抽屉 → 换一个没测过的模型再打开」时
  // state 仍残留上一次的 done/error，而 results 已清空 → 会渲染出一个空的「完成态」（只有折叠条
  // 和 0 行对比），用户看到的是上一个模型的残影，而不是「还没测」。
  state.value = 'empty';
  results.value = [];
  runError.value = null;
  aborted.value = false;
  runConfig.value = null;
  runId.value = null;
  completedRounds.value = 0;
  planTotal.value = 0;
  resetLive();
  selAliases.value = alias ? [alias] : [];
  focusAlias.value = alias ?? '';
  tier.value = 'standard';
  prompts.value = ['short', 'medium'];
  rounds.value = 3;
  maxTokens.value = 256;
  timeoutMs.value = 60_000;
  bustCache.value = true;
  loading.value = true;
  try {
    await loadHistory(alias, true);
    if (state.value !== 'done' && state.value !== 'error') state.value = 'empty';
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void openFor(props.alias);
    else {
      stopTimer();
      abortCtl?.abort();
      abortCtl = null;
    }
  },
  { immediate: true },
);

function close(): void {
  emit('close');
}

function onEvent(ev: { event: string; data: unknown }): void {
  const d = ev.data as Record<string, unknown>;
  switch (ev.event) {
    case 'start':
      planTotal.value = Number(d.planTotal ?? 0);
      break;
    case 'model_start':
      currentAlias.value = String(d.alias ?? '');
      break;
    case 'round_start':
      currentAlias.value = String(d.alias ?? '');
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
    case 'model_done': {
      const r: BenchModelResultVM = {
        alias: String(d.alias ?? ''),
        model: String(d.model ?? ''),
        baseUrlHost: String(d.baseUrlHost ?? ''),
        summary: d.summary as BenchModelResultVM['summary'],
      };
      results.value = [...results.value, r];
      if (!focusAlias.value) focusAlias.value = r.alias;
      break;
    }
    case 'failed':
      runError.value = String(d.error ?? '未知错误');
      break;
    default:
      break;
  }
}

async function start(): Promise<void> {
  if (selAliases.value.length === 0) {
    showToast('请先选择被测模型', 'error');
    return;
  }
  results.value = [];
  runError.value = null;
  aborted.value = false;
  completedRounds.value = 0;
  resetLive();
  runConfig.value = cfg.value;
  state.value = 'running';
  startTimer();
  try {
    const res = await api<{ runId: string; plan: { planTotal: number } }>('/models/bench', {
      method: 'POST',
      json: {
        aliases: selAliases.value,
        ...(tier.value === 'custom' ? {} : { tier: tier.value }),
        prompts: prompts.value,
        rounds: rounds.value,
        maxTokens: maxTokens.value,
        timeoutMs: timeoutMs.value,
        bustCache: bustCache.value,
      },
    });
    runId.value = res.runId;
    planTotal.value = res.plan.planTotal;
    abortCtl = new AbortController();
    await sseGet(`/models/bench/${res.runId}/stream`, onEvent, abortCtl.signal);
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) {
      runError.value = errText(e);
      showToast(`启动测速失败：${errText(e)}`, 'error');
      state.value = 'error';
    }
  } finally {
    abortCtl = null;
    stopTimer();
    finalize();
  }
}

/** 流结束：定态 + 拉历史 + 通知父级刷新「性能」列 */
function finalize(): void {
  if (state.value !== 'running') return;
  const hasOk = results.value.some((r) => (r.summary?.okCount ?? 0) > 0);
  state.value = hasOk ? 'done' : 'error';
  completedRounds.value = planTotal.value;
  const alias = results.value[0]?.alias ?? selAliases.value[0] ?? null;
  void loadHistory(alias, false);
  emit('finished');
}

async function stop(): Promise<void> {
  if (!runId.value) return;
  aborted.value = true;
  try {
    await api(`/models/bench/${encodeURIComponent(runId.value)}/stop`, { method: 'POST' });
  } catch (e) {
    showToast(`中断失败：${errText(e)}`, 'error');
  }
}

function reopenConfig(): void {
  state.value = 'config';
}

function retest(): void {
  void start();
}

function exportJson(): void {
  const payload = { exportedAt: new Date().toISOString(), config: runConfig.value, results: results.value, history: history.value };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bench-${results.value[0]?.alias ?? 'model'}-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function cacheText(s: BenchSampleVM): string {
  if (s.cacheHitTokens === undefined) return '—';
  return `${s.cacheHitTokens}`;
}

onBeforeUnmount(() => {
  stopTimer();
  abortCtl?.abort();
});
</script>

<template>
  <Teleport to="body">
    <div class="drawer-mask" :class="{ open }" @click="close"></div>
    <aside class="drawer" :class="{ open }" aria-label="模型性能测试">
      <div class="drawer-h">
        <span class="t">性能测试</span>
        <StatusBadge kind="dim">POST /models/bench</StatusBadge>
        <span class="spacer"></span>
        <button class="drawer-close" title="关闭" @click="close">✕</button>
      </div>

      <div class="drawer-b">
        <!-- ⓪ 配置摘要条：完成/失败态把配置折叠成一行，结果顶到首屏（原型复验修正点） -->
        <div v-if="state === 'done' || state === 'error'" class="bench-cfgbar">
          <span class="who">{{ shownResult?.alias ?? '—' }} · {{ shownResult?.model ?? '' }}</span>
          <span class="muted">{{ cfgText }}</span>
          <span class="spacer"></span>
          <button @click="reopenConfig">改配置</button>
        </div>

        <!-- ① 配置 -->
        <section v-if="state === 'config'" class="bench-sec bench-config">
          <div class="cfg-row">
            <span class="k">被测模型</span>
            <span class="v">
              <span class="aliases">
                <span
                  v-for="a in selAliases"
                  :key="a"
                  class="alias-chip on"
                  @click="toggleAlias(a)"
                >{{ a }} <span class="x">✕</span></span>
                <select v-if="remainingAliases.length > 0" class="alias-add" style="width:auto" @change="addAlias">
                  <option value="">＋ 加入对比</option>
                  <option v-for="a in remainingAliases" :key="a" :value="a">{{ a }}</option>
                </select>
              </span>
            </span>
          </div>
          <div class="cfg-row">
            <span class="k">档位</span>
            <span class="v">
              <span class="seg">
                <button :class="{ on: tier === 'quick' }" @click="setTier('quick')">快速 · 1 轮</button>
                <button :class="{ on: tier === 'standard' }" @click="setTier('standard')">标准 · 3 轮 × 2</button>
                <button :class="{ on: tier === 'custom' }" @click="tier = 'custom'">自定义</button>
              </span>
            </span>
          </div>
          <div class="cfg-row">
            <span class="k">提示词</span>
            <span class="v">
              <span class="seg">
                <button
                  v-for="p in PROMPT_OPTIONS"
                  :key="p.key"
                  :class="{ on: prompts.includes(p.key) }"
                  @click="togglePrompt(p.key)"
                >{{ p.label }}</button>
              </span>
            </span>
          </div>
          <div class="cfg-row">
            <span class="k">输出上限</span>
            <span class="v">
              <input v-model.number="maxTokens" type="number" min="32" max="1024" style="width:76px" aria-label="max_tokens">
              <span class="muted" style="font-size:12px">tokens · 固定值，保证跨模型可比</span>
            </span>
          </div>
          <div v-if="tier === 'custom'" class="cfg-row">
            <span class="k">轮数</span>
            <span class="v">
              <input v-model.number="rounds" type="number" min="1" max="10" style="width:76px" aria-label="轮数">
              <span class="muted" style="font-size:12px">每档提示词各跑几轮</span>
            </span>
          </div>
          <div class="cfg-row">
            <span class="k">单轮超时</span>
            <span class="v">
              <select v-model.number="timeoutMs" aria-label="超时">
                <option :value="30000">30s</option>
                <option :value="60000">60s</option>
                <option :value="120000">120s</option>
              </select>
              <label style="display:inline-flex;gap:5px;align-items:center;font-size:12.5px;color:var(--muted)">
                <input v-model="bustCache" type="checkbox"> 破坏前缀缓存（每轮随机 nonce）
              </label>
            </span>
          </div>
          <p class="cfg-hint">
            默认注入随机 nonce 前缀：否则第二轮起会命中 provider 前缀缓存，TTFT 被打到 1/10，「多轮平均」就变成缓存命中率测试。
          </p>
          <div class="form-row" style="margin-top:11px">
            <button class="primary" :disabled="loading" @click="start">开始测试</button>
            <button @click="close">取消</button>
            <span class="muted" style="font-size:12px">预计上限 {{ selAliases.length }} × {{ prompts.length }} × {{ rounds }} × {{ maxTokens }} = {{ estimate }} tok</span>
          </div>
        </section>

        <!-- ② 运行中 -->
        <section v-if="state === 'running'" class="bench-sec bench-run">
          <div class="prog-head">
            <span>第 {{ Math.min(completedRounds + 1, planTotal || 1) }} / {{ planTotal || '?' }} 轮 · {{ promptLabel(currentPrompt) }}<span v-if="currentAlias" class="muted"> · {{ currentAlias }}</span></span>
            <span class="spacer"></span>
            <button class="danger" @click="stop">中断</button>
          </div>
          <div class="prog-track"><div class="prog-bar" :style="{ width: progressPct + '%' }"></div></div>
          <div class="live-grid">
            <div class="live-cell" :class="liveWait ? 'wait' : 'hit'">
              <div class="k">{{ liveWait ? '等待首 token' : '首 token' }}</div>
              <div class="v">{{ liveWait ? '—' : fmtMs(liveTtft) }}</div>
            </div>
            <div class="live-cell"><div class="k">已生成</div><div class="v">{{ liveTokens }} tok</div></div>
            <div class="live-cell"><div class="k">当前速度</div><div class="v">{{ fmtTps(liveTps) }}</div></div>
            <div class="live-cell"><div class="k">已用时</div><div class="v">{{ (liveElapsed / 1000).toFixed(1) }}s</div></div>
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
          <p class="cfg-hint">首 token 只认「delta 里有非空内容」的 chunk：空串与只带 usage 的尾块都不计（对齐 vLLM / NVIDIA 口径）。</p>
        </section>

        <!-- ③ 结果 -->
        <section v-if="state === 'done' || state === 'error'" class="bench-result">
          <div class="bench-sec">
            <div v-if="shownSummary?.suspectBuffered" class="notice warn">
              <span>⚠</span>
              <span><b>疑似被网关缓冲</b>：本次 chunk 几乎一次性到达（间隔 ≈ 0），TPS 会虚高，不建议作为选型依据。</span>
            </div>
            <div v-if="errTitle" class="notice info">
              <span>⛔</span>
              <span>
                <b>{{ errTitle.label }}</b>：{{ errTitle.count }} 轮失败（按方案「不重试」，失败即记一轮；成功轮次仍可参考，但样本不足）。
              </span>
            </div>
            <div v-if="runError" class="notice info">
              <span>⛔</span>
              <span><b>运行异常</b>：{{ runError }}</span>
            </div>
          </div>

          <div v-if="results.length > 1" class="bench-sec">
            <div class="h">查看模型<span class="line"></span></div>
            <span class="seg">
              <button
                v-for="r in results"
                :key="r.alias"
                :class="{ on: (shownResult?.alias ?? '') === r.alias }"
                @click="focusAlias = r.alias"
              >{{ r.alias }}</button>
            </span>
          </div>

          <div class="bench-sec">
            <div class="h">
              本轮结论<span class="line"></span>
              <span class="muted" style="text-transform:none;font-weight:400">{{ cfgText }}</span>
            </div>
            <div class="metric-grid">
              <template v-if="!allFailed && shownSummary">
                <div class="metric" :class="ttftTone(shownSummary.ttft.p50) === 'good' ? 'good' : ttftTone(shownSummary.ttft.p50)">
                  <div class="k">TTFT（首 token）</div>
                  <div class="v">
                    {{ Math.round(shownSummary.ttft.p50 ?? 0) }}<span class="unit">ms</span>
                  </div>
                  <div class="s">p90 {{ fmtP(shownSummary.ttft, 'p90') }} · {{ shownSummary.ttft.count }} 轮样本</div>
                </div>
                <div class="metric" :class="tpsTone(shownSummary.decodeTps.p50)">
                  <div class="k">解码吞吐</div>
                  <div class="v">
                    {{ fmtTps(shownSummary.decodeTps.p50) }}<span class="unit">tok/s</span>
                  </div>
                  <div class="s">端到端 {{ fmtTps(shownSummary.e2eTps.p50) }} tok/s · TPOT {{ fmtMs(shownSummary.tpot.p50) }}</div>
                </div>
                <div class="metric" :class="successTone(shownSummary.successRate)">
                  <div class="k">稳定性</div>
                  <div class="v">
                    {{ Math.round(shownSummary.successRate * 100) }}<span class="unit">%</span>
                  </div>
                  <div class="s">ITL p90 {{ fmtMs(shownSummary.itlP90Ms.p50) }} · {{ shownSummary.okCount }}/{{ shownSummary.total }} 轮成功</div>
                </div>
              </template>
              <div v-else class="metric bad">
                <div class="k">测试失败</div>
                <div class="v" style="font-size:16px">{{ errTitle?.label ?? '全部失败' }}</div>
                <div class="s">{{ shownSummary?.okCount ?? 0 }}/{{ shownSummary?.total ?? 0 }} 轮成功 · 见下方明细</div>
              </div>
            </div>
            <p class="cfg-hint">{{ verdictText(shownResult) }}</p>
          </div>

          <div class="bench-sec">
            <div class="h">横向对比<span class="line"></span></div>
            <div class="cmp-head">
              <span class="muted" style="font-size:12px">排序依据</span>
              <span class="seg">
                <button :class="{ on: sortBy === 'ttft' }" @click="sortBy = 'ttft'">TTFT 越短越好</button>
                <button :class="{ on: sortBy === 'tps' }" @click="sortBy = 'tps'">吞吐越高越好</button>
              </span>
            </div>
            <div>
              <div v-for="r in cmpRows" :key="r.alias" class="cmp-row" :class="{ best: r.best }">
                <span class="name" :class="{ me: r.alias === shownResult?.alias }">{{ r.alias }}</span>
                <span class="track"><span class="bar" :style="{ width: r.pct.toFixed(1) + '%' }"></span></span>
                <span class="val">{{ r.txt }}</span>
              </div>
            </div>
            <p class="cfg-hint">对比在服务端串行执行：并行会互相抢带宽，两条流的 TTFT 都不准。</p>
          </div>

          <div class="bench-sec">
            <div class="h">
              每轮明细<span class="line"></span>
              <span class="muted" style="text-transform:none;font-weight:400">GET /models/bench/history</span>
            </div>
            <table class="mini-tbl">
              <thead>
                <tr>
                  <th>轮</th><th>提示词</th><th>TTFT</th><th>TPOT</th><th>解码 TPS</th><th>输出</th><th>缓存</th><th>状态</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(d, i) in detailRows" :key="i">
                  <td>{{ d.round }}</td>
                  <td class="txt">{{ promptLabel(d.prompt) }}</td>
                  <td>{{ fmtMs(d.ttftMs) }}</td>
                  <td>{{ fmtMs(d.tpotMs) }}</td>
                  <td>{{ fmtTps(d.decodeTps) }}</td>
                  <td>{{ d.estimated ? '~' : '' }}{{ d.outTokens ?? '—' }}</td>
                  <td>{{ cacheText(d) }}</td>
                  <td>
                    <StatusBadge v-if="d.ok" kind="ok">ok</StatusBadge>
                    <StatusBadge v-else kind="err" :title="d.error">{{ errorLabel(d.errorKind) }}</StatusBadge>
                  </td>
                </tr>
                <tr v-if="detailRows.length === 0">
                  <td colspan="8" class="muted txt">没有样本</td>
                </tr>
              </tbody>
            </table>
            <p class="cfg-hint">
              输出 token 以 <b>usage.completion_tokens</b> 为权威；服务商不回 usage 时按 chunk 数估算并加 <b>~</b> 前缀，避免跨模型误比。
            </p>
          </div>

          <div class="bench-sec">
            <div class="h">历史（同模型最近 {{ historyRows.length || 8 }} 次）<span class="line"></span></div>
            <div class="hist">
              <div v-for="h in historyRows" :key="h.key" class="row">
                <span class="when">{{ h.when }}</span>
                <span class="n">{{ h.value }}</span>
                <span class="spark">
                  <svg width="96" height="18" viewBox="0 0 96 18">
                    <polyline :points="h.ttftSpark" fill="none" stroke="var(--brand)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />
                  </svg>
                </span>
                <span class="spark">
                  <svg width="96" height="18" viewBox="0 0 96 18">
                    <polyline :points="h.tpsSpark" fill="none" stroke="var(--muted)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />
                  </svg>
                </span>
                <span v-if="h.delta !== null" class="d" :class="h.delta > 0 ? 'up' : 'down'">
                  {{ h.delta > 0 ? '↑' : '↓' }}{{ Math.abs(Math.round(h.delta)) }}%
                </span>
                <span v-else class="d muted">—</span>
              </div>
              <div v-if="historyRows.length === 0" class="muted" style="font-size:12px">暂无历史记录</div>
            </div>
          </div>

          <div class="result-actions">
            <button class="primary" @click="retest">重新测试</button>
            <button @click="exportJson">导出 JSON</button>
            <span class="muted" style="font-size:12px">历史落 ~/.loop-agent/model-bench/history.json（不存 apiKey）</span>
          </div>
        </section>

        <!-- ④ 空态 -->
        <section v-if="state === 'empty'" class="bench-empty">
          <div class="empty-box">
            <div class="ico">⏱</div>
            <div class="t">还没有针对 {{ props.alias ?? '该模型' }} 的性能数据</div>
            <div class="d">
              连通性只告诉你「能不能用」；性能测试才告诉你「有多快、稳不稳」——按当前默认档位（标准 · 3 轮 × 2 提示词 · max 256）跑一次即可。
            </div>
            <button class="primary" @click="start">按默认档位开跑</button>
            <details class="why">
              <summary>为什么默认要「破坏缓存」？</summary>
              <p>
                同一条 prompt 连打多轮会命中 provider 的前缀缓存，第二轮 TTFT 可能只有第一轮的 1/10。混合缓存状态的平均值没有意义，
                所以默认每轮注入随机 nonce，并把 <span class="mono">prompt_cache_hit_tokens</span> 一并记录下来供对照。
              </p>
            </details>
          </div>
        </section>
      </div>
    </aside>
  </Teleport>
</template>
