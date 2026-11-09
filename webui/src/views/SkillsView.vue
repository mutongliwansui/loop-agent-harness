<script setup lang="ts">
// 技能视图（原型-20261109-001 方案 B：卡片流 + 详情抽屉 + 安装模态 + 状态矩阵）
// 端点不变：GET /skills · GET /skills/:name（正文）· POST /skills/upload（同名未 overwrite 409）
//           DELETE /skills/:name（缺省 auto）· POST /skills/reload（装/删后自动重载）
// 纯逻辑（搜索 / 筛选 / 排序 / 高亮 / zip 校验）见 ../skills-ui.ts
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, ApiError, AuthError } from '../api/client';
import { highlightIn, renderMarkdown } from '../markdown';
import { showToast } from '../toast';
import { errText } from '../utils';
import {
  filterSkills,
  fmtAgo,
  fmtSize,
  highlightSegments,
  scopeCounts,
  scopeHint,
  scopeLabel,
  skillInitials,
  sortSkills,
  validateZipFile,
  type ScopeTab,
  type SkillRow,
  type SortMode,
} from '../skills-ui';

const skills = ref<SkillRow[]>([]);
const loading = ref(false);
const busy = ref(false);
const loadErr = ref('');
const syncAt = ref<number | null>(null);
const nowTick = ref(Date.now());

const query = ref('');
const scopeTab = ref<ScopeTab>('all');
const sortMode = ref<SortMode>('scope');
const searchInput = ref<HTMLInputElement | null>(null);

const tabs: { key: ScopeTab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'workspace', label: '工作空间' },
  { key: 'global', label: '全局' },
];

const counts = computed(() => scopeCounts(skills.value));
const filtered = computed(() => sortSkills(filterSkills(skills.value, query.value, scopeTab.value), sortMode.value));
const syncLabel = computed(() => (syncAt.value ? fmtAgo(syncAt.value, nowTick.value) : '—'));

/* ===== 详情抽屉 ===== */
const detail = ref<SkillRow | null>(null);
const detailBody = ref('');
const detailErr = ref('');
const detailLoading = ref(false);
const detailHtml = computed(() => renderMarkdown(detailBody.value));
const mdRef = ref<HTMLElement | null>(null);

/* ===== 卡片 ⋯ 菜单 ===== */
const menuSkill = ref<SkillRow | null>(null);
const menuPos = ref({ top: 0, left: 0 });

/* ===== 安装模态 ===== */
const showInstall = ref(false);
const installing = ref(false);
const dzOver = ref(false);
const zipInput = ref<HTMLInputElement | null>(null);
const overwrite = ref(false);
const installScope = ref<'workspace' | 'global'>('workspace');
const installErr = ref('');
const pickErr = ref('');

interface Picked {
  zipName: string;
  rootName: string;
  size: number;
  file: File;
}
const picked = ref<Picked | null>(null);

/* ===== 卸载确认 ===== */
const confirmSkill = ref<SkillRow | null>(null);

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

/* ===== 列表读写 ===== */
async function refresh(): Promise<void> {
  busy.value = true;
  try {
    const res = await api<{ skills: SkillRow[] }>('/skills');
    skills.value = res.skills;
    loadErr.value = '';
    syncAt.value = Date.now();
    menuSkill.value = null;
  } catch (e) {
    guard(e, '加载技能失败');
    loadErr.value = describe(e);
  } finally {
    busy.value = false;
  }
}

async function reload(): Promise<void> {
  busy.value = true;
  try {
    const res = await api<{ loaded: number }>('/skills/reload', { method: 'POST' });
    showToast(`Skill 已重新扫描：${res.loaded} 个`, 'success');
    await refresh();
  } catch (e) {
    guard(e, '重载失败');
  } finally {
    busy.value = false;
  }
}

/* ===== 详情 ===== */
async function openDetail(s: SkillRow): Promise<void> {
  menuSkill.value = null;
  detail.value = s;
  detailBody.value = '';
  detailErr.value = '';
  detailLoading.value = true;
  try {
    const res = await api<{ body: string }>(`/skills/${encodeURIComponent(s.name)}`);
    if (detail.value?.name !== s.name) return;
    detailBody.value = res.body;
    await nextTick();
    if (mdRef.value) highlightIn(mdRef.value);
  } catch (e) {
    guard(e, '查看失败');
    if (detail.value?.name === s.name) detailErr.value = describe(e);
  } finally {
    if (detail.value?.name === s.name) detailLoading.value = false;
  }
}

function closeDetail(): void {
  detail.value = null;
  detailBody.value = '';
  detailErr.value = '';
  detailLoading.value = false;
}

async function copyPath(p: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(p);
    showToast('路径已复制', 'success');
  } catch {
    showToast('复制失败，请手动选择路径', 'error');
  }
}

/* ===== 卡片菜单 ===== */
function openMenu(ev: MouseEvent, s: SkillRow): void {
  if (menuSkill.value?.name === s.name) {
    menuSkill.value = null;
    return;
  }
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  menuPos.value = {
    top: Math.min(r.bottom + 6, window.innerHeight - 170),
    left: Math.max(8, Math.min(r.right - 178, window.innerWidth - 186)),
  };
  menuSkill.value = s;
}

function menuView(): void {
  const s = menuSkill.value;
  if (s) void openDetail(s);
}

function menuCopy(): void {
  const s = menuSkill.value;
  if (!s) return;
  menuSkill.value = null;
  void copyPath(s.path);
}

function menuDelete(): void {
  const s = menuSkill.value;
  if (!s) return;
  menuSkill.value = null;
  confirmSkill.value = s;
}

/* ===== 卸载 ===== */
async function doDelete(): Promise<void> {
  const s = confirmSkill.value;
  if (!s || busy.value) return;
  busy.value = true;
  try {
    const res = await api<{ scope: string }>(`/skills/${encodeURIComponent(s.name)}`, { method: 'DELETE' });
    showToast(`Skill 已卸载：${s.name}（${scopeLabel(res.scope)}）`, 'success');
    confirmSkill.value = null;
    if (detail.value?.name === s.name) closeDetail();
    await refresh();
  } catch (e) {
    guard(e, '卸载失败');
  } finally {
    busy.value = false;
  }
}

