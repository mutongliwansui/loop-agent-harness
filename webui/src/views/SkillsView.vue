<script setup lang="ts">
// 技能视图（P1 §3.5；20261017-003 安装改为浏览器 zip 文件选择框上传）
// 端点映射：GET /skills（合并视图）· POST /skills/upload {scope, overwrite, rootName(zip 文件名去 .zip), zipBase64}
// （同名未 overwrite 409；成功自动 reload）· GET /skills/:name（元数据 + 正文 body）·
// DELETE /skills/:name?scope=（缺省 auto：工作空间优先 → 全局）· POST /skills/reload
import { onMounted, ref } from 'vue';
import { api, ApiError, AuthError } from '../api/client';
import { showToast } from '../toast';
import { errText } from '../utils';
import ConfirmButton from '../components/ConfirmButton.vue';
import StatusBadge from '../components/StatusBadge.vue';

interface SkillRow { name: string; description: string; scope: string; path: string }

/** 上传 zip 包大小上限（与后端 UPLOAD_MAX_TOTAL_BYTES 一致） */
const UPLOAD_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const skills = ref<SkillRow[]>([]);
const busy = ref(false);

const overwrite = ref(false);
const installScope = ref<'workspace' | 'global'>('workspace');
const zipInput = ref<HTMLInputElement | null>(null);

/** 所选 zip 包：rootName = zip 文件名去 .zip（即安装目录名），SKILL.md 由服务端权威校验 */
interface Picked { zipName: string; rootName: string; size: number; file: File }
const picked = ref<Picked | null>(null);
const pickErr = ref('');

const expanded = ref<string | null>(null);
const body = ref<{ name: string; body: string } | null>(null);

function guard(e: unknown, fallback: string): void {
  if (!(e instanceof AuthError)) showToast(e instanceof ApiError ? e.message : `${fallback}: ${errText(e)}`, 'error');
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function onPickZip(): void {
  pickErr.value = '';
  zipInput.value?.click();
}

function onZipChange(e: Event): void {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  if (!/\.zip$/i.test(f.name)) {
    picked.value = null;
    pickErr.value = `仅支持 .zip 文件，已忽略「${f.name}」`;
    return;
  }
  const rootName = f.name.replace(/\.zip$/i, '');
  if (!rootName || rootName === '.' || rootName === '..') {
    picked.value = null;
    pickErr.value = `zip 文件名「${f.name}」无法作为安装目录名，请重命名后重试`;
    return;
  }
  pickErr.value = '';
  picked.value = { zipName: f.name, rootName, size: f.size, file: f };
}

function clearPicked(): void {
  picked.value = null;
  pickErr.value = '';
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
  const p = picked.value;
  if (!p || busy.value) return;
  if (p.size > UPLOAD_MAX_TOTAL_BYTES) {
    showToast(`zip 包超过 ${UPLOAD_MAX_TOTAL_BYTES / 1024 / 1024}MB 上限`, 'error');
    return;
  }
  busy.value = true;
  try {
    const zipBase64 = await fileToBase64(p.file);
    const res = await api<{ name: string; scope: string }>('/skills/upload', {
      method: 'POST',
      json: { scope: installScope.value, overwrite: overwrite.value, rootName: p.rootName, zipBase64 },
    });
    showToast(`Skill 已安装：${res.name}（${res.scope}）`, 'success');
    clearPicked();
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
            <td colspan="5" class="muted">暂无已安装技能，在下方选择 zip 包安装。</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-h">安装技能 <StatusBadge kind="dim">POST /skills/upload</StatusBadge></div>
      <div class="card-b">
        <input ref="zipInput" type="file" accept=".zip,application/zip,application/x-zip-compressed" hidden @change="onZipChange">

        <!-- 空态：选择 zip 包 -->
        <div v-if="!picked" class="pick-empty">
          <button class="primary" @click="onPickZip">📦 选择技能 zip 包</button>
          <span class="muted">选择技能 zip 压缩包上传安装，安装目录名 = zip 文件名（去 .zip），上限 20MB。</span>
        </div>

        <!-- 已选态：摘要 + 安装行 -->
        <template v-else>
          <div class="pick-sum">
            <span class="f-ico">📦</span>
            <div class="pm">
              <div class="l1">
                <b class="mono">{{ picked.zipName }}</b>
                <StatusBadge kind="dim">安装为 {{ picked.rootName }}/</StatusBadge>
              </div>
              <div class="l2">{{ fmtSize(picked.size) }} · 服务端将校验 SKILL.md 与 frontmatter，zip 内顶层目录自动剥除</div>
            </div>
            <span class="grow"></span>
            <button :disabled="busy" @click="clearPicked">✕ 重选</button>
          </div>

          <div v-if="pickErr" class="err-bar">⚠ {{ pickErr }}</div>

          <div class="form-row" style="margin-top:12px">
            <select v-model="installScope" style="width:170px">
              <option value="workspace">workspace（工作空间）</option>
              <option value="global">global（全局）</option>
            </select>
            <label class="chk"><input v-model="overwrite" type="checkbox"> 同名覆盖</label>
            <span class="grow"></span>
            <button class="primary" :disabled="busy" @click="install">⬆ 上传安装</button>
          </div>
        </template>

        <p class="muted" style="font-size:12.5px;margin:10px 0 0">
          安装 / 卸载后自动重载，列表立即可见；同名冲突未勾选覆盖时返回 409；zip 包上限 20MB。
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pick-empty {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12.5px;
}
.pick-sum {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
}
.pick-sum .f-ico { font-size: 22px; }
.pick-sum .pm { min-width: 0; }
.pick-sum .l1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pick-sum .l2 { font-size: 12px; color: var(--muted); margin-top: 2px; }
.err-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 8px 12px;
  background: var(--danger, rgba(220, 38, 38, 0.1));
  color: var(--danger, #dc2626);
  border-radius: 8px;
  font-size: 12.5px;
}
</style>
