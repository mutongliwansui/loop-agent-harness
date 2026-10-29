<script setup lang="ts">
// 模型视图（需求 20261029-004 重设计 · 方案 D1–D13）
//
// 端点映射（语义未变）：GET /models（登记簿，apiKey 遮蔽 + isCurrent）· GET /model（当前生效快照）
// · POST /models（登记，同名 409）· PUT /model（切换激活）· POST /models/:alias/test（连通性）
// · DELETE /models/:alias?scope=（删当前激活 409）· GET /models/bench/history（测速摘要）
//
// 数据流：/models → sortActiveFirst（生效置顶）→ filterProfiles（关键字）→ 行卡；
// 状态胶囊由 modelPills() 派生（未测试走中性色，绿色只给成功、红色只给真失败）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, ApiError, AuthError } from '../api/client';
import { showToast } from '../toast';
import { errText } from '../utils';
import ConfirmButton from '../components/ConfirmButton.vue';
import BenchDrawer from '../components/BenchDrawer.vue';
import type { BenchHistoryEntryVM } from '../bench-format';
import {
  filterProfiles,
  hasErrors,
  hostOf,
  modelIconSvg,
  modelPills,
  sortActiveFirst,
  validateModelForm,
  type ModelFormErrors,
  type ModelFormInput,
  type ModelIconKey,
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
  isCurrent: boolean;
}

const profiles = ref<ProfileRow[]>([]);
const current = ref<{ model: { name: string; baseUrl: string; apiKey: string; temperature?: number }; active: string | null } | null>(null);
const scope = ref<'workspace' | 'global'>('workspace');
const busy = ref(false);
/** 首屏是否已加载完成（区分骨架与空态） */
const loaded = ref(false);
/** 关键字过滤（D11） */
const query = ref('');

/** 登记抽屉（D7） */
const drawerOpen = ref(false);
const showKey = ref(false);
/** 提交后开启实时校验，避免一打开就飘红 */
const touched = ref(false);
const form = ref<ModelFormInput>({ alias: '', name: '', baseUrl: '', apiKey: '', temperature: '' });
const errors = ref<ModelFormErrors>({});
const submitErr = ref('');

const tests = ref<Record<string, TestLike>>({});
const perf = ref<Record<string, PerfLike>>({});

/** 测速抽屉 */
const benchOpen = ref(false);
const benchAlias = ref<string | null>(null);

const icon = (key: ModelIconKey, w = 1.6): string => modelIconSvg(key, w);

const scopeText = computed(() => (scope.value === 'workspace' ? '工作空间' : '全局'));
const rows = computed(() => filterProfiles(sortActiveFirst(profiles.value), query.value));
const activeCount = computed(() => profiles.value.filter((p) => p.isCurrent).length);
/** 无激活但存在登记（走配置文件 model.* 快照）时给出提示，替代旧的「当前生效」卡片 */
const snapshotNotice = computed(() => loaded.value && profiles.value.length > 0 && activeCount.value === 0);

function guard(e: unknown, fallback: string): void {
  if (!(e instanceof AuthError)) showToast(e instanceof ApiError ? e.message : `${fallback}: ${errText(e)}`, 'error');
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
    for (const r of res.runs) {
      if (map[r.alias]) continue;
      map[r.alias] = { ttft: r.summary.ttft.p50, okCount: r.summary.okCount, total: r.summary.total };
    }
    perf.value = map;
  } catch {
    perf.value = {};
  }
}

function pillsOf(p: ProfileRow): Pill[] {
  return modelPills({ isCurrent: p.isCurrent, test: tests.value[p.alias], perf: perf.value[p.alias] });
}

/** 行卡是否处于失败态（左侧红条） */
function isFailed(p: ProfileRow): boolean {
  const t = tests.value[p.alias];
  if (t && !t.ok) return true;
  const pf = perf.value[p.alias];
  return !!pf && pf.ttft === null;
}

function openDrawer(): void {
  form.value = { alias: '', name: '', baseUrl: '', apiKey: '', temperature: '' };
  errors.value = {};
  submitErr.value = '';
  touched.value = false;
  showKey.value = false;
  drawerOpen.value = true;
}

