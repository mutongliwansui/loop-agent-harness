<script setup lang="ts">
// 技能视图（P1 §3.5）
// 端点映射：GET /skills（合并视图）· POST /skills {sourcePath, scope, overwrite}（同名未 overwrite 409；
// 成功自动 reload）· GET /skills/:name（元数据 + 正文 body）· DELETE /skills/:name?scope=（缺省 auto：
// 工作空间优先 → 全局）· POST /skills/reload
import { onMounted, ref } from 'vue';
import { api, ApiError, AuthError } from '../api/client';
import { showToast } from '../toast';
import { errText } from '../utils';
import ConfirmButton from '../components/ConfirmButton.vue';
import StatusBadge from '../components/StatusBadge.vue';

interface SkillRow { name: string; description: string; scope: string; path: string }

const skills = ref<SkillRow[]>([]);
const busy = ref(false);

const sourcePath = ref('');
const overwrite = ref(false);
const installScope = ref<'workspace' | 'global'>('workspace');

const expanded = ref<string | null>(null);
const body = ref<{ name: string; body: string } | null>(null);

function guard(e: unknown, fallback: string): void {
  if (!(e instanceof AuthError)) showToast(e instanceof ApiError ? e.message : `${fallback}: ${errText(e)}`, 'error');
}

async function refresh(): Promise<void> {
  busy.value = true;
  try {
    const res = await api<{ skills: SkillRow[] }>('/skills');
    skills.value = res.skills;
  } catch (e) {
    guard(e, '加载技能失败');
  } finally {
    busy.value = false;
  }
}

async function install(): Promise<void> {
  const p = sourcePath.value.trim();
  if (!p) {
    showToast('请填写技能目录本地路径', 'error');
    return;
  }
  busy.value = true;
  try {
    const res = await api<{ name: string; scope: string }>('/skills', {
      method: 'POST',
      json: { sourcePath: p, scope: installScope.value, overwrite: overwrite.value },
    });
    showToast(`Skill 已安装：${res.name}（${res.scope}）`, 'success');
    sourcePath.value = '';
    overwrite.value = false;
    await refresh();
  } catch (e) {
    guard(e, '安装失败');
  } finally {
    busy.value = false;
  }
}

async function view(name: string): Promise<void> {
  if (expanded.value === name) {
    expanded.value = null;
    body.value = null;
    return;
  }
  try {
    body.value = await api<{ name: string; body: string }>(`/skills/${encodeURIComponent(name)}`);
    expanded.value = name;
  } catch (e) {
    guard(e, '查看失败');
  }
}

async function del(name: string): Promise<void> {
  busy.value = true;
  try {
    const res = await api<{ scope: string }>(`/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
    showToast(`Skill 已删除：${name}（${res.scope}）`, 'success');
    await refresh();
  } catch (e) {
    guard(e, '删除失败');
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

onMounted(refresh);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1>技能</h1>
      <span v-if="busy" class="spin" title="处理中"></span>
      <StatusBadge kind="dim">GET /skills</StatusBadge>
      <span class="spacer"></span>
      <button :disabled="busy" @click="reload">⟳ 重载</button>
      <button :disabled="busy" @click="refresh">⟳ 刷新</button>
    </div>

    <div class="card">
      <table class="tbl">
        <thead>
          <tr><th>技能</th><th>来源</th><th>描述</th><th>路径</th><th style="width:150px">操作</th></tr>
        </thead>
        <tbody>
          <template v-for="s in skills" :key="s.name">
            <tr>
              <td><b>{{ s.name }}</b></td>
              <td><StatusBadge :kind="s.scope === 'workspace' ? 'brand' : 'dim'">{{ s.scope }}</StatusBadge></td>
              <td class="muted">{{ s.description }}</td>
              <td class="mono muted" style="max-width:280px;word-break:break-all">{{ s.path }}</td>
              <td>
                <button @click="view(s.name)">{{ expanded === s.name ? '收起' : '查看' }}</button>
                <ConfirmButton :disabled="busy" label="卸载" @confirm="del(s.name)" />
              </td>
            </tr>
            <tr v-if="expanded === s.name && body">
              <td colspan="5" style="padding:8px 10px">
                <div class="jv" style="margin:2px 0">
                  <details open>
                    <summary>SKILL.md 正文</summary>
                    <pre>{{ body.body }}</pre>
                  </details>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="skills.length === 0">
            <td colspan="5" class="muted">暂无已安装技能，在下方填写目录路径安装。</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-h">安装技能 <StatusBadge kind="dim">POST /skills</StatusBadge></div>
      <div class="card-b">
        <div class="form-row">
          <input v-model="sourcePath" class="grow mono" placeholder="技能目录本地路径，如 D:\skills\my-skill" @keyup.enter="install">
          <select v-model="installScope" style="width:150px">
            <option value="workspace">workspace（工作空间）</option>
            <option value="global">global（全局）</option>
          </select>
          <label class="chk"><input v-model="overwrite" type="checkbox"> 同名覆盖</label>
          <button class="primary" :disabled="busy" @click="install">安装</button>
        </div>
        <p class="muted" style="font-size:12.5px;margin:10px 0 0">
          安装 / 卸载后自动重载，列表立即可见；同名冲突未勾选覆盖时返回 409。
        </p>
      </div>
    </div>
  </div>
</template>
