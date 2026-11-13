<script setup lang="ts">
// 模型视图（需求 20261111-001 · 卡片流 + 统计条 + 抽屉）
//
// 端点映射：
// GET /models（登记簿，apiKey 遮蔽 + isCurrent）· GET /model（当前生效快照）
// · POST /models（登记，同名 409）· PATCH /models/:alias（编辑，需后端配套）
// · PUT /model（切换激活）· POST /models/:alias/test（连通性）
// · DELETE /models/:alias?scope=（删当前激活 409）· GET /models/bench/history（测速历史）
//
// 数据流：/models → filterProfiles（关键字）→ 分段过滤 → sortProfiles → 卡片网格；
// 状态胶囊由 modelPills() 派生，异常汇总由 isFailedModel() 派生（未测试 / 未测速不计入异常）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, ApiError, AuthError } from '../api/client';
import { showToast } from '../toast';
import { errText } from '../utils';
import ModelBenchRun from '../components/ModelBenchRun.vue';
import {
  dominantError,
  errorLabel,
  fmtMs,
  fmtP,
  fmtTps,
  fmtWhen,
  promptLabel,
  sparkPoints,
  successTone,
  tpsTone,
  ttftTone,
  type BenchHistoryEntryVM,
} from '../bench-format';
import {
  advancedCount,
  buildAdvanced,
  filterProfiles,
  hasAdvancedErrors,
  hasErrors,
  hostOf,
  isFailedModel,
  modelIconSvg,
  modelPills,
  providerMetaOf,
  sortProfiles,
  validateModelForm,
  type ModelAdvanced,
  type ModelFormErrors,
  type ModelFormInput,
  type ModelIconKey,
  type ModelProvider,
  type ModelSortMode,
  type PerfLike,
  type Pill,
  type TestLike,
} from '../models-ui';

interface ProfileRow {
  alias: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  temperature?: number;
  advanced?: ModelAdvanced;
  isCurrent: boolean;
}

type Tab = 'all' | 'active' | 'attention';

const profiles = ref<ProfileRow[]>([]);
const current = ref<{ model: { name: string; baseUrl: string; apiKey: string; temperature?: number; advanced?: ModelAdvanced }; active: string | null } | null>(null);
// 需求 20261112-008：模型配置只有全局一份，不再有 scope 选择
const busy = ref(false);
/** 首屏是否已加载完成（区分骨架与空态） */
const loaded = ref(false);
const query = ref('');
const tab = ref<Tab>('all');
const sortMode = ref<ModelSortMode>('active');
const searchEl = ref<HTMLInputElement | null>(null);

const tests = ref<Record<string, TestLike>>({});
const perf = ref<Record<string, PerfLike>>({});
const perfAt = ref<Record<string, string>>({});
/** 正在做连通性测试的别名（用于胶囊与详情按钮的进行中文案） */
const testingAlias = ref<string | null>(null);

/** 卡片 ⋯ 菜单（fixed 定位，坐标来自触发按钮） */
const menu = ref<{ alias: string; top: number; left: number } | null>(null);

/** 详情抽屉 */
const detailAlias = ref<string | null>(null);
const detailHistory = ref<BenchHistoryEntryVM[]>([]);
const historyLoading = ref(false);

/** 表单抽屉（添加 / 编辑共用） */
const formOpen = ref(false);
const formMode = ref<'add' | 'edit'>('add');
const editingAlias = ref<string | null>(null);
const showKey = ref(false);
/** 提交后开启实时校验，避免一打开就飘红 */
const touched = ref(false);
const form = ref<ModelFormInput>(emptyForm());
const errors = ref<ModelFormErrors>({});
const submitErr = ref('');
/** 高级设置折叠区（默认收起；校验失败自动展开） */
const advOpen = ref(false);

/** 空白表单（新增 / 关闭后复位共用） */
function emptyForm(): ModelFormInput {
  return {
    alias: '',
    name: '',
    baseUrl: '',
    apiKey: '',
    temperature: '',
    maxTokens: '',
    topP: '',
    topK: '',
    frequencyPenalty: '',
    timeoutMs: '',
    headers: [],
  };
}

/** 删除确认弹层 */
const confirmAlias = ref<string | null>(null);

/** 详情抽屉内联测速（需求 20261111-001：测速不再另开弹窗，直接跑在「性能」区） */
const benchRunning = ref(false);
const benchRun = ref<{ start: () => Promise<void>; stop: () => Promise<void> } | null>(null);

const icon = (key: ModelIconKey, w = 1.6): string => modelIconSvg(key, w);


const activeCount = computed(() => profiles.value.filter((p) => p.isCurrent).length);
const failedAliases = computed(() =>
  profiles.value.filter((p) => isFailed(p)).map((p) => p.alias),
);
const attentionCount = computed(() => failedAliases.value.length);
/** 无激活但存在登记（走配置文件 model.* 快照）时给出提示 */
const snapshotNotice = computed(() => loaded.value && profiles.value.length > 0 && activeCount.value === 0);

/** 关键字过滤后的全集（分段计数也基于它，保证数字与「全部」一致） */
const searched = computed(() => filterProfiles(profiles.value, query.value));
const counts = computed(() => ({
  all: searched.value.length,
  active: searched.value.filter((p) => p.isCurrent).length,
  attention: searched.value.filter((p) => isFailed(p)).length,
}));
const rows = computed(() => {
  let arr = searched.value;
  if (tab.value === 'active') arr = arr.filter((p) => p.isCurrent);
  else if (tab.value === 'attention') arr = arr.filter((p) => isFailed(p));
  return sortProfiles(arr, sortMode.value, (p) => perf.value[p.alias]?.ttft ?? null);
});

