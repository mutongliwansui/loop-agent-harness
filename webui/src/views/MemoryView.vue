<script setup lang="ts">
// 记忆视图（需求 20261026-004：四标签页重组——定时任务 / L2 情景 / L3 长期 / 检索）
//
// 端点映射：
//   GET /memory/status（未启用恒 200 {enabled:false}）· GET /memory/workspaces（空间下拉）
//   GET /memory/curated[?ws=] · GET /memory/episodic?limit=[&ws=] · GET /memory/search?q=
//   GET /memory/gate · POST /memory/dream · PUT /memory/dream/schedule · GET /memory/dream/preview
//   GET|DELETE /memory/dream/history?scope=all|ws · POST /memory/init
//
// 标签页状态（tab/ws）进 hash query（D1：`#/memory?tab=l2&ws=<id>`），刷新/分享可还原。
// L2 条目头解析与三级筛选在前端进行（D3，见 memory-entries.ts）；
// L3 空间切换只重取工作空间级文件，SOUL/USER 全局区不随动（D9）；
// 检索本期仅启动空间（D10）。
import { computed, onMounted, ref, watch } from 'vue';
import { api, ApiError, AuthError } from '../api/client';
import { showToast } from '../toast';
import { errText } from '../utils';
import { fmtLocal } from '../cron-ui';
import type { DreamRunRecord, DreamStatus } from '../dream-types';
import { currentPath, hashQuery, replaceHashQuery } from '../router';
import {
  filterEntries,
  groupByDay,
  parseDays,
  previewOf,
  sessionIdsOf,
  tagsOf,
  type MemEntry,
} from '../memory-entries';
import JsonViewer from '../components/JsonViewer.vue';
import StatusBadge from '../components/StatusBadge.vue';
import DreamScheduleCard from '../components/DreamScheduleCard.vue';
import DreamHistoryList, { type HistoryRow } from '../components/DreamHistoryList.vue';

// ---------- 共享状态 ----------

interface MemoryStatus {
  enabled: boolean;
  layers: { episodic?: { dir: string }; curated?: { workspace: string; files: Record<string, string> } };
  counts: { episodicDays?: number; gatePending?: number; gateApproved?: number };
  dreaming?: DreamStatus;
}

interface MemWorkspace {
  id: string;
  name: string;
  path: string;
  hasMemory: boolean;
  hasSession: boolean;
}