function closeDrawer(): void {
  drawerOpen.value = false;
  touched.value = false;
  errors.value = {};
  submitErr.value = '';
}

function revalidate(): void {
  if (touched.value) errors.value = validateModelForm(form.value);
}

async function submit(): Promise<void> {
  const errs = validateModelForm(form.value);
  errors.value = errs;
  touched.value = true;
  submitErr.value = '';
  if (hasErrors(errs)) return;

  busy.value = true;
  try {
    const raw = form.value.temperature.trim();
    const temperature = raw === '' ? undefined : Number(raw);
    await api('/models', {
      method: 'POST',
      json: {
        alias: form.value.alias.trim(),
        scope: scope.value,
        profile: {
          name: form.value.name.trim(),
          baseUrl: form.value.baseUrl.trim(),
          apiKey: form.value.apiKey.trim(),
          ...(temperature !== undefined ? { temperature } : {}),
        },
      },
    });
    showToast(`已登记模型 ${form.value.alias.trim()}（${scopeText.value}）`, 'success');
    closeDrawer();
    await refresh();
  } catch (e) {
    if (!(e instanceof AuthError)) submitErr.value = e instanceof ApiError ? e.message : `登记失败: ${errText(e)}`;
  } finally {
    busy.value = false;
  }
}

async function activate(alias: string): Promise<void> {
  busy.value = true;
  try {
    await api('/model', { method: 'PUT', json: { alias, scope: scope.value } });
    showToast(`已切换生效模型：${alias}（${scopeText.value}）`, 'success');
    await refresh();
  } catch (e) {
    guard(e, '切换失败');
  } finally {
    busy.value = false;
  }
}

async function test(alias: string): Promise<void> {
  try {
    tests.value = { ...tests.value, [alias]: await api<TestLike>(`/models/${encodeURIComponent(alias)}/test`, { method: 'POST' }) };
  } catch (e) {
    guard(e, '测试失败');
  }
}

async function del(alias: string): Promise<void> {
  busy.value = true;
  try {
    await api(`/models/${encodeURIComponent(alias)}?scope=${scope.value}`, { method: 'DELETE' });
    showToast(`已移除模型 ${alias}（${scopeText.value}）`, 'success');
    const rest = { ...tests.value };
    delete rest[alias];
    tests.value = rest;
    await refresh();
  } catch (e) {
    guard(e, '移除失败');
  } finally {
    busy.value = false;
  }
}

