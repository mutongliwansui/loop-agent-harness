<script setup lang="ts">
// 工具视图（P1 §3.5）
// 端点映射：GET /tools（内置 + MCP 快照；本页仅展示内置，MCP 工具归 MCP 页）
// · PATCH /tools/:name {enabled}（开关即生效）· GET /tools/:name（schema 详情）· POST /tools/reload
import { computed, onMounted, ref } from 'vue';
import { api, ApiError, AuthError } from '../api/client';
import { showToast } from '../toast';
import { errText } from '../utils';
import JsonViewer from '../components/JsonViewer.vue';
import StatusBadge from '../components/StatusBadge.vue';

interface ToolRow { name: string; description: string; enabled: boolean; source: 'builtin' | 'mcp' }

const tools = ref<ToolRow[]>([]);
const scope = ref<'workspace' | 'global'>('workspace');
const busy = ref(false);
const expanded = ref<string | null>(null);
const detail = ref<{ name: string; schema: unknown } | null>(null);

const builtin = computed(() => tools.value.filter((t) => t.source === 'builtin'));
const mcpCount = computed(() => tools.value.filter((t) => t.source === 'mcp').length);

function guard(e: unknown, fallback: string): void {
  if (!(e instanceof AuthError)) showToast(e instanceof ApiError ? e.message : `${fallback}: ${errText(e)}`, 'error');
}

async function refresh(): Promise<void> {
  busy.value = true;
  try {
    const res = await api<{ tools: ToolRow[] }>('/tools');
    tools.value = res.tools;
  } catch (e) {
    guard(e, '加载工具失败');
  } finally {
    busy.value = false;
  }
}

async function toggle(t: ToolRow): Promise<void> {
  busy.value = true;
  try {
    await api(`/tools/${encodeURIComponent(t.name)}`, {
      method: 'PATCH',
      json: { enabled: !t.enabled, scope: scope.value },
    });
    showToast(`工具已${!t.enabled ? '启用' : '禁用'}：${t.name}（${scope.value}）`, 'success');
    await refresh();
  } catch (e) {
    guard(e, '切换失败');
  } finally {
    busy.value = false;
  }
}

async function view(t: ToolRow): Promise<void> {
  if (expanded.value === t.name) {
    expanded.value = null;
    detail.value = null;
    return;
  }
  try {
    detail.value = await api<{ name: string; schema: unknown }>(`/tools/${encodeURIComponent(t.name)}`);
    expanded.value = t.name;
  } catch (e) {
    guard(e, '查看失败');
  }
}

async function reload(): Promise<void> {
  busy.value = true;
  try {
    const res = await api<{ reloaded: number }>('/tools/reload', { method: 'POST' });
    showToast(`工具已重新加载：${res.reloaded} 个`, 'success');
    await refresh();
  } catch (e) {
    guard(e, '重载失败');
  } finally {
    busy.value = false;
  }
}

onMounted(refresh);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1>工具</h1>
      <span v-if="busy" class="spin" title="处理中"></span>
      <StatusBadge kind="dim">GET /tools</StatusBadge>
      <span class="spacer"></span>
      <span class="muted">写入 scope：</span>
      <select v-model="scope">
        <option value="workspace">workspace（工作空间）</option>
        <option value="global">global（全局）</option>
      </select>
      <button :disabled="busy" @click="reload">⟳ 重载</button>
      <button :disabled="busy" @click="refresh">⟳ 刷新</button>
    </div>

    <div class="card">
      <div class="card-h">内置工具 <StatusBadge kind="dim">PATCH /tools/:name</StatusBadge></div>
      <table class="tbl">
        <thead>
          <tr><th>名称</th><th>说明</th><th style="width:70px">启用</th><th style="width:70px">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in builtin" :key="t.name">
            <td class="mono">{{ t.name }}</td>
            <td class="muted">{{ t.description }}</td>
            <td>
              <label class="tgl" :title="t.enabled ? '点击禁用' : '点击启用'">
                <input type="checkbox" :checked="t.enabled" :disabled="busy" @change="toggle(t)">
                <span class="tk"></span>
              </label>
            </td>
            <td><button @click="view(t)">{{ expanded === t.name ? '收起' : 'Schema' }}</button></td>
          </tr>
          <tr v-if="expanded && detail" :key="detail.name">
            <td colspan="4" style="padding:8px 10px">
              <JsonViewer :value="detail.schema" label="parameters schema" />
            </td>
          </tr>
          <tr v-if="builtin.length === 0">
            <td colspan="4" class="muted">暂无内置工具。</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="muted" style="font-size:12.5px">
      开关即生效（PATCH，落盘 + registry 同步）；另有 {{ mcpCount }} 个 MCP 工具在「MCP 服务器」页查看。重载会断开并重连全部 MCP server。
    </p>
  </div>
</template>
