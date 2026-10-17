<script setup lang="ts">
// MCP 服务器视图（P1 §3.5）
// 端点映射：GET /mcp/servers（合并配置 + 实时连接状态）· POST /mcp/servers（登记 + 自动连接；
// 502 = 配置已落盘但连接失败「半态」）· GET /mcp/servers/:name（详情 + 工具清单）
// · POST /mcp/servers/:name/test（临时连接探测）· POST /mcp/reload · DELETE /mcp/servers/:name?scope=
import { onMounted, ref } from 'vue';
import { api, ApiError, AuthError } from '../api/client';
import { showToast } from '../toast';
import { errText } from '../utils';
import ConfirmButton from '../components/ConfirmButton.vue';
import JsonViewer from '../components/JsonViewer.vue';
import StatusBadge from '../components/StatusBadge.vue';

interface ServerRow { name: string; transport: string; status: 'connected' | 'disconnected'; toolCount: number }
interface TestResult { ok: boolean; latencyMs: number; tools: number; error?: string }
interface ServerDetail { name: string; transport: string; status: string; tools: unknown[] }

const servers = ref<ServerRow[]>([]);
const rawCfg = ref<Record<string, { command?: string; args?: string[]; url?: string }>>({});
const scope = ref<'workspace' | 'global'>('workspace');
const busy = ref(false);

const showReg = ref(false);
const regName = ref('');
const regTransport = ref<'stdio' | 'sse' | 'http'>('stdio');
const regCommand = ref('');
const regArgs = ref('');
const regEnv = ref('');
const regUrl = ref('');
const regHeaders = ref('');

const tests = ref<Record<string, TestResult>>({});
const expanded = ref<string | null>(null);
const detail = ref<ServerDetail | null>(null);

function guard(e: unknown, fallback: string): void {
  if (!(e instanceof AuthError)) showToast(e instanceof ApiError ? e.message : `${fallback}: ${errText(e)}`, 'error');
}

/** 命令 / URL 展示文本（来自合并配置 tools.mcpServers） */
function targetOf(name: string): string {
  const c = rawCfg.value[name];
  if (!c) return '—';
  if (c.command) return [c.command, ...(c.args ?? [])].join(' ');
  return c.url ?? '—';
}

