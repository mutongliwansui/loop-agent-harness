<script setup lang="ts">
// 诊断视图（P1 §3.5）
// 端点映射：GET /doctor（启动体检逐项结果；端点恒 200，ok = 无 blocker 级问题）
// 三态：ok=true → pass（绿）｜missing（黄，提示创建）｜blocker（红，需处理）
import { computed, onMounted, ref } from 'vue';
import { api, ApiError, AuthError } from '../api/client';
import { showToast } from '../toast';
import { errText } from '../utils';
import StatusBadge from '../components/StatusBadge.vue';

interface Check { name: string; ok: boolean; level: string; detail: string }

const result = ref<{ ok: boolean; checks: Check[] } | null>(null);
const busy = ref(false);

const blockers = computed(() => result.value?.checks.filter((c) => !c.ok && c.level === 'blocker').length ?? 0);
const missing = computed(() => result.value?.checks.filter((c) => !c.ok && c.level !== 'blocker').length ?? 0);

function stateOf(c: Check): 'pass' | 'missing' | 'blocker' {
  if (c.ok) return 'pass';
  return c.level === 'blocker' ? 'blocker' : 'missing';
}
function iconOf(c: Check): string {
  const s = stateOf(c);
  return s === 'pass' ? '✅' : s === 'missing' ? '⚠️' : '⛔';
}

async function refresh(): Promise<void> {
  busy.value = true;
  try {
    result.value = await api<{ ok: boolean; checks: Check[] }>('/doctor');
  } catch (e) {
    if (!(e instanceof AuthError)) showToast(e instanceof ApiError ? e.message : `体检失败: ${errText(e)}`, 'error');
  } finally {
    busy.value = false;
  }
}

onMounted(refresh);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1>诊断</h1>
      <span v-if="busy" class="spin" title="处理中"></span>
      <StatusBadge kind="dim">GET /doctor</StatusBadge>
      <template v-if="result">
        <StatusBadge v-if="result.ok" kind="ok">整体健康</StatusBadge>
        <StatusBadge v-else kind="err">存在 blocker</StatusBadge>
        <StatusBadge v-if="missing > 0" kind="warn">missing {{ missing }}</StatusBadge>
      </template>
      <span class="spacer"></span>
      <button class="primary" :disabled="busy" @click="refresh">⟳ 重新体检</button>
    </div>

    <div class="card" v-if="result">
      <div class="card-b">
        <div class="doc-grid">
          <div v-for="c in result.checks" :key="c.name" class="doc-item" :class="stateOf(c)">
            <div class="t">{{ iconOf(c) }} {{ c.name }}</div>
            <div class="d">{{ c.detail }}</div>
          </div>
        </div>
        <p class="muted" style="font-size:12.5px;margin:12px 0 0">
          三态：<b style="color:var(--ok)">pass</b> / <b style="color:var(--warn)">missing</b>（提示创建）/
          <b style="color:var(--danger)">blocker</b>（需处理，共 {{ blockers }} 项）；端点始终 200，整体 ok = 无 blocker。
        </p>
      </div>
    </div>
  </div>
</template>
