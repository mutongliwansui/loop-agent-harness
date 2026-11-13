<script setup lang="ts">
// MCP 服务器视图（原型-20261109-002 方案 B：卡片流 + 详情抽屉 + 登记模态 + 移除确认）
// 端点：GET /mcp/servers · GET /config · GET /mcp/servers/:name
//      · POST /mcp/servers（409 / 502 半态）· POST /mcp/servers/:name/test
//      · POST /mcp/reload · DELETE /mcp/servers/:name
// 需求 20261112-008：MCP 配置只剩全局一份，登记与移除不再选择范围
// 纯逻辑（状态归一 / 筛选排序 / 倒计时 / 表单解析 / 工具展示）见 ../mcp-ui.ts
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, ApiError, AuthError } from '../api/client';
import { showToast } from '../toast';
import { errText } from '../utils';
import { highlightSegments } from '../skills-ui';
import { loadMcpToolMeta, metaSummary, metaTools } from '../mcp-tool-meta-loader.js';
import { mcpMetaOf } from '../mcp-tool-meta.js';
import {
  describeMcpTool,
  filterServers,
  fmtCountdown,
  mcpCounts,
  mcpInitials,
  MCP_CONFIG_PATH,
  normalizeState,
  parseKv,
  parseLines,
  serverTarget,
  sortServers,
  stateMeta,
  type McpServerRow,
  type McpSort,
  type McpTab,
  type McpTargetCfg,
} from '../mcp-ui';

interface TestResult { ok: boolean; latencyMs: number; tools: number; error?: string }
interface ServerDetail {
  name: string;
  transport: string;
  status: string;
  tools: { name: string; description?: string }[];
}
interface ConfigResp { config: { tools?: { mcpServers?: Record<string, McpTargetCfg> } } }

type RegAlert = { tone: 'err' | 'warn'; title: string; text: string; half?: boolean };

const servers = ref<McpServerRow[]>([]);
const rawCfg = ref<Record<string, McpTargetCfg>>({});
const loading = ref(true);
const busy = ref(false);
const loadErr = ref('');
const nowTick = ref(Date.now());

const query = ref('');
const tab = ref<McpTab>('all');
const sortMode = ref<McpSort>('status');
const searchInput = ref<HTMLInputElement | null>(null);

const tests = ref<Record<string, TestResult>>({});
const testing = ref<Record<string, boolean>>({});

const counts = computed(() => mcpCounts(servers.value));
const filtered = computed(() =>
  sortServers(filterServers(servers.value, rawCfg.value, query.value, tab.value), sortMode.value),
);
const metaSum = computed(() => metaSummary.value);
const metaPillText = computed(() => {
  const m = metaSummary.value;
  return m ? `${m.named}/${m.total}` : '—';
});
const tabs: { key: McpTab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'ok', label: '已连接' },
  { key: 'bad', label: '异常' },
];

/* ===== 卡片 ⋯ 菜单 / 中文化徽标弹层 ===== */
const menuServer = ref<McpServerRow | null>(null);
const menuPos = ref({ top: 0, left: 0 });
const showMeta = ref(false);
const metaPos = ref({ top: 0, left: 0 });

/* ===== 详情抽屉 ===== */
const drawerName = ref<string | null>(null);
const drawerRow = computed(() => servers.value.find((s) => s.name === drawerName.value) ?? null);
const detail = ref<ServerDetail | null>(null);
const detailErr = ref('');
const detailLoading = ref(false);
const toolFilter = ref('');
const drawerCfg = computed(() => rawCfg.value[drawerName.value ?? '']);
const drawerState = computed(() => (drawerRow.value ? normalizeState(drawerRow.value) : 'pending'));
const drawerPill = computed(() => stateMeta(drawerState.value));
const detailToolViews = computed(() => (detail.value?.tools ?? []).map((t) =>
  describeMcpTool(t.name, t.description ?? '', mcpMetaOf(t.name), detail.value?.name)));
const shownTools = computed(() => {
  const q = toolFilter.value.trim().toLowerCase();
  if (!q) return detailToolViews.value;
  return detailToolViews.value.filter((t) =>
    t.zh.toLowerCase().includes(q) || t.en.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q));
});
const detailTransFailed = computed(() => {
  if (!drawerName.value) return [];
  return metaTools.value.filter((m) => m.server === drawerName.value && m.translate === 'failed');
});
const failedReasons = computed(() => detailTransFailed.value
  .filter((m) => m.translateError)
  .slice(0, 3)
  .map((m) => `${m.tool}：${m.translateError}`));
const rawJson = computed(() => (detail.value ? JSON.stringify(detail.value.tools, null, 2) : ''));

const cfgRows = computed(() => {
  const c = drawerCfg.value;
  const rows: { k: string; v: string }[] = [];
  const type = c?.type ?? drawerRow.value?.transport;
  if (type) rows.push({ k: '传输', v: type });
  if (c?.command) rows.push({ k: '命令', v: c.command });
  if (c?.args?.length) rows.push({ k: '参数', v: c.args.join(' ') });
  if (c?.url) rows.push({ k: 'URL', v: c.url });
  if (c?.headers && Object.keys(c.headers).length > 0) {
    rows.push({ k: '请求头', v: Object.entries(c.headers).map(([k, v]) => `${k}: ${v}`).join('\n') });
  }
  if (c?.env && Object.keys(c.env).length > 0) {
    rows.push({ k: '环境变量', v: Object.keys(c.env).join(' ') });
  }
  return rows;
});

/* ===== 登记模态 ===== */
const showReg = ref(false);
const regSubmitting = ref(false);
const regName = ref('');
const regTransport = ref<'stdio' | 'sse' | 'http'>('stdio');
const regCommand = ref('');
const regArgs = ref('');
const regEnv = ref('');
const regUrl = ref('');
const regHeaders = ref('');
const regAlert = ref<RegAlert | null>(null);

/* ===== 移除确认 ===== */
const confirmServer = ref<McpServerRow | null>(null);
const cfmErr = ref('');
const cfmBusy = ref(false);

function describe(e: unknown): string {
  return e instanceof ApiError ? e.message : errText(e);
}

