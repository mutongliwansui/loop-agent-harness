<script setup lang="ts">
// 工具管理视图（原型-20261109-003 · 卡片流 + 抽屉 + 分段/排序/toggle + 视觉门控）
// 端点：GET /tools · GET /tools/:name（schema）· PATCH /tools/:name {enabled} · POST /tools/reload
//      · GET /vision（门控 analyzeImage）；仅展示内置工具，MCP 工具归 MCP 服务器页
// 需求 20261112-008：工具启停配置只剩全局一份，不再提供写入范围选择
// 纯逻辑（家族/统计/筛选/排序/Schema 解析）见 ../tool-ui.ts
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, ApiError, AuthError } from '../api/client';
import { showToast } from '../toast';
import { errText } from '../utils';
import { highlightSegments } from '../skills-ui';
import {
  builtinTools,
  classifyFamily,
  familyLabel,
  filterTools,
  parseSchemaParams,
  sortTools,
  toolCounts,
  toolInitials,
  withFamily,
  type FamilyTool,
  type ToolRow,
  type ToolSchema,
  type ToolSort,
  type ToolTab,
} from '../tool-ui';

/* ===== 状态 ===== */
const tools = ref<ToolRow[]>([]);
const visionAvailable = ref(true);
const visionReason = ref('');
const loading = ref(true);
const busy = ref(false);
const loadErr = ref('');
const query = ref('');
const tab = ref<ToolTab>('all');
const sortMode = ref<ToolSort>('name');
const searchInput = ref<HTMLInputElement | null>(null);

/* ===== 工具列表（仅内置，含 family 补充字段） ===== */
const visionGatedPrefixes = ['analyzeImage'];
function isVisionTool(name: string): boolean {
  return visionGatedPrefixes.some((p) => name === p || name.startsWith(p + '__'));
}

const allList = computed<FamilyTool[]>(() =>
  withFamily(builtinTools(tools.value)),
);
const counts = computed(() => toolCounts(allList.value));
const visibleList = computed<FamilyTool[]>(() =>
  sortTools(filterTools(allList.value, query.value, tab.value), sortMode.value),
);

const tabs = computed<{ key: ToolTab; label: string; count: number }[]>(() => [
  { key: 'all', label: '全部', count: counts.value.total },
  { key: 'enabled', label: '已启用', count: counts.value.enabled },
  { key: 'disabled', label: '已禁用', count: counts.value.disabled },
]);

/* ===== 卡片 ⋯ 菜单 ===== */
const menuTool = ref<FamilyTool | null>(null);
const menuPos = ref({ top: 0, left: 0 });

/* ===== 详情抽屉 ===== */
interface ToolDetail extends ToolRow { schema?: ToolSchema }
const drawerName = ref<string | null>(null);
const drawerDetail = ref<ToolDetail | null>(null);
const drawerErr = ref('');
const drawerLoading = ref(false);
const drawerParams = computed(() => parseSchemaParams(drawerDetail.value?.schema));
const drawerRawJson = computed(() =>
  drawerDetail.value?.schema ? JSON.stringify(drawerDetail.value.schema, null, 2) : '',
);

/* ===== 辅助 ===== */
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

/* ===== 列表加载 ===== */
async function refresh(silent = false): Promise<void> {
  if (!silent) busy.value = true;
  try {
    const [tRes, vRes] = await Promise.all([
      api<{ tools: ToolRow[] }>('/tools').catch(() => ({ tools: [] as ToolRow[] })),
      api<{ available: boolean; reason?: string }>('/vision').catch(() => ({ available: true, reason: undefined as string | undefined })),
    ]);
    tools.value = tRes.tools;
    visionAvailable.value = vRes.available !== false;
    visionReason.value = vRes.reason ?? '';
    loadErr.value = '';
    // 静默刷新后若抽屉仍指向存在的工具，不必关闭
    if (!silent) loading.value = false;
  } catch (e) {
    guard(e, '加载工具失败');
    if (!silent) loadErr.value = describe(e);
  } finally {
    if (!silent) busy.value = false;
  }
}

async function reload(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const res = await api<{ reloaded: number }>('/tools/reload', { method: 'POST' });
    showToast(`工具已重载：${res.reloaded} 个`, 'success');
    await refresh(false);
  } catch (e) {
    guard(e, '重载失败');
  } finally {
    busy.value = false;
  }
}

/* ===== toggle ===== */
async function toggle(t: ToolRow): Promise<void> {
  busy.value = true;
  const next = !t.enabled;
  try {
    await api(`/tools/${encodeURIComponent(t.name)}`, {
      method: 'PATCH',
      json: { enabled: next },
    });
    showToast(
      next
        ? `工具已启用：${t.name}`
        : `工具已禁用：${t.name}（运行中的会话继续可用）`,
      'success',
    );
    await refresh(false);
  } catch (e) {
    guard(e, '切换失败');
  } finally {
    busy.value = false;
  }
}

