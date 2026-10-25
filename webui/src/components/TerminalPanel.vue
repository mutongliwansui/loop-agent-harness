<script setup lang="ts">
// TerminalPanel：文件预览区终端（Task-20261027-001 P0）
//
// 独立组件而非内联进 FilesView（后者已 2472 行）：只通过 props（wsPath / visible）
// 与事件（close）交互，内部自持 xterm 实例与 WS 客户端。
//
// 六态覆盖层（与 client.ts 的 TermState 一一对应）：
//   connecting → 连接中；running → 正常；exited → 已退出（输出保留可滚动）；
//   offline → 顶部黄条重连；unsupported → 缺 PTY 给安装命令；denied → 未启用/无权限
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { TerminalClient, type TermState } from '../terminal/client.js';
import { createTerm, type TermHandle } from '../terminal/xterm.js';
import { api } from '../api/client.js';

const props = defineProps<{
  /** 工作空间路径（?ws=），决定 PTY 的 cwd */
  wsPath?: string;
  /** 当前标签是否激活（v-show 保活，隐藏时宽高为 0 不能 fit） */
  visible: boolean;
  /** 初始 shell id */
  initialShell?: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'title', t: string): void;
  /** 状态变化上报给父级页签（用于圆点颜色），避免父级再建一套状态副本 */
  (e: 'state', s: TermState): void;
}>();

const hostEl = ref<HTMLElement | null>(null);
const termHandle = shallowRef<TermHandle | null>(null);
const client = shallowRef<TerminalClient | null>(null);

const state = ref<TermState>('empty');
const stateMsg = ref('');
const exitCode = ref<number | null>(null);
const pid = ref<number | null>(null);
const shellLabel = ref('');
const cwd = ref('');
const cols = ref(0);
const rows = ref(0);
const copyTip = ref('');

/** 服务端能力信息（GET /terminal/info） */
const info = ref<{
  enabled: boolean;
  ptyAvailable: boolean;
  shells: { id: string; label: string }[];
  maxSessions: number;
} | null>(null);
const infoLoaded = ref(false);

const shellId = ref(props.initialShell ?? '');

let ro: ResizeObserver | null = null;
let mo: MutationObserver | null = null;
let mql: MediaQueryList | null = null;
let resizeDebounce: ReturnType<typeof setTimeout> | null = null;

/** 覆盖层文案与按钮（null = 不显示覆盖层） */
const overlay = computed<{ kind: string; title: string; desc: string; actions: 'restart' | 'close' | null } | null>(() => {
  switch (state.value) {
    case 'connecting':
      return { kind: 'connecting', title: '正在连接终端…', desc: '正在建立 WebSocket 与 PTY 会话', actions: null };
    case 'exited':
      return {
        kind: 'exited',
        title: '会话已结束',
        desc: `退出码 ${exitCode.value ?? '—'} · 上方输出保留可滚动`,
        actions: 'restart',
      };
    case 'unsupported':
      return {
        kind: 'unsupported',
        title: '交互式终端不可用',
        desc: stateMsg.value || '缺少 PTY 原生依赖',
        actions: null,
      };
    case 'denied':
      return {
        kind: 'denied',
        title: '终端不可用',
        desc: stateMsg.value || '终端未启用或当前无权访问',
        actions: null,
      };
    default:
      return null;
  }
});

/** 是否存活（决定状态条能否显示「已连接」，不得谎报） */
const alive = computed(() => state.value === 'running' || state.value === 'busy');
const canClipboard = computed(() => alive.value && cols.value > 0);

const statusText = computed(() => {
  if (alive.value) return '已连接';
  if (state.value === 'connecting') return '连接中';
  if (state.value === 'exited') return '已退出';
  if (state.value === 'offline') return '已断开';
  if (state.value === 'unsupported') return '不可用';
  if (state.value === 'denied') return '不可用';
  return '未连接';
});