const detail = computed(() => profiles.value.find((p) => p.alias === detailAlias.value) ?? null);
const detailMeta = computed(() => (detail.value ? providerMetaOf(detail.value.baseUrl) : null));
const latestHistory = computed(() => detailHistory.value[0] ?? null);
/** 历史里选中的那一次运行（默认最近一次），用于展开每轮明细 */
const selectedRunIdx = ref(0);
const selectedRun = computed(() => detailHistory.value[selectedRunIdx.value] ?? null);
const selectedErr = computed(() => dominantError(selectedRun.value?.summary.errorKinds));
const detailSpark = computed(() => {
  const vals = detailHistory.value
    .slice(0, 5)
    .reverse()
    .map((h) => h.summary.ttft.p50)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return sparkPoints(vals, 120, 24);
});
const formTile = computed((): { provider: ModelProvider; text: string } => {
  if (formMode.value !== 'edit') return { provider: 'deepseek', text: '＋' };
  const p = profiles.value.find((x) => x.alias === editingAlias.value);
  return p ? providerMetaOf(p.baseUrl) : { provider: 'deepseek', text: '＋' };
});
const editKeyMasked = computed(
  () => profiles.value.find((p) => p.alias === editingAlias.value)?.apiKey ?? '',
);
const confirmTarget = computed(
  () => profiles.value.find((p) => p.alias === confirmAlias.value) ?? null,
);
const menuProfile = computed(() => {
  const m = menu.value;
  return m ? profiles.value.find((p) => p.alias === m.alias) ?? null : null;
});

function guard(e: unknown, fallback: string): void {
  if (!(e instanceof AuthError)) showToast(e instanceof ApiError ? e.message : `${fallback}: ${errText(e)}`, 'error');
}

function isFailed(p: ProfileRow): boolean {
  return isFailedModel({ test: tests.value[p.alias], perf: perf.value[p.alias] });
}

async function refresh(): Promise<void> {
  busy.value = true;
  try {
    const [list, cur] = await Promise.all([
      api<{ profiles: ProfileRow[]; active: string | null }>('/models'),
      api<{ model: { name: string; baseUrl: string; apiKey: string; temperature?: number }; active: string | null }>('/model'),
    ]);
    profiles.value = list.profiles;
    current.value = cur;
    loaded.value = true;
  } catch (e) {
    guard(e, '加载模型失败');
  } finally {
    busy.value = false;
  }
  void loadPerf();
}

/** 拉测速历史（不带 alias 时后端只回每模型最近一次），失败静默降级为「未测速」 */
async function loadPerf(): Promise<void> {
  try {
    const res = await api<{ runs: BenchHistoryEntryVM[] }>('/models/bench/history?limit=50');
    const map: Record<string, PerfLike> = {};
    const at: Record<string, string> = {};
    for (const r of res.runs) {
      if (map[r.alias]) continue;
      map[r.alias] = { ttft: r.summary.ttft.p50, okCount: r.summary.okCount, total: r.summary.total };
      at[r.alias] = r.finishedAt;
    }
    perf.value = map;
    perfAt.value = at;
  } catch {
    perf.value = {};
    perfAt.value = {};
  }
}

function pillsOf(p: ProfileRow): Pill[] {
  if (testingAlias.value === p.alias) {
    // 进行中：用「测试中…」替代连通性胶囊，保留生效/性能两枚
    const base = modelPills({ isCurrent: p.isCurrent, test: null, perf: perf.value[p.alias] })
      .filter((pl) => pl.text !== '未测试');
    base.splice(p.isCurrent ? 1 : 0, 0, { tone: 'dim', text: '测试中…' });
    return base;
  }
  return modelPills({ isCurrent: p.isCurrent, test: tests.value[p.alias], perf: perf.value[p.alias] });
}

/** 卡片底部「最近测速 …」文案 */
function footText(p: ProfileRow): string {
  const pf = perf.value[p.alias];
  if (!pf) return '尚未测速';
  const when = perfAt.value[p.alias] ? fmtWhen(perfAt.value[p.alias]) : '';
  return `${when ? `最近测速 ${when}` : '最近测速'} · ${pf.okCount}/${pf.total} 轮成功`;
}

/** 详情抽屉里的连通性状态块 */
const detailConn = computed(() => {
  if (!detail.value) return { cls: '', title: '', sub: '' };
  if (testingAlias.value === detail.value.alias) {
    return { cls: '', title: '测试中…', sub: '正在等待首块响应' };
  }
  const t = tests.value[detail.value.alias];
  if (t && t.ok) {
    return { cls: 'ok', title: `连通正常 · ${fmtMs(t.latencyMs)}`, sub: '探测到首块即断开，近免费' };
  }
  if (t) return { cls: 'bad', title: '连通失败', sub: t.error || '未知错误' };
  return { cls: '', title: '尚未测试', sub: '发一条极短请求，收到首块即断开，几乎不产生费用' };
});

/** 详情抽屉性能指标（取最近一次测速） */
const detailPerf = computed(() => {
  const h = latestHistory.value;
  if (!h) return null;
  return {
    ttft: h.summary.ttft.p50,
    tps: h.summary.decodeTps.p50,
    okCount: h.summary.okCount,
    total: h.summary.total,
    rate: h.summary.successRate,
    when: fmtWhen(h.finishedAt),
  };
});

function onSortChange(e: Event): void {
  const v = (e.target as HTMLSelectElement).value;
  sortMode.value = v === 'alias' || v === 'ttft' ? v : 'active';
}

function openMenu(alias: string, ev: MouseEvent): void {
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  const top = Math.min(r.bottom + 6, window.innerHeight - 250);
  const left = Math.max(8, Math.min(r.right - 190, window.innerWidth - 198));
  menu.value = { alias, top, left };
}

function copyText(text: string, okMsg: string): void {
  if (!navigator.clipboard) {
    showToast('复制失败，请手动选择', 'error');
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => showToast(okMsg, 'success'),
    () => showToast('复制失败，请手动选择', 'error'),
  );
}

async function openDetail(alias: string): Promise<void> {
  menu.value = null;
  // 切换别名时结束上一个模型的内联测速（组件随 key 卸载并中断流）
  if (detailAlias.value !== alias) benchRunning.value = false;
  detailAlias.value = alias;
  detailHistory.value = [];
  await loadHistory(alias);
}

/** 详情抽屉打开时按别名拉最近 5 次测速 */
async function loadHistory(alias: string): Promise<void> {
  historyLoading.value = true;
  try {
    const res = await api<{ runs: BenchHistoryEntryVM[] }>(
      `/models/bench/history?alias=${encodeURIComponent(alias)}&limit=5`,
    );
    if (detailAlias.value === alias) {
      detailHistory.value = res.runs;
      selectedRunIdx.value = 0;
    }
  } catch {
    if (detailAlias.value === alias) {
      detailHistory.value = [];
      selectedRunIdx.value = 0;
    }
  } finally {
    historyLoading.value = false;
  }
}