/* ===== 抽屉 ===== */
async function openDrawer(t: FamilyTool): Promise<void> {
  menuTool.value = null;
  drawerName.value = t.name;
  drawerDetail.value = null;
  drawerErr.value = '';
  drawerLoading.value = true;
  try {
    const res = await api<ToolDetail>(`/tools/${encodeURIComponent(t.name)}`);
    if (drawerName.value !== t.name) return;
    drawerDetail.value = res;
  } catch (e) {
    guard(e, '读取工具详情失败');
    if (drawerName.value === t.name) drawerErr.value = describe(e);
  } finally {
    if (drawerName.value === t.name) drawerLoading.value = false;
  }
}
function closeDrawer(): void {
  drawerName.value = null;
  drawerDetail.value = null;
  drawerErr.value = '';
  drawerLoading.value = false;
}

/* ===== 菜单 ===== */
function openMenu(ev: MouseEvent, t: FamilyTool): void {
  if (menuTool.value?.name === t.name) {
    menuTool.value = null;
    return;
  }
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  menuPos.value = {
    top: Math.min(r.bottom + 6, window.innerHeight - 214),
    left: Math.max(8, Math.min(r.right - 188, window.innerWidth - 196)),
  };
  menuTool.value = t;
}

async function copyName(): Promise<void> {
  const t = menuTool.value;
  if (!t) return;
  menuTool.value = null;
  try {
    await navigator.clipboard.writeText(t.name);
    showToast(`已复制工具名：${t.name}`, 'success');
  } catch {
    showToast('复制失败，请手动选择文本', 'error');
  }
}