function guard(e: unknown, fallback: string): void {
  if (!(e instanceof AuthError)) showToast(e instanceof ApiError ? e.message : `${fallback}: ${errText(e)}`, 'error');
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

function short(text: string | undefined, max = 36): string {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function targetOf(name: string): string {
  return serverTarget(rawCfg.value[name]);
}

function stateOf(row: McpServerRow): ReturnType<typeof normalizeState> {
  return normalizeState(row);
}

function pillOf(row: McpServerRow): ReturnType<typeof stateMeta> {
  return stateMeta(stateOf(row));
}

/** MCP 配置只剩全局一份（需求 20261112-008）：卡片与抽屉统一展示全局来源，不再区分 workspace */
const SCOPE_LABEL = '全局';
const SCOPE_PATH = MCP_CONFIG_PATH;

function testChip(name: string): string {
  const t = tests.value[name];
  if (!t) return '';
  if (!t.ok) return `失败 · ${short(t.error, 30) || '未知错误'}`;
  return `通过 · ${t.latencyMs}ms · ${t.tools} 工具`;
}

/* ===== 列表 ===== */
async function refresh(silent = false, resetTests = true): Promise<void> {
  if (!silent) busy.value = true;
  try {
    const [list, cfg] = await Promise.all([
      api<{ servers: McpServerRow[] }>('/mcp/servers'),
      api<ConfigResp>('/config'),
    ]);
    servers.value = list.servers;
    rawCfg.value = cfg.config.tools?.mcpServers ?? {};
    loadErr.value = '';
    if (resetTests) tests.value = {};
    // 列表静默刷新时不必每 30s 重拉元信息；详情打开会强制刷新
    if (!silent || !metaSummary.value) void loadMcpToolMeta(!silent);
    // 外部删除后关闭指向已不存在 server 的浮层
    if (drawerName.value && !list.servers.some((s) => s.name === drawerName.value)) closeDetail();
    if (confirmServer.value && !list.servers.some((s) => s.name === confirmServer.value?.name)) {
      confirmServer.value = null;
    }
  } catch (e) {
    guard(e, '加载 MCP 失败');
    if (!silent) loadErr.value = describe(e);
  } finally {
    if (!silent) busy.value = false;
  }
}

async function reloadAll(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const res = await api<{ reconnected: number; failed: string[] }>('/mcp/reload', { method: 'POST' });
    if (res.failed.length > 0) {
      const names = res.failed.slice(0, 3).join('、');
      showToast(`重载完成：${res.reconnected} 个已连接，失败 ${res.failed.length} 个（${names}${res.failed.length > 3 ? '…' : ''}）`, 'info', 6000);
    } else {
      showToast(`重载完成：${res.reconnected} 个服务器已连接`, 'success');
    }
    await refresh(false, true);
  } catch (e) {
    guard(e, '重载失败');
  } finally {
    busy.value = false;
  }
}

async function runTest(name: string): Promise<void> {
  if (testing.value[name]) return;
  testing.value = { ...testing.value, [name]: true };
  try {
    const res = await api<TestResult>(`/mcp/servers/${encodeURIComponent(name)}/test`, { method: 'POST' });
    tests.value = { ...tests.value, [name]: res };
  } catch (e) {
    guard(e, '测试失败');
  } finally {
    testing.value = { ...testing.value, [name]: false };
  }
}

async function copyTarget(name: string): Promise<void> {
  const target = targetOf(name);
  if (target === '—') {
    showToast('暂无可复制的连接目标', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(target);
    showToast('连接目标已复制', 'success');
  } catch {
    showToast('复制失败，请手动选择文本', 'error');
  }
}

/* ===== 菜单 ===== */
function openMenu(ev: MouseEvent, s: McpServerRow): void {
  if (menuServer.value?.name === s.name) {
    menuServer.value = null;
    return;
  }
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  menuPos.value = {
    top: Math.min(r.bottom + 6, window.innerHeight - 186),
    left: Math.max(8, Math.min(r.right - 186, window.innerWidth - 194)),
  };
  menuServer.value = s;
  showMeta.value = false;
}

function menuView(): void {
  const s = menuServer.value;
  if (s) void openDetail(s);
}

function menuCopy(): void {
  const s = menuServer.value;
  if (!s) return;
  menuServer.value = null;
  void copyTarget(s.name);
}

function menuTest(): void {
  const s = menuServer.value;
  if (!s) return;
  menuServer.value = null;
  void runTest(s.name);
}

function menuRemove(): void {
  const s = menuServer.value;
  if (!s) return;
  menuServer.value = null;
  askRemove(s);
}

/* ===== 中文化弹层 ===== */
function openMeta(ev: MouseEvent): void {
  if (showMeta.value) {
    showMeta.value = false;
    return;
  }
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  metaPos.value = {
    top: Math.min(r.bottom + 6, window.innerHeight - 190),
    left: Math.max(8, Math.min(r.right - 268, window.innerWidth - 276)),
  };
  menuServer.value = null;
  showMeta.value = true;
}

/* ===== 详情 ===== */
async function openDetail(s: McpServerRow): Promise<void> {
  menuServer.value = null;
  drawerName.value = s.name;
  detail.value = null;
  detailErr.value = '';
  detailLoading.value = true;
  toolFilter.value = '';
  try {
    const res = await api<ServerDetail>(`/mcp/servers/${encodeURIComponent(s.name)}`);
    if (drawerName.value !== s.name) return;
    detail.value = res;
    void loadMcpToolMeta(true);
  } catch (e) {
    guard(e, '查询详情失败');
    if (drawerName.value === s.name) detailErr.value = describe(e);
  } finally {
    if (drawerName.value === s.name) detailLoading.value = false;
  }
}

function closeDetail(): void {
  drawerName.value = null;
  detail.value = null;
  detailErr.value = '';
  detailLoading.value = false;
  toolFilter.value = '';
}

function openDetailFromDrawer(): void {
  if (drawerRow.value) void copyTarget(drawerRow.value.name);
}

/* ===== 登记 ===== */
function openRegister(): void {
  if (busy.value) return;
  showReg.value = true;
  regAlert.value = null;
  regName.value = '';
  regTransport.value = 'stdio';
  regCommand.value = '';
  regArgs.value = '';
  regEnv.value = '';
  regUrl.value = '';
  regHeaders.value = '';
}

function closeRegister(): void {
  if (regSubmitting.value) return;
  showReg.value = false;
  regAlert.value = null;
}

function leaveHalfState(): void {
  if (regSubmitting.value) return;
  closeRegister();
  tab.value = 'bad';
  query.value = '';
  void refresh(false, true);
}

async function submitRegister(): Promise<void> {
  if (regSubmitting.value) return;
  regAlert.value = null;
  const name = regName.value.trim();
  if (!name) {
    regAlert.value = { tone: 'err', title: '名称必填', text: '请填写服务器名称；名称不能包含空格。' };
    return;
  }
  if (/\s/.test(name)) {
    regAlert.value = { tone: 'err', title: '名称含空白', text: '名称不能包含空格，请使用 server-postgres 这类写法。' };
    return;
  }
  const body: Record<string, unknown> = { name, transport: regTransport.value };
  if (regTransport.value === 'stdio') {
    const command = regCommand.value.trim();
    if (!command) {
      regAlert.value = { tone: 'err', title: '命令必填', text: 'stdio 传输必须提供可执行命令（例如 npx）。' };
      return;
    }
    const args = parseLines(regArgs.value);
    if (args.length > 0) body.args = args;
    const env = parseKv(regEnv.value);
    if (Object.keys(env).length > 0) body.env = env;
    body.command = command;
  } else {
    const url = regUrl.value.trim();
    if (!url) {
      regAlert.value = { tone: 'err', title: 'URL 必填', text: `${regTransport.value === 'sse' ? 'SSE' : 'HTTP'} 传输必须提供端点 URL。` };
      return;
    }
    body.url = url;
    if (regTransport.value === 'http') {
      const headers = parseKv(regHeaders.value);
      if (Object.keys(headers).length > 0) body.headers = headers;
    }
  }

  regSubmitting.value = true;
  try {
    const res = await api<{ name: string; scope: string; status: string }>('/mcp/servers', { method: 'POST', json: body });
    showToast(`MCP server 已登记并连接：${res.name}`, 'success');
    showReg.value = false;
    regAlert.value = null;
    await refresh(false, true);
  } catch (e) {
    if (e instanceof AuthError) return;
    if (e instanceof ApiError && e.status === 409) {
      regAlert.value = {
        tone: 'err',
        title: '409 同名冲突',
        text: `已存在同名 server「${name}」。请改名登记，或先在对应卡片移除旧配置。`,
      };
    } else if (e instanceof ApiError && e.status === 502) {
      regAlert.value = {
        tone: 'warn',
        title: '502 配置已落盘，但连接失败',
        text: `${e.message}。配置已保存，卡片会标记为「连接失败」；监测器会按指数退避自动重试。`,
        half: true,
      };
    } else {
      regAlert.value = { tone: 'err', title: '登记失败', text: describe(e) };
    }
  } finally {
    regSubmitting.value = false;
  }
}

/* ===== 移除 ===== */
function askRemove(s: McpServerRow): void {
  confirmServer.value = s;
  cfmErr.value = '';
}

async function doRemove(): Promise<void> {
  const s = confirmServer.value;
  if (!s || cfmBusy.value) return;
  cfmBusy.value = true;
  cfmErr.value = '';
  try {
    const res = await api<{ name: string; scope: string; deleted: boolean }>(
      `/mcp/servers/${encodeURIComponent(s.name)}`,
      { method: 'DELETE' },
    );
    if (!res.deleted) {
      cfmErr.value = `deleted:false · 全局配置中未找到该 server，可能已被其它窗口移除，请刷新后重试。`;
      return;
    }
    showToast(`已移除 MCP server：${s.name}`, 'success');
    confirmServer.value = null;
    if (drawerName.value === s.name) closeDetail();
    await refresh(false, true);
  } catch (e) {
    guard(e, '移除失败');
  } finally {
    cfmBusy.value = false;
  }
}

/* ===== 键盘与点击外部 ===== */
function closeAllOverlays(): boolean {
  if (confirmServer.value) {
    if (!cfmBusy.value) confirmServer.value = null;
    return true;
  }
  if (showReg.value) {
    if (!regSubmitting.value) closeRegister();
    return true;
  }
  if (menuServer.value) {
    menuServer.value = null;
    return true;
  }
  if (showMeta.value) {
    showMeta.value = false;
    return true;
  }
  if (drawerName.value) {
    closeDetail();
    return true;
  }
  return false;
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (closeAllOverlays()) e.preventDefault();
    return;
  }
  if (e.key === '/' && !isTyping(e.target)) {
    e.preventDefault();
    searchInput.value?.focus();
  }
}

function onDocClick(): void {
  menuServer.value = null;
  showMeta.value = false;
}

function onWinScroll(): void {
  if (menuServer.value) menuServer.value = null;
  if (showMeta.value) showMeta.value = false;
}

let ticker: ReturnType<typeof setInterval> | undefined;
let autoRefresh: ReturnType<typeof setInterval> | undefined;

onMounted(async () => {
  loading.value = true;
  try {
    await refresh(false, true);
  } finally {
    loading.value = false;
  }
  ticker = setInterval(() => { nowTick.value = Date.now(); }, 1000);
  autoRefresh = setInterval(() => {
    if (!busy.value && !document.hidden) void refresh(true, false);
  }, 30000);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('click', onDocClick);
  window.addEventListener('scroll', onWinScroll, true);
  window.addEventListener('resize', onWinScroll);
});

onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker);
  if (autoRefresh) clearInterval(autoRefresh);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('click', onDocClick);
  window.removeEventListener('scroll', onWinScroll, true);
  window.removeEventListener('resize', onWinScroll);
});
</script>