/* ===== 安装 ===== */
function openInstall(): void {
  if (busy.value) return;
  showInstall.value = true;
  picked.value = null;
  pickErr.value = '';
  installErr.value = '';
  overwrite.value = false;
  installScope.value = 'workspace';
}

function closeInstall(): void {
  if (installing.value) return;
  showInstall.value = false;
  dzOver.value = false;
}

function acceptFile(f: File): void {
  const check = validateZipFile(f.name, f.size);
  if (!check.ok) {
    picked.value = null;
    pickErr.value = check.error;
    installErr.value = '';
    return;
  }
  picked.value = { zipName: f.name, rootName: check.rootName, size: f.size, file: f };
  pickErr.value = '';
  installErr.value = '';
}

function onPickZip(): void {
  zipInput.value?.click();
}

function onZipChange(e: Event): void {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (f) acceptFile(f);
}

function onDragOver(e: DragEvent): void {
  e.preventDefault();
  dzOver.value = true;
}

function onDrop(e: DragEvent): void {
  e.preventDefault();
  dzOver.value = false;
  const f = e.dataTransfer?.files?.[0];
  if (f) acceptFile(f);
}

function clearPicked(): void {
  picked.value = null;
  pickErr.value = '';
  installErr.value = '';
}

async function fileToBase64(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function install(): Promise<void> {
  const p = picked.value;
  if (!p || installing.value) return;
  installErr.value = '';
  installing.value = true;
  busy.value = true;
  try {
    const zipBase64 = await fileToBase64(p.file);
    const res = await api<{ name: string; scope: string }>('/skills/upload', {
      method: 'POST',
      json: { scope: installScope.value, overwrite: overwrite.value, rootName: p.rootName, zipBase64 },
    });
    showToast(`Skill 已安装：${res.name}（${scopeLabel(res.scope)}）`, 'success');
    showInstall.value = false;
    picked.value = null;
    overwrite.value = false;
    await refresh();
  } catch (e) {
    if (e instanceof AuthError) return;
    if (e instanceof ApiError && e.status === 409) {
      installErr.value = `已存在同名技能「${p.rootName}」。勾选「同名覆盖」后重试，或重命名 zip 包。`;
    } else {
      installErr.value = `安装失败：${describe(e)}`;
    }
  } finally {
    installing.value = false;
    busy.value = false;
  }
}

/* ===== 键盘与点击外部 ===== */
function closeAllOverlays(): boolean {
  if (confirmSkill.value) {
    confirmSkill.value = null;
    return true;
  }
  if (showInstall.value) {
    if (!installing.value) closeInstall();
    return true;
  }
  if (menuSkill.value) {
    menuSkill.value = null;
    return true;
  }
  if (detail.value) {
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
  menuSkill.value = null;
}

function onWinScroll(): void {
  if (menuSkill.value) menuSkill.value = null;
}

let ticker: ReturnType<typeof setInterval> | undefined;

onMounted(async () => {
  loading.value = true;
  try {
    await refresh();
  } finally {
    loading.value = false;
  }
  ticker = setInterval(() => { nowTick.value = Date.now(); }, 30000);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('click', onDocClick);
  window.addEventListener('scroll', onWinScroll, true);
  window.addEventListener('resize', onWinScroll);
});

onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('click', onDocClick);
  window.removeEventListener('scroll', onWinScroll, true);
  window.removeEventListener('resize', onWinScroll);
});
</script>

