<script setup lang="ts">
// 模型视图（P1 §3.5）
// 端点映射：GET /models（登记簿，apiKey 遮蔽 + isCurrent）· GET /model（当前生效快照）
// · POST /models（登记，同名 409）· PUT /model（切换激活）· POST /models/:alias/test（连通性）
// · DELETE /models/:alias?scope=（删当前激活 409）
import { onMounted, ref } from 'vue';
import { api, ApiError, AuthError } from '../api/client';
import { showToast } from '../toast';
import { errText } from '../utils';
import ConfirmButton from '../components/ConfirmButton.vue';
import StatusBadge from '../components/StatusBadge.vue';
import BenchDrawer from '../components/BenchDrawer.vue';
import { fmtMs, ttftTone, type BenchHistoryEntryVM } from '../bench-format';

interface ProfileRow {
  alias: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  temperature?: number;
  isCurrent: boolean;
}
interface TestResult { ok: boolean; latencyMs: number; error?: string }

const profiles = ref<ProfileRow[]>([]);
const current = ref<{ model: { name: string; baseUrl: string; apiKey: string; temperature?: number }; active: string | null } | null>(null);
const scope = ref<'workspace' | 'global'>('workspace');
const busy = ref(false);

const showReg = ref(false);
const regAlias = ref('');
const regName = ref('');
const regBase = ref('');
const regKey = ref('');
const regTemp = ref('');

const tests = ref<Record<string, TestResult>>({});

/** 性能摘要（需求 20261027-003）：每模型取最近一次测速的 TTFT p50 与成功率 */
interface PerfCell {
  ttft: number | null;
  okCount: number;
  total: number;
  at: string;
  tone: string;
}
const perf = ref<Record<string, PerfCell>>({});

/** 测速抽屉 */
const benchOpen = ref(false);
const benchAlias = ref<string | null>(null);

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
  } catch (e) {
    guard(e, '加载模型失败');
  } finally {
    busy.value = false;
  }
  void loadPerf();
}

/** 拉测速历史（不带 alias 时后端只回每模型最近一次），失败静默降级为「未测」 */
async function loadPerf(): Promise<void> {
  try {
    const res = await api<{ runs: BenchHistoryEntryVM[] }>('/models/bench/history?limit=50');
    const map: Record<string, PerfCell> = {};
    for (const r of res.runs) {
      if (map[r.alias]) continue;
      map[r.alias] = {
        ttft: r.summary.ttft.p50,
        okCount: r.summary.okCount,
        total: r.summary.total,
        at: r.startedAt,
        tone: ttftTone(r.summary.ttft.p50),
      };
    }
    perf.value = map;
  } catch {
    perf.value = {};
  }
}

function openBench(alias: string): void {
  benchAlias.value = alias;
  benchOpen.value = true;
}

async function register(): Promise<void> {
  const alias = regAlias.value.trim();
  const name = regName.value.trim();
  const baseUrl = regBase.value.trim();
  const apiKey = regKey.value.trim();
  if (!alias || !name || !baseUrl || !apiKey) {
    showToast('alias / name / baseUrl / apiKey 均必填', 'error');
    return;
  }
  const tempRaw = regTemp.value.trim();
  let temperature: number | undefined;
  if (tempRaw !== '') {
    temperature = Number(tempRaw);
    if (!Number.isFinite(temperature)) {
      showToast('temperature 必须为数字', 'error');
      return;
    }
  }
  busy.value = true;
  try {
    await api('/models', {
      method: 'POST',
      json: {
        alias,
        scope: scope.value,
        profile: { name, baseUrl, apiKey, ...(temperature !== undefined ? { temperature } : {}) },
      },
    });
    showToast(`已登记模型 ${alias}（${scope.value}）`, 'success');
    showReg.value = false;
    regAlias.value = regName.value = regBase.value = regKey.value = regTemp.value = '';
    await refresh();
  } catch (e) {
    guard(e, '登记失败');
  } finally {
    busy.value = false;
  }
}

async function activate(alias: string): Promise<void> {
  busy.value = true;
  try {
    await api('/model', { method: 'PUT', json: { alias, scope: scope.value } });
    showToast(`已切换激活模型：${alias}（${scope.value}）`, 'success');
    await refresh();
  } catch (e) {
    guard(e, '切换失败');
  } finally {
    busy.value = false;
  }
}

async function test(alias: string): Promise<void> {
  try {
    tests.value = { ...tests.value, [alias]: await api<TestResult>(`/models/${encodeURIComponent(alias)}/test`, { method: 'POST' }) };
  } catch (e) {
    guard(e, '测试失败');
  }
}

async function del(alias: string): Promise<void> {
  busy.value = true;
  try {
    await api(`/models/${encodeURIComponent(alias)}?scope=${scope.value}`, { method: 'DELETE' });
    showToast(`已移除模型 ${alias}（${scope.value}）`, 'success');
    await refresh();
  } catch (e) {
    guard(e, '移除失败');
  } finally {
    busy.value = false;
  }
}