/** 主按钮可用性：空态与非存活态下清屏/复制必须置灰 */
const dotClass = computed(() => {
  if (alive.value) return 'on';
  if (state.value === 'connecting' || state.value === 'offline') return 'wait';
  if (state.value === 'exited') return 'off';
  return 'bad';
});

/* ------------------------------ 连接与管道 ------------------------------ */

function applyState(s: TermState, detail?: { message?: string; code?: number }): void {
  const prev = state.value;
  state.value = s;
  emit('state', s);
  if (detail?.message) stateMsg.value = detail.message;
  if (s === 'exited') exitCode.value = detail?.code ?? null;
  if (s === 'running') {
    stateMsg.value = '';
    exitCode.value = null;
  }
  // 从覆盖态回到 running：重新 fit（覆盖层曾遮挡，尺寸可能已变）
  if (s === 'running' && prev !== 'running') {
    void nextFit();
  }
}

function ensureClient(): TerminalClient {
  if (client.value) return client.value;
  const h = termHandle.value;
  const c = new TerminalClient({
    wsPath: props.wsPath,
    shellId: shellId.value || undefined,
    cols: cols.value || 96,
    rows: rows.value || 27,
    onData: (d) => h?.term.write(d),
    onState: (s, detail) => applyState(s, detail),
    onReady: (r) => {
      pid.value = r.pid;
      shellLabel.value = r.shellLabel;
      cwd.value = r.cwd;
      shellId.value = r.shell;
      emit('title', r.shellLabel);
      // ready 后立刻把真实尺寸同步过去（握手时用的可能是默认 96×27）
      const f = termHandle.value?.fitNow();
      if (f) {
        cols.value = f.cols;
        rows.value = f.rows;
        client.value?.resize(f.cols, f.rows);
      }
    },
  });
  client.value = c;
  return c;
}

async function nextFit(): Promise<void> {
  const f = termHandle.value?.fitNow();
  if (!f) return;
  cols.value = f.cols;
  rows.value = f.rows;
  client.value?.resize(f.cols, f.rows);
}

/** 拉取服务端能力：明确区分未启用 / 缺 PTY / 无 shell 三种不可用原因 */
async function loadInfo(): Promise<void> {
  try {
    const r = await api<{
      enabled: boolean;
      ptyAvailable: boolean;
      ptyHint?: string | null;
      shells: { id: string; label: string }[];
      maxSessions: number;
      cwd: string;
    }>('/terminal/info');
    info.value = r;
    if (!cwd.value) cwd.value = r.cwd;
    if (!shellId.value && r.shells.length) shellId.value = r.shells[0].id;
  } catch (e) {
    // 401 会由 api() 统一弹令牌门；其他错误不阻断面板渲染
    info.value = null;
    stateMsg.value = e instanceof Error ? e.message : '无法获取终端能力信息';
  } finally {
    infoLoaded.value = true;
  }
}

/** 根据能力信息决定是否自动连接 */
function maybeAutoConnect(): void {
  if (!props.visible) return;
  if (state.value !== 'empty') return;
  const i = info.value;
  if (!i) return;
  if (!i.enabled) {
    applyState('denied', { message: '终端未启用：请在配置中设置 webui.terminal = true 后重启服务' });
    return;
  }
  if (!i.ptyAvailable) {
    // 文案以服务端 ptyHint 为准（含真实查找路径与 SEA 部署说明）：
    // 前端写死「npm i」在单文件 exe 部署下会把人带偏，因为那类目录根本没有 npm 工程
    applyState('unsupported', {
      message: i.ptyHint ?? '未安装 @lydell/node-pty（免编译预编译版），执行下行命令后重启服务',
    });
    return;
  }
  if (!i.shells.length) {
    applyState('denied', { message: '未探测到可用的 shell（PowerShell / cmd）' });
    return;
  }
  ensureClient().connect();
}

/* -------------------------------- 操作 --------------------------------- */

function doClear(): void {
  termHandle.value?.term.clear();
}