/* ===== 键盘与点击外部 ===== */
function closeAllOverlays(): boolean {
  if (menuTool.value) { menuTool.value = null; return true; }
  if (drawerName.value) { closeDrawer(); return true; }
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
function onDocClick(): void { menuTool.value = null; }
function onWinScroll(): void { menuTool.value = null; }

let autoRefresh: ReturnType<typeof setInterval> | undefined;

onMounted(async () => {
  loading.value = true;
  await refresh(false);
  autoRefresh = setInterval(() => {
    if (!busy.value && !document.hidden) void refresh(true);
  }, 30000);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('click', onDocClick);
  window.addEventListener('scroll', onWinScroll, true);
  window.addEventListener('resize', onWinScroll);
});

onBeforeUnmount(() => {
  if (autoRefresh) clearInterval(autoRefresh);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('click', onDocClick);
  window.removeEventListener('scroll', onWinScroll, true);
  window.removeEventListener('resize', onWinScroll);
});
</script>

<template>
  <div class="page tl-page">
    <!-- 页头 -->
    <div class="tl-head">
      <div class="lead">
        <div class="tl-eyebrow">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5.5h10v5H3z"/><path d="M6 8h4"/></svg>
          Tool registry · 工具注册表
        </div>
        <h1>工具</h1>
        <p>Agent 可调用的内置工具。禁用后会从 prompt schema 中移除，运行中的会话继续可用；重载影响新会话。</p>
      </div>
      <div class="tl-actions">
        <button class="tl-btn icon" type="button" title="刷新列表" aria-label="刷新列表" :disabled="busy" @click="refresh(false)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.8V5h-2.2"/></svg>
        </button>
        <button class="tl-btn" type="button" :disabled="busy" @click="reload">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.4 8a5.6 5.6 0 0 1 9.6-4"/><path d="M13.6 8a5.6 5.6 0 0 1-9.6 4"/><path d="M12.4 1.8v2.8h-2.8M3.6 14.2v-2.8h2.8"/></svg>
          重载
        </button>
      </div>
    </div>

    <!-- 统计条 -->
    <div class="tl-stats">
      <div class="tl-stat"><div class="k"><i class="on"></i>工具总数</div><div class="v">{{ counts.total }}<small>个</small></div></div>
      <div class="tl-stat"><div class="k"><i class="on"></i>已启用</div><div class="v">{{ counts.enabled }}<small>个</small></div></div>
      <div class="tl-stat"><div class="k"><i class="bad"></i>已禁用</div><div class="v bad">{{ counts.disabled }}<small>个</small></div></div>
    </div>

    <!-- 工具条 -->
    <div class="tl-toolbar">
      <div class="tl-search">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.5 13.5"/></svg>
        <input ref="searchInput" v-model="query" type="text" placeholder="搜索名称或描述" autocomplete="off" spellcheck="false">
        <kbd>/</kbd>
      </div>
      <div class="tl-seg" role="tablist" aria-label="按状态筛选">
        <button
          v-for="t in tabs"
          :key="t.key"
          type="button"
          role="tab"
          :aria-selected="tab === t.key"
          :class="{ on: tab === t.key }"
          @click="tab = t.key"
        >{{ t.label }} <span class="n">{{ t.count }}</span></button>
      </div>
      <select v-model="sortMode" class="tl-sort" aria-label="排序方式">
        <option value="name">名称 A→Z</option>
        <option value="family">按家族分组</option>
        <option value="disabled">禁用优先</option>
      </select>
      <span class="tl-count">{{ visibleList.length }} / {{ counts.total }} 个工具</span>
    </div>

    <div v-if="loadErr && tools.length > 0" class="tl-alert err">
      <span class="ai">✕</span>
      <div><b>列表加载失败</b><div>{{ loadErr }}</div></div>
      <span class="spring"></span>
      <button class="tl-btn sm" type="button" @click="refresh(false)">重新加载</button>
    </div>

    <!-- 骨架 -->
    <div v-if="loading" class="tl-grid" aria-busy="true">
      <div v-for="i in 4" :key="i" class="tl-skel">
        <span class="t"></span>
        <div class="l"><i style="width:38%"></i><i style="width:86%"></i><i style="width:64%"></i><i style="width:52%"></i></div>
      </div>
    </div>

    <!-- 空库 -->
    <div v-else-if="tools.length === 0" class="tl-grid">
      <div class="tl-nothing">
        <span class="nt-ico">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5.5h10v5H3z"/><path d="M6 8h4"/></svg>
        </span>
        <b>{{ loadErr ? '无法加载工具列表' : '还没有任何工具' }}</b>
        <p>{{ loadErr || '刷新页面重试，或检查后端是否正常运行。' }}</p>
        <button v-if="loadErr" class="tl-btn" type="button" @click="refresh(false)">重新加载</button>
        <button v-else class="tl-btn primary" type="button" @click="reload">⟳ 重载工具</button>
      </div>
    </div>

    <!-- 无匹配 -->
    <div v-else-if="visibleList.length === 0" class="tl-grid">
      <div class="tl-nothing">
        <span class="nt-ico">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.5 13.5"/></svg>
        </span>
        <b>没有匹配的工具</b>
        <p>清空搜索，或切回「全部」分段。</p>
        <button class="tl-btn" type="button" @click="query = ''; tab = 'all'">清空筛选</button>
      </div>
    </div>

    <!-- 卡片流 -->
    <div v-else class="tl-grid">
      <article
        v-for="t in visibleList"
        :key="t.name"
        class="tl-card"
        :class="{
          disabled: !t.enabled,
          'vision-off': !visionAvailable && isVisionTool(t.name),
        }"
      >
        <div class="tl-top">
          <span
            class="tile"
            :class="[
              classifyFamily(t.name),
              !t.enabled || (!visionAvailable && isVisionTool(t.name)) ? 'disabled' : '',
            ]"
          >{{ toolInitials(t.name) }}</span>
          <div class="tl-id">
            <div class="tl-title">
              <h3>
                <template v-for="(seg, i) in highlightSegments(t.name, query)" :key="i">
                  <mark v-if="seg.hit">{{ seg.text }}</mark><template v-else>{{ seg.text }}</template>
                </template>
              </h3>
              <span
                class="tl-group"
                :class="{ mute: !t.enabled }"
              >{{ familyLabel(classifyFamily(t.name)) }}</span>
              <span
                class="tl-pill"
                :class="t.enabled ? 'on' : 'off'"
              ><i></i>{{ t.enabled ? '已启用' : '已禁用' }}</span>
            </div>
            <p class="tl-desc">
              <template v-if="!visionAvailable && isVisionTool(t.name)">
                <span class="vision-warn">视觉未启用：{{ visionReason || '未检测到可用视觉 Provider' }}，</span>
              </template>
              {{ t.description || '（无描述）' }}
            </p>
          </div>
          <button class="tl-more" type="button" aria-label="更多操作" @click.stop="openMenu($event, t)">
            <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>
          </button>
        </div>

        <div class="tl-foot">
          <span class="tl-meta">内置</span>
          <span class="spring"></span>
          <button
            class="tl-toggle"
            :class="{ on: t.enabled }"
            :title="t.enabled ? '点击禁用' : '点击启用'"
            :aria-label="t.enabled ? '禁用工具' : '启用工具'"
            @click.stop="toggle(t)"
          ></button>
          <button class="tl-btn sm ghost" type="button" @click.stop="openDrawer(t)">Schema</button>
        </div>
      </article>
    </div>

    <div class="tl-footline">
      <span>GET /tools · PATCH /tools/:name · 视觉门控：GET /vision · 静默刷新 30s</span>
      <span class="sp"></span>
      <span>共 {{ counts.total }} 个工具</span>
    </div>

    <!-- 卡片 ⋯ 菜单 -->
    <div
      v-if="menuTool"
      class="tl-menu"
      role="menu"
      :style="{ top: menuPos.top + 'px', left: menuPos.left + 'px' }"
      @click.stop
    >
      <div class="m-head">{{ menuTool.name }}</div>
      <button type="button" role="menuitem" @click="openDrawer(menuTool)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5h10v11H3z"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/></svg>
        查看 Schema
      </button>
      <button type="button" role="menuitem" @click="copyName">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.2" y="5.2" width="6.8" height="8" rx="1.2"/><path d="M10.4 5.2V3.4H3.6v8h1.6"/></svg>
        复制工具名
      </button>
      <div class="hr"></div>
      <button
        v-if="menuTool.enabled"
        type="button"
        role="menuitem"
        class="danger"
        @click="toggle(menuTool); menuTool = null"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 8h10"/></svg>
        禁用
      </button>
      <button
        v-else
        type="button"
        role="menuitem"
        @click="toggle(menuTool); menuTool = null"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M3 8h10"/></svg>
        启用
      </button>
    </div>

    <!-- 详情抽屉 -->
    <div class="tl-backdrop" :class="{ show: !!drawerName }" @click="closeDrawer"></div>
    <aside class="tl-drawer" :class="{ show: !!drawerName }" role="dialog" aria-modal="true" :aria-label="drawerDetail?.name || '工具详情'">
      <template v-if="drawerDetail">
        <div class="tl-drv-head">
          <span
            class="tile"
            :class="[
              classifyFamily(drawerDetail.name),
              !drawerDetail.enabled ? 'disabled' : '',
            ]"
          >{{ toolInitials(drawerDetail.name) }}</span>
          <div class="tl-drv-title">
            <h2>
              {{ drawerDetail.name }}
              <span class="tl-group">{{ familyLabel(classifyFamily(drawerDetail.name)) }}</span>
              <span
                class="tl-pill"
                :class="drawerDetail.enabled ? 'on' : 'off'"
              ><i></i>{{ drawerDetail.enabled ? '已启用' : '已禁用' }}</span>
            </h2>
            <div class="tl-drv-sub">
              <span>内置工具</span>
              <span>·</span>
              <span>配置统一保存于全局</span>
            </div>
          </div>
          <button class="tl-close-btn" type="button" aria-label="关闭详情" @click="closeDrawer">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m4 4 8 8M12 4l-8 8"/></svg>
          </button>
        </div>

        <div class="tl-drv-body">
          <div class="tl-lab">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5h10v11H3z"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3"/></svg>
            描述
          </div>
          <div class="tl-desc-card">{{ drawerDetail.description || '（后端未提供描述）' }}</div>

          <div class="tl-lab">基本信息</div>
          <table class="kv">
            <tbody>
              <tr><td class="k">名称</td><td class="v mono">{{ drawerDetail.name }}</td></tr>
              <tr><td class="k">来源</td><td class="v">内置工具</td></tr>
              <tr><td class="k">启用</td><td class="v">{{ drawerDetail.enabled ? '是' : '否' }}</td></tr>
            </tbody>
          </table>

          <div class="tl-lab">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5 3.5 10h3L5.5 14l4.5-7h-3L8 2.5Z"/></svg>
            参数 Schema
            <span class="n">{{ drawerParams.length }}</span>
          </div>
          <div v-if="drawerLoading" class="tl-loading-line">正在读取 Schema…</div>
          <div v-else-if="drawerErr" class="tl-alert err">
            <span class="ai">✕</span>
            <div><b>Schema 查询失败</b><div>{{ drawerErr }}</div></div>
          </div>
          <p v-else-if="drawerParams.length === 0" class="tl-muted-line">该工具无参数（schema 未提供 properties）。</p>
          <table v-else class="param-tbl">
            <thead><tr><th style="width:17%">名称</th><th style="width:13%">类型</th><th style="width:11%">必填</th><th>描述</th></tr></thead>
            <tbody>
              <tr v-for="p in drawerParams" :key="p.name">
                <td class="n">{{ p.name }}</td>
                <td class="t">{{ p.type || '—' }}</td>
                <td class="r" :class="{ yes: p.required }">{{ p.required ? '是' : '否' }}</td>
                <td class="d">{{ p.desc || '—' }}</td>
              </tr>
            </tbody>
          </table>

          <details v-if="drawerDetail.schema" class="raw-schema">
            <summary>原始 Schema JSON · GET /tools/{{ drawerDetail.name }}</summary>
            <pre>{{ drawerRawJson }}</pre>
          </details>
        </div>

        <div class="tl-drv-foot">
          <button class="tl-btn ghost sm" type="button" @click="closeDrawer">关闭</button>
          <span class="sp"></span>
          <button
            class="tl-btn sm"
            type="button"
            :disabled="busy"
            @click="toggle(drawerDetail); closeDrawer()"
          >{{ drawerDetail.enabled ? '禁用' : '启用' }}</button>
        </div>
      </template>
    </aside>
  </div>