<template>
  <div class="page sk-page">
    <!-- 页头 -->
    <div class="sk-head">
      <div class="lead">
        <div class="sk-eyebrow">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8.8 2.2 4.4 9h3l-.9 4.8L11.6 7h-3z"/></svg>
          能力库 · Capability library
        </div>
        <h1>技能</h1>
        <p>按需加载的专业能力包，工作空间优先于全局。安装后自动重载，Agent 会在匹配任务时启用。</p>
      </div>
      <div class="sk-actions">
        <button class="sk-btn icon" type="button" title="刷新列表" aria-label="刷新列表" :disabled="busy" @click="refresh">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.8V5h-2.2"/></svg>
        </button>
        <button class="sk-btn" type="button" :disabled="busy" @click="reload">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.4 8a5.6 5.6 0 0 1 9.6-4"/><path d="M13.6 8a5.6 5.6 0 0 1-9.6 4"/><path d="M12.4 1.8v2.8h-2.8M3.6 14.2v-2.8h2.8"/></svg>
          重载
        </button>
        <button class="sk-btn primary" type="button" @click="openInstall">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M3 8h10"/></svg>
          安装技能
        </button>
      </div>
    </div>

    <!-- 统计条 -->
    <div class="sk-stats">
      <div class="sk-stat">
        <div class="k"><i class="on"></i>已安装技能</div>
        <div class="v">{{ skills.length }}<small>个</small></div>
      </div>
      <div class="sk-stat">
        <div class="k"><i class="on"></i>工作空间</div>
        <div class="v">{{ counts.workspace }}<small>个</small></div>
      </div>
      <div class="sk-stat">
        <div class="k"><i></i>全局</div>
        <div class="v">{{ counts.global }}<small>个</small></div>
      </div>
      <div class="sk-stat">
        <div class="k"><i></i>最近同步</div>
        <div class="v small">{{ syncLabel }}</div>
      </div>
    </div>

    <!-- 工具条 -->
    <div class="sk-toolbar">
      <div class="sk-search">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.5 13.5"/></svg>
        <input ref="searchInput" v-model="query" type="text" placeholder="搜索名称、描述或路径" autocomplete="off" spellcheck="false">
        <kbd>/</kbd>
      </div>
      <div class="sk-seg" role="tablist" aria-label="按来源筛选">
        <button
          v-for="t in tabs"
          :key="t.key"
          type="button"
          role="tab"
          :aria-selected="scopeTab === t.key"
          :class="{ on: scopeTab === t.key }"
          @click="scopeTab = t.key"
        >{{ t.label }} <span class="n">{{ counts[t.key] }}</span></button>
      </div>
      <select v-model="sortMode" class="sk-sort" aria-label="排序方式">
        <option value="scope">来源优先</option>
        <option value="name">名称 A→Z</option>
      </select>
      <span class="sk-count">{{ filtered.length }} 个技能</span>
    </div>

    <!-- 加载骨架 -->
    <div v-if="loading" class="sk-grid" aria-busy="true">
      <div v-for="i in 4" :key="i" class="sk-skel">
        <span class="tile"></span>
        <div class="lines"><i style="width:34%"></i><i style="width:88%"></i><i style="width:62%"></i><i style="width:46%"></i></div>
      </div>
    </div>

    <!-- 空库 / 加载失败 / 无匹配 -->
    <div v-else-if="skills.length === 0" class="sk-grid">
      <div class="sk-nothing">
        <span class="nt-ico">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.6 2.2 4.3 8.8h2.9l-.8 5 4.3-6.6h-2.9z"/></svg>
        </span>
        <b>{{ loadErr ? '技能列表加载失败' : '还没有安装技能' }}</b>
        <p>{{ loadErr ? loadErr : '把技能 zip 包拖进安装窗口，Agent 会在需要时自动加载。' }}</p>
        <button v-if="loadErr" class="sk-btn" type="button" @click="refresh">重新加载</button>
        <button v-else class="sk-btn primary" type="button" @click="openInstall">＋ 安装第一个技能</button>
      </div>
    </div>

    <div v-else-if="filtered.length === 0" class="sk-grid">
      <div class="sk-nothing">
        <span class="nt-ico">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.5 13.5"/></svg>
        </span>
        <b>没有匹配的技能</b>
        <p>换个关键词，或清空来源筛选后重试。</p>
        <button class="sk-btn" type="button" @click="query = ''; scopeTab = 'all'">清空筛选</button>
      </div>
    </div>

    <!-- 卡片流 -->
    <div v-else class="sk-grid">
      <article v-for="s in filtered" :key="s.name" class="sk-card">
        <div class="sk-card-top">
          <span class="sk-tile" :class="s.scope === 'workspace' ? 'ws' : 'gl'">{{ skillInitials(s.name) }}</span>
          <div class="sk-id">
            <div class="sk-name-row">
              <h3 class="sk-name">
                <template v-for="(seg, i) in highlightSegments(s.name, query)" :key="i">
                  <mark v-if="seg.hit">{{ seg.text }}</mark><template v-else>{{ seg.text }}</template>
                </template>
              </h3>
              <span class="sk-badge" :class="s.scope === 'workspace' ? 'ws' : 'gl'"><i></i>{{ scopeLabel(s.scope) }}</span>
            </div>
            <div class="sk-path" :title="s.path">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 4.4c0-.7.6-1.3 1.3-1.3h3l1.3 1.5h4.8c.7 0 1.3.6 1.3 1.3v5.4c0 .7-.6 1.3-1.3 1.3H3.1c-.7 0-1.3-.6-1.3-1.3z"/></svg>
              <span>{{ s.path }}</span>
            </div>
          </div>
          <button class="sk-more" type="button" aria-label="更多操作" @click.stop="openMenu($event, s)">
            <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>
          </button>
        </div>
        <p class="sk-desc">
          <template v-for="(seg, i) in highlightSegments(s.description, query)" :key="i">
            <mark v-if="seg.hit">{{ seg.text }}</mark><template v-else>{{ seg.text }}</template>
          </template>
        </p>
        <div class="sk-foot">
          <span class="sk-meta">{{ scopeHint(s.scope) }}</span>
          <span class="sk-spring"></span>
          <button class="sk-view" type="button" @click="openDetail(s)">
            查看 SKILL.md
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>
          </button>
        </div>
      </article>
    </div>

    <div class="sk-footline">
      <span>技能由 <code>SKILL.md</code> 驱动 · 安装 / 卸载后自动重载</span>
      <span class="sp"></span>
      <span>共 {{ skills.length }} 个技能</span>
    </div>

    <!-- 卡片 ⋯ 菜单 -->
    <div
      v-if="menuSkill"
      class="sk-menu"
      role="menu"
      :style="{ top: menuPos.top + 'px', left: menuPos.left + 'px' }"
      @click.stop
    >
      <button type="button" role="menuitem" @click="menuView">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8 11.9 12.2 8 12.2 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.6"/></svg>
        查看 SKILL.md
      </button>
      <button type="button" role="menuitem" @click="menuCopy">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.4" y="3.2" width="8" height="9" rx="1.6"/><path d="M10.6 3.2V2.2a1.2 1.2 0 0 0-1.2-1.2H3.1A1.2 1.2 0 0 0 1.9 2.2v7.4c0 .7.5 1.2 1.2 1.2h1"/></svg>
        复制路径
      </button>
      <div class="hr"></div>
      <button type="button" class="danger" role="menuitem" @click="menuDelete">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 4.6h9.6M6.4 4.6V3.2h3.2v1.4M4.7 4.6l.6 8.2h5.4l.6-8.2"/></svg>
        卸载技能
      </button>
    </div>

    <!-- 详情抽屉 -->
    <div class="sk-backdrop" :class="{ show: !!detail }" @click="closeDetail"></div>
    <aside class="sk-drawer" :class="{ show: !!detail }" role="dialog" aria-modal="true" aria-label="技能详情">
      <template v-if="detail">
        <div class="sk-drv-head">
          <span class="sk-tile" :class="detail.scope === 'workspace' ? 'ws' : 'gl'">{{ skillInitials(detail.name) }}</span>
          <div class="sk-drv-title">
            <h2>{{ detail.name }}<span class="sk-badge" :class="detail.scope === 'workspace' ? 'ws' : 'gl'"><i></i>{{ scopeLabel(detail.scope) }}</span></h2>
            <div class="sk-drv-path">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 4.4c0-.7.6-1.3 1.3-1.3h3l1.3 1.5h4.8c.7 0 1.3.6 1.3 1.3v5.4c0 .7-.6 1.3-1.3 1.3H3.1c-.7 0-1.3-.6-1.3-1.3z"/></svg>
              <span>{{ detail.path }}</span>
            </div>
          </div>
          <button class="sk-drv-close" type="button" aria-label="关闭详情" @click="closeDetail">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4L4 12"/></svg>
          </button>
        </div>
        <div class="sk-drv-body">
          <div class="sk-lab">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.4 1.9h5.2l3 3v9.2H4.4z"/><path d="M9.4 1.9v3.2h3"/></svg>
            FRONTMATTER
          </div>
          <div class="sk-fm">
            <div class="sk-fm-cap">SKILL.md · frontmatter</div>
            <div class="sk-fm-row"><span class="k">name</span><span class="v">{{ detail.name }}</span></div>
            <div class="sk-fm-row"><span class="k">description</span><span class="v">{{ detail.description }}</span></div>
            <div class="sk-fm-row"><span class="k">scope</span><span class="v">{{ detail.scope }}（{{ scopeLabel(detail.scope) }}）</span></div>
            <div class="sk-fm-row"><span class="k">path</span><span class="v">{{ detail.path }}</span></div>
          </div>

          <div class="sk-lab">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 3.4h10.4v9.2H2.8z"/><path d="M2.8 6.2h10.4M5.4 9h2.2M5.4 11h4.6"/></svg>
            正文
          </div>
          <div v-if="detailErr" class="sk-err"><span class="ei">!</span><div>{{ detailErr }}</div></div>
          <div v-else-if="detailLoading" class="sk-loading-line">正在读取 SKILL.md…</div>
          <div v-else-if="detailBody" ref="mdRef" class="md sk-md" v-html="detailHtml"></div>
          <p v-else class="sk-muted-line">SKILL.md 正文为空。</p>
        </div>
        <div class="sk-drv-foot">
          <button class="sk-btn danger-ghost" type="button" :disabled="busy" @click="confirmSkill = detail">卸载技能</button>
          <span class="sp"></span>
          <button class="sk-btn" type="button" @click="copyPath(detail.path)">复制路径</button>
          <button class="sk-btn primary" type="button" @click="closeDetail">关闭</button>
        </div>
      </template>
    </aside>

    <!-- 安装模态 -->
    <div class="sk-backdrop" :class="{ show: showInstall }" style="z-index: 115" @click="closeInstall"></div>
    <div class="sk-mdl" :class="{ show: showInstall }" role="dialog" aria-modal="true" aria-labelledby="sk-mdl-title">
      <div class="sk-mdl-head">
        <div class="mh">
          <h2 id="sk-mdl-title">安装技能</h2>
          <p>上传技能 zip 包；安装目录名 = zip 文件名（去掉 .zip），服务端会校验 SKILL.md。</p>
        </div>
        <button class="sk-drv-close" type="button" aria-label="关闭安装窗口" @click="closeInstall">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4L4 12"/></svg>
        </button>
      </div>
      <div class="sk-mdl-body">
        <input ref="zipInput" type="file" accept=".zip,application/zip,application/x-zip-compressed" hidden @change="onZipChange">

        <div
          class="sk-dz"
          :class="{ over: dzOver, picked: !!picked }"
          @click="onPickZip"
          @dragover="onDragOver"
          @dragleave="dzOver = false"
          @drop="onDrop"
        >
          <div v-if="!picked" class="dz-idle">
            <span class="dz-ico">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10.4V2.6M5 5.6 8 2.6l3 3"/><path d="M2.6 9.6v2.6c0 .8.6 1.4 1.4 1.4h8c.8 0 1.4-.6 1.4-1.4V9.6"/></svg>
            </span>
            <b>拖拽 zip 包到此处</b>
            <p>或 <span class="link">点击选择文件</span> · 仅 .zip · 上限 20 MB</p>
          </div>
          <div v-else class="dz-picked">
            <span class="mf-ico">ZIP</span>
            <div class="mf-main">
              <b>{{ picked.zipName }}</b>
              <small>安装为 {{ picked.rootName }}/ · {{ fmtSize(picked.size) }}</small>
            </div>
            <button class="sk-btn sm" type="button" :disabled="installing" @click.stop="clearPicked">重选</button>
          </div>
        </div>
        <div v-if="pickErr" class="sk-err"><span class="ei">!</span><div>{{ pickErr }}</div></div>

        <div class="sk-lab">安装范围 <span class="req">*</span></div>
        <div class="sk-scope-grid">
          <label class="sk-scope" :class="{ on: installScope === 'workspace' }">
            <input v-model="installScope" type="radio" value="workspace">
            <span class="sc-t">工作空间 <i>推荐</i></span>
            <span class="sc-d">仅当前项目可用</span>
            <span class="sc-p">.loop-agent/skills/</span>
          </label>
          <label class="sk-scope" :class="{ on: installScope === 'global' }">
            <input v-model="installScope" type="radio" value="global">
            <span class="sc-t">全局</span>
            <span class="sc-d">所有项目可用</span>
            <span class="sc-p">~/.loop-agent/skills/</span>
          </label>
        </div>

        <div class="sk-ovw-row">
          <label class="sk-chk"><input v-model="overwrite" type="checkbox"> 同名覆盖</label>
          <span class="sk-chk-hint">未勾选时同名返回 409；勾选后覆盖旧目录</span>
        </div>

        <div v-if="installErr" class="sk-err"><span class="ei">!</span><div>{{ installErr }}</div></div>

        <template v-if="installing">
          <div class="sk-prog indet"><i></i></div>
          <div class="sk-prog-note"><span>上传并校验中…</span><span>请勿关闭</span></div>
        </template>
      </div>
      <div class="sk-mdl-foot">
        <span class="sp"></span>
        <button class="sk-btn" type="button" :disabled="installing" @click="closeInstall">取消</button>
        <button class="sk-btn primary" type="button" :disabled="!picked || installing" @click="install">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10.4V2.8M5 5.8 8 2.8l3 3"/><path d="M2.6 10v2.2c0 .8.6 1.4 1.4 1.4h8c.8 0 1.4-.6 1.4-1.4V10"/></svg>
          上传安装
        </button>
      </div>
    </div>

    <!-- 卸载确认 -->
    <div class="sk-backdrop" :class="{ show: !!confirmSkill }" style="z-index: 135" @click="busy || (confirmSkill = null)"></div>
    <div class="sk-cfm" :class="{ show: !!confirmSkill }" role="dialog" aria-modal="true" aria-labelledby="sk-cfm-title">
      <template v-if="confirmSkill">
        <div class="sk-cfm-ico">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 4.6h9.6M6.4 4.6V3.2h3.2v1.4M4.7 4.6l.6 8.2h5.4l.6-8.2"/></svg>
        </div>
        <h3 id="sk-cfm-title">卸载「{{ confirmSkill.name }}」？</h3>
        <p>将删除该技能目录，随包的脚本与文档一并移除，操作不可撤销。</p>
        <div class="sk-cfm-k">{{ confirmSkill.path }}</div>
        <div class="sk-cfm-btns">
          <button class="sk-btn" type="button" :disabled="busy" @click="confirmSkill = null">取消</button>
          <button class="sk-btn danger" type="button" :disabled="busy" @click="doDelete">卸载技能</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* ===== 页头 ===== */
