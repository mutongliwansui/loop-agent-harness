<script setup lang="ts">
// 记忆页「最近触发记录」卡片（需求 20261026-003 / 任务 20261026-003-02 D11/D13）
//
// 20261026-004 扩展（D5/D6/D8）：
// - 支持 ?scope=all|ws 聚合范围切换（卡片头部分段按钮），清空跟随范围；
// - 表格新增「工作空间」列（名称 + wsId 副行）；scope=ws 时行内无空间字段，显示「当前空间」。
// 展示 GET /memory/dream/history 的环形记录（新 → 旧，最多 historyLimit 条，默认 20）。
// 结果判定口径与后端一致：ok = (errors === 0)；有产出但有错误 → 部分失败，无产出且报错 → 失败。
import { computed } from 'vue';
import StatusBadge from './StatusBadge.vue';
import { durText, fmtShort } from '../cron-ui';
import type { DreamRunRecord } from '../dream-types';

/** 行数据：单空间模式为 DreamRunRecord；聚合模式附带空间三维（后端 aggregateRunHistory） */
export interface HistoryRow extends DreamRunRecord {
  workspaceId?: string;
  workspaceName?: string;
  workspacePath?: string;
}

const props = defineProps<{
  runs: HistoryRow[];
  loading?: boolean;
  /** 展示范围：all=全部空间聚合（默认）；ws=仅当前空间 */
  scope?: 'all' | 'ws';
}>();
const emit = defineEmits<{ clear: []; refresh: []; scopeChange: [s: 'all' | 'ws'] }>();

type BadgeKind = 'ok' | 'warn' | 'err' | 'brand' | 'dim';

const REASON: Record<string, { text: string; kind: BadgeKind }> = {
  schedule: { text: '定时', kind: 'brand' },
  manual: { text: '手动', kind: 'dim' },
  shutdown: { text: '关停', kind: 'warn' },
};

/** 来源徽章（未知来源按「手动」兜底，避免旧记录无徽章） */
function reasonOf(r: DreamRunRecord): { text: string; kind: BadgeKind } {
  return REASON[r.reason] ?? REASON.manual;
}

/** 结果徽章：跳过类优先，其次按 ok / 产出区分失败程度（与原型缺陷 1 修正口径一致） */
function resultOf(r: DreamRunRecord): { text: string; kind: BadgeKind } {
  if (r.skippedBecause === 'already-running') return { text: '跳过 · 进行中', kind: 'dim' };
  if (r.skippedBecause === 'missed') return { text: '错过', kind: 'warn' };
  if (r.skippedBecause === 'busy') return { text: '跳过 · 对话中', kind: 'dim' };
  if (r.skippedBecause) return { text: '跳过', kind: 'dim' };
  if (!r.ok) return r.promoted > 0 ? { text: '部分失败', kind: 'warn' } : { text: '失败', kind: 'err' };
  return { text: '成功', kind: 'ok' };
}

const rows = computed(() => props.runs ?? []);
</script>

<template>
  <section class="card">
    <div class="card-h">
      <span>最近触发记录</span>
      <span class="ch-hint">保留最近 20 条 · 跨重启保留</span>
      <span class="spacer"></span>
      <span class="seg" role="group" aria-label="记录范围">
        <button :class="{ on: scope !== 'ws' }" :disabled="loading" @click="emit('scopeChange', 'all')">全部空间</button>
        <button :class="{ on: scope === 'ws' }" :disabled="loading" @click="emit('scopeChange', 'ws')">当前空间</button>
      </span>
      <button class="sm" :disabled="loading || rows.length === 0" @click="emit('clear')">清空记录</button>
      <button class="sm" :disabled="loading" @click="emit('refresh')">⟳ 刷新</button>
    </div>
    <div class="card-b dream-hist">
      <div v-if="rows.length === 0" class="empty-box">
        <div class="ico">🗒</div>
        <div class="t">尚无触发记录</div>
        <div class="d">
          保存定时后，首次触发（或点「立即梳理」）会在这里留痕：时间 · 空间 · 来源 · 结果 · 读取窗口 · 晋升/跳过/错误 · 耗时
        </div>
      </div>
      <table v-else class="dtable">
        <thead>
          <tr>
            <th>触发时间</th>
            <th>工作空间</th>
            <th>来源</th>
            <th>结果</th>
            <th>窗口</th>
            <th class="num">晋升 / 跳过 / 错误</th>
            <th class="num">耗时</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in rows" :key="`${r.workspaceId ?? 'cur'}-${r.startedAt}-${i}`">
            <td class="t">
              {{ fmtShort(r.startedAt) }}
              <span v-if="r.errorMessage" class="em" :title="r.errorMessage">{{ r.errorMessage }}</span>
            </td>
            <td class="ws">
              <template v-if="r.workspaceName">
                <span class="ws-name" :title="r.workspacePath || r.workspaceName">{{ r.workspaceName }}</span>
                <span class="ws-id mono">{{ r.workspaceId }}</span>
              </template>
              <template v-else>
                <span class="muted">当前空间</span>
              </template>
            </td>
            <td>
              <StatusBadge :kind="reasonOf(r).kind">{{ reasonOf(r).text }}</StatusBadge>
              <StatusBadge v-if="r.catchup" kind="brand">补跑</StatusBadge>
            </td>
            <td>
              <StatusBadge :kind="resultOf(r).kind">{{ resultOf(r).text }}</StatusBadge>
            </td>
            <td class="win">{{ r.skippedBecause ? '—' : `${r.daysBack}d` }}</td>
            <td v-if="r.skippedBecause" class="nums muted">—</td>
            <td v-else class="nums">
              <span class="n-ok">{{ r.promoted }}</span> / <span class="muted">{{ r.skipped }}</span> /
              <span :class="r.errors ? 'n-err' : 'muted'">{{ r.errors }}</span>
            </td>
            <td class="num dur">{{ r.skippedBecause ? '—' : durText(r.durationMs) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
