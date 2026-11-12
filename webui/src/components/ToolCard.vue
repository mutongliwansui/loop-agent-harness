<!--
  工具调用卡片（Task-20261024-001，方案 B 卡片内聚式）
  ------------------------------------------------------------------
  设计定稿：docs/designs/原型-20261024-001+工具调用展示重设计.html
  - 头部内聚：图标徽标 + 中文名 + 等宽副标题 + { } 浮层 / pill / 耗时 / caret
  - 失败时副标题直写原因（不展开即可读懂）
  - 原始 JSON 降级为头部 { } 浮层，默认不占纵向空间（D4）
  - 结果区单滚动：190px ≈ 12 行，>12 行才出「展开全部 N 行」，展开 420px（D6）
  卡片自治：展开态由本组件持有（D8），ChatView 只负责 buildRenderItems + v-for。
  20261107-010：取消「连续同名工具合并 ×N」——一次调用一张卡。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  isPathArgClickable,
  prettyJson,
  resultLines,
  resultMetaText,
  resultNeedsExpand,
  resultTruncation,
  stripAnsi,
  toolDisplay,
  toolFailReason,
  toolIconSvg,
  toolParamRows,
  toolSummary,
  type ToolCardVM,
} from '../tool-meta.js';
import { showToast } from '../toast.js';
import { clipName } from '../mcp-tool-meta.js';
import { metaRev } from '../mcp-tool-meta-loader.js';
import { parseBackgroundResult } from '../background-task-card.js';
import type { ProcessTrace } from '../subagent-process.js';
import BackgroundTaskCard from './BackgroundTaskCard.vue';
import SubAgentProcess from './SubAgentProcess.vue';

/** 卡片渲染所需的最小段形状（与 chat-stream 的 ToolSeg 结构兼容，避免耦合） */
interface CardSeg {
  tool: string;
  args: string;
  result: string;
  done: boolean;
  elapsedMs?: number;
  aborted?: boolean;
  /** 子 Agent 执行轨迹（需求 20261107-002 D3）：默认收起 */
  sub?: ProcessTrace;
}

const props = defineProps<{ card: ToolCardVM<CardSeg>; wsRoot?: string }>();

/** 20261028-006 D2：chip 点击向外冒泡，由 ChatView 接线到 FilesView.openPath */
const emit = defineEmits<{ (e: 'open-path', payload: { path: string; kind: 'file' | 'dir' }): void }>();

/** 结果硬截断上限（超过 2 万字符前端不再渲染全文，防卡顿） */
const MAX_RESULT_CHARS = 20000;

const rootEl = ref<HTMLElement | null>(null);
const open = ref(false);
const jsonOpen = ref(false);
const expandedResult = ref(false);

const head = computed(() => props.card.seg);
const headSeg = computed(() => head.value.seg);
const display = computed(() => {
  // 20261104-001：toolDisplay 读的是模块级 MCP 元信息注册表（非响应式），必须显式依赖 metaRev，
  // 否则「元信息比首帧晚到」时卡片会永久停在英文原名
  void metaRev.value;
  return toolDisplay(props.card.tool);
});
const iconSvg = computed(() => {
  void metaRev.value;
  return toolIconSvg(props.card.tool);
});
/** MCP 工具名超长截断（20261104-001 D12）；内置工具名原样 */
const nameText = computed(() =>
  display.value.mcp ? clipName(display.value.name) : display.value.name,
);
/** 截断名的悬停全名：优先规范 title，其次全名本身（仅 MCP 工具设置） */
const nameTitle = computed(() => {
  const m = display.value.mcp;
  if (!m) return undefined;
  return m.title || display.value.name;
});

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
      return { cls: 'fail', text: '失败', spin: false };
    case 'stop':
      return { cls: 'stop', text: '已中断', spin: false };
    default:
      return { cls: 'ok', text: '完成', spin: false };
  }
});

function fmtSecs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const elapsedText = computed(() => {
  const ms = headSeg.value.elapsedMs;
  return typeof ms === 'number' ? fmtSecs(ms) : '';
});

/** 单次调用摘要（副标题用） */
function summaryOf(it: { seg: CardSeg }): string {
  return toolSummary(props.card.tool, it.seg.args) || '（无参数）';
}

/**
 * 副标题：
 * - 失败：摘要 · 失败原因（不展开即可读懂为什么失败）；
 * - 中断：用户停止，结果未返回；执行中：摘要 · 执行中…
 */