.sk-head { display: flex; align-items: flex-end; gap: 20px; flex-wrap: wrap; }
.sk-head .lead { min-width: 0; }
.sk-eyebrow {
  display: flex; align-items: center; gap: 6px;
  font-size: 10.5px; font-weight: 600; letter-spacing: .14em;
  text-transform: uppercase; color: var(--muted);
}
.sk-eyebrow svg { width: 12px; height: 12px; color: var(--brand); }
.sk-head h1 { margin: 3px 0 0; font-size: 24px; font-weight: 700; line-height: 1.2; letter-spacing: -.01em; }
.sk-head p { margin: 7px 0 0; font-size: 12.5px; color: var(--muted); max-width: 62ch; }
.sk-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }

.sk-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  height: 34px; padding: 0 13px;
  border: 1px solid var(--line); border-radius: 9px;
  background: var(--panel); color: var(--text-2);
  font-size: 12.5px; font-weight: 500; line-height: 1; cursor: pointer; white-space: nowrap;
  transition: border-color .13s, background .13s, color .13s, filter .13s;
}
.sk-btn:hover { border-color: var(--line-strong); color: var(--text); background: var(--bar-bg); }
.sk-btn svg { width: 15px; height: 15px; flex: none; }
.sk-btn.primary { background: var(--brand); border-color: var(--brand); color: var(--brand-on); font-weight: 600; box-shadow: 0 1px 2px rgba(14, 159, 110, .22); }
.sk-btn.primary:hover { filter: brightness(1.05); background: var(--brand); color: var(--brand-on); }
.sk-btn.icon { width: 34px; padding: 0; }
.sk-btn.sm { height: 28px; padding: 0 10px; font-size: 12px; border-radius: 8px; }
.sk-btn.danger-ghost { color: var(--danger); border-color: transparent; background: transparent; }
.sk-btn.danger-ghost:hover { background: var(--danger-weak); border-color: var(--danger); color: var(--danger); }
.sk-btn.danger { background: var(--danger); border-color: var(--danger); color: #fff; font-weight: 600; }
.sk-btn.danger:hover { background: var(--danger); color: #fff; filter: brightness(1.06); }
.sk-btn:disabled { opacity: .5; cursor: not-allowed; filter: none; }

/* ===== 统计条 ===== */
.sk-stats {
  display: grid; grid-template-columns: repeat(4, 1fr);
  margin-top: 20px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
}
.sk-stat { padding: 11px 16px 12px; border-left: 1px solid var(--line-soft); min-width: 0; }
.sk-stat:first-child { border-left: none; }
.sk-stat .k { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); letter-spacing: .01em; }
.sk-stat .k i { width: 5px; height: 5px; border-radius: 50%; background: var(--line-strong); flex: none; }
.sk-stat .k i.on { background: var(--brand); }
.sk-stat .v { font-size: 20px; font-weight: 650; line-height: 1.3; letter-spacing: -.01em; margin-top: 1px; font-variant-numeric: tabular-nums; }
.sk-stat .v small { font-size: 11px; font-weight: 500; color: var(--muted); margin-left: 4px; letter-spacing: 0; }
.sk-stat .v.small { font-size: 15px; font-weight: 600; color: var(--text-2); line-height: 1.75; }

/* ===== 工具条 ===== */
.sk-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 16px 0 13px; }
.sk-search {
  flex: 1; min-width: 210px; max-width: 350px;
  display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 9px;
  transition: border-color .13s, box-shadow .13s;
}
.sk-search:focus-within { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-weak); }
.sk-search svg { width: 14px; height: 14px; color: var(--muted); flex: none; }
.sk-search input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font-size: 12.5px; font-weight: 400; line-height: 1; color: var(--text); }
.sk-search input:focus { border: none; }
.sk-search input::placeholder { color: var(--muted); }
.sk-search kbd {
  font: 500 10px/1 var(--mono); color: var(--muted);
  border: 1px solid var(--line); border-radius: 4px; padding: 2px 5px; flex: none;
}