<template>
  <div class="page mc-page">
    <!-- 页头 -->
    <div class="mc-head">
      <div class="lead">
        <div class="mc-eyebrow">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5h4v5h-4z"/><path d="M9.5 5.5h4v5h-4z"/><path d="M6.5 8h3"/></svg>
          MCP gateway · 模型上下文协议
        </div>
        <h1>MCP 服务器</h1>
        <p>连接本地进程与远程端点，为 Agent 提供外部工具。登记即连接，失败由监测器按指数退避自动重试。</p>
      </div>
      <div class="mc-actions">
        <button class="mc-btn icon" type="button" title="刷新列表" aria-label="刷新列表" :disabled="busy" @click="refresh(false, true)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.8V5h-2.2"/></svg>
        </button>
        <button class="mc-btn" type="button" :disabled="busy" @click="reloadAll">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.4 8a5.6 5.6 0 0 1 9.6-4"/><path d="M13.6 8a5.6 5.6 0 0 1-9.6 4"/><path d="M12.4 1.8v2.8h-2.8M3.6 14.2v-2.8h2.8"/></svg>
          重载
        </button>
        <button class="mc-btn primary" type="button" @click="openRegister">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M3 8h10"/></svg>
          登记服务器
        </button>
      </div>
    </div>

    <!-- 统计条 -->
    <div class="mc-stats">
      <div class="mc-stat">
        <div class="k"><i class="on"></i>已登记</div>
        <div class="v">{{ counts.total }}<small>个</small></div>
      </div>
      <div class="mc-stat">
        <div class="k"><i class="on"></i>已连接</div>
        <div class="v">{{ counts.connected }}<small>个</small></div>
      </div>
      <div class="mc-stat">
        <div class="k"><i class="bad"></i>异常</div>
        <div class="v bad">{{ counts.failed }}<small>个</small></div>
      </div>
      <div class="mc-stat">
        <div class="k"><i></i>工具总数</div>
        <div class="v">{{ counts.tools }}<small>个</small></div>
      </div>
    </div>

    <!-- 工具条 -->
    <div class="mc-toolbar">
      <div class="mc-search">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.5 13.5"/></svg>
        <input ref="searchInput" v-model="query" type="text" placeholder="搜索名称、command 或 URL" autocomplete="off" spellcheck="false">
        <kbd>/</kbd>
      </div>
      <div class="mc-seg" role="tablist" aria-label="按状态筛选">
        <button
          v-for="t in tabs"
          :key="t.key"
          type="button"
          role="tab"
          :aria-selected="tab === t.key"
          :class="{ on: tab === t.key }"
          @click="tab = t.key"
        >{{ t.label }} <span class="n">{{ t.key === 'all' ? counts.total : t.key === 'ok' ? counts.connected : counts.failed }}</span></button>
      </div>
      <select v-model="sortMode" class="mc-sort" aria-label="排序方式">
        <option value="status">状态优先</option>
        <option value="name">名称 A→Z</option>
        <option value="tools">工具数降序</option>
      </select>
      <button class="mc-meta-pill" type="button" @click.stop="openMeta($event)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 7.2v3.4M8 5.2v.2"/></svg>
        工具名中文化 <b>{{ metaPillText }}</b>
      </button>
      <span class="mc-count">{{ filtered.length }} / {{ counts.total }} 个服务器</span>
    </div>

    <div v-if="loadErr && servers.length > 0" class="mc-alert err mc-load-err">
      <span class="ai">✕</span>
      <div><b>列表加载失败</b><div>{{ loadErr }}</div></div>
      <span class="spring"></span>
      <button class="mc-btn sm" type="button" @click="refresh(false, true)">重新加载</button>
    </div>

    <!-- 骨架 -->
    <div v-if="loading" class="mc-grid" aria-busy="true">
      <div v-for="i in 4" :key="i" class="mc-skel">
        <span class="t"></span>
        <div class="l"><i style="width:38%"></i><i style="width:86%"></i><i style="width:64%"></i><i style="width:52%"></i></div>
      </div>
    </div>

    <!-- 空库 -->
    <div v-else-if="servers.length === 0" class="mc-grid">
      <div class="mc-nothing">
        <span class="nt-ico">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5h4v5h-4z"/><path d="M9.5 5.5h4v5h-4z"/><path d="M6.5 8h3"/></svg>
        </span>
        <b>{{ loadErr ? '无法加载 MCP 服务器' : '还没有 MCP 服务器' }}</b>
        <p>{{ loadErr || '登记第一个本地命令或远程端点，登记后会自动尝试连接。' }}</p>
        <button v-if="loadErr" class="mc-btn" type="button" @click="refresh(false, true)">重新加载</button>
        <button v-else class="mc-btn primary" type="button" @click="openRegister">＋ 登记第一个服务器</button>
      </div>
    </div>

    <!-- 无匹配 -->
    <div v-else-if="filtered.length === 0" class="mc-grid">
      <div class="mc-nothing">
        <span class="nt-ico">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.5 13.5"/></svg>
        </span>
        <b>没有匹配的服务器</b>
        <p>清空搜索，或切回「全部」分段。</p>
        <button class="mc-btn" type="button" @click="query = ''; tab = 'all'">清空筛选</button>
      </div>
    </div>

    <!-- 卡片流 -->
    <div v-else class="mc-grid">
      <article
        v-for="s in filtered"
        :key="s.name"
        class="mc-card"
        :class="{ bad: stateOf(s) === 'failed', warn: stateOf(s) === 'connecting' }"
      >
        <div class="mc-card-top">
          <span class="mc-tile" :class="[s.transport === 'stdio' ? 'stdio' : 'remote', stateOf(s) !== 'connected' ? 'off' : '']">{{ mcpInitials(s.name) }}</span>
          <div class="mc-id">
            <div class="mc-title">
              <h3>
                <template v-for="(seg, i) in highlightSegments(s.name, query)" :key="i">
                  <mark v-if="seg.hit">{{ seg.text }}</mark><template v-else>{{ seg.text }}</template>
                </template>
              </h3>
              <span class="mc-scope gl"><i></i>{{ SCOPE_LABEL }}</span>
              <span class="mc-pill" :class="pillOf(s).tone"><i></i>{{ pillOf(s).label }}</span>
            </div>
            <div class="mc-target" :title="targetOf(s.name)">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5.5 5.5 8 3 10.5"/><path d="M8 10.5h5"/></svg>
              <span>
                <template v-for="(seg, i) in highlightSegments(targetOf(s.name), query)" :key="i">
                  <mark v-if="seg.hit">{{ seg.text }}</mark><template v-else>{{ seg.text }}</template>
                </template>
              </span>
              <button class="mc-ic-btn" type="button" title="复制连接目标" aria-label="复制连接目标" @click.stop="copyTarget(s.name)">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.4" y="3.2" width="8" height="9" rx="1.6"/><path d="M10.6 3.2V2.2a1.2 1.2 0 0 0-1.2-1.2H3.1A1.2 1.2 0 0 0 1.9 2.2v7.4c0 .7.5 1.2 1.2 1.2h1"/></svg>
              </button>
            </div>
          </div>
          <button class="mc-more" type="button" aria-label="更多操作" @click.stop="openMenu($event, s)">
            <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>
          </button>
        </div>

        <div v-if="stateOf(s) === 'failed'" class="mc-err">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2 14.8 13.6H1.2L8 2.2Z"/><path d="M8 6v3.4M8 11.5v.2"/></svg>
          <span class="msg">{{ s.lastError || '连接失败，接口未返回具体原因' }}</span>
          <span v-if="s.nextRetryAt" class="retry">{{ fmtCountdown(s.nextRetryAt, nowTick) }} 后重试</span>
        </div>
        <div v-else-if="stateOf(s) === 'connecting'" class="mc-note">
          <span class="mc-spin"></span>正在连接或按退避重试…
        </div>
        <div v-else-if="stateOf(s) === 'pending'" class="mc-note">
          <span class="mc-dot"></span>等待监测器下一轮探活（≤30s）
        </div>

        <div class="mc-foot">
          <span class="mc-meta">{{ s.toolCount }} 个工具</span>
          <span class="sep">·</span>
          <span class="mc-meta">{{ s.transport }}</span>
          <span class="spring"></span>
          <span v-if="testing[s.name]" class="mc-note"><span class="mc-spin"></span>测试中…</span>
          <span v-else-if="tests[s.name]" class="mc-chip" :class="tests[s.name].ok ? 'ok' : 'err'" :title="tests[s.name].error || ''">{{ testChip(s.name) }}</span>
          <button class="mc-btn sm" type="button" :disabled="!!testing[s.name]" @click="runTest(s.name)">测试</button>
          <button class="mc-btn sm ghost" type="button" @click="openDetail(s)">明细</button>
        </div>
      </article>
    </div>

    <div class="mc-footline">
      <span>监测器每 30s 探活，失败按指数退避重试（30s → 5min）· 登记返回 502 为半态（配置已落盘但连接失败）</span>
      <span class="sp"></span>
      <span>共 {{ counts.total }} 个服务器</span>
    </div>

    <!-- 卡片 ⋯ 菜单 -->
    <div
      v-if="menuServer"
      class="mc-menu"
      role="menu"
      :style="{ top: menuPos.top + 'px', left: menuPos.left + 'px' }"
      @click.stop
    >
      <div class="m-head">{{ menuServer.name }}</div>
      <button type="button" role="menuitem" @click="menuView">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5h10v11H3z"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/></svg>
        查看明细
      </button>
      <button type="button" role="menuitem" @click="menuCopy">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.2" y="5.2" width="6.8" height="8" rx="1.2"/><path d="M10.4 5.2V3.4H3.6v8h1.6"/></svg>
        复制连接目标
      </button>
      <button type="button" role="menuitem" @click="menuTest">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 2 4 9h3.3L7 14l4.5-7H8.2L8.5 2Z"/></svg>
        测试连接
      </button>
      <div class="hr"></div>
      <button type="button" class="danger" role="menuitem" @click="menuRemove">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 4.8h10.4M6 4.8V3.3h4v1.5M4.4 4.8l.6 8.4h6l.6-8.4"/></svg>
        移除服务器
      </button>
    </div>

    <!-- 中文化说明层 -->
    <div
      v-if="showMeta"
      class="mc-menu mc-meta-pop"
      role="dialog"
      aria-label="工具名中文化说明"
      :style="{ top: metaPos.top + 'px', left: metaPos.left + 'px' }"
      @click.stop
    >
      <div class="m-head">工具名中文化 · GET /mcp/tool-meta</div>
      <div class="mc-meta-body">
        展示名优先级：协议 title → 中文描述提炼 → LLM 翻译 → 名字美化。<br>
        <span class="mc-meta-stats">
          已命名 {{ metaSum?.named ?? '—' }} · 已译 {{ metaSum?.translated ?? '—' }} · 失败 {{ metaSum?.failed ?? '—' }}
        </span><br>
        翻译失败项可在对应服务器的「明细 → 工具列表」查看原因。
      </div>
      <div class="hr"></div>
      <button type="button" @click="showMeta = false">知道了</button>
    </div>

    <!-- 详情抽屉 -->
    <div class="mc-backdrop" :class="{ show: !!drawerName }" @click="closeDetail"></div>
    <aside class="mc-drawer" :class="{ show: !!drawerName }" role="dialog" aria-modal="true" aria-label="MCP 服务器详情">
      <template v-if="drawerRow">
        <div class="mc-drv-head">
          <span class="mc-tile" :class="[drawerRow.transport === 'stdio' ? 'stdio' : 'remote', drawerState !== 'connected' ? 'off' : '']">{{ mcpInitials(drawerRow.name) }}</span>
          <div class="mc-drv-title">
            <h2>
              {{ drawerRow.name }}
              <span class="mc-scope gl"><i></i>{{ SCOPE_LABEL }}</span>
              <span class="mc-pill" :class="drawerPill.tone"><i></i>{{ drawerPill.label }}</span>
            </h2>
            <div class="mc-drv-sub">
              <span class="mono">{{ drawerRow.transport }}</span>
              <span>·</span>
              <span>{{ drawerRow.toolCount }} 个工具</span>
              <span v-if="drawerRow.nextRetryAt">· {{ fmtCountdown(drawerRow.nextRetryAt, nowTick) }} 后重试</span>
            </div>
          </div>
          <button class="mc-close-btn" type="button" aria-label="关闭详情" @click="closeDetail">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m4 4 8 8M12 4l-8 8"/></svg>
          </button>
        </div>

        <div class="mc-drv-body">
          <div class="mc-lab">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5.5 5.5 8 3 10.5"/><path d="M8 10.5h5"/></svg>
            连接目标
          </div>
          <div class="mc-target-card">
            <span>{{ targetOf(drawerRow.name) }}</span>
            <button class="mc-ic-btn" type="button" title="复制连接目标" aria-label="复制连接目标" @click="copyTarget(drawerRow.name)">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.4" y="3.2" width="8" height="9" rx="1.6"/><path d="M10.6 3.2V2.2a1.2 1.2 0 0 0-1.2-1.2H3.1A1.2 1.2 0 0 0 1.9 2.2v7.4c0 .7.5 1.2 1.2 1.2h1"/></svg>
            </button>
          </div>

          <div class="mc-lab">运行状态</div>
          <table class="mc-kv">
            <tbody>
              <tr><td class="k">状态</td><td class="v"><span class="mc-pill" :class="drawerPill.tone"><i></i>{{ drawerPill.label }}</span></td></tr>
              <tr><td class="k">工具数</td><td class="v">{{ drawerRow.toolCount }}</td></tr>
              <tr><td class="k">来源范围</td><td class="v">全局（配置只剩全局一份）</td></tr>
              <tr><td class="k">配置位置</td><td class="v"><code>{{ SCOPE_PATH }}</code></td></tr>
              <tr v-if="drawerRow.lastError"><td class="k">失败原因</td><td class="v">{{ drawerRow.lastError }}</td></tr>
              <tr v-if="drawerRow.nextRetryAt"><td class="k">下次重试</td><td class="v"><code>{{ fmtCountdown(drawerRow.nextRetryAt, nowTick) }}</code></td></tr>
            </tbody>
          </table>

          <div class="mc-lab">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5h10v11H3z"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/></svg>
            生效配置
          </div>
          <div v-if="cfgRows.length > 0" class="mc-cfg">
            <div v-for="row in cfgRows" :key="row.k" class="row">
              <span class="k">{{ row.k }}</span>
              <span class="v">{{ row.v }}</span>
            </div>
          </div>
          <p v-else class="mc-muted-line">未在合并配置中找到该 server（配置可能刚被移除）。</p>

          <div class="mc-tools-head">
            <div class="mc-lab">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.4 2.2 4 9h3.2L6.5 14l4.4-7H8.1L8.4 2.2Z"/></svg>
              工具
              <span v-if="detail" class="n">{{ detail.tools.length }}</span>
            </div>
            <span class="spring"></span>
            <input v-if="detail && detail.tools.length > 0" v-model="toolFilter" class="mc-tool-filter" type="text" placeholder="筛选工具名或描述" autocomplete="off" spellcheck="false">
          </div>

          <div v-if="detailLoading" class="mc-loading-line">正在读取工具清单…</div>
          <div v-else-if="detailErr" class="mc-tool-err">
            <span class="ei">!</span>
            <div>
              <b>工具清单查询失败</b>
              <div>{{ detailErr }}</div>
              <div v-if="drawerRow.nextRetryAt" class="mc-retry-line">监测器将在 {{ fmtCountdown(drawerRow.nextRetryAt, nowTick) }} 后重试连接。</div>
            </div>
          </div>
          <p v-else-if="detail && detail.tools.length === 0" class="mc-muted-line">该服务器未返回任何工具。</p>
          <p v-else-if="shownTools.length === 0" class="mc-muted-line">没有匹配「{{ toolFilter }}」的工具。</p>
          <div v-else class="mc-tool-list">
            <div v-for="(t, i) in shownTools" :key="i" class="mc-tool">
              <div class="tool-top">
                <b>{{ t.zh }}</b>
                <span class="orig">{{ t.en }}</span>
                <span class="src" :class="{ z: t.badge !== '原文' }">{{ t.badge }}</span>
              </div>
              <p>{{ t.desc }}</p>
              <div v-if="t.required.length > 0" class="req">
                必填
                <code v-for="key in t.required" :key="key">{{ key }}</code>
              </div>
            </div>
          </div>

          <div v-if="detailTransFailed.length > 0" class="mc-trans-fail">
            <b>{{ detailTransFailed.length }} 个工具的中文名翻译失败</b>，当前回落协议原文。
            <ul v-if="failedReasons.length > 0">
              <li v-for="(r, i) in failedReasons" :key="i">{{ short(r, 120) }}</li>
            </ul>
          </div>

          <details v-if="detail" class="mc-raw">
            <summary>原始响应 JSON · GET /mcp/servers/{{ drawerRow.name }}</summary>
            <pre>{{ rawJson }}</pre>
          </details>
        </div>

        <div class="mc-drv-foot">
          <button class="mc-btn ghost sm" type="button" @click="closeDetail">关闭</button>
          <span class="sp"></span>
          <button class="mc-btn sm" type="button" @click="openDetailFromDrawer">复制目标</button>
          <button class="mc-btn sm" type="button" :disabled="!!testing[drawerRow.name]" @click="runTest(drawerRow.name)">测试连接</button>
        </div>
      </template>
    </aside>

    <!-- 登记模态 -->
    <div class="mc-backdrop" :class="{ show: showReg }" style="z-index: 115" @click="closeRegister"></div>
    <div class="mc-mdl" :class="{ show: showReg }" role="dialog" aria-modal="true" aria-labelledby="mc-reg-title">
      <div class="mc-mdl-head">
        <div class="mh">
          <h2 id="mc-reg-title">登记 MCP 服务器</h2>
          <p>登记即尝试连接；连接失败会保留配置，由监测器按指数退避自动重试。</p>
        </div>
        <button class="mc-close-btn" type="button" aria-label="关闭登记窗口" @click="closeRegister">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m4 4 8 8M12 4l-8 8"/></svg>
        </button>
      </div>
      <div class="mc-mdl-body">
        <div class="mc-field">
          <label>名称 <span class="req">*</span><span class="hint">不可含空格；同名返回 409</span></label>
          <input v-model="regName" class="mc-inp" placeholder="例如 postgres" autocomplete="off" spellcheck="false">
        </div>
        <div class="mc-field">
          <label>传输方式</label>
          <div class="mc-seg mc-reg-seg">
            <button type="button" :class="{ on: regTransport === 'stdio' }" @click="regTransport = 'stdio'">stdio</button>
            <button type="button" :class="{ on: regTransport === 'sse' }" @click="regTransport = 'sse'">SSE</button>
            <button type="button" :class="{ on: regTransport === 'http' }" @click="regTransport = 'http'">HTTP</button>
          </div>
        </div>

        <div v-if="regTransport === 'stdio'" class="mc-sec">
          <div class="mc-field">
            <label>命令 <span class="req">*</span><span class="hint">可执行文件或 npx</span></label>
            <input v-model="regCommand" class="mc-inp script" placeholder="npx" autocomplete="off" spellcheck="false">
          </div>
          <div class="mc-field">
            <label>参数<span class="hint">每行一个</span></label>
            <textarea v-model="regArgs" class="mc-ta" placeholder="-y&#10;@modelcontextprotocol/server-postgres&#10;postgresql://localhost:5432/app"></textarea>
          </div>
          <div class="mc-field">
            <label>环境变量<span class="hint">每行 KEY=VALUE</span></label>
            <textarea v-model="regEnv" class="mc-ta" placeholder="PGPASSWORD=secret"></textarea>
          </div>
        </div>

        <div v-else class="mc-sec">
          <div class="mc-field">
            <label>URL <span class="req">*</span></label>
            <input v-model="regUrl" class="mc-inp script" placeholder="https://example.com/mcp" autocomplete="off" spellcheck="false">
          </div>
          <div v-if="regTransport === 'http'" class="mc-field">
            <label>请求头<span class="hint">每行 KEY=VALUE</span></label>
            <textarea v-model="regHeaders" class="mc-ta" placeholder="Authorization=Bearer …"></textarea>
          </div>
          <p v-else class="mc-sec-note">SSE 传输暂不支持自定义请求头；需要鉴权时请改用 HTTP。</p>
        </div>

        <div class="mc-field">
          <label>配置位置</label>
          <p class="mc-sec-note">MCP 服务器配置统一保存于 <code>{{ SCOPE_PATH }}</code>，对所有项目生效。</p>
        </div>

        <div class="mc-chk-row">
          <span class="mc-chk-hint">登记后会立即尝试连接；若失败，配置仍保留在全局配置，卡片标记为「连接失败」。</span>
        </div>

        <div v-if="regAlert" class="mc-alert" :class="regAlert.tone">
          <span class="ai">{{ regAlert.tone === 'warn' ? '!' : '✕' }}</span>
          <div>
            <b>{{ regAlert.title }}</b>
            <div>{{ regAlert.text }}</div>
          </div>
          <span class="spring"></span>
          <button v-if="regAlert.half" class="mc-btn sm" type="button" @click="leaveHalfState">查看异常卡片</button>
        </div>

        <div v-if="regSubmitting" class="mc-reg-prog">
          <span>正在登记并连接…</span>
          <div class="bar"><i></i></div>
        </div>
      </div>
      <div class="mc-mdl-foot">
        <span class="sp"></span>
        <button class="mc-btn" type="button" :disabled="regSubmitting" @click="closeRegister">取消</button>
        <button class="mc-btn primary" type="button" :disabled="regSubmitting" @click="submitRegister">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M3 8h10"/></svg>
          登记并连接
        </button>
      </div>
    </div>

    <!-- 移除确认 -->
    <div class="mc-backdrop" :class="{ show: !!confirmServer }" style="z-index: 135" @click="cfmBusy || (confirmServer = null)"></div>
    <div class="mc-cfm" :class="{ show: !!confirmServer }" role="dialog" aria-modal="true" aria-labelledby="mc-cfm-title">
      <template v-if="confirmServer">
        <div class="mc-cfm-ico">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 4.8h10.4M6 4.8V3.3h4v1.5M4.4 4.8l.6 8.4h6l.6-8.4"/></svg>
        </div>
        <h3 id="mc-cfm-title">移除「{{ confirmServer.name }}」？</h3>
        <p>将从全局配置中删除并断开连接。</p>
        <div v-if="cfmErr" class="mc-alert err mc-cfm-err">
          <span class="ai">✕</span>
          <div>{{ cfmErr }}</div>
        </div>
        <div class="mc-cfm-btns">
          <button class="mc-btn" type="button" :disabled="cfmBusy" @click="confirmServer = null">取消</button>
          <button class="mc-btn danger" type="button" :disabled="cfmBusy" @click="doRemove">移除</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* ===== 页头 ===== */