const TABS = [
  { key: 'sched', label: '定时任务' },
  { key: 'l2', label: 'L2 情景' },
  { key: 'l3', label: 'L3 长期' },
  { key: 'search', label: '检索' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const status = ref<MemoryStatus | null>(null);
const workspaces = ref<MemWorkspace[]>([]);
const busy = ref(false);
const histBusy = ref(false);
const histScope = ref<'all' | 'ws'>('all');
const runs = ref<HistoryRow[]>([]);
const l2TotalAll = ref(0); // 仅用于标签页上的条目计数（启动空间 7 天）

/** 当前激活标签页（hash ?tab= 还原；非法值回落 sched） */
const tab = computed<TabKey>(() => {
  const t = hashQuery.value.get('tab');
  return (TABS.find((x) => x.key === t)?.key ?? 'sched') as TabKey;
});

function setTab(k: TabKey): void {
  replaceHashQuery({ tab: k === 'sched' ? undefined : k });
}

function guard(e: unknown, fallback: string): void {
  if (!(e instanceof AuthError)) showToast(e instanceof ApiError ? e.message : `${fallback}: ${errText(e)}`, 'error');
}

// ---------- 定时任务页（沿用 003 既有能力 + D5/D6 聚合记录） ----------

async function loadHistory(): Promise<void> {
  histBusy.value = true;
  try {
    const qs = histScope.value === 'all' ? '?limit=50&scope=all' : '?limit=20';
    const res = await api<{ runs: HistoryRow[] }>(`/memory/dream/history${qs}`);
    runs.value = res.runs ?? [];
  } catch (e) {
    guard(e, '加载触发记录失败');
  } finally {
    histBusy.value = false;
  }
}

async function clearHistory(): Promise<void> {
  histBusy.value = true;
  try {
    const qs = histScope.value === 'all' ? '?scope=all' : '';
    const res = await api<{ deleted: number }>(`/memory/dream/history${qs}`, { method: 'DELETE' });
    await loadHistory();
    showToast(`已清空 ${res?.deleted ?? 0} 条触发记录${histScope.value === 'all' ? '（全部空间）' : ''}`, 'success');
  } catch (e) {
    guard(e, '清空触发记录失败');
  } finally {
    histBusy.value = false;
  }
}

function setHistScope(s: 'all' | 'ws'): void {
  if (histScope.value === s) return;
  histScope.value = s;
  replaceHashQuery({ histScope: s === 'all' ? undefined : s });
  void loadHistory();
}

async function dream(): Promise<void> {
  busy.value = true;
  try {
    const res = await api<{ accepted?: boolean; skippedBecause?: string }>('/memory/dream', { method: 'POST' });
    // Task-20261026-002 D11：已有晋升在跑时服务端回 accepted:false（仍 202）
    if (res && res.accepted === false) {
      showToast(`已有晋升在进行中（${res.skippedBecause ?? 'already-running'}），本次请求已忽略`, 'error');
    } else {
      showToast('已受理：记忆整理（dream）在后台异步执行，完成后可在「最近触发记录」看到结果', 'success');
    }
    try {
      status.value = await api<MemoryStatus>('/memory/status');
    } catch {
      /* 状态刷新失败不影响主流程 */
    }
    await loadHistory();
  } catch (e) {
    guard(e, 'dream 失败');
  } finally {
    busy.value = false;
  }
}

/** 保存定时后：刷新状态（下次触发时间以服务端为准）与历史 */
async function onScheduleSaved(): Promise<void> {
  try {
    status.value = await api<MemoryStatus>('/memory/status');
  } catch (e) {
    guard(e, '刷新状态失败');
  }
  await loadHistory();
}

// ---------- L2 情景页（D3 三级筛选，前端解析） ----------

const epi = ref<{ entries: { day: string; content: string }[] } | null>(null);
const epiLoading = ref(false);
const l2Ws = ref(''); // ''= 启动空间（缺省请求不带 ws）
const l2Session = ref('');
const l2Scope = ref<'' | 'session' | 'global'>('');
const l2Tag = ref('');
const l2Days = ref('14');
const l2Collapsed = ref<Set<string>>(new Set());
const epiLimit = ref('7'); // 启动空间轻量预载（状态卡用）

const allEntries = computed<MemEntry[]>(() => parseDays(epi.value?.entries ?? []));
const filteredEntries = computed(() =>
  filterEntries(allEntries.value, { sessionId: l2Session.value, scope: l2Scope.value, tag: l2Tag.value }),
);
const dayGroups = computed(() => groupByDay(filteredEntries.value));
const sessionOptions = computed(() => sessionIdsOf(allEntries.value));
const tagOptions = computed(() => tagsOf(allEntries.value));
const l2Hit = computed(() => filteredEntries.value.length);

/** L2 空间下拉标题（孤儿空间标注） */
function wsLabel(w: MemWorkspace): string {
  const flags = [w.hasMemory ? '记忆' : '', w.hasSession ? '会话' : ''].filter(Boolean).join('·');
  return `${w.name}（${flags || '未知'}）`;
}

/** 按 id 找空间（启动空间缺省项的展示名） */
function wsById(id: string): MemWorkspace | undefined {
  return workspaces.value.find((w) => w.id === id);
}

const l2WsName = computed(() => (l2Ws.value ? (wsById(l2Ws.value)?.name ?? l2Ws.value.slice(0, 8)) : '启动空间'));

async function loadEpisodic(): Promise<void> {
  epiLoading.value = true;
  try {
    const n = Math.min(Math.max(Number(l2Days.value) || 14, 1), 90);
    const ws = l2Ws.value ? `&ws=${encodeURIComponent(l2Ws.value)}` : '';
    epi.value = await api<{ entries: { day: string; content: string }[] }>(`/memory/episodic?limit=${n}${ws}`);
    // 空间切换后重置会话/标签筛选（旧空间的会话 id 在新空间无意义）
    l2Session.value = '';
    l2Tag.value = '';
  } catch (e) {
    guard(e, '加载情景记忆失败');
  } finally {
    epiLoading.value = false;
  }
}

/** 启动空间 7 天轻量预载（仅用于标签页计数，避免进页面就拉 90 天） */
async function preloadEpisodicCount(): Promise<void> {
  try {
    const res = await api<{ entries: { day: string; content: string }[] }>('/memory/episodic?limit=7');
    l2TotalAll.value = parseDays(res.entries ?? []).length;
  } catch {
    l2TotalAll.value = 0;
  }
}

/** L2 空间切换后同步 hash（ws 参数 L2/L3 共用，见 hash watch） */
function onL2WsHash(): void {
  replaceHashQuery({ ws: l2Ws.value || undefined, tab: tab.value === 'sched' ? 'l2' : tab.value });
}

/** 折叠/展开某天分组 */
function toggleDay(day: string): void {
  const next = new Set(l2Collapsed.value);
  if (next.has(day)) next.delete(day);
  else next.add(day);
  l2Collapsed.value = next;
}

// ---------- L3 长期页（D9：全局区 + 空间级分区） ----------

const GLOBAL_LABEL: Record<string, string> = { soul: 'SOUL · Agent 人格', user: 'USER · 用户画像' };
const WS_LABEL: Record<string, string> = { memory: 'MEMORY · 工作空间精炼' };

interface CuratedEntry {
  key: string;
  path: string;
  content: string;
}

const curatedGlobal = ref<CuratedEntry[]>([]);
const curatedWs = ref<CuratedEntry[]>([]);
const l3Ws = ref(''); // ''= 启动空间（缺省请求）
const l3Loading = ref(false);

const l3WsOptions = computed(() => workspaces.value.filter((w) => w.hasMemory || w.path));
const l3WsName = computed(() => (l3Ws.value ? (wsById(l3Ws.value)?.name ?? l3Ws.value.slice(0, 8)) : '启动空间'));

/** 启动空间走缺省请求（现行为不变）；其余空间带 ?ws= 直读 */
async function loadCurated(): Promise<void> {
  l3Loading.value = true;
  try {
    const qs = l3Ws.value ? `?ws=${encodeURIComponent(l3Ws.value)}` : '';
    const res = await api<{ entries: CuratedEntry[] }>(`/memory/curated${qs}`);
    const entries = res.entries ?? [];
    curatedGlobal.value = entries.filter((e) => e.key in GLOBAL_LABEL);
    curatedWs.value = entries.filter((e) => !(e.key in GLOBAL_LABEL));
  } catch (e) {
    guard(e, '加载长期记忆失败');
  } finally {
    l3Loading.value = false;
  }
}

function onL3WsChange(): void {
  replaceHashQuery({ ws: l3Ws.value || undefined, tab: tab.value === 'sched' ? 'l3' : tab.value });
  void loadCurated();
}

// ---------- 检索页（D10：本期仅启动空间） ----------

const searchQ = ref('');
const searching = ref(false);
const results = ref<Record<string, unknown>[] | null>(null);

function scoreOf(r: Record<string, unknown>): number | null {
  return typeof r.score === 'number' ? r.score : null;
}
function textOf(r: Record<string, unknown>): string {
  for (const k of ['text', 'content', 'note', 'summary', 'title', 'day', 'date']) {
    const v = r[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return JSON.stringify(r);
}
function titleOf(r: Record<string, unknown>, i: number): string {
  for (const k of ['day', 'date', 'title', 'id']) {
    const v = r[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return `结果 ${i + 1}`;
}

async function search(): Promise<void> {
  const q = searchQ.value.trim();
  if (!q) {
    showToast('请输入检索关键词', 'error');
    return;
  }
  searching.value = true;
  try {
    const res = await api<{ results: Record<string, unknown>[] }>(`/memory/search?q=${encodeURIComponent(q)}`);
    results.value = res.results;
  } catch (e) {
    guard(e, '检索失败');
  } finally {
    searching.value = false;
  }
}

// ---------- 初始化 ----------

async function refresh(): Promise<void> {
  busy.value = true;
  try {
    status.value = await api<MemoryStatus>('/memory/status');
    if (status.value.enabled) {
      // 空间下拉 + Gate + 启动空间计数可并行；L2/L3 数据按需懒加载
      const [ws, g] = await Promise.all([
        api<{ workspaces: MemWorkspace[] }>('/memory/workspaces').catch(() => ({ workspaces: [] as MemWorkspace[] })),
        api<{ thresholds: unknown; recentDecisions: { pending: unknown[]; approved: unknown[] } }>('/memory/gate'),
      ]);
      workspaces.value = ws.workspaces ?? [];
      gate.value = g;
      await Promise.all([preloadEpisodicCount(), loadEpisodic(), loadCurated()]);
    }
  } catch (err) {
    guard(err, '加载记忆失败');
  } finally {
    busy.value = false;
  }
  await loadHistory();
}

const gate = ref<{ thresholds: unknown; recentDecisions: { pending: unknown[]; approved: unknown[] } } | null>(null);

async function init(): Promise<void> {
  busy.value = true;
  try {
    await api('/memory/init', { method: 'POST' });
    showToast('记忆库已初始化', 'success');
    await refresh();
  } catch (e) {
    guard(e, '初始化失败');
  } finally {
    busy.value = false;
  }
}

// tab / ws 状态与 hash 同步：从 hash 还原（刷新/分享进入时）
watch(
  hashQuery,
  (q) => {
    const ws = q.get('ws') ?? '';
    const scope = q.get('histScope');
    let dirty = false;
    if (ws !== l2Ws.value && ws !== l3Ws.value) {
      // ws 同时驱动 L2 与 L3（D1 简化：一个 ws 参数两个标签页共用）
      l2Ws.value = ws;
      l3Ws.value = ws;
      dirty = true;
    }
    if ((scope === 'ws' || scope === 'all') && scope !== histScope.value) {
      histScope.value = scope;
      dirty = true;
    }
    if (dirty) {
      void loadEpisodic();
      void loadCurated();
      void loadHistory();
    }
  },
  { immediate: true },
);

onMounted(refresh);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1>记忆</h1>
      <template v-if="status">
        <StatusBadge :kind="status.enabled ? 'ok' : 'warn'">{{ status.enabled ? '已启用' : '未启用' }}</StatusBadge>
        <span v-if="status.enabled" class="muted sub">
          情景 {{ status.counts.episodicDays ?? 0 }} 天 · Gate 待定 {{ status.counts.gatePending ?? 0 }} / 已批准
          {{ status.counts.gateApproved ?? 0 }}
        </span>
      </template>
      <span v-if="busy" class="spin" title="处理中"></span>
      <span class="spacer"></span>
      <button :disabled="busy || !status?.enabled" @click="dream">✦ 立即梳理</button>
      <button :disabled="busy" @click="refresh">⟳ 刷新</button>
    </div>

    <template v-if="status && !status.enabled">
      <div class="card">
        <div class="card-b">
          <StatusBadge kind="warn">未启用</StatusBadge>
          <span class="muted" style="margin-left:10px">
            可在「配置」页将 memory.enabled 置为 true 开启（写入后本页「⟳ 刷新」生效）。定时排期仍可在此页预先配置。
          </span>
          <button style="margin-left:10px" :disabled="busy" @click="init">初始化记忆库</button>
        </div>
      </div>
    </template>

    <!-- 四标签页导航（原型-20261026-004：tabs 样式与结构对齐） -->
    <div class="tabs" role="tablist">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="tab"
        :class="{ on: tab === t.key }"
        role="tab"
        :aria-selected="tab === t.key"
        @click="setTab(t.key)"
      >
        <svg v-if="t.key === 'sched'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.8V8l2.2 1.6"/></svg>
        <svg v-else-if="t.key === 'l2'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 4.5h11v8.5h-11z"/><path d="M2.5 7h11M5.5 2.5v2M10.5 2.5v2"/></svg>
        <svg v-else-if="t.key === 'l3'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 5.5 8 3l5 2.5v5L8 13l-5-2.5z"/><path d="M3 5.5 8 8l5-2.5M8 8v5"/></svg>
        <svg v-else viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.2"/><path d="m10.4 10.4 3 3"/></svg>
        {{ t.label }}
        <span v-if="t.key === 'l2' && status?.enabled" class="n">{{ l2TotalAll }}</span>
      </button>
    </div>

    <!-- pane: 定时任务 -->
    <section v-show="tab === 'sched'" role="tabpanel">
      <div class="card">
        <div class="card-h">
          自动晋升定时 <span class="ch-hint">进程级配置 · 所有工作空间共用</span>
        </div>
        <div class="card-b">
          <DreamScheduleCard :status="status?.dreaming" :memory-enabled="status?.enabled" @saved="onScheduleSaved" />
        </div>
      </div>
      <DreamHistoryList
        :runs="runs"
        :loading="histBusy"
        :scope="histScope"
        @clear="clearHistory"
        @refresh="loadHistory"
        @scope-change="setHistScope"
      />
      <!-- 分层状态概要（原「分层状态」卡压缩为定时页的一行摘要） -->
      <div class="card">
        <div class="card-h">分层状态 <StatusBadge kind="dim">GET /memory/status</StatusBadge></div>
        <div class="card-b">
          <template v-if="status?.enabled">
            <div class="stat-grid">
              <div class="stat">
                <span class="k">情景记忆</span>
                <span class="v mono">{{ status.counts.episodicDays ?? 0 }} 天</span>
              </div>
              <div class="stat">
                <span class="k">Gate 晋升</span>
                <span class="v mono">待定 {{ status.counts.gatePending ?? 0 }} / 批准 {{ status.counts.gateApproved ?? 0 }}</span>
              </div>
              <div class="stat">
                <span class="k">已整理至 <StatusBadge kind="dim">UTC</StatusBadge></span>
                <span class="v mono">{{ status.dreaming?.lastProcessedDay ?? '—' }}</span>
              </div>
              <div class="stat">
                <span class="k">上次触发</span>
                <span class="v mono">{{ status.dreaming?.lastRunAt ? fmtLocal(status.dreaming.lastRunAt) : '尚未执行' }}</span>
              </div>
            </div>
            <div v-if="status.layers.episodic" class="form-row" style="margin-top:10px">
              <span class="muted" style="width:70px">episodic</span>
              <span class="mono">{{ status.layers.episodic.dir }}</span>
            </div>
            <div v-if="status.layers.curated" class="form-row" style="margin-top:6px">
              <span class="muted" style="width:70px">curated</span>
              <span class="mono">{{ status.layers.curated.workspace }}</span>
            </div>
          </template>
          <template v-else> <span class="muted">记忆未启用，无分层数据。</span> </template>
        </div>
      </div>
      <div class="card">
        <div class="card-h">
          Gate 晋升 <StatusBadge kind="dim">GET /memory/gate</StatusBadge>
          <template v-if="gate">
            <StatusBadge kind="dim">待定 {{ gate.recentDecisions.pending.length }}</StatusBadge>
            <StatusBadge kind="ok">已批准 {{ gate.recentDecisions.approved.length }}</StatusBadge>
          </template>
        </div>
        <div v-if="gate" class="card-b">
          <JsonViewer :value="gate.thresholds" label="阈值 thresholds" />
          <JsonViewer v-if="gate.recentDecisions.pending.length > 0" :value="gate.recentDecisions.pending" label="待定决策" />
          <JsonViewer
            v-if="gate.recentDecisions.approved.length > 0"
            :value="gate.recentDecisions.approved"
            label="已批准决策"
          />
        </div>
      </div>
    </section>

    <!-- pane: L2 情景 -->
    <section v-show="tab === 'l2'" role="tabpanel">
      <div class="card">
        <div class="card-h">
          情景记忆（L2 · daily notes）
          <span class="ch-hint">按工作空间分目录 · 条目带会话与来源标记</span>
          <span class="spacer"></span>
          <StatusBadge kind="dim">GET /memory/episodic</StatusBadge>
        </div>
        <div class="card-b">
          <!-- 三级筛选链（D3） -->
          <div class="filter-row">
            <span class="fl">空间</span>
            <span class="sel-wrap">
              <select v-model="l2Ws" :disabled="epiLoading" @change="loadEpisodic(); onL2WsHash()">
                <option value="">启动空间（缺省）</option>
                <option v-for="w in workspaces" :key="w.id" :value="w.id">{{ wsLabel(w) }}</option>
              </select>
            </span>
            <span class="fl">会话</span>
            <span class="sel-wrap">
              <select v-model="l2Session" class="f-session">
                <option value="">全部会话</option>
                <option v-for="s in sessionOptions" :key="s" :value="s" class="mono">{{ s }}</option>
              </select>
            </span>
            <span class="fl">范围</span>
            <span class="sel-wrap">
              <select v-model="l2Scope">
                <option value="">全部来源</option>
                <option value="session">仅会话私有</option>
                <option value="global">仅全局</option>
              </select>
            </span>
            <span class="fl">标签</span>
            <span class="sel-wrap">
              <select v-model="l2Tag">
                <option value="">全部标签</option>
                <option v-for="t in tagOptions" :key="t" :value="t">{{ t }}</option>
              </select>
            </span>
            <span class="fl">天数</span>
            <input v-model="l2Days" type="number" min="1" max="90" style="width:64px">
            <button :disabled="epiLoading" @click="loadEpisodic">加载</button>
            <span class="spacer"></span>
            <span class="muted" style="font-size:12px">筛选在已加载条目上进行 · 数据源 GET /memory/episodic</span>
          </div>

          <!-- 汇总条 -->
          <div class="l2-summary">
            <span>空间 <b>{{ l2WsName }}</b></span>
            <span>已选会话 <b>{{ l2Session || '全部会话' }}</b></span>
            <span>命中 <b>{{ l2Hit }}</b> 条 / 共 <b>{{ allEntries.length }}</b> 条（{{ l2Days }} 天）</span>
            <span>涉及 <b>{{ dayGroups.length }}</b> 天</span>
          </div>

          <!-- 按天分组 -->
          <div v-if="dayGroups.length === 0" class="empty-box">
            <div class="ico">🗓</div>
            <div class="t">暂无情景记忆</div>
            <div class="d">{{ epiLoading ? '加载中…' : '该时间范围内没有 daily notes；调整空间或天数后点「加载」。' }}</div>
          </div>
          <div v-for="g in dayGroups" v-else :key="g.day" class="day-group" :class="{ 'day-collapsed': l2Collapsed.has(g.day) }">
            <div class="day-h" @click="toggleDay(g.day)">
              <span class="mono">{{ g.day }}</span>
              <span class="cnt">{{ g.items.length }} 条</span>
              <span class="caret">▾</span>
            </div>
            <div class="day-body">
              <div v-for="(e, i) in g.items" :key="`${e.ts}-${i}`" class="mem-item">
                <div class="mem-meta">
                  <span class="mono">{{ e.ts }}</span>
                  <StatusBadge :kind="e.scope === 'global' ? 'brand' : 'dim'">{{ e.scope === 'global' ? '全局' : '会话' }}</StatusBadge>
                  <StatusBadge v-if="e.tag" kind="dim">{{ e.tag }}</StatusBadge>
                  <span v-if="e.sessionId" class="sid mono" :title="e.sessionTitle || e.sessionId">{{ e.sessionTitle || e.sessionId }}</span>
                </div>
                <div class="mem-text">{{ e.text }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- pane: L3 长期 -->
    <section v-show="tab === 'l3'" role="tabpanel">
      <div class="card">
        <div class="card-h">
          长期记忆（L3 · Curated）
          <span class="ch-hint">SOUL/USER 全局共享 · MEMORY 按空间隔离</span>
          <span class="spacer"></span>
          <span class="sel-wrap">
            <select v-model="l3Ws" style="max-width:340px" title="切换工作空间（SOUL/USER 不受影响）" @change="onL3WsChange">
              <option value="">启动空间（缺省）</option>
              <option v-for="w in l3WsOptions" :key="w.id" :value="w.id">{{ wsLabel(w) }}</option>
            </select>
          </span>
          <StatusBadge kind="dim">GET /memory/curated</StatusBadge>
        </div>
      </div>
      <div class="l3-cols">
        <div class="card l3-card">
          <div class="l3-head"><span>🌐 全局共享（SOUL / USER）</span><span class="spacer"></span><span class="muted" style="font-size:11.5px">不随空间切换</span></div>
          <div class="l3-body">
            <template v-if="curatedGlobal.length">
              <details v-for="e in curatedGlobal" :key="e.key" class="l3f" open>
                <summary>
                  {{ GLOBAL_LABEL[e.key] ?? e.key }}
                  <span class="path" :title="e.path">{{ e.path }}</span>
                </summary>
                <pre>{{ e.content }}</pre>
              </details>
            </template>
            <span v-else class="muted">{{ l3Loading ? '加载中…' : '暂无全局记忆文件。' }}</span>
          </div>
        </div>
        <div class="card l3-card">
          <div class="l3-head"><span>📦 工作空间级（{{ l3WsName }}）</span><span class="spacer"></span><span class="muted" style="font-size:11.5px">随空间切换</span></div>
          <div class="l3-body">
            <template v-if="curatedWs.length">
              <details v-for="e in curatedWs" :key="e.key" class="l3f" open>
                <summary>
                  {{ WS_LABEL[e.key] ?? e.key }}
                  <span class="path" :title="e.path">{{ e.path }}</span>
                </summary>
                <pre>{{ e.content }}</pre>
              </details>
            </template>
            <span v-else class="muted">{{ l3Loading ? '加载中…' : '该空间暂无工作空间级记忆文件。' }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- pane: 检索 -->
    <section v-show="tab === 'search'" role="tabpanel">
      <div class="card">
        <div class="card-h">
          语义检索 <span class="ch-hint">L2 向量 + 关键词混合检索</span>
          <span class="spacer"></span>
          <StatusBadge kind="dim">启动空间</StatusBadge>
          <StatusBadge kind="dim">GET /memory/search</StatusBadge>
        </div>
        <div class="card-b">
          <div class="search-bar">
            <input v-model="searchQ" placeholder="搜索记忆，如「端口占用」「记忆晋升作用域」" @keyup.enter="search">
            <button class="primary" :disabled="searching" @click="search">搜索</button>
          </div>
          <div v-if="results" style="margin-top:12px">
            <div v-if="results.length === 0" class="muted">无匹配结果。</div>
            <div v-for="(r, i) in results" :key="i" class="result-item">
              <div class="rt">
                {{ titleOf(r, i) }}
                <StatusBadge v-if="scoreOf(r) !== null" kind="brand">{{ scoreOf(r)!.toFixed(2) }}</StatusBadge>
              </div>
              <div class="rx">{{ textOf(r) }}</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