function closeDetail(): void {
  benchRunning.value = false;
  detailAlias.value = null;
  detailHistory.value = [];
}

function openAdd(): void {
  formMode.value = 'add';
  editingAlias.value = null;
  form.value = emptyForm();
  beginForm();
}

function openEdit(alias: string): void {
  const p = profiles.value.find((x) => x.alias === alias);
  if (!p) {
    showToast('模型不存在，可能已被移除', 'error');
    return;
  }
  closeDetail();
  menu.value = null;
  formMode.value = 'edit';
  editingAlias.value = alias;
  const adv = p.advanced;
  form.value = {
    alias,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: '',
    temperature: p.temperature !== undefined ? String(p.temperature) : '',
    maxTokens: adv?.maxTokens !== undefined ? String(adv.maxTokens) : '',
    topP: adv?.topP !== undefined ? String(adv.topP) : '',
    topK: adv?.topK !== undefined ? String(adv.topK) : '',
    frequencyPenalty: adv?.frequencyPenalty !== undefined ? String(adv.frequencyPenalty) : '',
    timeoutMs: adv?.timeoutMs !== undefined ? String(adv.timeoutMs) : '',
    headers: Object.entries(adv?.headers ?? {}).map(([key, value]) => ({ key, value })),
  };
  beginForm();
}

function beginForm(): void {
  errors.value = {};
  submitErr.value = '';
  touched.value = false;
  showKey.value = false;
  // 打开抽屉时始终收起，只在折叠头显示「已配置 N 项」
  advOpen.value = false;
  formOpen.value = true;
}

/** 请求头行：新增时展开折叠区，删除后立即复校验 */
function addHeaderRow(): void {
  form.value.headers.push({ key: '', value: '' });
  advOpen.value = true;
}

function removeHeaderRow(index: number): void {
  form.value.headers.splice(index, 1);
  revalidate();
}

function closeForm(): void {
  formOpen.value = false;
  touched.value = false;
  errors.value = {};
  submitErr.value = '';
  editingAlias.value = null;
  formMode.value = 'add';
}

function revalidate(): void {
  if (!touched.value) return;
  errors.value = validateModelForm(form.value, { editing: formMode.value === 'edit' });
  // 错误落在折叠区时自动展开，否则用户看不到红框
  if (hasAdvancedErrors(errors.value)) advOpen.value = true;
}

async function submit(): Promise<void> {
  const editing = formMode.value === 'edit';
  const errs = validateModelForm(form.value, { editing });
  errors.value = errs;
  touched.value = true;
  submitErr.value = '';
  if (hasAdvancedErrors(errs)) advOpen.value = true;
  if (hasErrors(errs)) return;

  busy.value = true;
  try {
    const tempRaw = form.value.temperature.trim();
    const name = form.value.name.trim();
    const baseUrl = form.value.baseUrl.trim();
    const apiKey = form.value.apiKey.trim();
    const advanced = buildAdvanced(form.value);

    if (editing) {
      const alias = editingAlias.value as string;
      const old = profiles.value.find((p) => p.alias === alias);
      // 高级参数（请求头/超时）也会影响连通性，变更后同样作废旧结论
      const advancedChanged = JSON.stringify(old?.advanced ?? null) !== JSON.stringify(advanced ?? null);
      const changed = !!old && (old.name !== name || old.baseUrl !== baseUrl || apiKey !== '' || advancedChanged);
      await api(`/models/${encodeURIComponent(alias)}`, {
        method: 'PATCH',
        json: {
          profile: {
            name,
            baseUrl,
            ...(apiKey ? { apiKey } : {}),
            // 空 = 删除该配置，交回服务商默认值
            temperature: tempRaw === '' ? null : Number(tempRaw),
            // 高级设置整组提交：全部留空 = 删除该模型的 advanced
            advanced: advanced ?? null,
          },
        },
      });
      if (changed) {
        // 接入点变了，旧的连通性结论作废，避免误以为仍然可用
        const rest = { ...tests.value };
        delete rest[alias];
        tests.value = rest;
      }
      showToast(`已保存 ${alias} 的修改${changed ? ' · 建议重新测试连通性' : ''}`, 'success');
    } else {
      const temperature = tempRaw === '' ? undefined : Number(tempRaw);
      await api('/models', {
        method: 'POST',
        json: {
          alias: form.value.alias.trim(),
          profile: {
            name,
            baseUrl,
            apiKey,
            ...(temperature !== undefined ? { temperature } : {}),
            ...(advanced ? { advanced } : {}),
          },
        },
      });
      showToast(`已登记模型 ${form.value.alias.trim()}`, 'success');
    }
    closeForm();
    await refresh();
  } catch (e) {
    if (!(e instanceof AuthError)) submitErr.value = e instanceof ApiError ? e.message : `${editing ? '保存' : '登记'}失败: ${errText(e)}`;
  } finally {
    busy.value = false;
  }
}

async function activate(alias: string): Promise<void> {
  busy.value = true;
  try {
    await api('/model', { method: 'PUT', json: { alias } });
    showToast(`已切换生效模型：${alias}`, 'success');
    await refresh();
  } catch (e) {
    guard(e, '切换失败');
  } finally {
    busy.value = false;
  }
}

async function test(alias: string): Promise<void> {
  if (testingAlias.value) return;
  testingAlias.value = alias;
  try {
    const r = await api<TestLike>(`/models/${encodeURIComponent(alias)}/test`, { method: 'POST' });
    tests.value = { ...tests.value, [alias]: r };
    showToast(
      r.ok ? `${alias} 连通正常 · ${fmtMs(r.latencyMs)}` : `${alias} 连通失败：${r.error ?? '未知错误'}`,
      r.ok ? 'success' : 'error',
    );
  } catch (e) {
    guard(e, '测试失败');
  } finally {
    testingAlias.value = null;
  }
}

function askDelete(alias: string): void {
  menu.value = null;
  const p = profiles.value.find((x) => x.alias === alias);
  if (p?.isCurrent) {
    showToast('当前生效模型不能移除，请先切换', 'error');
    return;
  }
  confirmAlias.value = alias;
}