</template>

<style scoped>
/* ===== 页头 ===== */
.tl-page { }
.tl-head { display: flex; align-items: flex-end; gap: 20px; flex-wrap: wrap; }
.tl-head .lead { min-width: 0; }
.tl-eyebrow {
  display: flex; align-items: center; gap: 6px;
  font-size: 10.5px; font-weight: 600; letter-spacing: .14em;
  text-transform: uppercase; color: var(--muted);
}
.tl-eyebrow svg { width: 12px; height: 12px; color: var(--brand); }
.tl-head h1 { margin: 3px 0 0; font-size: 24px; font-weight: 700; line-height: 1.2; letter-spacing: -.01em; }
.tl-head p { margin: 7px 0 0; font-size: 12.5px; color: var(--muted); max-width: 66ch; }
.tl-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }

.tl-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  height: 34px; padding: 0 13px;
  border: 1px solid var(--line); border-radius: 9px;
  background: var(--panel); color: var(--text-2);
  font-size: 12.5px; font-weight: 500; line-height: 1; cursor: pointer; white-space: nowrap;
  transition: border-color .13s, background .13s, color .13s, filter .13s;
}
.tl-btn:hover { border-color: var(--line-strong); color: var(--text); background: var(--bar-bg); }
.tl-btn svg { width: 15px; height: 15px; flex: none; }
.tl-btn.primary { background: var(--brand); border-color: var(--brand); color: var(--brand-on); font-weight: 600; box-shadow: 0 1px 2px rgba(14, 159, 110, .22); }
.tl-btn.primary:hover { filter: brightness(1.05); background: var(--brand); color: var(--brand-on); }
.tl-btn.icon { width: 34px; padding: 0; }
.tl-btn.sm { height: 27px; padding: 0 9px; font-size: 11.5px; border-radius: 7px; }
.tl-btn.ghost { background: transparent; }
.tl-btn:disabled { opacity: .5; cursor: not-allowed; filter: none; }