.sk-seg { display: flex; gap: 2px; padding: 2px; background: var(--code-bg); border-radius: 9px; }
.sk-seg button {
  display: inline-flex; align-items: center; gap: 5px;
  height: 28px; padding: 0 10px; border: none; border-radius: 7px;
  background: transparent; color: var(--muted);
  font-size: 12px; font-weight: 500; line-height: 1; cursor: pointer;
}
.sk-seg button:hover { color: var(--text-2); background: transparent; border: none; }
.sk-seg button.on { background: var(--panel); color: var(--text); font-weight: 600; box-shadow: 0 1px 2px rgba(16, 24, 40, .09); }
.sk-seg .n {
  font: 600 10px/14px var(--mono); color: var(--muted);
  background: var(--panel); border-radius: 999px; padding: 0 5px; min-width: 16px; text-align: center;
}
.sk-seg button.on .n { color: var(--brand); background: var(--brand-weak); }

.sk-sort {
  height: 34px; padding: 0 26px 0 10px; border: 1px solid var(--line); border-radius: 9px;
  background: var(--panel) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 16 16' fill='none' stroke='%236b7280' stroke-width='1.5'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E") no-repeat right 9px center;
  color: var(--text-2); font-size: 12px; font-weight: 500; line-height: 1; cursor: pointer; appearance: none;
  margin-left: auto;
}
.sk-count { font-size: 11px; color: var(--muted); white-space: nowrap; }