/** textarea「k=v」逐行解析为对象 */
function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && line.slice(0, i).trim()) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function toolNames(tools: unknown[]): string {
  const names = tools
    .map((t) => (t !== null && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string' ? (t as { name: string }).name : ''))
    .filter(Boolean);
  return names.length > 0 ? names.join(' · ') : '—';
}

async function refresh(): Promise<void> {
  busy.value = true;
  try {
    const [list, cfg] = await Promise.all([
      api<{ servers: ServerRow[] }>('/mcp/servers'),
      api<{ config: { tools?: { mcpServers?: Record<string, { command?: string; args?: string[]; url?: string }> } } }>('/config'),
    ]);
    servers.value = list.servers;
    rawCfg.value = cfg.config.tools?.mcpServers ?? {};
  } catch (e) {
    guard(e, '加载 MCP 失败');
  } finally {
    busy.value = false;
  }
}

async function register(): Promise<void> {
  const name = regName.value.trim();
  if (!name) {
    showToast('name 必填', 'error');
    return;
  }
  const base: Record<string, unknown> = { name, transport: regTransport.value, scope: scope.value };
  let body: Record<string, unknown>;
  if (regTransport.value === 'stdio') {
    const command = regCommand.value.trim();
    if (!command) {
      showToast('stdio 传输必须提供 command', 'error');
      return;
    }
    const args = regArgs.value.trim().split(/\s+/).filter(Boolean);
    const env = parseKv(regEnv.value);
    body = { ...base, command, ...(args.length > 0 ? { args } : {}), ...(Object.keys(env).length > 0 ? { env } : {}) };
  } else {
    const url = regUrl.value.trim();
    if (!url) {
      showToast(`${regTransport.value} 传输必须提供 url`, 'error');
      return;
    }
    const headers = parseKv(regHeaders.value);
    body = { ...base, url, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
  }
  busy.value = true;
  try {
    await api('/mcp/servers', { method: 'POST', json: body });
    showToast(`MCP server 已登记并连接：${name}（${scope.value}）`, 'success');
    closeReg();
    await refresh();
  } catch (e) {
    if (e instanceof ApiError && e.status === 502) {
      // 半态：配置已落盘但连接失败（§3.6 错误边界），刷新列表可见 disconnected
      showToast(e.message, 'info', 6000);
      closeReg();
      await refresh();
    } else {
      guard(e, '登记失败');
    }
  } finally {
    busy.value = false;
  }
}

function closeReg(): void {
  showReg.value = false;
  regName.value = '';
  regCommand.value = '';
  regArgs.value = '';
  regEnv.value = '';
  regUrl.value = '';
  regHeaders.value = '';
}

async function test(name: string): Promise<void> {
  try {
    tests.value = { ...tests.value, [name]: await api<TestResult>(`/mcp/servers/${encodeURIComponent(name)}/test`, { method: 'POST' }) };
  } catch (e) {
    guard(e, '测试失败');
  }
}

async function view(name: string): Promise<void> {
  if (expanded.value === name) {
    expanded.value = null;
    detail.value = null;
    return;
  }
  try {
    detail.value = await api<ServerDetail>(`/mcp/servers/${encodeURIComponent(name)}`);
    expanded.value = name;
  } catch (e) {
    guard(e, '查询失败');
  }
}

async function reloadAll(): Promise<void> {
  busy.value = true;
  try {
    const res = await api<{ reconnected: number; failed: string[] }>('/mcp/reload', { method: 'POST' });
    showToast(
      res.failed.length > 0 ? `MCP 已重载：成功 ${res.reconnected}，失败 ${res.failed.join('、')}` : `MCP 已重载：成功 ${res.reconnected}`,
      res.failed.length > 0 ? 'info' : 'success',
      res.failed.length > 0 ? 6000 : undefined,
    );
    await refresh();
  } catch (e) {
    guard(e, '重载失败');
  } finally {
    busy.value = false;
  }
}

async function del(name: string): Promise<void> {
  busy.value = true;
  try {
    await api(`/mcp/servers/${encodeURIComponent(name)}?scope=${scope.value}`, { method: 'DELETE' });
    showToast(`MCP server 已断连并移除：${name}（${scope.value}）`, 'success');
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
      <h1>MCP 服务器</h1>
      <span v-if="busy" class="spin" title="处理中"></span>
      <StatusBadge kind="dim">GET /mcp/servers</StatusBadge>
      <span class="spacer"></span>
      <span class="muted">写入 scope：</span>
      <select v-model="scope">
        <option value="workspace">workspace（工作空间）</option>
        <option value="global">global（全局）</option>
      </select>
      <button @click="showReg = !showReg">＋ 登记</button>
      <button :disabled="busy" @click="reloadAll">⟳ 重载</button>
      <button :disabled="busy" @click="refresh">⟳ 刷新</button>
    </div>

    <div v-if="showReg" class="card">
      <div class="card-h">登记 MCP server <StatusBadge kind="dim">POST /mcp/servers</StatusBadge></div>
      <div class="card-b">
        <div class="form-row">
          <input v-model="regName" class="grow" placeholder="名称 name（不含空白）">
          <select v-model="regTransport" style="width:150px">
            <option value="stdio">stdio</option>
            <option value="sse">sse</option>
            <option value="http">http</option>
          </select>
        </div>
        <div v-if="regTransport === 'stdio'" style="margin-top:10px">
          <div class="form-row">
            <input v-model="regCommand" class="grow mono" placeholder="command，如 npx">
            <input v-model="regArgs" class="grow mono" placeholder="args（空格分隔），如 -y @modelcontextprotocol/server-filesystem">
          </div>
          <textarea v-model="regEnv" class="mono" style="width:100%;margin-top:10px" rows="2" placeholder="env（每行 KEY=VALUE，可选）"></textarea>
        </div>
        <div v-else style="margin-top:10px">
          <div class="form-row">
            <input v-model="regUrl" class="grow mono" placeholder="url，如 https://example.com/mcp/">
          </div>
          <textarea v-if="regTransport === 'http'" v-model="regHeaders" class="mono" style="width:100%;margin-top:10px" rows="2" placeholder="headers（每行 KEY=VALUE，可选）"></textarea>
        </div>
        <div class="form-row" style="margin-top:10px">
          <button class="primary" :disabled="busy" @click="register">登记并连接</button>
          <button @click="closeReg">取消</button>
          <span class="muted">连接失败返回 502：配置仍已落盘（半态），可稍后「测试」或「重载」。</span>
        </div>
      </div>
    </div>

    <div class="card">
      <table class="tbl">
        <thead>
          <tr>
            <th>名称</th><th>传输</th><th>命令 / URL</th><th>状态</th><th>工具数</th><th>连通性</th><th style="width:210px">操作</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="s in servers" :key="s.name">
            <tr>
              <td><b>{{ s.name }}</b></td>
              <td class="mono">{{ s.transport }}</td>
              <td class="mono" style="max-width:340px;word-break:break-all">{{ targetOf(s.name) }}</td>
              <td>
                <StatusBadge :kind="s.status === 'connected' ? 'ok' : 'err'" :title="s.status === 'disconnected' ? '半态可能：配置已落盘但连接失败' : ''">
                  {{ s.status }}
                </StatusBadge>
              </td>
              <td class="mono">{{ s.toolCount }}</td>
              <td>
                <StatusBadge v-if="tests[s.name]?.ok" kind="ok" :title="tests[s.name].error">{{ tests[s.name].latencyMs }}ms · {{ tests[s.name].tools }} 工具</StatusBadge>
                <StatusBadge v-else-if="tests[s.name]" kind="err" :title="tests[s.name].error">失败</StatusBadge>
                <span v-else class="muted">—</span>
              </td>
              <td>
                <button @click="test(s.name)">测试</button>
                <button @click="view(s.name)">{{ expanded === s.name ? '收起' : '明细' }}</button>
                <ConfirmButton :disabled="busy" @confirm="del(s.name)" />
              </td>
            </tr>
            <tr v-if="expanded === s.name && detail">
              <td colspan="7" style="padding:8px 10px">
                <div style="margin:2px 2px 6px">
                  <span class="muted">提供的工具：</span><span class="mono">{{ toolNames(detail.tools) }}</span>
                </div>
                <JsonViewer :value="detail" :label="`GET /mcp/servers/${s.name}`" />
              </td>
            </tr>
          </template>
          <tr v-if="servers.length === 0">
            <td colspan="7" class="muted">暂无 MCP server，点右上「＋ 登记」。</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="muted" style="font-size:12.5px">
      登记返回 502 时为半态（配置已落盘但连接失败）；删除先断连再删配置；「重载」全部断连重连。
    </p>
  </div>
</template>
