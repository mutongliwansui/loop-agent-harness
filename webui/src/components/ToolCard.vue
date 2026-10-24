<!--
  工具调用卡片（Task-20261024-001，方案 B 卡片内聚式）
  ------------------------------------------------------------------
  设计定稿：docs/designs/原型-20261024-001+工具调用展示重设计.html
  - 头部内聚：图标徽标 + 中文名（组卡带 ×N）+ 等宽副标题 + { } 浮层 / pill / 耗时 / caret
  - 失败时副标题直写原因（不展开即可读懂）；组含失败不合并（groupToolSegs 已拆单卡，D5）
  - 原始 JSON 降级为头部 { } 浮层，默认不占纵向空间（D4）
  - 结果区单滚动：190px ≈ 12 行，>12 行才出「展开全部 N 行」，展开 420px（D6）
  卡片自治：展开态由本组件持有（D8），ChatView 只负责 groupToolSegs + v-for。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  prettyJson,
  resultLines,
  resultMetaText,
  resultNeedsExpand,
  stripAnsi,
  toolDisplay,
  toolFailReason,
  toolIconSvg,
  toolParamRows,
  toolResultLooksFailed,
  toolSummary,
  type ToolCardVM,
} from '../tool-meta.js';
import { showToast } from '../toast.js';

/** 卡片渲染所需的最小段形状（与 chat-stream 的 ToolSeg 结构兼容，避免耦合） */
interface CardSeg {
  tool: string;
  args: string;
  result: string;
  done: boolean;
  elapsedMs?: number;
  aborted?: boolean;
}

const props = defineProps<{ card: ToolCardVM<CardSeg> }>();

/** 结果硬截断上限（超过 2 万字符前端不再渲染全文，防卡顿） */
const MAX_RESULT_CHARS = 20000;

const rootEl = ref<HTMLElement | null>(null);
const open = ref(false);
const jsonOpen = ref(false);
const expandedResult = ref(false);

const items = computed(() => props.card.items);
const grouped = computed(() => props.card.kind === 'group');
const head = computed(() => items.value[0]);
const headSeg = computed(() => head.value.seg);
const display = computed(() => toolDisplay(props.card.tool));
const iconSvg = computed(() => toolIconSvg(props.card.tool));

/** 状态优先级：执行中 > 失败 > 已中断 > 完成（与原型 pill 语义一致） */
const state = computed<'ok' | 'fail' | 'run' | 'stop'>(() => {
  const c = props.card;
  if (c.running) return 'run';
  if (c.failed) return 'fail';
  if (c.aborted) return 'stop';
  return 'ok';
});

const pill = computed(() => {
  switch (state.value) {
    case 'run':
      return { cls: 'run', text: '执行中', spin: true };
    case 'fail':
      return { cls: 'fail', text: grouped.value ? '有失败' : '失败', spin: false };
    case 'stop':
      return { cls: 'stop', text: '已中断', spin: false };
    default:
      return { cls: 'ok', text: grouped.value ? '全部完成' : '完成', spin: false };
  }
});

function fmtSecs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const totalMsText = computed(() => {
  const ms = props.card.totalMs;
  return typeof ms === 'number' ? fmtSecs(ms) : '';
});

/** 单次调用摘要（组卡逐行复用） */
function summaryOf(it: { seg: CardSeg }): string {
  return toolSummary(props.card.tool, it.seg.args) || '（无参数）';
}

/**
 * 副标题：
 * - 组卡：各次参数摘要依次拼接（CSS 单行省略）；
 * - 失败单卡：摘要 · 失败原因（不展开即可读懂为什么失败）；
 * - 中断单卡：用户停止，结果未返回；执行中：摘要 · 执行中…
 */
const subtitle = computed(() => {
  const c = props.card;
  if (grouped.value) return items.value.map(summaryOf).join(' · ');
  const seg = headSeg.value;
  const sum = summaryOf(head.value);
  if (c.failed) {
    const reason = toolFailReason(seg.result, c.tool) || '执行失败';
    const base = toolSummary(c.tool, seg.args);
    return base ? `${base} · ${reason}` : reason;
  }
  if (c.aborted) return sum === '（无参数）' ? '用户停止，结果未返回' : `${sum} · 用户停止，结果未返回`;
  if (c.running) return sum === '（无参数）' ? '执行中…' : `${sum} · 执行中…`;
  return sum;
});