/* ===== 卡片网格 ===== */
.sk-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.sk-card {
  position: relative; display: flex; flex-direction: column; gap: 9px;
  padding: 14px 16px 11px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 13px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, .03);
  transition: border-color .15s, box-shadow .15s, transform .15s;
}
.sk-card:hover { border-color: var(--line-strong); box-shadow: var(--shadow-card); transform: translateY(-1px); }
.sk-card-top { display: flex; align-items: flex-start; gap: 11px; min-width: 0; }
.sk-tile {
  width: 42px; height: 42px; border-radius: 12px; flex: none;
  display: grid; place-items: center;
  font-size: 12px; font-weight: 700; line-height: 1; letter-spacing: .04em; color: #fff;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .24), 0 2px 7px -3px rgba(16, 24, 40, .35);
}
.sk-tile.ws { background: linear-gradient(135deg, #10b981, #0d9488); }
.sk-tile.gl { background: linear-gradient(135deg, #64748b, #475569); }
.sk-id { flex: 1; min-width: 0; }
.sk-name-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.sk-name { margin: 0; font-size: 14px; font-weight: 650; line-height: 1.35; overflow-wrap: anywhere; }
.sk-badge {
  display: inline-flex; align-items: center; gap: 5px;
  height: 19px; padding: 0 7px; border-radius: 999px;
  font-size: 10.5px; font-weight: 600; white-space: nowrap;
}
.sk-badge i { width: 5px; height: 5px; border-radius: 50%; flex: none; }
.sk-badge.ws { color: var(--brand); background: var(--brand-weak); }
.sk-badge.ws i { background: var(--brand); }
.sk-badge.gl { color: var(--muted); background: var(--code-bg); }
.sk-badge.gl i { background: var(--muted); }
.sk-path { display: flex; align-items: center; gap: 5px; min-width: 0; margin-top: 3px; font: 400 11px/1.45 var(--mono); color: var(--muted); }
.sk-path svg { width: 11px; height: 11px; flex: none; opacity: .75; }
.sk-path span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sk-more {
  width: 26px; height: 26px; flex: none; margin: -2px -5px 0 0;
  display: grid; place-items: center; border: none; border-radius: 6px;
  background: transparent; color: var(--muted); cursor: pointer;
  opacity: .6; transition: opacity .12s, background .12s;
}
.sk-more svg { width: 15px; height: 15px; }
.sk-card:hover .sk-more { opacity: 1; }
.sk-more:hover { background: var(--active); color: var(--text); border: none; }
.sk-desc {
  flex: 1; margin: 0; color: var(--text-2); font-size: 12.5px; line-height: 1.64;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
  min-height: 61px;
}
.sk-desc mark, .sk-name mark, .sk-path mark { background: var(--warn-weak); color: var(--warn); border-radius: 3px; padding: 0 1px; }
.sk-foot { display: flex; align-items: center; gap: 8px; padding-top: 9px; border-top: 1px solid var(--line-soft); }
.sk-meta { font-size: 11px; color: var(--muted); display: flex; align-items: center; min-width: 0; }
.sk-spring { flex: 1; }
.sk-view {
  display: inline-flex; align-items: center; gap: 4px;
  height: 26px; padding: 0 9px; flex: none;
  border: 1px solid var(--line); border-radius: 7px;
  background: transparent; color: var(--text-2);
  font-size: 11.5px; font-weight: 500; line-height: 1; cursor: pointer;
  transition: border-color .12s, color .12s, background .12s;
}
.sk-view:hover { border-color: var(--brand); color: var(--brand); background: var(--brand-weak); }
.sk-view svg { width: 12px; height: 12px; }

/* ===== 骨架 / 空态 / 底注 ===== */
.sk-skel {
  display: flex; gap: 11px; padding: 15px 16px;
  min-height: 128px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 13px;
}
.sk-skel .tile { width: 42px; height: 42px; flex: none; border-radius: 12px; background: var(--code-bg); animation: sk-pulse 1.2s ease-in-out infinite; }
.sk-skel .lines { flex: 1; display: flex; flex-direction: column; gap: 9px; padding-top: 4px; }
.sk-skel .lines i { display: block; height: 8px; border-radius: 4px; background: var(--code-bg); animation: sk-pulse 1.2s ease-in-out infinite; }
.sk-skel .lines i:nth-child(2) { animation-delay: .1s; }
.sk-skel .lines i:nth-child(3) { animation-delay: .2s; }
.sk-skel .lines i:nth-child(4) { animation-delay: .3s; }
@keyframes sk-pulse { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }

.sk-nothing {
  grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center;
  padding: 34px 20px; text-align: center;
  border: 1px dashed var(--line-strong); border-radius: 14px;
  background: var(--panel);
}
.sk-nothing .nt-ico {
  width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center;
  background: var(--code-bg); color: var(--muted); margin-bottom: 11px;
}
.sk-nothing .nt-ico svg { width: 22px; height: 22px; }
.sk-nothing b { font-size: 13.5px; font-weight: 650; }
.sk-nothing p { margin: 5px 0 13px; font-size: 12px; color: var(--muted); max-width: 46ch; }

.sk-footline {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 14px; padding-top: 11px; border-top: 1px solid var(--line-soft);
  font-size: 11px; color: var(--muted);
}
.sk-footline .sp { flex: 1; }
.sk-footline code { font: 500 10.5px/1 var(--mono); color: var(--text-2); background: var(--code-bg); padding: 2px 5px; border-radius: 4px; }

/* ===== 浮层通用 ===== */
.sk-backdrop {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(16, 24, 40, .4); backdrop-filter: blur(2px);
  opacity: 0; pointer-events: none; transition: opacity .2s;
}
.sk-backdrop.show { opacity: 1; pointer-events: auto; }

.sk-menu {
  position: fixed; z-index: 96; width: 178px; padding: 4px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: var(--shadow-pop);
}
.sk-menu button {
  display: flex; width: 100%; align-items: center; gap: 8px;
  padding: 7px 9px; border: none; border-radius: 6px; background: transparent;
  font-size: 12px; font-weight: 400; line-height: 1.3; color: var(--text-2); text-align: left; cursor: pointer;
}
.sk-menu button svg { width: 14px; height: 14px; color: var(--muted); flex: none; }
.sk-menu button:hover { background: var(--hover); color: var(--text); border: none; }
.sk-menu .hr { height: 1px; background: var(--line-soft); margin: 4px 2px; }
.sk-menu button.danger { color: var(--danger); }
.sk-menu button.danger svg { color: var(--danger); }
.sk-menu button.danger:hover { background: var(--danger-weak); color: var(--danger); }

/* ===== 详情抽屉 ===== */
.sk-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 110;
  width: min(480px, 100%); display: flex; flex-direction: column;
  background: var(--panel); border-left: 1px solid var(--line);
  box-shadow: -24px 0 64px -24px rgba(16, 24, 40, .45);
  transform: translateX(102%); visibility: hidden;
  transition: transform .26s cubic-bezier(.2, .8, .2, 1), visibility .26s;
}
.sk-drawer.show { transform: none; visibility: visible; }
.sk-drv-head { display: flex; align-items: flex-start; gap: 12px; padding: 18px 20px 16px; border-bottom: 1px solid var(--line-soft); }
.sk-drv-head .sk-tile { width: 46px; height: 46px; border-radius: 13px; font-size: 13px; }
.sk-drv-title { flex: 1; min-width: 0; }
.sk-drv-title h2 { margin: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 16px; font-weight: 650; line-height: 1.35; overflow-wrap: anywhere; }
.sk-drv-path { display: flex; align-items: center; gap: 6px; margin-top: 4px; font: 400 10.5px/1.5 var(--mono); color: var(--muted); overflow-wrap: anywhere; }
.sk-drv-path svg { width: 11px; height: 11px; flex: none; }
.sk-drv-close {
  width: 30px; height: 30px; flex: none; display: grid; place-items: center;
  border: 1px solid var(--line); border-radius: 8px; background: var(--panel);
  color: var(--muted); cursor: pointer; margin: -3px -4px 0 0;
}
.sk-drv-close:hover { background: var(--code-bg); color: var(--text); border-color: var(--line); }
.sk-drv-close svg { width: 14px; height: 14px; }
.sk-drv-body { flex: 1; overflow: auto; padding: 16px 20px 28px; }
.sk-lab { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; color: var(--muted); margin: 17px 0 8px; }
.sk-lab svg { width: 12px; height: 12px; }
.sk-lab .req { color: var(--brand); }
.sk-fm { background: var(--bar-bg); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.sk-fm-cap { padding: 7px 12px; font: 500 10.5px/1.4 var(--mono); color: var(--muted); background: var(--code-bg); border-bottom: 1px solid var(--line-soft); }
.sk-fm-row { display: grid; grid-template-columns: 92px 1fr; gap: 10px; padding: 7px 12px; border-top: 1px solid var(--line-soft); font-size: 12px; }
.sk-fm-cap + .sk-fm-row { border-top: none; }
.sk-fm-row .k { font: 500 10.5px/1.7 var(--mono); color: var(--muted); }
.sk-fm-row .v { color: var(--text-2); overflow-wrap: anywhere; line-height: 1.65; }
.sk-loading-line, .sk-muted-line { margin: 6px 0; font-size: 12.5px; color: var(--muted); }
.sk-drv-foot { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--bar-bg); }
.sk-drv-foot .sp { flex: 1; }

/* 正文排版（v-html，经 DOMPurify 消毒） */
.sk-md :deep(h1), .sk-md :deep(h2) {
  margin: 20px 0 7px; padding-bottom: 6px;
  font-size: 13.5px; font-weight: 650; border-bottom: 1px solid var(--line-soft);
  color: var(--text);
}
.sk-md :deep(h3) { margin: 15px 0 6px; font-size: 12.5px; font-weight: 650; color: var(--text); }
.sk-md :deep(h1:first-child), .sk-md :deep(h2:first-child), .sk-md :deep(h3:first-child) { margin-top: 0; }
.sk-md :deep(p) { margin: 7px 0; font-size: 12.5px; line-height: 1.72; color: var(--text-2); }
.sk-md :deep(ul), .sk-md :deep(ol) { margin: 7px 0; padding-left: 20px; font-size: 12.5px; line-height: 1.78; color: var(--text-2); }
.sk-md :deep(li) { margin: 2px 0; }
.sk-md :deep(li::marker) { color: var(--muted); }
.sk-md :deep(code) { font: 500 11px/1.5 var(--mono); color: var(--text-2); background: var(--code-bg); padding: 2px 5px; border-radius: 4px; }
.sk-md :deep(pre) {
  margin: 10px 0 4px; padding: 11px 13px; overflow: auto;
  background: var(--code-bg); border: 1px solid var(--line-soft); border-radius: 8px;
  font: 400 11.5px/1.6 var(--mono); color: var(--text-2); white-space: pre-wrap; word-break: break-all;
}
.sk-md :deep(pre code) { background: none; padding: 0; }
.sk-md :deep(table) { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 12px; }
.sk-md :deep(th), .sk-md :deep(td) { border: 1px solid var(--line); padding: 5px 8px; text-align: left; }
.sk-md :deep(th) { background: var(--code-bg); font-weight: 600; }
.sk-md :deep(a) { color: var(--brand); }

/* ===== 安装模态 ===== */
.sk-mdl {
  position: fixed; z-index: 120; left: 50%; top: 7vh;
  width: min(560px, calc(100vw - 32px)); max-height: 86vh; overflow: auto;
  display: flex; flex-direction: column;
  background: var(--panel); border: 1px solid var(--line); border-radius: 16px;
  box-shadow: 0 30px 90px -24px rgba(16, 24, 40, .5);
  opacity: 0; pointer-events: none;
  transform: translate(-50%, -8px) scale(.985);
  transition: opacity .18s, transform .18s;
}
.sk-mdl.show { opacity: 1; pointer-events: auto; transform: translate(-50%, 0) scale(1); }
.sk-mdl-head { padding: 18px 20px 0; display: flex; align-items: flex-start; gap: 12px; }
.sk-mdl-head .mh { flex: 1; min-width: 0; }
.sk-mdl-head h2 { margin: 0; font-size: 17px; font-weight: 700; letter-spacing: -.005em; }
.sk-mdl-head p { margin: 5px 0 0; font-size: 12px; color: var(--muted); }
.sk-mdl-body { padding: 16px 20px 4px; }
.sk-mdl-foot {
  display: flex; align-items: center; gap: 8px;
  padding: 14px 20px; margin-top: 14px;
  border-top: 1px solid var(--line-soft); background: var(--bar-bg);
  border-radius: 0 0 16px 16px;
}
.sk-mdl-foot .sp { flex: 1; }

.sk-dz {
  border: 1.5px dashed var(--line-strong); border-radius: 12px;
  background: var(--bar-bg); padding: 22px 16px; text-align: center;
  cursor: pointer; transition: border-color .14s, background .14s, transform .14s;
}
.sk-dz:hover, .sk-dz.over { border-color: var(--brand); background: var(--brand-weak); }
.sk-dz.over { transform: scale(1.004); }
.dz-idle .dz-ico {
  width: 42px; height: 42px; margin: 0 auto; display: grid; place-items: center;
  border-radius: 12px; background: var(--panel); border: 1px solid var(--line);
  color: var(--brand);
}
.dz-idle .dz-ico svg { width: 20px; height: 20px; }
.dz-idle b { display: block; margin-top: 9px; font-size: 13px; font-weight: 600; }
.dz-idle p { margin: 4px 0 0; font-size: 11.5px; color: var(--muted); }
.link { color: var(--brand); text-decoration: underline; text-underline-offset: 2px; }
.dz-picked { display: flex; align-items: center; gap: 11px; text-align: left; }
.mf-ico {
  width: 38px; height: 38px; flex: none; display: grid; place-items: center;
  border-radius: 10px; background: var(--panel); border: 1px solid var(--line);
  font: 700 10px/1 var(--mono); color: var(--muted);
}
.mf-main { flex: 1; min-width: 0; }
.mf-main b { display: block; font-size: 12.5px; font-weight: 600; overflow-wrap: anywhere; }
.mf-main small { display: block; margin-top: 2px; font-size: 11px; color: var(--muted); }

.sk-scope-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.sk-scope {
  position: relative; display: block; padding: 11px 12px;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--panel); cursor: pointer; transition: border-color .12s, background .12s;
}
.sk-scope:hover { border-color: var(--line-strong); }
.sk-scope.on { border-color: var(--brand); background: var(--brand-weak); box-shadow: 0 0 0 1px var(--brand) inset; }
.sk-scope input { position: absolute; opacity: 0; pointer-events: none; }
.sc-t { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; }
.sc-t i {
  font-style: normal; font-size: 9.5px; font-weight: 600; color: var(--brand);
  background: var(--panel); border: 1px solid var(--line-soft); border-radius: 999px; padding: 1px 6px;
}
.sc-d { display: block; margin-top: 2px; font-size: 11px; color: var(--muted); }
.sc-p { display: block; margin-top: 6px; font: 400 10.5px/1.4 var(--mono); color: var(--muted); overflow-wrap: anywhere; }
.sk-ovw-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 13px; }
.sk-chk { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); cursor: pointer; }
.sk-chk input { accent-color: var(--brand); cursor: pointer; }
.sk-chk-hint { font-size: 11px; color: var(--muted); }
.sk-err {
  display: flex; align-items: flex-start; gap: 9px; margin-top: 12px;
  padding: 9px 12px; border-radius: 9px; font-size: 12px; line-height: 1.6;
  color: var(--danger); background: var(--danger-weak); border: 1px solid var(--danger);
}
.sk-err .ei {
  width: 17px; height: 17px; flex: none; display: grid; place-items: center; margin-top: 1px;
  border-radius: 50%; border: 1px solid currentColor;
  font: 700 10px/1 var(--mono);
}
.sk-prog { height: 6px; margin-top: 13px; border-radius: 999px; background: var(--code-bg); overflow: hidden; }
.sk-prog i { display: block; height: 100%; width: 0; border-radius: inherit; background: var(--brand); }
.sk-prog.indet i { width: 38%; animation: sk-indet 1.1s ease-in-out infinite; }
@keyframes sk-indet { 0% { transform: translateX(-40%); } 100% { transform: translateX(300%); } }
.sk-prog-note { display: flex; justify-content: space-between; margin-top: 5px; font-size: 10.5px; color: var(--muted); }
@media (max-width: 520px) { .sk-scope-grid { grid-template-columns: 1fr; } }

