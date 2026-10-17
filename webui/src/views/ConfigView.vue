<script setup lang="ts">
// 配置视图（P1 §3.5）
// 端点映射：GET /config（遮蔽树）· GET /config/path · GET/PUT/DELETE /config/:key（scope 可选，缺省 workspace）
// 语义：api.* 写入后响应附 restartRequired: true（需重启生效）；DELETE 返回 {deleted: existed}
import { computed, onMounted, ref } from 'vue';
import { api, ApiError, AuthError } from '../api/client';
import { showToast } from '../toast';
import { displayValue, errText, parseLoose } from '../utils';
import ConfirmButton from '../components/ConfirmButton.vue';
import StatusBadge from '../components/StatusBadge.vue';

interface Row { key: string; value: unknown; display: string; masked: boolean }
interface Section { name: string; rows: Row[] }

const tree = ref<Record<string, unknown> | null>(null);
const paths = ref<{ globalPath: string; workspacePath: string; workspaceExists: boolean } | null>(null);
const scope = ref<'workspace' | 'global'>('workspace');
const busy = ref(false);

const editingKey = ref<string | null>(null);
const editValue = ref('');

const queryKey = ref('');
const keyResult = ref<{ key: string; value: unknown; scope: string } | null>(null);

const sections = computed<Section[]>(() => {
  if (!tree.value) return [];
  const out: Section[] = [];
  for (const [name, val] of Object.entries(tree.value)) {
    const rows: Row[] = [];
    walk(name, val, rows);
    if (rows.length > 0) out.push({ name, rows });
  }
  return out;
});

/** 递归展平：叶子（原始值/数组）成行，点路径为完整键 */
function walk(prefix: string, val: unknown, rows: Row[]): void {
  if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      walk(`${prefix}.${k}`, v, rows);
    }
    return;
  }
  rows.push({
    key: prefix,
    value: val,
    display: displayValue(val),
    masked: typeof val === 'string' && val.includes('***'),
  });
}

function guard(e: unknown, fallback: string): void {
  if (!(e instanceof AuthError)) showToast(e instanceof ApiError ? e.message : `${fallback}: ${errText(e)}`, 'error');
}

async function refresh(): Promise<void> {
  busy.value = true;
  try {
    const [cfg, p] = await Promise.all([
      api<{ config: Record<string, unknown> }>('/config'),
      api<{ globalPath: string; workspacePath: string; workspaceExists: boolean }>('/config/path'),
    ]);
    tree.value = cfg.config;
    paths.value = p;
  } catch (e) {
    guard(e, '加载配置失败');
  } finally {
    busy.value = false;
  }
}

function startEdit(row: Row): void {
  editingKey.value = row.key;
  editValue.value = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
}

function cancelEdit(): void {
  editingKey.value = null;
  editValue.value = '';
}

async function saveEdit(key: string): Promise<void> {
  busy.value = true;
  try {
    const res = await api<{ key: string; scope: string; restartRequired?: boolean }>(`/config/${encodeURIComponent(key)}`, {
      method: 'PUT',
      json: { value: parseLoose(editValue.value), scope: scope.value },
    });
    showToast(res.restartRequired ? `已写入 ${key}，需重启服务生效` : `已写入 ${key}（${res.scope}）`, 'success');
    cancelEdit();
    await refresh();
  } catch (e) {
    guard(e, '写入失败');
  } finally {
    busy.value = false;
  }
}

async function del(key: string): Promise<void> {
  busy.value = true;
  try {
    const res = await api<{ deleted: boolean }>(`/config/${encodeURIComponent(key)}?scope=${scope.value}`, { method: 'DELETE' });
    showToast(res.deleted ? `已从 ${scope.value} 删除 ${key}` : `${scope.value} 层未设置此键，无需删除`, res.deleted ? 'success' : 'info');
    await refresh();
  } catch (e) {
    guard(e, '删除失败');
  } finally {
    busy.value = false;
  }
}

async function readKey(): Promise<void> {
  const key = queryKey.value.trim();
  if (!key) return;
  busy.value = true;
  try {
    keyResult.value = await api<{ key: string; value: unknown; scope: string }>(`/config/${encodeURIComponent(key)}`);
  } catch (e) {
    keyResult.value = null;
    guard(e, '读取失败');
  } finally {
    busy.value = false;
  }
}

onMounted(refresh);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1>配置</h1>
      <span v-if="busy" class="spin" title="处理中"></span>
      <StatusBadge kind="dim">GET /config</StatusBadge>
      <span class="spacer"></span>
      <span class="muted">写入 scope：</span>
      <select v-model="scope">
        <option value="workspace">workspace（工作空间）</option>
        <option value="global">global（全局）</option>
      </select>
      <button :disabled="busy" @click="refresh">⟳ 刷新</button>
    </div>

    <div v-for="sec in sections" :key="sec.name" class="card">
      <div class="card-h">
        {{ sec.name }}
        <StatusBadge v-if="sec.name === 'api'" kind="warn">api.* 修改需重启</StatusBadge>
      </div>
      <table class="tbl">
        <thead>
          <tr><th style="width:30%">键</th><th>值</th><th style="width:170px">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in sec.rows" :key="row.key">
            <td><code>{{ row.key }}</code></td>
            <td>
              <template v-if="editingKey === row.key">
                <input
                  v-model="editValue"
                  class="mono"
                  style="width:100%"
                  placeholder="JSON 值（非 JSON 文本按字符串写入）"
                  @keyup.enter="saveEdit(row.key)"
                >
              </template>
              <template v-else>
                <span class="mono" style="word-break:break-all">{{ row.display }}</span>
                <StatusBadge v-if="row.masked" kind="dim">遮蔽</StatusBadge>
              </template>
            </td>
            <td>
              <template v-if="editingKey === row.key">
                <button class="primary" :disabled="busy" @click="saveEdit(row.key)">保存</button>
                <button @click="cancelEdit">取消</button>
              </template>
              <template v-else>
                <button @click="startEdit(row)">编辑</button>
                <ConfirmButton :disabled="busy" @confirm="del(row.key)" />
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-h">单键读取 <StatusBadge kind="dim">GET /config/:key</StatusBadge></div>
      <div class="card-b">
        <div class="form-row">
          <input v-model="queryKey" class="grow mono" placeholder="配置键，如 model.maxTokens" @keyup.enter="readKey">
          <button class="primary" :disabled="busy || !queryKey.trim()" @click="readKey">读取</button>
        </div>
        <div v-if="keyResult" class="form-row" style="margin-top:10px">
          <span>值：<span class="mono" style="word-break:break-all">{{ displayValue(keyResult.value) }}</span></span>
          <StatusBadge kind="brand">来源 {{ keyResult.scope }}</StatusBadge>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-h">配置文件路径 <StatusBadge kind="dim">GET /config/path</StatusBadge></div>
      <div class="card-b" v-if="paths">
        <div class="form-row"><span class="muted" style="width:80px">全局</span><span class="mono">{{ paths.globalPath }}</span></div>
        <div class="form-row" style="margin-top:6px">
          <span class="muted" style="width:80px">工作空间</span>
          <span class="mono">{{ paths.workspacePath }}</span>
          <StatusBadge :kind="paths.workspaceExists ? 'ok' : 'dim'">{{ paths.workspaceExists ? '已存在' : '未创建' }}</StatusBadge>
        </div>
      </div>
    </div>
  </div>
</template>