async function doCopy(): Promise<void> {
  const t = termHandle.value?.term;
  if (!t) return;
  const sel = t.getSelection();
  const text = sel || bufferText();
  try {
    await navigator.clipboard.writeText(text);
    copyTip.value = sel ? '已复制选中' : '已复制全部';
  } catch {
    copyTip.value = '复制失败（浏览器拒绝剪贴板权限）';
  }
  setTimeout(() => (copyTip.value = ''), 1600);
}

/** 取整个回滚缓冲的纯文本（复制全部用） */
function bufferText(): string {
  const t = termHandle.value?.term;
  if (!t) return '';
  const buf = t.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  // 去掉尾部空行
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

function doRestart(): void {
  exitCode.value = null;
  stateMsg.value = '';
  ensureClient().reconnect();
}

function doClose(): void {
  client.value?.closeSession();
  emit('close');
}

/**
 * 供父级（页签 ✕ / 视图销毁）主动关闭会话：告知服务端 kill PTY。
 *
 * 必须与 dispose() 区分：dispose() 只断 WS，服务端 PTY 进入 60s 宽限期且**仍占并发名额**；
 * 父级删页签属于「用户明确不要这个终端」，必须走这里真正释放，否则反复开关会占满
 * maxSessions（表现为"并发终端数已达上限"但界面上一个终端都没有）。幂等。
 */
function shutdown(): void {
  client.value?.closeSession();
  client.value = null;
}

defineExpose({ shutdown });

function onShellChange(): void {
  // 换 shell 等价于重启（PTY 进程的 shell 无法热切换）
  if (state.value === 'running' || state.value === 'exited') doRestart();
}

/* -------------------------------- 生命周期 ------------------------------- */

function observeResize(): void {
  if (!hostEl.value) return;
  ro = new ResizeObserver(() => {
    if (resizeDebounce) clearTimeout(resizeDebounce);
    // 防抖 120ms：拖拽分割条时会高频触发，避免每像素一次 resize
    resizeDebounce = setTimeout(() => {
      resizeDebounce = null;
      if (!props.visible) return;
      void nextFit();
    }, 120);
  });
  ro.observe(hostEl.value);
}

/** 主题切换：xterm 是 canvas 绘制，必须显式重设 theme */
function observeTheme(): void {
  const apply = (): void => termHandle.value?.applyTheme();
  mo = new MutationObserver(apply);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  mql = window.matchMedia('(prefers-color-scheme: dark)');
  mql.addEventListener('change', apply);
}

/**
 * 页面卸载（刷新 / 直接关浏览器标签）：立刻释放 PTY。
 *
 * 只靠 onBeforeUnmount 的 dispose() 时，每刷新一次就留一个 detached 会话占名额 60s，
 * 刷新 4 次即撞并发上限。bfcache 恢复（persisted=true）不算真卸载，不能关，
 * 否则用户点后退回来终端已经死了。
 * 注意：卸载期 send 可能被浏览器丢弃，故服务端另有兜底（回收过期 detached）。
 */
function onPageHide(e: PageTransitionEvent): void {
  if (e.persisted) return;
  client.value?.closeSession();
}

onMounted(async () => {
  if (hostEl.value) {
    const h = createTerm(hostEl.value);
    termHandle.value = h;
    // 键盘 → PTY
    h.term.onData((d) => client.value?.send(d));
    // 首个尺寸
    const f = h.fitNow();
    if (f) {
      cols.value = f.cols;
      rows.value = f.rows;
    }
  }
  observeResize();
  observeTheme();
  window.addEventListener('pagehide', onPageHide);
  await loadInfo();
  maybeAutoConnect();
});

watch(
  () => props.visible,
  (v) => {
    if (v) {
      // 重新可见：容器此前宽高为 0，必须重算尺寸并刷新画布
      requestAnimationFrame(() => {
        void nextFit();
        termHandle.value?.term.refresh(0, Math.max(0, termHandle.value.term.rows - 1));
      });
      maybeAutoConnect();
    }
  },
);

// wsPath 变化（切换工作空间）：终止当前会话并按新路径重连
watch(
  () => props.wsPath,
  () => {
    if (!props.visible) return;
    client.value?.closeSession();
    client.value = null;
    pid.value = null;
    cwd.value = '';
    state.value = 'empty';
    maybeAutoConnect();
  },
);

onBeforeUnmount(() => {
  if (resizeDebounce) clearTimeout(resizeDebounce);
  ro?.disconnect();
  mo?.disconnect();
  mql?.removeEventListener('change', () => {});
  window.removeEventListener('pagehide', onPageHide);
  // 只断开 WS，不发 close：保留 PTY 供 60s 内重连。
  // 若父级要彻底关闭，必须先调 shutdown()（见 defineExpose），不能只靠卸载。
  client.value?.dispose();
  client.value = null;
  termHandle.value?.dispose();
  termHandle.value = null;
});
</script>

<template>
  <div class="term-panel" :class="`st-${state}`">
    <!-- 工具条（38px） -->
    <div class="term-bar">
      <select
        v-if="info?.shells?.length"
        v-model="shellId"
        class="term-shell"
        title="选择 shell（切换会重启会话）"
        @change="onShellChange"
      >
        <option v-for="s in info.shells" :key="s.id" :value="s.id">{{ s.label }}</option>
      </select>
      <span v-else class="term-shell-static">{{ shellLabel || 'shell' }}</span>

      <span class="term-cwd" :title="cwd || '工作目录未知'">{{ cwd || '—' }}</span>

      <span class="term-gap"></span>

      <button class="term-btn" title="清屏（不清回滚缓冲外的内容）" :disabled="!alive" @click="doClear">清屏</button>
      <button class="term-btn" title="复制选中内容；未选中则复制全部输出" :disabled="!canClipboard" @click="doCopy">
        复制
      </button>
      <button class="term-btn" title="重启会话" @click="doRestart">重启</button>
      <button class="term-btn danger" title="关闭终端" @click="doClose">关闭</button>
    </div>

    <!-- 断连横幅（不遮画面） -->
    <div v-if="state === 'offline'" class="term-banner">
      <span>终端连接已断开，正在自动重连…</span>
      <button class="term-btn" @click="doRestart">立即重连</button>
    </div>

    <!-- 终端画布 -->
    <div class="term-wrap">
      <div ref="hostEl" class="term-host"></div>

      <!-- 覆盖层（exited 时半透明，输出仍可见） -->
      <div v-if="overlay" class="term-overlay" :class="{ card: overlay.kind === 'exited' }">
        <div class="ov-title">{{ overlay.title }}</div>
        <div class="ov-desc">{{ overlay.desc }}</div>
        <code v-if="overlay.kind === 'unsupported'" class="ov-code">npm i @lydell/node-pty</code>
        <div v-if="overlay.actions" class="ov-acts">
          <button class="term-btn primary" @click="doRestart">重新启动</button>
          <button class="term-btn" @click="doClose">关闭</button>
        </div>
      </div>
    </div>

    <!-- 底部状态条 -->
    <div class="term-status">
      <span class="dot" :class="dotClass"></span>
      <span>{{ statusText }}</span>
      <span v-if="cols" class="sep">·</span>
      <span v-if="cols">{{ cols }}×{{ rows }}</span>
      <span v-if="pid !== null" class="sep">·</span>
      <span v-if="pid !== null">PID {{ pid }}</span>
      <span v-if="shellLabel" class="sep">·</span>
      <span v-if="shellLabel">{{ shellLabel }}</span>
      <span class="term-gap"></span>
      <span v-if="copyTip" class="copy-tip">{{ copyTip }}</span>
      <span v-else-if="info && !infoLoaded" class="sep">读取能力信息…</span>
    </div>
  </div>
</template>

<style scoped>
.term-panel {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--term-bg);
}