.mc-head { display: flex; align-items: flex-end; gap: 20px; flex-wrap: wrap; }
.mc-head .lead { min-width: 0; }
.mc-eyebrow {
  display: flex; align-items: center; gap: 6px;
  font-size: 10.5px; font-weight: 600; letter-spacing: .14em;
  text-transform: uppercase; color: var(--muted);
}
.mc-eyebrow svg { width: 12px; height: 12px; color: var(--brand); }
.mc-head h1 { margin: 3px 0 0; font-size: 24px; font-weight: 700; line-height: 1.2; letter-spacing: -.01em; }
.mc-head p { margin: 7px 0 0; font-size: 12.5px; color: var(--muted); max-width: 66ch; }
.mc-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }

.mc-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  height: 34px; padding: 0 13px;
  border: 1px solid var(--line); border-radius: 9px;
  background: var(--panel); color: var(--text-2);
  font-size: 12.5px; font-weight: 500; line-height: 1; cursor: pointer; white-space: nowrap;
  transition: border-color .13s, background .13s, color .13s, filter .13s;
}
.mc-btn:hover { border-color: var(--line-strong); color: var(--text); background: var(--bar-bg); }
.mc-btn svg { width: 15px; height: 15px; flex: none; }
.mc-btn.primary { background: var(--brand); border-color: var(--brand); color: var(--brand-on); font-weight: 600; box-shadow: 0 1px 2px rgba(14, 159, 110, .22); }
.mc-btn.primary:hover { filter: brightness(1.05); background: var(--brand); color: var(--brand-on); }
.mc-btn.icon { width: 34px; padding: 0; }
.mc-btn.sm { height: 27px; padding: 0 9px; font-size: 11.5px; border-radius: 7px; }
.mc-btn.ghost { background: transparent; }
.mc-btn.danger { background: var(--danger); border-color: var(--danger); color: #fff; font-weight: 600; }
.mc-btn.danger:hover { background: var(--danger); color: #fff; filter: brightness(1.06); }
.mc-btn:disabled { opacity: .5; cursor: not-allowed; filter: none; }

/* ===== 统计条 ===== */
.mc-stats {
  display: grid; grid-template-columns: repeat(4, 1fr);
  margin-top: 20px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
}
.mc-stat { padding: 11px 16px 12px; border-left: 1px solid var(--line-soft); min-width: 0; }
.mc-stat:first-child { border-left: none; }
.mc-stat .k { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
.mc-stat .k i { width: 5px; height: 5px; border-radius: 50%; background: var(--line-strong); flex: none; }
.mc-stat .k i.on { background: var(--brand); }
.mc-stat .k i.bad { background: var(--danger); }
.mc-stat .v { font-size: 20px; font-weight: 650; line-height: 1.3; margin-top: 1px; font-variant-numeric: tabular-nums; }
.mc-stat .v small { font-size: 11px; font-weight: 500; color: var(--muted); margin-left: 4px; }
.mc-stat .v.bad { color: var(--danger); }

/* ===== 工具条 ===== */
.mc-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 16px 0 13px; }
.mc-search {
  flex: 1; min-width: 200px; max-width: 330px;
  display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 9px;
  transition: border-color .13s, box-shadow .13s;
}
.mc-search:focus-within { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-weak); }
.mc-search svg { width: 14px; height: 14px; color: var(--muted); flex: none; }
.mc-search input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font-size: 12.5px; font-weight: 400; line-height: 1; color: var(--text); }
.mc-search input:focus { border: none; }
.mc-search kbd { font: 500 10px/1 var(--mono); color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 2px 5px; }