function openBench(alias: string): void {
  benchAlias.value = alias;
  benchOpen.value = true;
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && drawerOpen.value) closeDrawer();
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  void refresh();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="page mv-page">
    <!-- 页头：标题 + 说明 + 写入位置 + 主操作（D2/D3：不再展示 HTTP 端点） -->
    <header class="mv-head">
      <div class="mv-title">
        <h1>模型</h1>
        <p class="mv-sub">登记 LLM 接入配置，切换后立即用于后续对话</p>
      </div>
      <div class="mv-head-acts">
        <span v-if="busy" class="spin" title="处理中"></span>
        <div class="mv-scope">
          <span class="lb">写入位置</span>
          <div class="seg" role="group" aria-label="写入位置">
            <button
              :class="{ on: scope === 'workspace' }"
              :aria-pressed="scope === 'workspace'"
              title="写入当前工作空间配置"
              @click="scope = 'workspace'"
            >工作空间</button>
            <button
              :class="{ on: scope === 'global' }"
              :aria-pressed="scope === 'global'"
              title="写入全局配置，所有工作空间共享"
              @click="scope = 'global'"
            >全局</button>
          </div>
        </div>
        <button class="btn-primary" title="登记一个新的模型接入点" @click="openDrawer">
          <span v-html="icon('plus')"></span>添加模型
        </button>
        <button class="icon-btn" :disabled="busy" title="刷新" aria-label="刷新" @click="refresh">
          <span v-html="icon('refresh')"></span>
        </button>
      </div>
    </header>

    <!-- 工具行：过滤 + 计数（D11） -->
    <div v-if="loaded && profiles.length > 0" class="mv-tools">
      <div class="mv-filter">
        <span v-html="icon('search')"></span>
        <input v-model="query" type="text" placeholder="按别名、型号或主机过滤" aria-label="过滤模型">
      </div>
      <span class="mv-count">
        <b>{{ rows.length }}</b> 个模型 · <b>{{ activeCount }}</b> 个生效
        <template v-if="query.trim()">（过滤「{{ query.trim() }}」）</template>
      </span>
    </div>

    <div v-if="snapshotNotice" class="notice info">
      未激活任何登记模型，当前使用配置文件里的 <b>model.*</b> 快照<template v-if="current">（{{ current.model.name }}）</template>；把某一项设为生效即可接管。
    </div>

    <!-- 骨架（首屏加载） -->
    <div v-if="!loaded" aria-busy="true">
      <div class="skel"></div>
      <div class="skel"></div>
      <div class="skel"></div>
    </div>

    <!-- 空态（D9） -->
    <div v-else-if="profiles.length === 0" class="empty-box">
      <span class="mv-empty-ico" v-html="icon('chip')"></span>
      <div class="t">还没有登记任何模型</div>
      <div class="d">登记一个 OpenAI 兼容的接入点即可开始对话：需要别名、型号名、Base URL 与 API Key。也可以直接在终端用 <code class="mono">/model add</code> 登记。</div>
      <button class="btn-primary" @click="openDrawer">
        <span v-html="icon('plus')"></span>添加第一个模型
      </button>
    </div>

    <!-- 无匹配 -->
    <div v-else-if="rows.length === 0" class="mv-none">
      没有匹配「{{ query.trim() }}」的模型，换个关键字试试。
    </div>

    <!-- 行卡列表（D1） -->
    <ul v-else class="mv-list">
      <li
        v-for="p in rows"
        :key="p.alias"
        class="mv-row"
        :class="{ on: p.isCurrent, bad: !p.isCurrent && isFailed(p) }"
        :data-alias="p.alias"
      >
        <span class="mv-ico" v-html="icon('chip')"></span>

        <div class="mv-main">
          <div class="mv-name">
            <span class="alias">{{ p.alias }}</span>
          </div>
          <div class="mv-meta">
            <span class="mono clamp" :title="p.name">{{ p.name }}</span>
            <span class="dot"></span>
            <span class="host clamp" :title="p.baseUrl">{{ hostOf(p.baseUrl) }}</span>
            <span class="dot"></span>
            <span class="key" title="API Key（服务端已遮蔽）">{{ p.apiKey }}</span>
            <template v-if="p.temperature !== undefined">
              <span class="dot"></span>
              <span class="mono">T {{ p.temperature }}</span>
            </template>
          </div>
        </div>

        <div class="mv-state">
          <span
            v-for="(pl, i) in pillsOf(p)"
            :key="i"
            class="pill"
            :class="pl.tone"
            :title="pl.title"
          >
            <span v-if="pl.icon" v-html="icon(pl.icon, 1.8)"></span>{{ pl.text }}
          </span>
        </div>

        <div class="mv-ops">
          <button class="icon-btn" :disabled="busy" title="测试连通性（发一条极短请求，近免费）" aria-label="测试连通性" @click="test(p.alias)">
            <span v-html="icon('pulse')"></span>
          </button>
          <button class="icon-btn" :disabled="busy" title="性能测速（跑完整流，按输出 token 计费）" aria-label="性能测速" @click="openBench(p.alias)">
            <span v-html="icon('gauge')"></span>
          </button>
          <button
            v-if="!p.isCurrent"
            class="btn-use"
            :disabled="busy"
            title="切换为当前生效模型"
            @click="activate(p.alias)"
          >
            <span v-html="icon('arrow')"></span>设为生效
          </button>
          <ConfirmButton
            class="icon-btn danger"
            :disabled="busy || p.isCurrent"
            :title="p.isCurrent ? '先切换生效模型后才能删除' : '移除该模型'"
            armed-title="再点一次确认移除"
            @confirm="del(p.alias)"
          >
            <template #default="{ armed }">
              <span v-html="icon(armed ? 'check' : 'trash', armed ? 2 : 1.6)"></span>
            </template>
          </ConfirmButton>
        </div>
      </li>
    </ul>

    <!-- 版尾说明（D10：折叠，不再常驻） -->
    <details class="mv-note">
      <summary>
        <span v-html="icon('caret')"></span>说明：测试与测速的区别、删除限制
      </summary>
      <div class="body">
        <b>测试</b>＝连通性探测，发一条极短请求收到首块即断开，几乎不产生费用；<b>测速</b>＝性能体检，用固定提示词跑完整流，按输出 token 计费，两者并存互不替代。<br>
        删除当前生效的模型会被拒绝（需先把另一个模型设为生效）；API Key 出于安全只显示后四位，明文不落前端。<br>
        写入位置决定登记 / 切换 / 删除作用在哪个配置层：<b>工作空间</b>只影响当前项目，<b>全局</b>由所有工作空间共享。
      </div>
    </details>

    <!-- 登记抽屉（D7/D8） -->
    <template v-if="drawerOpen">
      <div class="mv-scrim" @click="closeDrawer"></div>
      <aside class="mv-drawer" role="dialog" aria-modal="true" aria-labelledby="mv-dw-title">
        <div class="dh">
          <h2 id="mv-dw-title">添加模型</h2>
          <button class="icon-btn x" title="关闭" aria-label="关闭" @click="closeDrawer">
            <span v-html="icon('close')"></span>
          </button>
        </div>

        <div class="db">
          <p v-if="submitErr" class="errbox">{{ submitErr }}</p>

          <div class="field">
            <label for="mv-f-alias">别名 <span class="req">*</span></label>
            <input
              id="mv-f-alias"
              v-model="form.alias"
              class="mono"
              :class="{ bad: errors.alias }"
              placeholder="如 deepseek-flash"
              @input="revalidate"
            >
            <p v-if="errors.alias" class="err"><span v-html="icon('alert')"></span>{{ errors.alias }}</p>
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
            <label for="mv-f-key">API Key <span class="req">*</span></label>
            <div class="with-suffix">
              <input
                id="mv-f-key"
                v-model="form.apiKey"
                class="mono"
                :class="{ bad: errors.apiKey }"
                :type="showKey ? 'text' : 'password'"
                placeholder="sk-..."
                @input="revalidate"
              >
              <button type="button" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button>
            </div>
            <p v-if="errors.apiKey" class="err"><span v-html="icon('alert')"></span>{{ errors.apiKey }}</p>
            <p v-else class="hint">只保存在服务端配置文件里，页面回显时一律遮蔽为后四位。</p>
          </div>

          <div class="field">
            <label for="mv-f-temp">temperature <span class="opt">可选</span></label>
            <input
              id="mv-f-temp"
              v-model="form.temperature"
              class="mono"
              style="max-width:180px"
              :class="{ bad: errors.temperature }"
              placeholder="0 ~ 2，留空用服务商默认"
              @input="revalidate"
            >
            <p v-if="errors.temperature" class="err"><span v-html="icon('alert')"></span>{{ errors.temperature }}</p>
          </div>

          <!-- D8：写入位置在提交处就地可见，与页头共用同一状态 -->
          <div class="scope-line">
            <span class="t">写入位置</span>
            <div class="seg" role="group" aria-label="写入位置">
              <button :class="{ on: scope === 'workspace' }" :aria-pressed="scope === 'workspace'" @click="scope = 'workspace'">工作空间</button>
              <button :class="{ on: scope === 'global' }" :aria-pressed="scope === 'global'" @click="scope = 'global'">全局</button>
            </div>
            <span class="sp"></span>
            <span class="t mono" style="font-size:11.5px">{{ scope === 'workspace' ? '当前工作空间配置' : '全局配置' }}</span>
          </div>
        </div>

        <div class="df">
          <button @click="closeDrawer">取消</button>
          <span class="sp"></span>
          <button class="btn-primary" :disabled="busy" @click="submit">登记模型</button>
        </div>
      </aside>
    </template>

    <BenchDrawer
      :open="benchOpen"
      :alias="benchAlias"
      :aliases="profiles.map((p) => p.alias)"
      @close="benchOpen = false"
      @finished="loadPerf"
    />
  </div>
</template>