/* ===== 卸载确认 ===== */
.sk-cfm {
  position: fixed; z-index: 140; left: 50%; top: 50%;
  width: min(400px, calc(100vw - 32px)); padding: 20px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 24px 70px -20px rgba(16, 24, 40, .5);
  opacity: 0; pointer-events: none;
  transform: translate(-50%, -48%) scale(.985); transition: opacity .16s, transform .16s;
}
.sk-cfm.show { opacity: 1; pointer-events: auto; transform: translate(-50%, -50%) scale(1); }
.sk-cfm-ico {
  width: 38px; height: 38px; display: grid; place-items: center; margin-bottom: 12px;
  border-radius: 11px; background: var(--danger-weak); color: var(--danger);
}
.sk-cfm-ico svg { width: 18px; height: 18px; }
.sk-cfm h3 { margin: 0; font-size: 15px; font-weight: 650; overflow-wrap: anywhere; }
.sk-cfm p { margin: 6px 0 0; font-size: 12px; color: var(--muted); line-height: 1.65; }
.sk-cfm-k { font: 500 10.5px/1.6 var(--mono); color: var(--muted); margin-top: 8px; overflow-wrap: anywhere; }
.sk-cfm-btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }

/* ===== 响应式 ===== */
@media (max-width: 980px) {
  .sk-grid { grid-template-columns: 1fr; }
  .sk-stats { grid-template-columns: 1fr 1fr; }
  .sk-stat:nth-child(3) { border-left: none; border-top: 1px solid var(--line-soft); }
  .sk-stat:nth-child(4) { border-top: 1px solid var(--line-soft); }
}
@media (max-width: 700px) {
  .sk-head { flex-direction: column; align-items: flex-start; gap: 14px; }
  .sk-actions { margin-left: 0; width: 100%; }
  .sk-actions .sk-btn.primary { flex: 1; }
  .sk-search { max-width: none; flex-basis: 100%; }
  .sk-sort { margin-left: 0; }
  .sk-count { display: none; }
}

/* 深色微调：降低白色高光与卡片阴影 */
:global(:root[data-theme='dark']) .sk-tile { box-shadow: inset 0 1px 0 rgba(255, 255, 255, .16), 0 2px 8px -3px rgba(0, 0, 0, .5); }
:global(:root[data-theme='dark']) .sk-card { box-shadow: none; }
@media (prefers-color-scheme: dark) {
  :global(:root:not([data-theme='light'])) .sk-card { box-shadow: none; }
}
</style>