onMounted(refresh);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1>模型</h1>
      <span v-if="busy" class="spin" title="处理中"></span>
      <StatusBadge kind="dim">GET /models</StatusBadge>
      <span class="spacer"></span>
      <span class="muted">写入 scope：</span>
      <select v-model="scope">
        <option value="workspace">workspace（工作空间）</option>
        <option value="global">global（全局）</option>
      </select>
      <button @click="showReg = !showReg">＋ 登记模型</button>
      <button :disabled="busy" @click="refresh">⟳ 刷新</button>
    </div>

    <div v-if="showReg" class="card">
      <div class="card-h">登记模型 <StatusBadge kind="dim">POST /models</StatusBadge></div>
      <div class="card-b">
        <div class="form-row">
          <input v-model="regAlias" class="grow" placeholder="别名 alias，如 deepseek">
          <input v-model="regName" class="grow" placeholder="型号 name，如 deepseek-chat">
          <input v-model="regTemp" style="width:130px" placeholder="temperature（可选）">
        </div>
        <div class="form-row" style="margin-top:10px">
          <input v-model="regBase" class="grow mono" placeholder="baseUrl，如 https://api.deepseek.com/v1">
          <input v-model="regKey" class="grow mono" placeholder="apiKey" type="password">
        </div>
        <div class="form-row" style="margin-top:10px">
          <button class="primary" :disabled="busy" @click="register">登记</button>
          <button @click="showReg = false">取消</button>
          <span class="muted">同名 409；登记到 {{ scope }} 层。</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-h">当前生效 <StatusBadge kind="dim">GET /model</StatusBadge></div>
      <div class="card-b" v-if="current">
        <div class="form-row">
          <span class="mono">{{ current.model.name }}</span>
          <span class="mono muted">{{ current.model.baseUrl }}</span>
          <span class="mono">{{ current.model.apiKey }}</span>
          <span v-if="current.model.temperature !== undefined" class="mono muted">temperature {{ current.model.temperature }}</span>
          <StatusBadge v-if="current.active" kind="brand">active: {{ current.active }}</StatusBadge>
          <StatusBadge v-else kind="dim">未激活（使用 model.* 快照）</StatusBadge>
        </div>
      </div>
    </div>

    <div class="card">
      <table class="tbl">
        <thead>
          <tr>
            <th>别名</th><th>型号</th><th>baseUrl</th><th>apiKey</th><th>连通性</th><th>性能</th><th style="width:290px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in profiles" :key="p.alias">
            <td><b>{{ p.alias }}</b> <StatusBadge v-if="p.isCurrent" kind="brand">active</StatusBadge></td>
            <td class="mono">{{ p.name }}</td>
            <td class="mono">{{ p.baseUrl }}</td>
            <td class="mono">{{ p.apiKey }}</td>
            <td>
              <StatusBadge v-if="tests[p.alias]?.ok" kind="ok" :title="String(tests[p.alias].latencyMs)">{{ tests[p.alias].latencyMs }}ms</StatusBadge>
              <StatusBadge v-else-if="tests[p.alias]" kind="err" :title="tests[p.alias].error">不可用</StatusBadge>
              <StatusBadge v-else kind="warn">未测试</StatusBadge>
            </td>
            <td>
              <StatusBadge
                v-if="perf[p.alias] && perf[p.alias].ttft !== null"
                :kind="perf[p.alias].tone === 'good' ? 'ok' : perf[p.alias].tone === 'warn' ? 'warn' : 'err'"
                :title="`最近一次测速：${perf[p.alias].okCount}/${perf[p.alias].total} 轮成功`"
              >TTFT {{ fmtMs(perf[p.alias].ttft) }}</StatusBadge>
              <StatusBadge v-else-if="perf[p.alias]" kind="err" :title="`最近一次测速 ${perf[p.alias].okCount}/${perf[p.alias].total} 轮成功`">全部失败</StatusBadge>
              <StatusBadge v-else kind="dim">未测</StatusBadge>
            </td>
            <td>
              <button :disabled="busy" @click="test(p.alias)">测试</button>
              <button class="primary" :disabled="busy" @click="openBench(p.alias)">测速</button>
              <button :disabled="busy || p.isCurrent" @click="activate(p.alias)">设为 active</button>
              <ConfirmButton :disabled="busy" @confirm="del(p.alias)" />
            </td>
          </tr>
          <tr v-if="profiles.length === 0">
            <td colspan="7" class="muted">暂无登记模型，点右上「＋ 登记模型」。</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="muted" style="font-size:12.5px">
      删除当前激活模型将返回 409（需先切换）；测试走 POST /models/:alias/test，显示延迟与是否可用；apiKey 出于安全仅显示遮蔽值。
      「测试」= 连通性（发 ping 收首块即断，近免费）；「测速」= 性能体检（固定提示词跑完整流，按输出 token 计费）。两者并存互不替代。
    </p>

    <BenchDrawer
      :open="benchOpen"
      :alias="benchAlias"
      :aliases="profiles.map((p) => p.alias)"
      @close="benchOpen = false"
      @finished="loadPerf"
    />
  </div>
</template>