/* ---------- 工具条 ---------- */
.term-bar {
  flex: none;
  height: 38px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-bottom: 1px solid var(--line-soft);
  background: var(--bar-bg);
  min-width: 0;
}
.term-shell {
  flex: none;
  max-width: 150px;
  height: 24px;
  font-size: 12px;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-ctl);
  padding: 0 4px;
}
.term-shell-static {
  flex: none;
  font-size: 12px;
  color: var(--muted);
}
.term-cwd {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 42%;
  direction: rtl; /* 中间省略：长路径优先露出尾部目录名 */
  text-align: left;
}
.term-gap { flex: 1; min-width: 0; }
.term-btn {
  flex: none;
  height: 24px;
  padding: 0 9px;
  font-size: 12px;
  color: var(--text-2);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-ctl);
  cursor: pointer;
  transition: background 0.13s, border-color 0.13s, color 0.13s;
}
.term-btn:hover:not(:disabled) { background: var(--hover); border-color: var(--line-strong); }
.term-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.term-btn.danger { color: var(--danger); }
.term-btn.primary {
  color: var(--brand-on);
  background: var(--brand);
  border-color: var(--brand);
}
.term-btn.primary:hover { background: var(--brand); opacity: 0.9; }

/* ---------- 断连横幅 ---------- */
.term-banner {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--warn);
  background: var(--warn-weak);
  border-bottom: 1px solid var(--line-soft);
}