/* ===== 统计条 ===== */
.tl-stats {
  display: grid; grid-template-columns: repeat(3, 1fr);
  margin-top: 20px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
}
.tl-stat { padding: 11px 16px 12px; border-left: 1px solid var(--line-soft); min-width: 0; }
.tl-stat:first-child { border-left: none; }
.tl-stat .k { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
.tl-stat .k i { width: 5px; height: 5px; border-radius: 50%; background: var(--line-strong); flex: none; }
.tl-stat .k i.on { background: var(--brand); }
.tl-stat .k i.bad { background: var(--danger); }
.tl-stat .v { font-size: 20px; font-weight: 650; line-height: 1.3; margin-top: 1px; font-variant-numeric: tabular-nums; }
.tl-stat .v small { font-size: 11px; font-weight: 500; color: var(--muted); margin-left: 4px; }
.tl-stat .v.bad { color: var(--danger); }

/* ===== 工具条 ===== */
.tl-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 16px 0 13px; }
.tl-search {
  flex: 1; min-width: 200px; max-width: 330px;
  display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 9px;
  transition: border-color .13s, box-shadow .13s;
}
.tl-search:focus-within { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-weak); }
.tl-search svg { width: 14px; height: 14px; color: var(--muted); flex: none; }
.tl-search input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font-size: 12.5px; font-weight: 400; line-height: 1; color: var(--text); }
.tl-search input:focus { border: none; }
.tl-search kbd { font: 500 10px/1 var(--mono); color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 2px 5px; }

.tl-seg { display: flex; gap: 2px; padding: 2px; background: var(--code-bg); border-radius: 9px; }
.tl-seg button {
  display: inline-flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 10px; border: none; border-radius: 7px;
  background: transparent; color: var(--muted);
  font-size: 12px; font-weight: 500; line-height: 1; cursor: pointer;
}
.tl-seg button:hover { color: var(--text-2); }
.tl-seg button.on { background: var(--panel); color: var(--text); font-weight: 600; box-shadow: 0 1px 2px rgba(16, 24, 40, .09); }
.tl-seg .n { font: 600 10px/14px var(--mono); color: var(--muted); background: var(--panel); border-radius: 999px; padding: 0 5px; min-width: 16px; text-align: center; }
.tl-seg button.on .n { color: var(--brand); background: var(--brand-weak); }