/* ===== 参数键值表 / 原始 JSON 浮层（D4） ===== */

const rows = computed(() => (grouped.value ? [] : toolParamRows(props.card.tool, headSeg.value.args)));
const jsonText = computed(() => (grouped.value ? '' : prettyJson(headSeg.value.args)));
const canJson = computed(() => !!jsonText.value);

const headArgs = computed(() => headSeg.value.args || '');

function toggleJson(): void {
  jsonOpen.value = !jsonOpen.value;
}

async function copyText(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label}已复制`, 'success');
  } catch {
    showToast('复制失败：需 https 或 localhost 环境', 'error');
  }
}

function copyJson(): void {
  void copyText(jsonText.value, '原始参数');
}

function copyResult(): void {
  void copyText(headSeg.value.result ?? '', '结果');
}

/* 浮层关闭：点卡片外 / Esc（仅在浮层打开时挂监听，避免每张卡常驻全局监听） */
function onOutside(ev: Event): void {
  const el = rootEl.value;
  if (el && ev.target instanceof Node && el.contains(ev.target)) return;
  jsonOpen.value = false;
}
function onEsc(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') jsonOpen.value = false;
}
watch(jsonOpen, (on) => {
  if (on) {
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onEsc, true);
  } else {
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onEsc, true);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onEsc, true);
});

/* ===== 结果区（D6：190px / 420px / >12 行才出展开） ===== */

const resultRaw = computed(() => headSeg.value.result ?? '');

const resultText = computed(() => {
  const raw = stripAnsi(resultRaw.value);
  if (!raw) {
    if (state.value === 'stop') return '用户停止，结果未返回';
    return headSeg.value.done ? '（空）' : '执行中…';
  }
  if (raw.length > MAX_RESULT_CHARS) {
    return `${raw.slice(0, MAX_RESULT_CHARS)}\n…（已截断，原文共 ${raw.length} 字符）`;
  }
  return raw;
});

const resultLineCount = computed(() => resultLines(resultRaw.value));
const outMeta = computed(() => resultMetaText(resultRaw.value));
const canExpand = computed(() => !!resultRaw.value && !grouped.value && resultNeedsExpand(resultRaw.value));
const outLabel = computed(() => {
  switch (state.value) {
    case 'run':
      return '结果（执行中…）';
    case 'stop':
      return '结果（已中断）';
    default:
      return '结果';
  }
});

/** 组行状态：执行中 / 失败 / 已中断 / 完成 */
function rowState(it: { seg: CardSeg }): string {
  const s = it.seg;
  if (!s.done && !s.aborted) return 'run';
  if (s.aborted) return 'stop';
  return toolResultLooksFailed(s.result, s.tool) ? 'fail' : 'ok';
}
</script>

<template>
  <div ref="rootEl" class="tcard" :class="{ 'is-open': open }" :data-state="state">
    <div
      class="tcard-h"
      role="button"
      tabindex="0"
      :aria-expanded="open"
      :title="headArgs"
      @click="open = !open"
      @keydown.enter.prevent="open = !open"
      @keydown.space.prevent="open = !open"
    >
      <!-- eslint-disable-next-line vue/no-v-html — 图标为 tool-meta.ts 内置 SVG 常量，非用户输入 -->
      <span class="tcard-ico" v-html="iconSvg"></span>
      <span class="tcard-txt">
        <span class="tcard-name" :class="{ raw: !display.known }">{{ display.name }}</span>
        <span v-if="grouped" class="ttimes">×{{ items.length }}</span>
        <span class="tcard-sub">{{ subtitle }}</span>
      </span>
      <span class="tcard-side">
        <button
          v-if="canJson"
          type="button"
          class="tjson-btn"
          :class="{ on: jsonOpen }"
          :aria-pressed="jsonOpen"
          aria-label="查看原始参数 JSON"
          title="原始参数 JSON"
          @click.stop="toggleJson"
        >
          { }
        </button>
        <span class="tpill" :class="pill.cls">
          <span v-if="pill.spin" class="sp"></span>{{ pill.text }}
        </span>
        <span v-if="totalMsText" class="tcard-ms">{{ totalMsText }}</span>
        <span class="tcaret">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 3.6L10.4 8 6 12.4" />
          </svg>
        </span>
      </span>
    </div>

    <!-- 原始参数浮层（D4）：绝对定位，不占默认纵向空间 -->
    <div v-if="jsonOpen" class="tjson" @click.stop>
      <div class="tjson-h">
        <span class="tjson-t">原始参数 JSON</span>
        <button type="button" class="tjson-copy" @click="copyJson">复制</button>
      </div>
      <pre>{{ jsonText }}</pre>
    </div>

    <div v-if="open" class="tbody">
      <!-- 组卡：逐次调用行（序号 / 状态点 / 摘要 / 耗时） -->
      <div v-if="grouped" class="trows">
        <div v-for="(it, k) in items" :key="it.index" class="trow" :data-state="rowState(it)">
          <span class="trow-n">{{ k + 1 }}</span>
          <span class="trow-dot"></span>
          <span class="trow-sub">{{ summaryOf(it) }}</span>
          <span v-if="it.seg.elapsedMs != null" class="trow-ms">{{ fmtSecs(it.seg.elapsedMs) }}</span>
        </div>
      </div>

      <!-- 单卡：键值表 + 结果区 -->
      <template v-else>
        <div v-if="rows.length" class="tkv">
          <template v-for="row in rows" :key="row.key">
            <span class="k">{{ row.zh }}</span>
            <span class="v">{{ row.text }}</span>
          </template>
        </div>
        <div class="tout" :class="{ fail: state === 'fail', big: expandedResult }">
          <div class="tout-h">
            <span class="tout-t">{{ outLabel }}</span>
            <span v-if="outMeta" class="tout-n">{{ outMeta }}</span>
            <button v-if="resultRaw" type="button" class="tout-copy" title="复制结果" aria-label="复制结果" @click="copyResult">
              复制
            </button>
          </div>
          <pre>{{ resultText }}</pre>
          <button v-if="canExpand" type="button" class="tmore" @click="expandedResult = !expandedResult">
            {{ expandedResult ? '收起结果' : `展开全部 ${resultLineCount} 行` }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 卡片外框：overflow 必须 visible，否则 { } 浮层被裁（D4） */
.tcard {
  position: relative;
  margin: 8px 0;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
}

/* 左侧状态条：绝对定位 + z-index，避免被头部 hover 背景覆盖（20261023-003 已知坑） */
.tcard::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  border-radius: 10px 0 0 10px;
  background: var(--ok);
  z-index: 2;
}
.tcard[data-state='fail']::before { background: var(--danger); }
.tcard[data-state='run']::before { background: var(--warn); }
.tcard[data-state='stop']::before { background: var(--line-strong); }

/* 头部：整行可点，展开时不与正文分离 */
.tcard-h {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px 7px 12px;
  border-radius: 10px;
  min-width: 0;
  cursor: pointer;
  user-select: none;
}
.tcard-h:hover { background: var(--hover); }
.tcard.is-open .tcard-h { border-radius: 10px 10px 0 0; }
.tcard-h:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }

.tcard-ico { flex: none; display: grid; place-items: center; color: var(--text-2); }
.tcard-ico :deep(svg) { width: 15px; height: 15px; }
.tcard[data-state='fail'] .tcard-ico { color: var(--danger); }
.tcard[data-state='run'] .tcard-ico { color: var(--warn); }
.tcard[data-state='stop'] .tcard-ico { color: var(--muted); }

.tcard-txt { display: flex; align-items: baseline; gap: 6px; flex: 1 1 auto; min-width: 0; }
.tcard-name {
  flex: none;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.01em;
}
.tcard-name.raw { font-family: ui-monospace, Consolas, monospace; font-size: 12px; font-weight: 500; }
.ttimes {
  flex: none;
  font: 500 11px/1 ui-monospace, Consolas, monospace;
  color: var(--muted);
}
.tcard-sub {
  flex: 1 1 auto;
  min-width: 0;
  font: 11.5px/1.5 ui-monospace, Consolas, monospace;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tcard-side { flex: none; display: flex; align-items: center; gap: 7px; margin-left: auto; }

/* { } 浮层入口（D4） */
.tjson-btn {
  flex: none;
  font: 600 11.5px/1.5 ui-monospace, Consolas, monospace;
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 0 5px;
  cursor: pointer;
}
.tjson-btn:hover { color: var(--text); border-color: var(--line-strong); }
.tjson-btn.on { color: var(--brand); border-color: var(--brand); background: var(--brand-weak); }

/* 状态 pill：整卡唯一彩色元素 */
.tpill {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font: 600 11.5px/1.5 ui-monospace, Consolas, monospace;
  padding: 1px 7px;
  border-radius: 999px;
  white-space: nowrap;
}
.tpill.ok { background: var(--ok-weak); color: var(--ok); }
.tpill.fail { background: var(--danger-weak); color: var(--danger); }
.tpill.run { background: var(--warn-weak); color: var(--warn); }
.tpill.stop { background: var(--code-bg); color: var(--muted); }
.tpill .sp {
  display: inline-block;
  width: 8px;
  height: 8px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: tcard-spin 0.8s linear infinite;
}
@keyframes tcard-spin { to { transform: rotate(360deg); } }

.tcard-ms {
  flex: none;
  font: 11.5px/1 ui-monospace, Consolas, monospace;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.tcaret { flex: none; display: grid; place-items: center; color: var(--muted); transition: transform 0.15s; }
.tcaret svg { width: 12px; height: 12px; }
.tcard.is-open .tcaret { transform: rotate(90deg); }

/* 原始参数浮层（D4） */
.tjson {
  position: absolute;
  top: 36px;
  right: 10px;
  z-index: 30;
  width: min(420px, calc(100% - 20px));
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}
.tjson-h {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  border-bottom: 1px solid var(--line-soft);
}
.tjson-t { font-size: 11.5px; color: var(--muted); }
.tjson-copy {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--brand);
  background: transparent;
  border: 0;
  cursor: pointer;
  padding: 0;
}
.tjson-copy:hover { text-decoration: underline; }
.tjson pre {
  margin: 0;
  padding: 8px 10px;
  max-height: 240px;
  overflow: auto;
  font: 11.5px/1.5 ui-monospace, Consolas, monospace;
  color: var(--text);
}

/* 正文：左侧让开状态条 */
.tbody { padding: 2px 10px 10px 18px; }

/* 键值表：无边框两列，取代 .ptable 的全边框表格 */
.tkv {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 4px 10px;
  margin: 4px 0 9px;
}
.tkv .k { font-size: 11.5px; color: var(--muted); padding-top: 1px; white-space: nowrap; }
.tkv .v {
  font: 11.5px/1.6 ui-monospace, Consolas, monospace;
  color: var(--text);
  word-break: break-all;
  white-space: pre-wrap;
}

/* 结果区：单一滚动机制（190px ≈ 12 行 / 展开 420px） */
.tout { border-radius: 8px; background: var(--code-bg); overflow: hidden; }
.tout.fail { box-shadow: inset 3px 0 0 var(--danger); }
.tout-h {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 9px;
  border-bottom: 1px solid var(--line-soft);
}
.tout-t { font-size: 11.5px; color: var(--muted); }
.tout.fail .tout-t { color: var(--danger); }
.tout-n {
  margin-left: auto;
  font: 11px/1 ui-monospace, Consolas, monospace;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.tout-copy {
  font-size: 11.5px;
  color: var(--brand);
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
}
.tout-copy:hover { text-decoration: underline; }
.tout pre {
  margin: 0;
  padding: 8px 10px;
  max-height: 190px;
  overflow: auto;
  font: 11.5px/1.55 ui-monospace, Consolas, monospace;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
.tout.big pre { max-height: 420px; }
.tmore {
  display: block;
  width: 100%;
  text-align: left;
  padding: 5px 9px;
  border: 0;
  border-top: 1px solid var(--line-soft);
  background: transparent;
  color: var(--brand);
  font-size: 11.5px;
  cursor: pointer;
}
.tmore:hover { background: var(--hover); }

/* 组卡逐次调用行（D5） */
.trows { display: flex; flex-direction: column; }
.trow { display: flex; align-items: center; gap: 8px; padding: 4px 2px; min-width: 0; }
.trow-n {
  flex: none;
  width: 16px;
  text-align: right;
  font: 11px/1 ui-monospace, Consolas, monospace;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.trow-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
.trow[data-state='fail'] .trow-dot { background: var(--danger); }
.trow[data-state='run'] .trow-dot { background: var(--warn); }
.trow[data-state='stop'] .trow-dot { background: var(--line-strong); }
.trow-sub {
  flex: 1 1 auto;
  min-width: 0;
  font: 11.5px/1.5 ui-monospace, Consolas, monospace;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.trow-ms {
  flex: none;
  font: 11px/1 ui-monospace, Consolas, monospace;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
</style>