const subtitle = computed(() => {
  void metaRev.value; // 摘要走 MCP 元信息（mcpBrief），同上需显式依赖
  const c = props.card;
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

const rows = computed(() => {
  void metaRev.value; // 参数中文标签走 MCP 元信息，同上需显式依赖
  return toolParamRows(props.card.tool, headSeg.value.args);
});
const jsonText = computed(() => prettyJson(headSeg.value.args));
const canJson = computed(() => !!jsonText.value);

/* ===== 路径 chip（20261028-006 D4/D7） ===== */

/** chip 图标：目录 / 文件（形制对齐 FilesView ICONS，stroke 1.2） */
const CHIP_ICONS = {
  dir: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.9 4.4c0-.7.6-1.3 1.3-1.3h2.8c.4 0 .8.2 1 .5l.6.8h6.2c.7 0 1.3.6 1.3 1.3v6.5c0 .7-.6 1.3-1.3 1.3H3.2c-.7 0-1.3-.6-1.3-1.3V4.4Z" stroke="currentColor" stroke-width="1.2"/></svg>',
  file: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.1 2.2h4.6l3.2 3.2v8.4c0 .5-.4.9-.9.9H4.1a.9.9 0 0 1-.9-.9V3.1c0-.5.4-.9.9-.9Z" stroke="currentColor" stroke-width="1.2"/><path d="M8.6 2.4v3.2h3.3" stroke="currentColor" stroke-width="1.2"/></svg>',
} as const;

/** 单卡参数行 → chip 渲染模型：可点返回 {path,kind}，不可点路径参数返回 {disabled}，其余 undefined */
function chipOf(row: { path?: string; kind?: 'file' | 'dir' }): { path: string; kind: 'file' | 'dir' } | { disabled: string } | undefined {
  if (!row.path || !row.kind) return undefined;
  if (!isPathArgClickable(row.path, props.wsRoot)) return { disabled: '文件在工作空间之外' };
  return { path: row.path, kind: row.kind };
}

/** 单卡键值行的 chip 模型（v-for 内逐行判定，避免模板里塞复杂表达式） */
const rowChips = computed(() => rows.value.map((r) => chipOf(r)));

const headArgs = computed(() => headSeg.value.args || '');

/* ===== 子 Agent 过程区（需求 20261107-002 D3：默认收起，展开可查） ===== */
const subTrace = computed(() => headSeg.value.sub);
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
/** 截断/省略徽标：提示写在正文中间或末尾，190px 预览区默认看不到，必须放到头部 */
const cut = computed(() => resultTruncation(resultRaw.value));
const canExpand = computed(() => !!resultRaw.value && resultNeedsExpand(resultRaw.value));
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

/* ===== 后台任务卡片分流（需求 20261104-005 D2/D3）===== */
/** 结果 JSON 含合法 taskId → 结果区替换为 BackgroundTaskCard */
const backgroundInfo = computed(() =>
  parseBackgroundResult(resultRaw.value, headArgs.value),
);
/** 初始态交给卡片自行轮询收敛：先按运行中展示，避免「退出码未知」的假失败 */
const backgroundInitial = computed(() => ({
  status: 'running',
  startedAt: backgroundInfo.value?.startedAt,
}));
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
        <span class="tcard-name" :class="{ raw: !display.known && !display.mcp }" :title="nameTitle">{{ nameText }}</span>
        <span v-if="display.mcp" class="tsrc" :title="`来源 MCP server：${display.mcp.server}`">{{ display.mcp.server }}</span>
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
        <span v-if="cut" class="tcut" :title="cut.detail">{{ cut.label }}</span>
        <span class="tpill" :class="pill.cls">
          <span v-if="pill.spin" class="sp"></span>{{ pill.text }}
        </span>
        <span v-if="elapsedText" class="tcard-ms">{{ elapsedText }}</span>
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
      <!-- 子 Agent 过程区（20261107-003）：渲染交给 SubAgentProcess，默认收起 -->
      <SubAgentProcess
        v-if="subTrace"
        :trace="subTrace"
        :status="subTrace.status"
        :elapsed-ms="headSeg.elapsedMs"
      />
      <BackgroundTaskCard
        v-if="backgroundInfo"
        class="tcard-bg"
        :task-id="backgroundInfo.taskId"
        :command="backgroundInfo.command"
        :initial="backgroundInitial"
      />
      <template v-else>
        <div v-if="rows.length" class="tkv">
        <template v-for="(row, ri) in rows" :key="row.key">
          <span class="k">{{ row.zh }}</span>
          <button
            v-if="rowChips[ri] && 'path' in rowChips[ri]"
            type="button"
            class="path-chip"
            :title="`${rowChips[ri].path}（点击在文件面板打开）`"
            @click="emit('open-path', { path: rowChips[ri].path, kind: rowChips[ri].kind })"
          >
            <!-- eslint-disable-next-line vue/no-v-html — 图标为内置 SVG 常量，非用户输入 -->
            <span class="path-chip-ico" v-html="CHIP_ICONS[rowChips[ri].kind]"></span>
            <span class="path-chip-txt">{{ rowChips[ri].path }}</span>
          </button>
          <span v-else-if="rowChips[ri] && 'disabled' in rowChips[ri]" class="v v-disabled" :title="rowChips[ri].disabled">{{
            row.text
          }}</span>
          <span v-else class="v">{{ row.text }}</span>
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
/* MCP 工具来源徽标（20261104-001 D12）：灰底小字，复用既有设计令牌，不引入新色值 */
.tsrc {
  flex: none;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 5px;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  background: var(--line-soft);
  font: 500 10.5px/1.4 ui-monospace, Consolas, monospace;
  color: var(--muted);
  align-self: center;
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

/* 截断/省略徽标：中性警示色，常驻头部（结果区默认折叠看不到正文里的提示） */
.tcut {
  flex: none;
  font: 600 11px/1.4 ui-monospace, Consolas, monospace;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--warn-weak);
  color: var(--warn);
  white-space: nowrap;
  cursor: help;
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

/* 后台任务卡片容器：沿用结果区底色，与普通工具视觉连续（20261104-005 D3） */
.tcard-bg { padding: 7px 9px; border-radius: 8px; background: var(--code-bg); }

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

/* ===== 路径 chip（20261028-006）：等宽 + 虚线下划线 + hover 反馈，零新令牌 ===== */
.path-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  padding: 0 2px;
  font: 11.5px/1.5 ui-monospace, Consolas, monospace;
  color: var(--brand);
  background: transparent;
  border: 0;
  border-bottom: 1px dashed var(--line-strong);
  border-radius: 0;
  cursor: pointer;
  text-align: left;
}
.path-chip:hover { background: var(--hover); }
.path-chip:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
.path-chip-ico { flex: none; display: grid; place-items: center; color: var(--brand); }
.path-chip-ico svg { width: 13px; height: 13px; }
.path-chip-txt {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 键值表中的 chip 占满值列并允许换行省略 */
.tkv .path-chip { min-width: 0; align-self: start; }
.tkv .v-disabled { color: var(--muted); cursor: help; }
</style>