.tl-sort {
  height: 34px; padding: 0 26px 0 10px; border: 1px solid var(--line); border-radius: 9px;
  background: var(--panel) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 16 16' fill='none' stroke='%236b7280' stroke-width='1.5'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E") no-repeat right 9px center;
  color: var(--text-2); font-size: 12px; font-weight: 500; line-height: 1; cursor: pointer; appearance: none;
}
.tl-count { font-size: 11px; color: var(--muted); white-space: nowrap; }

/* ===== 骨架 / 空态 / 无匹配 ===== */
.tl-skel { display: flex; gap: 11px; padding: 15px 16px; min-height: 110px; background: var(--panel); border: 1px solid var(--line); border-radius: 13px; }
.tl-skel .t { width: 42px; height: 42px; flex: none; border-radius: 12px; background: var(--code-bg); animation: tlSk 1.2s ease-in-out infinite; }
.tl-skel .l { flex: 1; display: flex; flex-direction: column; gap: 9px; padding-top: 4px; }
.tl-skel .l i { display: block; height: 8px; border-radius: 4px; background: var(--code-bg); animation: tlSk 1.2s ease-in-out infinite; }
.tl-skel .l i:nth-child(2) { animation-delay: .1s; width: 80%; }
.tl-skel .l i:nth-child(3) { animation-delay: .2s; width: 55%; }
@keyframes tlSk { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }

.tl-nothing { grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; padding: 34px 20px; text-align: center; border: 1px dashed var(--line-strong); border-radius: 14px; background: var(--panel); }
.tl-nothing .nt-ico { width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center; background: var(--code-bg); color: var(--muted); margin-bottom: 11px; }
.tl-nothing .nt-ico svg { width: 22px; height: 22px; }
.tl-nothing b { font-size: 13.5px; font-weight: 650; }
.tl-nothing p { margin: 5px 0 13px; font-size: 12px; color: var(--muted); max-width: 56ch; line-height: 1.65; }

/* ===== 卡片流 ===== */
.tl-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.tl-card {
  position: relative; display: flex; flex-direction: column; gap: 9px;
  padding: 14px 16px 11px; background: var(--panel); border: 1px solid var(--line); border-radius: 13px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, .03);
  transition: border-color .15s, box-shadow .15s, transform .15s;
}
.tl-card:hover { border-color: var(--line-strong); box-shadow: var(--shadow-card); transform: translateY(-1px); }
.tl-card.disabled { border-left: 3px solid var(--muted); padding-left: 14px; background: linear-gradient(180deg, var(--panel) 0%, color-mix(in srgb, var(--muted) 3%, var(--panel)) 100%); }
.tl-card.disabled::before { content: '禁用 · 不出现在 prompt schema'; position: absolute; right: 12px; top: -10px; font: 500 10px/1 var(--mono); color: var(--muted); background: var(--code-bg); border: 1px solid var(--line); padding: 3px 6px; border-radius: 999px; }
.tl-card.vision-off::before { content: '视觉未启用'; position: absolute; right: 12px; top: -10px; font: 500 10px/1 var(--mono); color: var(--warn); background: var(--warn-weak); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); padding: 3px 6px; border-radius: 999px; }