.mc-seg { display: flex; gap: 2px; padding: 2px; background: var(--code-bg); border-radius: 9px; }
.mc-seg button {
  display: inline-flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 10px; border: none; border-radius: 7px;
  background: transparent; color: var(--muted);
  font-size: 12px; font-weight: 500; line-height: 1; cursor: pointer;
}
.mc-seg button:hover { color: var(--text-2); }
.mc-seg button.on { background: var(--panel); color: var(--text); font-weight: 600; box-shadow: 0 1px 2px rgba(16, 24, 40, .09); }
.mc-seg .n {
  font: 600 10px/14px var(--mono); color: var(--muted); background: var(--panel);
  border-radius: 999px; padding: 0 5px; min-width: 16px; text-align: center;
}
.mc-seg button.on .n { color: var(--brand); background: var(--brand-weak); }

.mc-sort {
  height: 34px; padding: 0 26px 0 10px; border: 1px solid var(--line); border-radius: 9px;
  background: var(--panel) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 16 16' fill='none' stroke='%236b7280' stroke-width='1.5'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E") no-repeat right 9px center;
  color: var(--text-2); font-size: 12px; font-weight: 500; line-height: 1; cursor: pointer; appearance: none;
}
.mc-count { font-size: 11px; color: var(--muted); white-space: nowrap; margin-left: auto; }

