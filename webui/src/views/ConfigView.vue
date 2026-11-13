<script setup lang="ts">
// 配置视图（P1 §3.5）
// 端点映射：GET /config（遮蔽树）· GET /config/path · GET/PUT/DELETE /config/:key
// 需求 20261112-008：配置只剩全局一份，不再提供 scope 选择，请求也不再带 scope 参数
// 语义：api.* 写入后响应附 restartRequired: true（需重启生效）；DELETE 返回 {deleted: existed}
import { computed, onMounted, ref } from 'vue';
import { api, ApiError, AuthError } from '../api/client';
import { showToast } from '../toast';
import { displayValue, errText, parseLoose } from '../utils';
import ConfirmButton from '../components/ConfirmButton.vue';
import StatusBadge from '../components/StatusBadge.vue';
import {
  getNotifySettings,
  setNotifySettings,
  requestNotifyPermission,
  notifySupported,
  playChime,
  type NotifySettings,
} from '../notify';

interface Row { key: string; value: unknown; display: string; masked: boolean }
interface Section { name: string; rows: Row[] }

const tree = ref<Record<string, unknown> | null>(null);
const paths = ref<{ globalPath: string | null } | null>(null);
const busy = ref(false);

const editingKey = ref<string | null>(null);
const editValue = ref('');

const queryKey = ref('');
const keyResult = ref<{ key: string; value: unknown; scope: string } | null>(null);

/** model/models 与 tools 两节由「模型」（#/models）、「工具」（#/tools）模块独立管理，配置页不展示 */
const EXCLUDED_SECTIONS = new Set(['model', 'models', 'tools']);

/* ===== 界面偏好：后台完成提醒（task-20261025-002 D3-B）=====
 * 输入坞删掉了 🔔 入口，两开关迁到这里，保证「删了 UI 就再也改不了」的代价不出现。
 * 存储仍是 notify.ts 的 localStorage，chat-stream 的完成提醒逻辑零改动。 */
const notifyCfg = ref<NotifySettings>(getNotifySettings());
const notifySecure = notifySupported();

/** 系统通知：必须在用户手势中请求权限；拒绝则回退开关并说明 */
async function onToggleNotifySystem(on: boolean): Promise<void> {
  if (on) {
    if (!notifySecure) {
      notifyCfg.value.system = false;
      showToast('当前环境不支持系统通知（需 https/localhost），提示音仍可用', 'error');
      return;
    }
    const perm = await requestNotifyPermission();
    if (perm !== 'granted') {
      notifyCfg.value.system = false;
      showToast(perm === 'denied' ? '通知权限已被拒绝，可在浏览器设置中恢复' : '通知权限未授权', 'error');
      setNotifySettings({ asked: true });
      return;
    }
  }
  notifyCfg.value.system = on;
  setNotifySettings({ system: on, asked: true });
}

/** 提示音：手势中播放一次，同时解锁 AudioContext（自动播放策略） */
function onToggleNotifySound(on: boolean): void {
  notifyCfg.value.sound = on;
  setNotifySettings({ sound: on });
  // playChime 此前在 ChatView 中被调用却未 import（运行时 ReferenceError，解锁静默失效），
  // 迁入本页后已正确导入，顺带修掉该 bug
  if (on) playChime();
}

const sections = computed<Section[]>(() => {
  if (!tree.value) return [];
  const out: Section[] = [];
  for (const [name, val] of Object.entries(tree.value)) {
    if (EXCLUDED_SECTIONS.has(name)) continue;
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
      api<{ globalPath: string | null }>('/config/path'),
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
      json: { value: parseLoose(editValue.value) },
    });
    showToast(res.restartRequired ? `已写入 ${key}，需重启服务生效` : `已写入 ${key}`, 'success');
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
    const res = await api<{ deleted: boolean }>(`/config/${encodeURIComponent(key)}`, { method: 'DELETE' });
    showToast(res.deleted ? `已删除 ${key}` : `未设置此键，无需删除`, res.deleted ? 'success' : 'info');
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
      <StatusBadge kind="brand">模型/工具配置请前往 <a href="#/models" style="color:inherit;font-weight:600">模型</a> · <a href="#/tools" style="color:inherit;font-weight:600">工具</a> 模块</StatusBadge>
      <span class="spacer"></span>
      <button :disabled="busy" @click="refresh">⟳ 刷新</button>
    </div>

    <!-- 界面偏好（task-20261025-002 D3-B）：输入坞已删除 🔔 入口，两开关迁到这里 -->
    <div class="card">
      <div class="card-h">
        界面偏好
        <StatusBadge kind="dim">存于本机浏览器</StatusBadge>
      </div>
      <div class="card-b">
        <div class="pref-row">
          <label class="pref-label">
            <input
              type="checkbox"
              :checked="notifyCfg.system"
              :disabled="!notifySecure"
              @change="onToggleNotifySystem(($event.target as HTMLInputElement).checked)"
            >
            <span>系统通知</span>
          </label>
          <span class="pref-hint">切到其他窗口时，回答完成/停止会弹系统提醒</span>
        </div>
        <div class="pref-row">
          <label class="pref-label">
            <input
              type="checkbox"
              :checked="notifyCfg.sound"
              @change="onToggleNotifySound(($event.target as HTMLInputElement).checked)"
            >
            <span>提示音</span>
          </label>
          <span class="pref-hint">回答完成时播放一声轻提示（首次开启会解锁音频）</span>
        </div>
        <p v-if="!notifySecure" class="pref-warn">
          当前通过局域网 IP + http 访问，浏览器不提供系统通知；提示音与页内提醒不受影响
        </p>
      </div>
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
          <input v-model="queryKey" class="grow mono" placeholder="配置键，如 agent.verbose" @keyup.enter="readKey">
          <button class="primary" :disabled="busy || !queryKey.trim()" @click="readKey">读取</button>
        </div>
        <div v-if="keyResult" class="form-row" style="margin-top:10px">
          <span>值：<span class="mono" style="word-break:break-all">{{ displayValue(keyResult.value) }}</span></span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-h">配置文件路径 <StatusBadge kind="dim">GET /config/path</StatusBadge></div>
      <div class="card-b" v-if="paths">
        <div class="form-row"><span class="muted" style="width:80px">全局</span><span class="mono">{{ paths.globalPath }}</span></div>
        <div class="form-row" style="margin-top:6px">
          <span class="muted">配置只剩全局一份，工作空间级配置已移除</span>
        </div>
      </div>
    </div>
  </div>
</template>