async function removeModel(alias: string): Promise<void> {
  busy.value = true;
  try {
    await api(`/models/${encodeURIComponent(alias)}`, { method: 'DELETE' });
    showToast(`已移除模型 ${alias}`, 'success');
    const restTests = { ...tests.value };
    delete restTests[alias];
    tests.value = restTests;
    const restPerf = { ...perf.value };
    delete restPerf[alias];
    perf.value = restPerf;
    if (detailAlias.value === alias) closeDetail();
    await refresh();
  } catch (e) {
    guard(e, '移除失败');
  } finally {
    busy.value = false;
  }
}

async function confirmDelete(): Promise<void> {
  const alias = confirmAlias.value;
  confirmAlias.value = null;
  if (alias) await removeModel(alias);
}

function menuAction(a: 'detail' | 'edit' | 'copy' | 'test' | 'bench' | 'del', alias: string): void {
  menu.value = null;
  if (a === 'detail') void openDetail(alias);
  else if (a === 'edit') openEdit(alias);
  else if (a === 'copy') copyText(alias, '别名已复制');
  else if (a === 'test') void test(alias);
  else if (a === 'bench') void startBench(alias);
  else askDelete(alias);
}

/**
 * 在详情抽屉内开跑测速（对齐原型：⋯ 菜单「性能测速」= 打开详情并立即开跑）。
 * 组件挂载后再调用 start，确保 ref 已就绪。
 */
async function startBench(alias: string): Promise<void> {
  menu.value = null;
  if (detailAlias.value !== alias) await openDetail(alias);
  if (detailAlias.value !== alias || benchRunning.value) return;
  benchRunning.value = true;
  await nextTick();
  void benchRun.value?.start();
}

function onBenchFinished(): void {
  benchRunning.value = false;
  void loadPerf();
  if (detailAlias.value) void loadHistory(detailAlias.value);
}

function onDocClick(e: MouseEvent): void {
  const t = e.target as HTMLElement | null;
  if (!t || !t.closest('.mv-menu') && !t.closest('.mv-more')) menu.value = null;
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (confirmAlias.value) { confirmAlias.value = null; return; }
    if (formOpen.value) { closeForm(); return; }
    if (detailAlias.value) { closeDetail(); return; }
    menu.value = null;
    return;
  }
  const tag = (e.target as HTMLElement | null)?.tagName ?? '';
  if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) {
    e.preventDefault();
    searchEl.value?.focus();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('click', onDocClick);
  void refresh();
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('click', onDocClick);
});
</script>