.tl-top { display: flex; align-items: flex-start; gap: 11px; min-width: 0; }
.tile { width: 42px; height: 42px; border-radius: 12px; flex: none; display: grid; place-items: center; color: #fff; font: 700 12px/1 var(--sans); letter-spacing: .04em; box-shadow: inset 0 1px 0 rgba(255, 255, 255, .22), 0 2px 7px -3px rgba(16, 24, 40, .35); }
.tile.file     { background: linear-gradient(135deg, #2563eb, #1d4ed8); }
.tile.cmd      { background: linear-gradient(135deg, #7c3aed, #6d28d9); }
.tile.session  { background: linear-gradient(135deg, #0891b2, #0e7490); }
.tile.memory   { background: linear-gradient(135deg, #be185d, #9d174d); }
.tile.vision   { background: linear-gradient(135deg, #ca8a04, #a16207); }
.tile.http     { background: linear-gradient(135deg, #ea580c, #c2410c); }
.tile.skill    { background: linear-gradient(135deg, #059669, #047857); }
.tile.other    { background: linear-gradient(135deg, #6b7280, #4b5563); }
.tile.disabled { filter: grayscale(1) opacity(.65); }

.tl-id { flex: 1; min-width: 0; }
.tl-title { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; }
.tl-title h3 { margin: 0; font: 650 14px/1.35 var(--mono); color: var(--text); overflow-wrap: anywhere; }
.tl-card.disabled .tl-title h3 { color: var(--muted); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--muted) 55%, transparent); }
.tl-group { font: 500 10.5px/1 var(--sans); color: var(--brand); background: var(--brand-weak); padding: 3px 7px; border-radius: 999px; white-space: nowrap; }
.tl-group.mute { color: var(--muted); background: var(--code-bg); }
.tl-pill { display: inline-flex; align-items: center; gap: 5px; height: 19px; padding: 0 7px; border-radius: 999px; font: 600 10.5px/1 var(--sans); white-space: nowrap; }
.tl-pill i { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.tl-pill.on { color: var(--ok); background: var(--ok-weak); }
.tl-pill.on i { background: var(--ok); }
.tl-pill.off { color: var(--muted); background: var(--code-bg); }
.tl-pill.off i { background: var(--muted); }
.tl-pill.err { color: var(--danger); background: var(--danger-weak); }
.tl-pill.err i { background: var(--danger); }

.tl-desc { margin: 3px 0 0; font-size: 12px; color: var(--text-2); line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.tl-desc .vision-warn { color: var(--warn); font-weight: 550; }

.tl-foot { display: flex; align-items: center; gap: 7px; padding-top: 9px; border-top: 1px solid var(--line-soft); flex-wrap: wrap; }
.tl-foot .tl-meta { font-size: 11px; color: var(--muted); white-space: nowrap; }
.tl-foot .sep { color: var(--line-strong); font-size: 10px; }
.tl-foot .spring { flex: 1; }

.tl-toggle { position: relative; width: 40px; height: 22px; flex: none; border-radius: 999px; cursor: pointer; background: var(--line-strong); transition: background .18s; }
.tl-toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(16, 24, 40, .22); transition: transform .18s; }
.tl-toggle.on { background: var(--brand); }
.tl-toggle.on::after { transform: translateX(18px); }

/* 顶部对齐在卡片右上角：-2px 上偏让 26px 按钮中心对齐 19px 标题行中心；
   padding: 0 重置全局 button 的 6px 10px，让 15px 图标在 26px 盒内真正居中；
   不再用 -5px 右负边距，按钮盒与卡片内容右边界对齐（与下方 Schema 按钮一致） */
.tl-more { width: 26px; height: 26px; flex: none; margin: -2px 0 0; padding: 0; display: grid; place-items: center; border: none; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; opacity: .6; }
.tl-more svg { width: 15px; height: 15px; }
.tl-card:hover .tl-more { opacity: 1; }
.tl-more:hover { background: var(--hover); color: var(--text); }

.tl-footline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 14px; padding-top: 11px; border-top: 1px solid var(--line-soft); font-size: 11px; color: var(--muted); }
.tl-footline .sp { flex: 1; }

.tl-alert { display: flex; align-items: flex-start; gap: 9px; margin-top: 12px; padding: 10px 12px; border-radius: 9px; font-size: 12px; line-height: 1.65; border: 1px solid transparent; }
.tl-alert .ai { width: 17px; height: 17px; flex: none; display: grid; place-items: center; margin-top: 1px; border-radius: 50%; border: 1px solid currentColor; font: 700 10px/1 var(--mono); }
.tl-alert .spring { flex: 1; }
.tl-alert b { font-weight: 650; }
.tl-alert.warn { color: var(--warn); background: var(--warn-weak); border-color: color-mix(in srgb, var(--warn) 35%, transparent); }
.tl-alert.err { color: var(--danger); background: var(--danger-weak); border-color: color-mix(in srgb, var(--danger) 35%, transparent); }

/* ===== 菜单 ===== */
.tl-menu { position: fixed; z-index: 96; width: 186px; padding: 4px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow-pop); }
.tl-menu .m-head { padding: 6px 9px 7px; font: 600 11px/1.3 var(--mono); color: var(--muted); border-bottom: 1px solid var(--line-soft); margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tl-menu button { display: flex; width: 100%; align-items: center; gap: 8px; padding: 7px 9px; border: none; border-radius: 6px; background: transparent; font-size: 12px; color: var(--text-2); text-align: left; cursor: pointer; }
.tl-menu button svg { width: 14px; height: 14px; color: var(--muted); flex: none; }
.tl-menu button:hover { background: var(--hover); color: var(--text); }
.tl-menu .hr { height: 1px; background: var(--line-soft); margin: 4px 2px; }
.tl-menu button.danger { color: var(--danger); }
.tl-menu button.danger svg { color: var(--danger); }
.tl-menu button.danger:hover { background: var(--danger-weak); }

/* ===== 遮罩 / 抽屉 ===== */
.tl-backdrop { position: fixed; inset: 0; z-index: 100; background: rgba(16, 24, 40, .4); backdrop-filter: blur(2px); opacity: 0; pointer-events: none; transition: opacity .2s; }
.tl-backdrop.show { opacity: 1; pointer-events: auto; }
.tl-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 110;
  width: min(520px, 100%); display: flex; flex-direction: column;
  background: var(--panel); border-left: 1px solid var(--line);
  box-shadow: -24px 0 64px -24px rgba(16, 24, 40, .45);
  transform: translateX(102%); visibility: hidden;
  transition: transform .26s cubic-bezier(.2, .8, .2, 1), visibility .26s;
}
.tl-drawer.show { transform: none; visibility: visible; }
.tl-drv-head { display: flex; align-items: flex-start; gap: 12px; padding: 18px 20px 16px; border-bottom: 1px solid var(--line-soft); }
.tl-drv-head .tile { width: 46px; height: 46px; border-radius: 13px; font-size: 13px; }
.tl-drv-title { flex: 1; min-width: 0; }
.tl-drv-title h2 { margin: 0; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font: 650 16px/1.35 var(--mono); color: var(--text); overflow-wrap: anywhere; }
.tl-drv-sub { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-top: 4px; font-size: 11px; color: var(--muted); }
.tl-close-btn { width: 30px; height: 30px; flex: none; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--muted); cursor: pointer; margin: -3px -4px 0 0; }
.tl-close-btn:hover { background: var(--code-bg); color: var(--text); }
.tl-close-btn svg { width: 14px; height: 14px; }

.tl-drv-body { flex: 1; overflow: auto; padding: 16px 20px 28px; }
.tl-lab { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; color: var(--muted); margin: 17px 0 8px; }
.tl-lab:first-child { margin-top: 0; }
.tl-lab svg { width: 12px; height: 12px; }
.tl-lab .n { font-family: var(--mono); color: var(--brand); background: var(--brand-weak); border-radius: 999px; padding: 0 6px; font-size: 10px; margin-left: 4px; }

.tl-desc-card { padding: 10px 12px; border-radius: 9px; background: var(--bar-bg); border: 1px solid var(--line); font-size: 12.5px; color: var(--text-2); line-height: 1.75; }

.kv { width: 100%; border-collapse: collapse; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
.kv tr + tr td { border-top: 1px solid var(--line-soft); }
.kv td { padding: 7px 11px; font-size: 12px; vertical-align: top; }
.kv td.k { width: 104px; color: var(--muted); font-size: 11.5px; background: var(--bar-bg); }
.kv td.v { color: var(--text-2); overflow-wrap: anywhere; }
.kv td.v.mono { font-family: var(--mono); }
.kv code { font: 500 11px/1.5 var(--mono); background: var(--code-bg); padding: 2px 5px; border-radius: 4px; }

.param-tbl { width: 100%; border-collapse: collapse; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; font-size: 11.5px; }
.param-tbl th { text-align: left; padding: 7px 10px; background: var(--bar-bg); color: var(--muted); font-size: 11px; font-weight: 600; border-bottom: 1px solid var(--line-soft); }
.param-tbl td { padding: 7px 10px; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
.param-tbl tr:last-child td { border-bottom: none; }
.param-tbl td.n { font-family: var(--mono); color: var(--brand); white-space: nowrap; }
.param-tbl td.t { font-family: var(--mono); color: var(--muted); white-space: nowrap; }
.param-tbl td.r { color: var(--muted); }
.param-tbl td.r.yes { color: var(--danger); font-weight: 600; }
.param-tbl td.d { color: var(--text-2); line-height: 1.55; }

.raw-schema { border: 1px solid var(--line); border-radius: 9px; overflow: hidden; margin-top: 10px; }
.raw-schema summary { padding: 8px 11px; font-size: 11px; color: var(--muted); cursor: pointer; background: var(--bar-bg); }
.raw-schema pre { margin: 0; padding: 10px 12px; border-top: 1px solid var(--line-soft); font: 400 10.5px/1.6 var(--mono); color: var(--text-2); overflow: auto; max-height: 260px; }

.tl-muted-line { font-size: 12px; color: var(--muted); padding: 8px 12px; background: var(--code-bg); border-radius: 8px; }
.tl-loading-line { font-size: 12px; color: var(--muted); }

.tl-drv-foot { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--bar-bg); }
.tl-drv-foot .sp { flex: 1; }

/* ===== 响应式 ===== */
@media (max-width: 980px) {
  .tl-grid { grid-template-columns: 1fr; }
}
@media (max-width: 700px) {
  .tl-head { flex-direction: column; align-items: flex-start; gap: 14px; }
  .tl-actions { margin-left: 0; width: 100%; }
  .tl-search { max-width: none; flex-basis: 100%; }
  .tl-sort { width: 100%; }
  .tl-count { margin-left: 0; width: 100%; text-align: right; }
}
</style>