.mc-meta-pill {
  display: inline-flex; align-items: center; gap: 6px; height: 27px; padding: 0 9px;
  border: 1px solid var(--line); border-radius: 999px; background: var(--panel);
  font-size: 11px; font-weight: 500; line-height: 1; color: var(--muted); cursor: pointer;
}
.mc-meta-pill:hover { border-color: var(--line-strong); color: var(--text); }
.mc-meta-pill b { color: var(--brand); font-weight: 650; font-family: var(--mono); }
.mc-meta-pill svg { width: 12px; height: 12px; }

/* ===== 服务器卡片 ===== */
.mc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.mc-card {
  position: relative; display: flex; flex-direction: column; gap: 9px;
  padding: 14px 16px 11px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 13px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, .03);
  transition: border-color .15s, box-shadow .15s, transform .15s;
}
.mc-card:hover { border-color: var(--line-strong); box-shadow: var(--shadow-card); transform: translateY(-1px); }
.mc-card.bad { border-left: 3px solid var(--danger); padding-left: 14px; }
.mc-card.warn { border-left: 3px solid var(--warn); padding-left: 14px; }

.mc-card-top { display: flex; align-items: flex-start; gap: 11px; min-width: 0; }
.mc-tile {
  width: 42px; height: 42px; border-radius: 12px; flex: none;
  display: grid; place-items: center; color: #fff;
  font-size: 12px; font-weight: 700; line-height: 1; letter-spacing: .04em;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .24), 0 2px 7px -3px rgba(16, 24, 40, .35);
}
.mc-tile.stdio { background: linear-gradient(135deg, #10b981, #0d9488); }
.mc-tile.remote { background: linear-gradient(135deg, #6366f1, #4f46e5); }
.mc-tile.off { filter: grayscale(.65); opacity: .8; }
.mc-id { flex: 1; min-width: 0; }
.mc-title { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; }
.mc-title h3 { margin: 0; font-size: 14px; font-weight: 650; line-height: 1.35; overflow-wrap: anywhere; }
.mc-title mark, .mc-target mark { background: var(--warn-weak); color: var(--warn); border-radius: 3px; padding: 0 1px; }

.mc-scope {
  display: inline-flex; align-items: center; gap: 5px; height: 19px; padding: 0 7px;
  border-radius: 999px; font-size: 10.5px; font-weight: 600; white-space: nowrap;
}
.mc-scope i { width: 5px; height: 5px; border-radius: 50%; flex: none; }
.mc-scope.ws { color: var(--brand); background: var(--brand-weak); }
.mc-scope.ws i { background: var(--brand); }
.mc-scope.gl { color: var(--muted); background: var(--code-bg); }
.mc-scope.gl i { background: var(--muted); }

.mc-pill {
  display: inline-flex; align-items: center; gap: 5px; height: 19px; padding: 0 7px;
  border-radius: 999px; font-size: 10.5px; font-weight: 600; white-space: nowrap;
}
.mc-pill i { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.mc-pill.ok { color: var(--ok); background: var(--ok-weak); }
.mc-pill.ok i { background: var(--ok); }
.mc-pill.warn { color: var(--warn); background: var(--warn-weak); }
.mc-pill.warn i { background: var(--warn); animation: mc-pulse 1.1s ease-in-out infinite; }
.mc-pill.err { color: var(--danger); background: var(--danger-weak); }
.mc-pill.err i { background: var(--danger); }
.mc-pill.idle { color: var(--muted); background: var(--code-bg); }
.mc-pill.idle i { background: var(--muted); }
@keyframes mc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@keyframes mc-rot { to { transform: rotate(360deg); } }

.mc-target {
  display: flex; align-items: center; gap: 6px; min-width: 0;
  padding: 6px 8px; border-radius: 8px; background: var(--bar-bg); border: 1px solid var(--line-soft);
  font-family: var(--mono); font-size: 11px; font-weight: 400; line-height: 1.5; color: var(--text-2);
}
.mc-target > svg { width: 12px; height: 12px; flex: none; opacity: .7; }
.mc-target span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-target .mc-ic-btn { width: 22px; height: 22px; flex: none; margin: -2px -3px -2px 0; }

.mc-ic-btn {
  display: grid; place-items: center; width: 26px; height: 26px;
  border: none; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer;
  transition: background .12s, color .12s;
}
.mc-ic-btn:hover { background: var(--active); color: var(--text); }
.mc-ic-btn svg { width: 14px; height: 14px; }

.mc-more {
  /* 顶部对齐右上角；padding: 0 重置全局 button 内边距让图标居中；右边与卡片内容边界对齐 */
  width: 26px; height: 26px; flex: none; margin: -2px 0 0; padding: 0;
  display: grid; place-items: center; border: none; border-radius: 6px;
  background: transparent; color: var(--muted); cursor: pointer; opacity: .6;
}
.mc-more svg { width: 15px; height: 15px; }
.mc-card:hover .mc-more { opacity: 1; }
.mc-more:hover { background: var(--active); color: var(--text); }

.mc-err {
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  padding: 7px 10px; border-radius: 8px;
  background: var(--danger-weak); border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
  font-size: 11px; line-height: 1.5; color: var(--danger);
}
.mc-err svg { width: 12px; height: 12px; flex: none; }
.mc-err .msg { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.mc-err .retry { font: 500 10.5px/1 var(--mono); white-space: nowrap; opacity: .9; }

.mc-note { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--muted); }
.mc-note .mc-spin, .mc-spin {
  display: inline-block; width: 11px; height: 11px; border-radius: 50%;
  border: 1.5px solid var(--line-strong); border-top-color: var(--warn); animation: mc-rot .8s linear infinite;
}
.mc-note .mc-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--line-strong); flex: none; }

.mc-foot { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; padding-top: 9px; border-top: 1px solid var(--line-soft); }
.mc-foot .mc-meta { font-size: 11px; color: var(--muted); white-space: nowrap; }
.mc-foot .sep { color: var(--line-strong); font-size: 10px; }
.mc-foot .spring { flex: 1; }
.mc-chip {
  display: inline-flex; align-items: center; gap: 4px; height: 19px; padding: 0 7px;
  border-radius: 5px; font: 500 10.5px/1 var(--mono);
  max-width: 210px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mc-chip.ok { color: var(--ok); background: var(--ok-weak); }
.mc-chip.err { color: var(--danger); background: var(--danger-weak); }

/* ===== 骨架 / 空态 / 页脚 ===== */
.mc-skel {
  display: flex; gap: 11px; padding: 15px 16px; min-height: 128px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 13px;
}
.mc-skel .t { width: 42px; height: 42px; flex: none; border-radius: 12px; background: var(--code-bg); animation: mc-sk 1.2s ease-in-out infinite; }
.mc-skel .l { flex: 1; display: flex; flex-direction: column; gap: 9px; padding-top: 4px; }
.mc-skel .l i { display: block; height: 8px; border-radius: 4px; background: var(--code-bg); animation: mc-sk 1.2s ease-in-out infinite; }
.mc-skel .l i:nth-child(2) { animation-delay: .1s; }
.mc-skel .l i:nth-child(3) { animation-delay: .2s; }
.mc-skel .l i:nth-child(4) { animation-delay: .3s; }
@keyframes mc-sk { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }

.mc-nothing {
  grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center;
  padding: 34px 20px; text-align: center;
  border: 1px dashed var(--line-strong); border-radius: 14px; background: var(--panel);
}
.mc-nothing .nt-ico {
  width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center;
  background: var(--code-bg); color: var(--muted); margin-bottom: 11px;
}
.mc-nothing .nt-ico svg { width: 22px; height: 22px; }
.mc-nothing b { font-size: 13.5px; font-weight: 650; }
.mc-nothing p { margin: 5px 0 13px; font-size: 12px; color: var(--muted); max-width: 50ch; }

.mc-footline {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 14px; padding-top: 11px; border-top: 1px solid var(--line-soft);
  font-size: 11px; color: var(--muted);
}
.mc-footline .sp { flex: 1; }

/* ===== 卡片菜单 / 中文化说明层 ===== */
.mc-menu {
  position: fixed; z-index: 96; width: 186px; padding: 4px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: var(--shadow-pop);
}
.mc-menu .m-head {
  padding: 6px 9px 7px; font: 600 11px/1.3 var(--mono); color: var(--muted);
  border-bottom: 1px solid var(--line-soft); margin-bottom: 4px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mc-menu button {
  display: flex; width: 100%; align-items: center; gap: 8px;
  padding: 7px 9px; border: none; border-radius: 6px; background: transparent;
  font-size: 12px; font-weight: 400; line-height: 1.3; color: var(--text-2); text-align: left; cursor: pointer;
}
.mc-menu button svg { width: 14px; height: 14px; color: var(--muted); flex: none; }
.mc-menu button:hover { background: var(--hover); color: var(--text); }
.mc-menu .hr { height: 1px; background: var(--line-soft); margin: 4px 2px; }
.mc-menu button.danger { color: var(--danger); }
.mc-menu button.danger svg { color: var(--danger); }
.mc-menu button.danger:hover { background: var(--danger-weak); }

.mc-meta-pop { width: 268px; }
.mc-meta-body { padding: 7px 9px 9px; font-size: 11.5px; color: var(--muted); line-height: 1.7; }
.mc-meta-stats { color: var(--text-2); font-family: var(--mono); }

/* ===== 通用提示条 ===== */
.mc-alert {
  display: flex; align-items: flex-start; gap: 9px; margin-top: 12px;
  padding: 10px 12px; border-radius: 9px; font-size: 12px; line-height: 1.65;
}
.mc-alert .ai {
  width: 17px; height: 17px; flex: none; display: grid; place-items: center; margin-top: 1px;
  border-radius: 50%; border: 1px solid currentColor; font: 700 10px/1 var(--mono);
}
.mc-alert .spring { flex: 1; }
.mc-alert b { font-weight: 650; }
.mc-alert.err { color: var(--danger); background: var(--danger-weak); border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent); }
.mc-alert.warn { color: var(--warn); background: var(--warn-weak); border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); }
.mc-alert.ok { color: var(--ok); background: var(--ok-weak); border: 1px solid color-mix(in srgb, var(--ok) 35%, transparent); }
.mc-load-err { margin: 0 0 13px; }

/* ===== 遮罩 / 抽屉 ===== */
.mc-backdrop {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(16, 24, 40, .4); backdrop-filter: blur(2px);
  opacity: 0; pointer-events: none; transition: opacity .2s;
}
.mc-backdrop.show { opacity: 1; pointer-events: auto; }

.mc-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 110;
  width: min(500px, 100%); display: flex; flex-direction: column;
  background: var(--panel); border-left: 1px solid var(--line);
  box-shadow: -24px 0 64px -24px rgba(16, 24, 40, .45);
  transform: translateX(102%); visibility: hidden;
  transition: transform .26s cubic-bezier(.2, .8, .2, 1), visibility .26s;
}
.mc-drawer.show { transform: none; visibility: visible; }
.mc-drv-head { display: flex; align-items: flex-start; gap: 12px; padding: 18px 20px 16px; border-bottom: 1px solid var(--line-soft); }
.mc-drv-head .mc-tile { width: 46px; height: 46px; border-radius: 13px; font-size: 13px; }
.mc-drv-title { flex: 1; min-width: 0; }
.mc-drv-title h2 {
  margin: 0; display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  font-size: 16px; font-weight: 650; line-height: 1.35; overflow-wrap: anywhere;
}
.mc-drv-sub { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-top: 4px; font-size: 11px; color: var(--muted); }
.mc-drv-sub .mono { font-family: var(--mono); }
.mc-close-btn {
  width: 30px; height: 30px; flex: none; display: grid; place-items: center;
  border: 1px solid var(--line); border-radius: 8px; background: var(--panel);
  color: var(--muted); cursor: pointer; margin: -3px -4px 0 0;
}
.mc-close-btn:hover { background: var(--code-bg); color: var(--text); }
.mc-close-btn svg { width: 14px; height: 14px; }

.mc-drv-body { flex: 1; overflow: auto; padding: 16px 20px 28px; }
.mc-lab { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; color: var(--muted); margin: 17px 0 8px; }
.mc-lab:first-child { margin-top: 0; }
.mc-lab svg { width: 12px; height: 12px; }
.mc-lab .n { font: 600 10px/1 var(--mono); color: var(--brand); background: var(--brand-weak); padding: 3px 6px; border-radius: 999px; }

.mc-target-card {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 11px; border-radius: 9px; background: var(--bar-bg); border: 1px solid var(--line);
  font-family: var(--mono); font-size: 11.5px; font-weight: 400; line-height: 1.55; color: var(--text-2);
}
.mc-target-card span { flex: 1; min-width: 0; overflow-wrap: anywhere; }

.mc-kv { width: 100%; border-collapse: collapse; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
.mc-kv tr + tr td { border-top: 1px solid var(--line-soft); }
.mc-kv td { padding: 7px 11px; font-size: 12px; vertical-align: top; }
.mc-kv td.k { width: 104px; color: var(--muted); font-size: 11.5px; background: var(--bar-bg); }
.mc-kv td.v { color: var(--text-2); overflow-wrap: anywhere; }
.mc-kv code { font: 500 11px/1.5 var(--mono); background: var(--code-bg); padding: 2px 5px; border-radius: 4px; }

.mc-cfg { border: 1px solid var(--line); border-radius: 9px; overflow: hidden; background: var(--bar-bg); }
.mc-cfg .row { display: grid; grid-template-columns: 84px 1fr; gap: 10px; padding: 7px 11px; font-size: 11.5px; }
.mc-cfg .row + .row { border-top: 1px solid var(--line-soft); }
.mc-cfg .k { font: 500 10.5px/1.7 var(--mono); color: var(--muted); }
.mc-cfg .v { font: 400 11px/1.65 var(--mono); color: var(--text-2); overflow-wrap: anywhere; white-space: pre-wrap; }

.mc-tools-head { display: flex; align-items: center; gap: 8px; margin: 18px 0 9px; }
.mc-tools-head .mc-lab { margin: 0; }
.mc-tools-head .spring { flex: 1; }
.mc-tool-filter {
  width: 150px; height: 27px; padding: 0 8px;
  border: 1px solid var(--line); border-radius: 7px; background: var(--panel);
  font-size: 11.5px; color: var(--text); outline: none;
}
.mc-tool-filter:focus { border-color: var(--brand); }
.mc-tool-list { display: flex; flex-direction: column; gap: 7px; }
.mc-tool { padding: 9px 11px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); }
.mc-tool .tool-top { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.mc-tool .tool-top b { font-size: 12.5px; font-weight: 650; }
.mc-tool .tool-top .orig { font: 400 10.5px/1.4 var(--mono); color: var(--muted); }
.mc-tool .tool-top .src {
  font: 500 9.5px/1 var(--mono); color: var(--muted); border: 1px solid var(--line);
  border-radius: 999px; padding: 2px 5px; background: var(--code-bg);
}
.mc-tool .tool-top .src.z { color: var(--brand); background: var(--brand-weak); border-color: transparent; }
.mc-tool p { margin: 3px 0 0; font-size: 11.5px; color: var(--text-2); line-height: 1.6; }
.mc-tool .req { margin-top: 5px; font-size: 10.5px; color: var(--muted); display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
.mc-tool .req code { font: 500 10px/1.4 var(--mono); color: var(--text-2); background: var(--code-bg); padding: 1px 4px; border-radius: 3px; }

.mc-tool-err {
  display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px;
  border-radius: 9px; background: var(--danger-weak); color: var(--danger);
  border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
  font-size: 11.5px; line-height: 1.6;
}
.mc-tool-err .ei { flex: none; font-weight: 700; }
.mc-tool-err b { display: block; font-weight: 650; }
.mc-retry-line { margin-top: 3px; font-family: var(--mono); font-size: 10.5px; opacity: .9; }

.mc-trans-fail {
  margin-top: 14px; padding: 9px 11px; border-radius: 9px;
  border: 1px solid var(--line); background: var(--bar-bg);
  font-size: 11.5px; color: var(--muted); line-height: 1.6;
}
.mc-trans-fail b { color: var(--warn); font-weight: 600; }
.mc-trans-fail ul { margin: 4px 0 0; padding-left: 17px; }
.mc-trans-fail li { font-family: var(--mono); font-size: 10.5px; line-height: 1.6; overflow-wrap: anywhere; }

.mc-raw { margin-top: 13px; border: 1px solid var(--line); border-radius: 9px; background: var(--bar-bg); }
.mc-raw summary { padding: 8px 11px; font-size: 11px; color: var(--muted); cursor: pointer; }
.mc-raw pre {
  margin: 0; padding: 10px 12px; border-top: 1px solid var(--line-soft);
  font: 400 10.5px/1.6 var(--mono); color: var(--text-2); overflow: auto; max-height: 260px;
}
.mc-muted-line, .mc-loading-line { margin: 8px 0 0; font-size: 11.5px; color: var(--muted); }
.mc-loading-line { display: flex; align-items: center; gap: 7px; }

.mc-drv-foot {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--line); background: var(--bar-bg);
}
.mc-drv-foot .sp { flex: 1; }

/* ===== 登记模态 ===== */
.mc-mdl {
  position: fixed; z-index: 120; left: 50%; top: 6vh;
  width: min(570px, calc(100vw - 32px)); max-height: 88vh; overflow: auto;
  background: var(--panel); border: 1px solid var(--line); border-radius: 16px;
  box-shadow: 0 30px 90px -24px rgba(16, 24, 40, .5);
  opacity: 0; pointer-events: none;
  transform: translate(-50%, -8px) scale(.985);
  transition: opacity .18s, transform .18s;
}
.mc-mdl.show { opacity: 1; pointer-events: auto; transform: translate(-50%, 0) scale(1); }
.mc-mdl-head { display: flex; align-items: flex-start; gap: 12px; padding: 18px 20px 0; }
.mc-mdl-head .mh { flex: 1; min-width: 0; }
.mc-mdl-head h2 { margin: 0; font-size: 17px; font-weight: 700; }
.mc-mdl-head p { margin: 5px 0 0; font-size: 12px; color: var(--muted); }
.mc-mdl-body { padding: 16px 20px 4px; }
.mc-field { margin-bottom: 14px; }
.mc-field > label { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; margin-bottom: 6px; }
.mc-field > label .req { color: var(--brand); }
.mc-field > label .hint { font-size: 10.5px; font-weight: 400; color: var(--muted); margin-left: auto; }
.mc-inp, .mc-ta {
  width: 100%; border: 1px solid var(--line); border-radius: 8px; background: var(--panel);
  padding: 8px 10px; font-size: 12.5px; font-weight: 400; line-height: 1.5; color: var(--text); outline: none;
}
.mc-inp { height: 35px; padding: 0 10px; }
.mc-inp:focus, .mc-ta:focus { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-weak); }
.mc-ta { min-height: 62px; resize: vertical; font-family: var(--mono); font-size: 11.5px; }
.mc-inp.script { font-family: var(--mono); font-size: 12px; }
.mc-reg-seg { width: fit-content; margin-bottom: 0; }
.mc-reg-seg button { height: 30px; padding: 0 12px; font-size: 12px; }
.mc-sec-note { margin: -4px 0 0; font-size: 11.5px; color: var(--muted); line-height: 1.65; }

.mc-chk-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
.mc-chk-hint { font-size: 11px; color: var(--muted); line-height: 1.6; }

.mc-reg-prog { display: flex; align-items: center; gap: 9px; margin-top: 13px; font-size: 11.5px; color: var(--muted); }
.mc-reg-prog .bar { flex: 1; height: 5px; border-radius: 999px; background: var(--code-bg); overflow: hidden; }
.mc-reg-prog .bar i { display: block; width: 38%; height: 100%; border-radius: inherit; background: var(--brand); animation: mc-indet 1.1s ease-in-out infinite; }
@keyframes mc-indet { 0% { transform: translateX(-40%); } 100% { transform: translateX(300%); } }

.mc-mdl-foot {
  display: flex; align-items: center; gap: 8px;
  padding: 14px 20px; margin-top: 14px;
  border-top: 1px solid var(--line-soft); background: var(--bar-bg);
  border-radius: 0 0 16px 16px;
}
.mc-mdl-foot .sp { flex: 1; }

/* ===== 移除确认 ===== */
.mc-cfm {
  position: fixed; z-index: 140; left: 50%; top: 50%;
  width: min(430px, calc(100vw - 32px)); padding: 20px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 24px 70px -20px rgba(16, 24, 40, .5);
  opacity: 0; pointer-events: none;
  transform: translate(-50%, -48%) scale(.985); transition: opacity .16s, transform .16s;
}
.mc-cfm.show { opacity: 1; pointer-events: auto; transform: translate(-50%, -50%) scale(1); }
.mc-cfm-ico {
  width: 38px; height: 38px; display: grid; place-items: center; margin-bottom: 12px;
  border-radius: 11px; background: var(--danger-weak); color: var(--danger);
}
.mc-cfm-ico svg { width: 18px; height: 18px; }
.mc-cfm h3 { margin: 0; font-size: 15px; font-weight: 650; overflow-wrap: anywhere; }
.mc-cfm p { margin: 6px 0 0; font-size: 12px; color: var(--muted); line-height: 1.65; }
.mc-cfm-err { margin-top: 11px; }
.mc-cfm-btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }

/* ===== 响应式 ===== */
@media (max-width: 980px) {
  .mc-grid { grid-template-columns: 1fr; }
  .mc-stats { grid-template-columns: 1fr 1fr; }
  .mc-stat:nth-child(3) { border-left: none; border-top: 1px solid var(--line-soft); }
  .mc-stat:nth-child(4) { border-top: 1px solid var(--line-soft); }
}
@media (max-width: 700px) {
  .mc-head { flex-direction: column; align-items: flex-start; gap: 14px; }
  .mc-actions { margin-left: 0; width: 100%; }
  .mc-actions .mc-btn.primary { flex: 1; }
  .mc-search { max-width: none; flex-basis: 100%; }
  .mc-count { display: none; }
  .mc-tool-filter { width: 100%; flex-basis: 100%; }
  .mc-tools-head { flex-wrap: wrap; }
}

/* ===== 深色微调 ===== */
:global(:root[data-theme='dark']) .mc-card { box-shadow: none; }
:global(:root[data-theme='dark']) .mc-tile { box-shadow: inset 0 1px 0 rgba(255, 255, 255, .16), 0 2px 8px -3px rgba(0, 0, 0, .5); }
@media (prefers-color-scheme: dark) {
  :global(:root:not([data-theme='light'])) .mc-card { box-shadow: none; }
}
</style>