<template>
  <div class="page mv-page">
    <!-- 页头：标题 + 说明 + 刷新 / 添加 -->
    <header class="mv-head">
      <div class="mv-lead">
        <div class="mv-eyebrow">
          <span v-html="icon('chip')"></span>模型接入 · 登记簿
        </div>
        <h1>模型</h1>
        <p class="mv-sub">登记 OpenAI 兼容的接入点，切换后立即用于后续对话。测试只收首块（近免费），测速才跑完整流。</p>
      </div>
      <div class="mv-actions">
        <button class="mv-btn icon" :disabled="busy" title="刷新登记簿" aria-label="刷新登记簿" @click="refresh">
          <span v-html="icon('refresh')"></span>
        </button>
        <button class="mv-btn primary" title="登记一个新的模型接入点" @click="openAdd">
          <span v-html="icon('plus')"></span>添加模型
        </button>
      </div>
    </header>

    <!-- 统计条：已登记 / 生效中 / 需关注 -->
    <div class="mv-stats">
      <div class="mv-stat">
        <div class="k"><i class="on"></i>已登记</div>
        <div class="v">{{ profiles.length }}<small>个</small></div>
      </div>
      <div class="mv-stat">
        <div class="k"><i class="on"></i>生效中</div>
        <div class="v">{{ activeCount }}<small>个</small></div>
      </div>
      <div class="mv-stat">
        <div class="k"><i class="bad"></i>需关注</div>
        <div class="v" :class="{ bad: attentionCount > 0 }">{{ attentionCount }}<small>个</small></div>
      </div>
    </div>

    <!-- 工具条：搜索 + 状态分段 + 排序 + 计数 -->
    <div class="mv-toolbar">
      <div class="mv-search">
        <span v-html="icon('search', 1.5)"></span>
        <input ref="searchEl" v-model="query" type="text" placeholder="搜索别名、型号或主机" aria-label="搜索模型">
        <kbd>/</kbd>
      </div>
      <div class="mv-seg" role="tablist" aria-label="按状态筛选">
        <button type="button" :class="{ on: tab === 'all' }" @click="tab = 'all'">全部 <span class="n">{{ counts.all }}</span></button>
        <button type="button" :class="{ on: tab === 'active' }" @click="tab = 'active'">生效中 <span class="n">{{ counts.active }}</span></button>
        <button type="button" :class="{ on: tab === 'attention' }" @click="tab = 'attention'">需关注 <span class="n">{{ counts.attention }}</span></button>
      </div>
      <select class="mv-sel" :value="sortMode" aria-label="排序" @change="onSortChange">
        <option value="active">生效优先</option>
        <option value="alias">别名 A→Z</option>
        <option value="ttft">TTFT 升序</option>
      </select>
      <span class="mv-count">显示 {{ rows.length }} / {{ profiles.length }}</span>
    </div>

    <div v-if="snapshotNotice" class="notice info">
      未激活任何登记模型，当前使用配置文件里的 <b>model.*</b> 快照<template v-if="current">（{{ current.model.name }}）</template>；把某一项设为默认即可接管。
    </div>

    <!-- 异常汇总：一键直达第一个失败模型 -->
    <div v-if="loaded && attentionCount > 0" class="mv-alert">
      <span class="ai">!</span>
      <div>
        <b>{{ attentionCount }} 个模型需要处理</b>：{{ failedAliases.join('、') }}。
        <button class="mv-link" @click="openDetail(failedAliases[0])">查看详情</button>
      </div>
    </div>

    <!-- 骨架（首屏加载） -->
    <div v-if="!loaded" class="mv-grid" aria-busy="true">
      <div v-for="i in 4" :key="i" class="mv-skel">
        <div class="t"></div>
        <div class="l"><i></i><i></i><i></i></div>
      </div>
    </div>

    <!-- 空态 -->
    <div v-else-if="profiles.length === 0" class="mv-nothing">
      <span class="nt-ico" v-html="icon('chip', 1.5)"></span>
      <b>还没有登记任何模型</b>
      <p>登记一个 OpenAI 兼容的接入点即可开始对话：需要别名、型号名、Base URL 与 API Key。也可以直接在终端用 <code class="mono">/model add</code> 登记。</p>
      <button class="mv-btn sm primary" @click="openAdd">
        <span v-html="icon('plus')"></span>添加第一个模型
      </button>
    </div>

    <!-- 无匹配 -->
    <div v-else-if="rows.length === 0" class="mv-nothing">
      <span class="nt-ico" v-html="icon('search', 1.5)"></span>
      <b>没有匹配的模型</b>
      <p>换个关键字，或切回「全部」分段。当前筛选：{{ tab === 'attention' ? '需关注' : tab === 'active' ? '生效中' : '全部' }}。</p>
      <button class="mv-btn sm primary" @click="query = ''; tab = 'all'">清空筛选</button>
    </div>

    <!-- 卡片网格 -->
    <div v-else class="mv-grid">
      <article
        v-for="p in rows"
        :key="p.alias"
        class="mv-card"
        :class="{ on: p.isCurrent, bad: !p.isCurrent && isFailed(p) }"
        role="button"
        tabindex="0"
        :aria-label="`查看 ${p.alias} 详情`"
        :data-alias="p.alias"
        @click="openDetail(p.alias)"
        @keydown.enter.prevent="openDetail(p.alias)"
        @keydown.space.prevent="openDetail(p.alias)"
      >
        <div class="mv-top">
          <span class="mv-tile" :class="providerMetaOf(p.baseUrl).provider">
            {{ providerMetaOf(p.baseUrl).text }}
          </span>
          <div class="mv-id">
            <div class="mv-title">
              <h3>{{ p.alias }}</h3>
              <span class="mv-tag">{{ providerMetaOf(p.baseUrl).label }}</span>
            </div>
            <p class="mv-meta">
              <span class="m" :title="p.name">{{ p.name }}</span>
              <span class="dot"></span>
              <span class="m" :title="p.baseUrl">{{ hostOf(p.baseUrl) }}</span>
            </p>
            <p class="mv-meta sub">
              <span class="m" title="API Key（服务端已遮蔽）">{{ p.apiKey }}</span>
              <template v-if="p.temperature !== undefined">
                <span class="dot"></span>
                <span class="m">T {{ p.temperature }}</span>
              </template>
            </p>
          </div>
          <button class="mv-more" type="button" title="更多操作" aria-label="更多操作" @click.stop="openMenu(p.alias, $event)">
            <span v-html="icon('dots')"></span>
          </button>
        </div>

        <div class="mv-pills">
          <span v-for="(pl, i) in pillsOf(p)" :key="i" class="pill" :class="pl.tone" :title="pl.title">
            <span v-if="pl.icon" v-html="icon(pl.icon, 2)"></span>{{ pl.text }}
          </span>
        </div>

        <div class="mv-foot">
          <span>{{ footText(p) }}</span>
          <span class="sp"></span>
          <span v-if="p.isCurrent" class="mv-on-txt">当前生效 · 立即用于新对话</span>
          <button v-else class="mv-btn sm primary" :disabled="busy" title="切换为当前生效模型" @click.stop="activate(p.alias)">
            <span v-html="icon('arrow')"></span>设置为默认
          </button>
        </div>
      </article>
    </div>

    <div class="mv-footline">
      <span>测试 = 连通性探测；测速 = 完整流性能体检，两者并存互不替代。</span>
      <span class="sp"></span>
      <span>共 <b>{{ profiles.length }}</b> 个模型 · API Key 仅回显后四位</span>
    </div>

    <!-- 卡片 ⋯ 菜单 -->
    <div v-if="menu" class="mv-menu" :style="{ top: `${menu.top}px`, left: `${menu.left}px` }">
      <div class="m-head">{{ menu.alias }}</div>
      <button type="button" @click="menuAction('detail', menu.alias)">
        <span v-html="icon('info', 1.5)"></span>查看详情
      </button>
      <button type="button" @click="menuAction('edit', menu.alias)">
        <span v-html="icon('pencil', 1.5)"></span>编辑信息
      </button>
      <button type="button" @click="menuAction('copy', menu.alias)">
        <span v-html="icon('copy', 1.5)"></span>复制别名
      </button>
      <button type="button" @click="menuAction('test', menu.alias)">
        <span v-html="icon('pulse', 1.5)"></span>连通性测试
      </button>
      <button type="button" @click="menuAction('bench', menu.alias)">
        <span v-html="icon('gauge', 1.5)"></span>性能测速
      </button>
      <div class="hr"></div>
      <button
        type="button"
        class="danger"
        :disabled="menuProfile?.isCurrent"
        :title="menuProfile?.isCurrent ? '当前生效模型不能移除' : '移除模型'"
        @click="menuAction('del', menu.alias)"
      >
        <span v-html="icon('trash', 1.5)"></span>移除模型
      </button>
    </div>

    <!-- 详情抽屉 -->
    <template v-if="detail">
      <div class="mv-backdrop" @click="closeDetail"></div>
      <aside class="mv-drawer" role="dialog" aria-modal="true" aria-labelledby="mv-detail-title">
        <div class="mv-drv-head">
          <span class="mv-tile" :class="detailMeta?.provider">{{ detailMeta?.text }}</span>
          <div class="mv-drv-title">
            <h2 id="mv-detail-title">
              {{ detail.alias }}
              <span v-if="detail.isCurrent" class="pill brand"><span v-html="icon('check', 2)"></span>生效中</span>
            </h2>
            <div class="mv-drv-sub">
              <span class="mv-tag">{{ detailMeta?.label }}</span>
              <span class="mono">{{ detail.name }}</span>
              <span class="sep">·</span>
              <span class="mono">{{ hostOf(detail.baseUrl) }}</span>
            </div>
          </div>
          <button class="mv-close" title="编辑模型信息" aria-label="编辑模型信息" @click="openEdit(detail.alias)">
            <span v-html="icon('pencil', 1.5)"></span>
          </button>
          <button class="mv-close" title="关闭" aria-label="关闭" @click="closeDetail">
            <span v-html="icon('close')"></span>
          </button>
        </div>

        <div class="mv-drv-body">
          <div class="mv-lab"><span v-html="icon('chip', 1.5)"></span>接入配置</div>
          <table class="kv">
            <tbody>
              <tr><td class="k">别名</td><td class="v"><code>{{ detail.alias }}</code></td></tr>
              <tr><td class="k">型号</td><td class="v"><code>{{ detail.name }}</code></td></tr>
              <tr>
                <td class="k">Base URL</td>
                <td class="v">
                  <code class="url">{{ detail.baseUrl }}</code>
                  <button class="mv-mini" title="复制 Base URL" aria-label="复制 Base URL" @click="copyText(detail.baseUrl, 'Base URL 已复制')">
                    <span v-html="icon('copy', 1.5)"></span>
                  </button>
                </td>
              </tr>
              <tr>
                <td class="k">API Key</td>
                <td class="v"><code>{{ detail.apiKey }}</code> <span class="mv-dim">仅回显后四位</span></td>
              </tr>
              <tr>
                <td class="k">temperature</td>
                <td class="v">
                  <code v-if="detail.temperature !== undefined">{{ detail.temperature }}</code>
                  <span v-else class="mv-dim">未设置（服务商默认）</span>
                </td>
              </tr>
            </tbody>
          </table>

          <div class="mv-lab"><span v-html="icon('pulse', 1.5)"></span>连通性</div>
          <div class="mv-conn" :class="detailConn.cls">
            <span class="dot"></span>
            <div class="txt">
              <b>{{ detailConn.title }}</b>
              <p>{{ detailConn.sub }}</p>
            </div>
            <button class="mv-btn sm" :disabled="!!testingAlias" @click="test(detail.alias)">
              {{ testingAlias === detail.alias ? '测试中…' : '立即测试' }}
            </button>
          </div>

          <div class="mv-lab">
            <span v-html="icon('gauge', 1.5)"></span>性能
            <span v-if="benchRunning" class="mv-lab-sub">运行中</span>
            <span v-else-if="detailPerf" class="mv-lab-sub">最近 {{ detailPerf.when }}</span>
          </div>

          <!-- 运行中：测速直接融入抽屉，不再另开弹窗（原型 D6） -->
          <ModelBenchRun
            v-if="benchRunning"
            ref="benchRun"
            :key="detail.alias"
            :alias="detail.alias"
            @finished="onBenchFinished"
          />
          <div v-else-if="historyLoading" class="mv-empty-mini">
            <b>正在读取测速历史…</b>
          </div>
          <div v-else-if="!detailPerf" class="mv-empty-mini">
            <b>还没有性能数据</b>
            <p>连通性只回答「能不能用」；测速跑完整流，回答「有多快、稳不稳」。按标准档位（3 轮 × 2 提示词 · max 256）跑一次即可。</p>
            <button class="mv-btn sm primary" @click="startBench(detail.alias)">开始测速</button>
          </div>
          <template v-else>
            <div class="mv-metrics">
              <div class="mv-metric" :class="ttftTone(detailPerf.ttft)">
                <div class="k">TTFT（首 token）</div>
                <div class="v">{{ fmtMs(detailPerf.ttft) }}</div>
                <div class="s">{{ detailPerf.okCount }}/{{ detailPerf.total }} 轮成功</div>
              </div>
              <div class="mv-metric" :class="tpsTone(detailPerf.tps)">
                <div class="k">解码吞吐</div>
                <div class="v">{{ fmtTps(detailPerf.tps) }}<span class="u">tok/s</span></div>
                <div class="s">按输出 token 计费</div>
              </div>
              <div class="mv-metric" :class="successTone(detailPerf.rate)">
                <div class="k">稳定性</div>
                <div class="v">{{ Math.round(detailPerf.rate * 100) }}<span class="u">%</span></div>
                <div class="s">{{ detailPerf.okCount }}/{{ detailPerf.total }} 轮成功</div>
              </div>
            </div>
            <div v-if="detailSpark" class="mv-sparkrow">
              <span class="mv-dim">TTFT 走势</span>
              <svg width="120" height="24" viewBox="0 0 120 24">
                <polyline :points="detailSpark" fill="none" stroke="var(--brand)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />
              </svg>
            </div>
            <table class="mv-hist">
              <thead><tr><th>时间</th><th>TTFT</th><th>吞吐</th><th>成功</th></tr></thead>
              <tbody>
                <tr
                  v-for="(h, i) in detailHistory"
                  :key="h.runId"
                  class="sel-row"
                  :class="{ sel: i === selectedRunIdx }"
                  :title="'查看该次运行的明细'"
                  @click="selectedRunIdx = i"
                >
                  <td>{{ fmtWhen(h.finishedAt) }}</td>
                  <td>{{ fmtMs(h.summary.ttft.p50) }}</td>
                  <td>{{ fmtTps(h.summary.decodeTps.p50) }} tok/s</td>
                  <td :class="h.summary.okCount === h.summary.total ? 'ok' : 'bad'">{{ h.summary.okCount }}/{{ h.summary.total }}</td>
                </tr>
              </tbody>
            </table>
            <div class="mv-dim" style="font-size: 10.5px">点击某一行查看该次的每轮明细</div>

            <!-- 选中那一次的明细（对齐旧测速页：补充指标 + 每轮样本） -->
            <div v-if="selectedRun" class="mv-run-detail">
              <div class="mv-dt-h">
                <b>本次明细</b>
                <span>{{ fmtWhen(selectedRun.finishedAt) }} · {{ selectedRun.model || selectedRun.alias }}</span>
              </div>
              <div v-if="selectedRun.summary.suspectBuffered" class="mv-warn">
                疑似被网关缓冲：chunk 几乎一次性到达，TPS 会虚高，不建议作为选型依据。
              </div>
              <div v-if="selectedErr" class="mv-warn danger">
                {{ selectedErr.label }}：{{ selectedErr.count }} 轮失败（失败即记一轮，成功轮次仍可参考）
              </div>
              <div class="mv-dt-grid">
                <div><span>TTFT p90</span><b>{{ fmtP(selectedRun.summary.ttft, 'p90') }}</b></div>
                <div><span>TPOT</span><b>{{ fmtMs(selectedRun.summary.tpot.p50) }}</b></div>
                <div><span>ITL p90</span><b>{{ fmtMs(selectedRun.summary.itlP90Ms.p50) }}</b></div>
                <div><span>端到端</span><b>{{ fmtTps(selectedRun.summary.e2eTps.p50) }}<i>tok/s</i></b></div>
              </div>
              <table class="mv-hist mv-samples">
                <thead>
                  <tr><th>轮</th><th>提示词</th><th>TTFT</th><th>TPOT</th><th>解码</th><th>输出</th><th>缓存</th><th>状态</th></tr>
                </thead>
                <tbody>
                  <tr v-for="(s, i) in selectedRun.summary.samples" :key="i">
                    <td>{{ i + 1 }}</td>
                    <td>{{ promptLabel(s.prompt) }}</td>
                    <td>{{ fmtMs(s.ttftMs) }}</td>
                    <td>{{ fmtMs(s.tpotMs) }}</td>
                    <td>{{ fmtTps(s.decodeTps) }}</td>
                    <td>{{ s.estimated ? '~' : '' }}{{ s.outTokens ?? '—' }}</td>
                    <td>{{ s.cacheHitTokens ?? '—' }}</td>
                    <td :class="s.ok ? 'ok' : 'bad'">{{ s.ok ? 'ok' : errorLabel(s.errorKind) }}</td>
                  </tr>
                  <tr v-if="selectedRun.summary.samples.length === 0">
                    <td colspan="8" class="mv-dim">没有样本</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="mv-perf-acts">
              <button class="mv-btn sm primary" @click="startBench(detail.alias)">重新测速</button>
              <span class="mv-dim">完整流测速，按输出 token 计费</span>
            </div>
          </template>

          <div class="mv-lab"><span v-html="icon('alert', 1.5)"></span>危险区</div>
          <div class="mv-danger">
            <div>
              <b>移除模型</b>
              <p v-if="detail.isCurrent">当前生效模型不能移除，请先把其他模型设置为默认。</p>
              <p v-else>删除该接入点，明文 Key 一并移除，不可撤销。</p>
            </div>
            <button class="mv-btn sm danger-outline" :disabled="detail.isCurrent || busy" @click="askDelete(detail.alias)">移除</button>
          </div>
        </div>

        <div class="mv-drv-foot">
          <span class="sp"></span>
          <button class="mv-btn" @click="closeDetail">关闭</button>
          <button v-if="detail.isCurrent" class="mv-btn primary" disabled>当前生效</button>
          <button v-else class="mv-btn primary" :disabled="busy" @click="activate(detail.alias)">
            <span v-html="icon('arrow')"></span>设置为默认
          </button>
        </div>
      </aside>
    </template>

    <!-- 添加 / 编辑表单抽屉 -->
    <template v-if="formOpen">
      <div class="mv-backdrop" @click="closeForm"></div>
      <aside class="mv-drawer" role="dialog" aria-modal="true" aria-labelledby="md-form-title">
        <div class="mv-drv-head">
          <span class="mv-tile" :class="formTile.provider">{{ formTile.text }}</span>
          <div class="mv-drv-title">
            <h2 id="md-form-title" class="sans">{{ formMode === 'edit' ? '编辑模型' : '添加模型' }}</h2>
            <div class="mv-drv-sub">
              {{ formMode === 'edit' ? `修改 ${editingAlias} 的接入配置` : '登记一个 OpenAI 兼容的接入点' }}
            </div>
          </div>
          <button class="mv-close" title="关闭" aria-label="关闭" @click="closeForm">
            <span v-html="icon('close')"></span>
          </button>
        </div>

        <div class="mv-drv-body">
          <p v-if="submitErr" class="mv-errbox">{{ submitErr }}</p>

          <div class="field">
            <label for="mv-f-alias">别名 <span v-if="formMode === 'add'" class="req">*</span></label>
            <input
              id="mv-f-alias"
              v-model="form.alias"
              class="mono"
              :class="{ bad: errors.alias }"
              :readonly="formMode === 'edit'"
              placeholder="如 deepseek-flash"
              @input="revalidate"
            >
            <p v-if="errors.alias" class="err"><span v-html="icon('alert')"></span>{{ errors.alias }}</p>
            <p v-else-if="formMode === 'edit'" class="hint">别名是登记簿主键，不可修改；需要改名请移除后重新登记。</p>
            <p v-else class="hint">对话内切换模型与 <code class="mono">/model</code> 命令都用这个别名，同名会冲突。</p>
          </div>

          <div class="field">
            <label for="mv-f-name">型号 <span class="req">*</span></label>
            <input
              id="mv-f-name"
              v-model="form.name"
              class="mono"
              :class="{ bad: errors.name }"
              placeholder="如 deepseek-chat"
              @input="revalidate"
            >
            <p v-if="errors.name" class="err"><span v-html="icon('alert')"></span>{{ errors.name }}</p>
            <p v-else class="hint">请求体里的 <code class="mono">model</code> 字段原值，以服务商文档为准。</p>
          </div>

          <div class="field-sep"></div>

          <div class="field">
            <label for="mv-f-base">Base URL <span class="req">*</span></label>
            <input
              id="mv-f-base"
              v-model="form.baseUrl"
              class="mono"
              :class="{ bad: errors.baseUrl }"
              placeholder="https://api.deepseek.com/v1"
              @input="revalidate"
            >
            <p v-if="errors.baseUrl" class="err"><span v-html="icon('alert')"></span>{{ errors.baseUrl }}</p>
            <p v-else class="hint">兼容 OpenAI 协议的接入点，通常以 <code class="mono">/v1</code> 结尾。</p>
          </div>

          <div class="field">
            <label for="mv-f-key">API Key <span v-if="formMode === 'add'" class="req">*</span></label>
            <div class="with-suffix">
              <input
                id="mv-f-key"
                v-model="form.apiKey"
                class="mono"
                :class="{ bad: errors.apiKey }"
                :type="showKey ? 'text' : 'password'"
                :placeholder="formMode === 'edit' ? '留空保持现有 Key' : 'sk-...'"
                @input="revalidate"
              >
              <button type="button" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button>
            </div>
            <p v-if="errors.apiKey" class="err"><span v-html="icon('alert')"></span>{{ errors.apiKey }}</p>
            <p v-else-if="formMode === 'edit'" class="hint">留空表示保持现有 Key（{{ editKeyMasked }}）；填写则整体替换，页面仍只回显后四位。</p>
            <p v-else class="hint">只保存在服务端配置文件里，页面回显时一律遮蔽为后四位。</p>
          </div>

          <div class="field">
            <label for="mv-f-temp">temperature <span class="opt">可选</span></label>
            <input
              id="mv-f-temp"
              v-model="form.temperature"
              class="mono"
              style="max-width:190px"
              :class="{ bad: errors.temperature }"
              placeholder="0 ~ 2，留空用服务商默认"
              @input="revalidate"
            >
            <p v-if="errors.temperature" class="err"><span v-html="icon('alert')"></span>{{ errors.temperature }}</p>
            <p v-else-if="formMode === 'edit'" class="hint">清空表示删除该配置，交回服务商默认值。</p>
          </div>

          <!-- 高级设置：默认收起，留空即不下发 -->
          <div class="mv-adv" :class="{ open: advOpen }">
            <button
              type="button"
              class="mv-adv-head"
              :aria-expanded="advOpen"
              aria-controls="mv-adv-body"
              @click="advOpen = !advOpen"
            >
              <span class="chev" v-html="icon('caret')"></span>
              <span>高级设置</span>
              <span class="sum">
                <span v-if="advancedCount(form) > 0" class="mv-adv-badge">已配置 {{ advancedCount(form) }} 项</span>
                <span v-else>可选 · 默认收起</span>
              </span>
            </button>
            <div v-show="advOpen" id="mv-adv-body" class="mv-adv-body">
              <div class="mv-adv-grid">
                <div class="field">
                  <label for="mv-f-max-tokens">max_tokens <span class="opt">可选</span></label>
                  <input
                    id="mv-f-max-tokens"
                    v-model="form.maxTokens"
                    class="mono"
                    inputmode="numeric"
                    placeholder="如 2048"
                    :class="{ bad: errors.maxTokens }"
                    @input="revalidate"
                  >
                  <p v-if="errors.maxTokens" class="err"><span v-html="icon('alert')"></span>{{ errors.maxTokens }}</p>
                </div>
                <div class="field">
                  <label for="mv-f-top-p">top_p <span class="opt">可选</span></label>
                  <input
                    id="mv-f-top-p"
                    v-model="form.topP"
                    class="mono"
                    inputmode="decimal"
                    placeholder="0 ~ 1，缺省 1"
                    :class="{ bad: errors.topP }"
                    @input="revalidate"
                  >
                  <p v-if="errors.topP" class="err"><span v-html="icon('alert')"></span>{{ errors.topP }}</p>
                </div>
                <div class="field">
                  <label for="mv-f-top-k">top_k <span class="opt">可选</span></label>
                  <input
                    id="mv-f-top-k"
                    v-model="form.topK"
                    class="mono"
                    inputmode="numeric"
                    placeholder="如 40，留空不下发"
                    :class="{ bad: errors.topK }"
                    @input="revalidate"
                  >
                  <p v-if="errors.topK" class="err"><span v-html="icon('alert')"></span>{{ errors.topK }}</p>
                </div>
                <div class="field">
                  <label for="mv-f-freq-penalty">frequency_penalty <span class="opt">可选</span></label>
                  <input
                    id="mv-f-freq-penalty"
                    v-model="form.frequencyPenalty"
                    class="mono"
                    inputmode="decimal"
                    placeholder="-2 ~ 2，缺省 0"
                    :class="{ bad: errors.frequencyPenalty }"
                    @input="revalidate"
                  >
                  <p v-if="errors.frequencyPenalty" class="err"><span v-html="icon('alert')"></span>{{ errors.frequencyPenalty }}</p>
                </div>
                <div class="field">
                  <label for="mv-f-timeout">请求超时 <span class="opt">毫秒</span></label>
                  <input
                    id="mv-f-timeout"
                    v-model="form.timeoutMs"
                    class="mono"
                    inputmode="numeric"
                    placeholder="如 120000，缺省沿用全局"
                    :class="{ bad: errors.timeoutMs }"
                    @input="revalidate"
                  >
                  <p v-if="errors.timeoutMs" class="err"><span v-html="icon('alert')"></span>{{ errors.timeoutMs }}</p>
                </div>
              </div>

              <div class="field">
                <label>自定义请求头 <span class="opt">可选</span></label>
                <div class="mv-hdr-rows">
                  <div v-for="(row, i) in form.headers" :key="i" class="mv-hdr-row">
                    <input
                      v-model="row.key"
                      class="mono"
                      placeholder="Header 名，如 api-version"
                      :class="{ bad: errors.headers }"
                      @input="revalidate"
                    >
                    <input
                      v-model="row.value"
                      class="mono"
                      placeholder="值，如 2024-10-21"
                      :class="{ bad: errors.headers }"
                      @input="revalidate"
                    >
                    <button type="button" class="del" title="删除该请求头" @click="removeHeaderRow(i)">
                      <span v-html="icon('close')"></span>
                    </button>
                  </div>
                </div>
                <button type="button" class="mv-adv-add" @click="addHeaderRow">＋ 添加请求头</button>
                <p v-if="errors.headers" class="err"><span v-html="icon('alert')"></span>{{ errors.headers }}</p>
                <p v-else class="mv-adv-note">
                  用于 <code class="mono">OpenAI-Organization</code>、Azure 的 <code class="mono">api-version</code>
                  这类租户/网关标识；留空即不下发。Authorization 由 API Key 自动生成，不允许覆盖。
                </p>
              </div>

              <p class="mv-adv-note">高级项留空表示「不下发」，使用服务商默认值；填写后仅在该模型被调用时生效，切换模型互不影响。</p>
            </div>
          </div>

        </div>

        <div class="mv-drv-foot">
          <button class="mv-btn" @click="closeForm">取消</button>
          <span class="sp"></span>
          <button class="mv-btn primary" :disabled="busy" @click="submit">
            {{ formMode === 'edit' ? '保存修改' : '登记模型' }}
          </button>
        </div>
      </aside>
    </template>

    <!-- 删除确认 -->
    <div v-if="confirmAlias" class="mv-modal-mask" @click.self="confirmAlias = null">
      <div class="mv-modal" role="dialog" aria-modal="true" aria-labelledby="mv-confirm-title">
        <h3 id="mv-confirm-title">移除模型？</h3>
        <p>
          将移除「{{ confirmAlias }}」<template v-if="confirmTarget">（{{ confirmTarget.name }}）</template>，不可撤销。
        </p>
        <div class="mv-modal-acts">
          <button class="mv-btn" @click="confirmAlias = null">取消</button>
          <button class="mv-btn danger" :disabled="busy" @click="confirmDelete">确认移除</button>
        </div>
      </div>
    </div>
  </div>
</template>