/* ---------- 画布 ---------- */
.term-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  background: var(--term-bg);
  padding: 6px 8px;
}
.term-host { width: 100%; height: 100%; }
/* xterm 的 viewport 需要撑满容器 */
.term-host :deep(.xterm) { height: 100%; }
.term-host :deep(.xterm-viewport) { background: transparent !important; }

/* ---------- 覆盖层 ---------- */
.term-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 18px;
  text-align: center;
  background: var(--term-bg);
  z-index: 2;
}
/* 已退出：半透明悬浮卡片，输出仍可滚动查看 */
.term-overlay.card {
  background: transparent;
}
.term-overlay.card > * {
  background: var(--panel);
}
.term-overlay.card .ov-title,
.term-overlay.card .ov-desc {
  border: 1px solid var(--line);
  padding: 0 12px;
}
.term-overlay.card .ov-title {
  border-radius: var(--radius-card) var(--radius-card) 0 0;
  border-bottom: none;
  padding-top: 10px;
}
.term-overlay.card .ov-desc {
  border-top: none;
  padding-bottom: 6px;
  box-shadow: var(--shadow-card);
}
.term-overlay.card .ov-acts {
  border: 1px solid var(--line);
  border-top: none;
  border-radius: 0 0 var(--radius-card) var(--radius-card);
  padding: 10px 12px;
  box-shadow: var(--shadow-card);
}
.ov-title { font-size: 13.5px; font-weight: 600; color: var(--text); }
.ov-desc { font-size: 12px; color: var(--muted); max-width: 46ch; line-height: 1.6; }
.ov-code {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text);
  background: var(--code-bg);
  border: 1px solid var(--line);
  border-radius: var(--radius-ctl);
  padding: 5px 10px;
  user-select: all;
}
.ov-acts { display: flex; gap: 8px; }

/* ---------- 状态条 ---------- */
.term-status {
  flex: none;
  height: 24px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  font-size: 11px;
  color: var(--muted);
  background: var(--bar-bg);
  border-top: 1px solid var(--line-soft);
  white-space: nowrap;
  overflow: hidden;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: var(--muted);
}
.dot.on { background: var(--ok); }
.dot.wait { background: var(--warn); animation: term-pulse 1.1s ease-in-out infinite; }
.dot.off { background: var(--muted); }
.dot.bad { background: var(--danger); }
@keyframes term-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.32; }
}
.sep { opacity: 0.5; }
.copy-tip { color: var(--ok); }

/* 非存活态：清屏/复制已由 :disabled 置灰，状态条由 statusText 保证不谎报「已连接」 */
</style>
