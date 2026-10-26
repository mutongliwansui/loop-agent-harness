<script setup lang="ts">
// 记忆视图（需求 20261026-003 重设计：自动晋升可编辑 + 最近触发记录 + 分层状态 + 分层内容 + 检索）
// 端点映射：GET /memory/status（未启用恒 200 {enabled:false}）· GET /memory/curated · GET /memory/episodic?limit=
// · GET /memory/search?q=&limit= · GET /memory/gate · POST /memory/dream（202 异步受理）
// · PUT /memory/dream/schedule · GET /memory/dream/preview · GET|DELETE /memory/dream/history
// · POST /memory/init；未启用时其余端点 409（消息提示开启方式）
import { onMounted, ref } from 'vue';
import { api, ApiError, AuthError } from '../api/client';
import { showToast } from '../toast';
import { errText } from '../utils';
import { fmtLocal } from '../cron-ui';
import type { DreamRunRecord, DreamStatus } from '../dream-types';
import JsonViewer from '../components/JsonViewer.vue';
import StatusBadge from '../components/StatusBadge.vue';
import DreamScheduleCard from '../components/DreamScheduleCard.vue';
import DreamHistoryList from '../components/DreamHistoryList.vue';

interface MemoryStatus {
  enabled: boolean;
  layers: { episodic?: { dir: string }; curated?: { workspace: string; files: Record<string, string> } };
  counts: { episodicDays?: number; gatePending?: number; gateApproved?: number };
  dreaming?: DreamStatus;
}

const status = ref<MemoryStatus | null>(null);
const curated = ref<{ entries: { key: string; path: string; content: string }[] } | null>(null);
const episodic = ref<{ entries: unknown[] } | null>(null);
const gate = ref<{ thresholds: unknown; recentDecisions: { pending: unknown[]; approved: unknown[] } } | null>(null);
const runs = ref<DreamRunRecord[]>([]);

const epiLimit = ref('7');
const searchQ = ref('');
const searching = ref(false);
const results = ref<Record<string, unknown>[] | null>(null);
const busy = ref(false);
const histBusy = ref(false);

function guard(e: unknown, fallback: string): void {
  if (!(e instanceof AuthError)) showToast(e instanceof ApiError ? e.message : `${fallback}: ${errText(e)}`, 'error');
}

/** 检索结果防御性取字段（score / 正文 / 标题） */
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

/** 加载运行历史（记忆未启用时也允许查看） */
async function loadHistory(): Promise<void> {
  histBusy.value = true;
  try {
    const res = await api<{ runs: DreamRunRecord[] }>('/memory/dream/history?limit=20');
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
    const res = await api<{ deleted: number }>('/memory/dream/history', { method: 'DELETE' });
    runs.value = [];
    showToast(`已清空 ${res?.deleted ?? 0} 条触发记录`, 'success');
  } catch (e) {
    guard(e, '清空触发记录失败');
  } finally {
    histBusy.value = false;
  }
}

async function refresh(): Promise<void> {
  busy.value = true;
  try {
    status.value = await api<MemoryStatus>('/memory/status');
    if (status.value.enabled) {
      const [c, e, g] = await Promise.all([
        api<{ entries: { key: string; path: string; content: string }[] }>('/memory/curated'),
        api<{ entries: unknown[] }>('/memory/episodic?limit=7'),
        api<{ thresholds: unknown; recentDecisions: { pending: unknown[]; approved: unknown[] } }>('/memory/gate'),
      ]);
      curated.value = c;
      episodic.value = e;
      gate.value = g;
    }
  } catch (err) {
    guard(err, '加载记忆失败');
  } finally {
    busy.value = false;
  }
  await loadHistory();
}

async function loadEpisodic(): Promise<void> {
  const n = Math.min(Math.max(Number(epiLimit.value) || 7, 1), 90);
  try {
    episodic.value = await api<{ entries: unknown[] }>(`/memory/episodic?limit=${n}`);
  } catch (e) {
    guard(e, '加载情景记忆失败');
  }
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
    // 轻量刷新状态，让「运行中」指示尽快可见
    try {
      status.value = await api<MemoryStatus>('/memory/status');
    } catch {
      // 状态刷新失败不影响主流程（下次「刷新」时再取）
    }
  } catch (e) {
    guard(e, 'dream 失败');
  } finally {
    busy.value = false;
  }
}

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

/** 保存定时后：刷新状态（下次触发时间以服务端为准）与历史 */
async function onScheduleSaved(): Promise<void> {
  try {
    status.value = await api<MemoryStatus>('/memory/status');
  } catch (e) {
    guard(e, '刷新状态失败');
  }
  await loadHistory();
}

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

    <!-- 卡片 A：自动晋升（就地可编辑，保存即生效） -->
    <DreamScheduleCard :status="status?.dreaming" :memory-enabled="status?.enabled" @saved="onScheduleSaved" />

    <!-- 卡片 B：最近触发记录 -->
    <DreamHistoryList :runs="runs" :loading="histBusy" @clear="clearHistory" @refresh="loadHistory" />

    <!-- 卡片 C：分层状态 -->
    <div class="card">
      <div class="card-h">
        分层状态
        <span class="spacer"></span>
        <StatusBadge kind="dim">GET /memory/status</StatusBadge>
      </div>
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

    <template v-if="status?.enabled">
      <div class="card">
        <div class="card-h">Curated 长期记忆 <StatusBadge kind="dim">GET /memory/curated</StatusBadge></div>
        <div v-if="curated" class="card-b">
          <div v-if="curated.entries.length === 0" class="muted">三层 Curated 文件暂无内容。</div>
          <div v-for="e in curated.entries" :key="e.key">
            <div class="jv">
              <details>
                <summary>{{ e.key }} <span class="muted">（{{ e.path }}）</span></summary>
                <pre>{{ e.content }}</pre>
              </details>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          Episodic 情景记忆 <StatusBadge kind="dim">GET /memory/episodic</StatusBadge>
          <span class="spacer"></span>
          <input v-model="epiLimit" style="width:70px" title="天数（1-90）">
          <button @click="loadEpisodic">加载</button>
        </div>
        <div v-if="episodic" class="card-b">
          <div v-if="episodic.entries.length === 0" class="muted">最近无 daily notes。</div>
          <JsonViewer v-for="(entry, i) in episodic.entries" :key="i" :value="entry" :label="`第 ${i + 1} 条`" />
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
    </template>

    <div class="card">
      <div class="card-h">检索 <StatusBadge kind="dim">GET /memory/search</StatusBadge></div>
      <div class="card-b">
        <div class="form-row">
          <input v-model="searchQ" class="grow" placeholder="搜索记忆，如「端口占用」" @keyup.enter="search">
          <button class="primary" :disabled="searching" @click="search">搜索</button>
        </div>
        <div v-if="results" style="margin-top:10px">
          <div v-if="results.length === 0" class="muted">无匹配结果。</div>
          <div v-for="(r, i) in results" :key="i" class="card" style="margin:0 0 8px;box-shadow:none">
            <div class="card-b" style="padding:10px 14px">
              <div style="font-size:13px">
                <b>{{ titleOf(r, i) }}</b>
                <StatusBadge v-if="scoreOf(r) !== null" kind="brand">{{ scoreOf(r)!.toFixed(2) }}</StatusBadge>
              </div>
              <div class="muted" style="font-size:12.5px;margin-top:3px;white-space:pre-wrap;word-break:break-all">
                {{ textOf(r) }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
