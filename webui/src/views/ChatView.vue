<script setup lang="ts">
// ChatView：会话 CRUD + SSE 流式对话 + 停止生成 + 对话内上传（Task-20261017-001 D5/D7）
// 端点映射：
//   GET    /workspaces          → 左侧会话列表（按工作空间分组聚合，当前空间置顶）
//   POST   /sessions            → ＋新建（发送前无会话时也自动创建）
//   GET    /sessions/:id        → 恢复历史消息（{meta, messages}；支持跨工作空间会话）
//   DELETE /sessions/:id        → 删除（二次确认；in-flight 409；支持跨工作空间会话）
//   POST   /sessions/:id/messages → 发消息（默认 SSE；stream:false 非流式 JSON；跨空间会话 409）
// 跨工作空间会话：仅支持查看与删除，不支持继续对话（composer 禁用 + 只读徽标）
//   POST   /uploads/raw         → 📎 文件选择框上传 → chip（contextNote 随下一条消息注入）
//   DELETE /uploads             → 上传面板「清空全部」（二次确认）
// 停止生成：AbortController 中断 fetch（服务端照常完成并持久化，停止后刷新列表）

import { computed, nextTick, onMounted, ref } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api, AuthError, uploadRaw } from '../api/client.js';
import { sseFetch, type SseEvent } from '../api/sse.js';
import { showToast } from '../toast.js';

interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}
interface WorkspaceGroup {
  id: string;
  name: string;
  path: string;
  current: boolean;
  createdAt: string;
  lastAccessedAt: string;
  sessions: SessionMeta[];
}
interface ToolCall {
  tool: string;
  args: string;
  result: string;
  done: boolean;
}
interface ChatMsg {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  files?: string[]; // 该消息附带的上传文件名（仅用户消息展示）
  tools?: ToolCall[]; // 仅助手消息：工具调用折叠块
  streaming?: boolean;
  failed?: boolean;
  failedText?: string; // fatal 终止原因
  meta?: string; // done 后的耗时/轮数标注
}
interface UploadChip {
  id: number;
  fileName: string;
  bytes: number;
  contextNote: string;
}

const workspaces = ref<WorkspaceGroup[]>([]);
const collapsedWs = ref<Set<string>>(new Set());
const sessKw = ref('');
const activeId = ref<string | null>(null);
const messages = ref<ChatMsg[]>([]);
const draft = ref('');
const streaming = ref(false);
const streamChk = ref(true);
const uploads = ref<UploadChip[]>([]);
const upPopOpen = ref(false);
const upBusy = ref(false);
const upCleanArmed = ref(false);
const delArmedId = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const msgsEl = ref<HTMLElement | null>(null);

const activeMeta = computed(() => {
  for (const w of workspaces.value) {
    const s = w.sessions.find((x) => x.id === activeId.value);
    if (s) return s;
  }
  return null;
});
const activeWs = computed(
  () => workspaces.value.find((w) => w.sessions.some((s) => s.id === activeId.value)) ?? null,
);
const foreignActive = computed(() => activeWs.value !== null && !activeWs.value.current);
const filteredGroups = computed(() => {
  const kw = sessKw.value.trim().toLowerCase();
  if (!kw) return workspaces.value;
  return workspaces.value
    .map((w) => {
      if (w.name.toLowerCase().includes(kw) || w.path.toLowerCase().includes(kw)) return w;
      const hit = w.sessions.filter((s) => (s.title || '').toLowerCase().includes(kw));
      return hit.length > 0 ? { ...w, sessions: hit } : null;
    })
    .filter((w): w is WorkspaceGroup => w !== null);
});

let msgSeq = 0;
let chipSeq = 0;
let abortCtrl: AbortController | null = null;
let composing = false; // 中文输入法组词中的 Enter 不发送

function fmtBytes(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function renderMarkdown(text: string | null | undefined): string {
  if (!text) return '';
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}

function scrollBottom(): void {
  nextTick(() => {
    if (msgsEl.value) msgsEl.value.scrollTop = msgsEl.value.scrollHeight;
  });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ================= 会话列表（按工作空间分组） ================= */

const WS_COLORS = ['#0e9f6e', '#4f46e5', '#b45309', '#0e7490', '#be185d', '#7c3aed'];

function wsColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = h * 31 + name.charCodeAt(i);
  return WS_COLORS[Math.abs(h) % WS_COLORS.length];
}

function toggleWs(id: string): void {
  const next = new Set(collapsedWs.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedWs.value = next;
}

async function loadSessions(): Promise<void> {
  try {
    const r = await api<{ workspaces: WorkspaceGroup[] }>('/workspaces');
    workspaces.value = r.workspaces;
  } catch (e) {
    if (!(e instanceof AuthError)) showToast(errText(e), 'error');
  }
}

async function createSession(): Promise<string | null> {
  try {
    const r = await api<SessionMeta>('/sessions', { method: 'POST' });
    const cur = workspaces.value.find((w) => w.current);
    if (cur) {
      cur.sessions.unshift(r);
      collapsedWs.value = new Set([...collapsedWs.value].filter((id) => id !== cur.id));
    } else {
      void loadSessions(); // 当前空间组缺失（异常）：整体重载
    }
    activeId.value = r.id;
    messages.value = [];
    scrollBottom();
    return r.id;
  } catch (e) {
    if (!(e instanceof AuthError)) showToast(errText(e), 'error');
    return null;
  }
}

async function selectSession(id: string): Promise<void> {
  if (id === activeId.value) return;
  if (streaming.value) {
    showToast('正在生成回复，请先停止', 'error');
    return;
  }
  try {
    const r = await api<{ meta: SessionMeta; messages: { role: string; content: string }[] }>(
      `/sessions/${encodeURIComponent(id)}`,
    );
    activeId.value = id;
    messages.value = r.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ id: ++msgSeq, role: m.role as ChatMsg['role'], text: m.content }));
    scrollBottom();
  } catch (e) {
    if (!(e instanceof AuthError)) showToast(errText(e), 'error');
  }
}

function onDelSession(s: SessionMeta): void {
  if (delArmedId.value !== s.id) {
    delArmedId.value = s.id; // 动词即确认：二次点击
    setTimeout(() => {
      if (delArmedId.value === s.id) delArmedId.value = null;
    }, 2600);
    return;
  }
  delArmedId.value = null;
  void (async () => {
    try {
      await api(`/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      for (const w of workspaces.value) {
        const i = w.sessions.findIndex((x) => x.id === s.id);
        if (i >= 0) {
          w.sessions.splice(i, 1);
          break;
        }
      }
      if (activeId.value === s.id) {
        activeId.value = null;
        messages.value = [];
      }
      showToast('会话已删除', 'success');
    } catch (e) {
      if (e instanceof AuthError) return;
      showToast((e as { code?: string }).code === 'busy' ? '会话正在处理消息，暂不能删除' : errText(e), 'error');
    }
  })();
}

/* ================= 消息发送与 SSE 渲染 ================= */

function handleEvent(ev: SseEvent, asst: ChatMsg): void {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  switch (ev.event) {
    case 'llm_stream':
      asst.text += String(d.text ?? '');
      scrollBottom();
      break;
    case 'tool_start':
      asst.tools ??= [];
      asst.tools.push({
        tool: String(d.tool ?? ''),
        args: JSON.stringify(d.args ?? null),
        result: '',
        done: false,
      });
      scrollBottom();
      break;
    case 'tool_end': {
      const tc = [...(asst.tools ?? [])].reverse().find((t) => !t.done && t.tool === String(d.tool ?? ''));
      if (tc) {
        tc.result = typeof d.result === 'string' ? d.result : JSON.stringify(d.result ?? null);
        tc.done = true;
      }
      scrollBottom();
      break;
    }
    case 'final': // 定稿覆盖流式累积文本
      asst.text = String(d.answer ?? '');
      break;
    case 'error':
      showToast(`模型错误: ${String(d.message ?? d.name ?? '')}`, 'error');
      break;
    case 'warning':
      showToast(String(d.message ?? ''), 'error');
      break;
    case 'fatal':
      asst.streaming = false;
      asst.failed = true;
      asst.failedText = String(d.message ?? '生成失败');
      scrollBottom();
      break;
    case 'done':
      asst.streaming = false;
      asst.meta = `${(Number(d.durationMs ?? 0) / 1000).toFixed(1)}s · ${String(d.iterations ?? '?')} 轮`;
      scrollBottom();
      break;
    default:
      break; // start/iteration_start/llm_end/end 等事件 P0 不展示
  }
}

async function ensureSession(): Promise<string | null> {
  return activeId.value ?? (await createSession());
}

async function send(): Promise<void> {
  if (foreignActive.value) {
    showToast('跨工作空间会话仅支持查看与删除，不支持继续对话', 'error');
    return;
  }
  const text = draft.value.trim();
  if (!text && uploads.value.length === 0) return;
  if (streaming.value) return;
  const sessionId = await ensureSession();
  if (!sessionId) return;

  // contextNote 拼接进 message 文本（POST messages 无独立 contextNote 字段）
  const notes = uploads.value.map((u) => u.contextNote);
  const full = [...notes, text].filter(Boolean).join('\n\n');

  const chipsSnapshot = uploads.value;
  const draftSnapshot = draft.value;
  const baseLen = messages.value.length;

  const userMsg: ChatMsg = {
    id: ++msgSeq,
    role: 'user',
    text,
    files: chipsSnapshot.map((u) => u.fileName),
  };
  const asst: ChatMsg = { id: ++msgSeq, role: 'assistant', text: '', tools: [], streaming: true };
  if (streamChk.value) messages.value.push(userMsg, asst);
  else messages.value.push(userMsg);

  uploads.value = [];
  draft.value = '';
  streaming.value = true;
  scrollBottom();

  abortCtrl = new AbortController();
  try {
    if (streamChk.value) {
      await sseFetch(
        `/sessions/${encodeURIComponent(sessionId)}/messages`,
        { message: full, stream: true },
        (ev) => handleEvent(ev, asst),
        abortCtrl.signal,
      );
      asst.streaming = false;
    } else {
      const r = await api<{
        answer: string;
        iterations: number;
        durationMs: number;
        warnings?: string[];
      }>(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        json: { message: full, stream: false },
      });
      asst.text = r.answer;
      asst.streaming = false;
      asst.meta = `${(r.durationMs / 1000).toFixed(1)}s · ${r.iterations} 轮`;
      for (const w of r.warnings ?? []) showToast(w, 'error');
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      asst.streaming = false; // 用户主动停止：保留已收内容
      showToast('已停止生成（服务端将照常完成并保存）');
    } else {
      // 请求未成功：乐观消息回滚 + 恢复输入
      messages.value = messages.value.slice(0, baseLen);
      uploads.value = chipsSnapshot;
      draft.value = draftSnapshot;
      if (!(e instanceof AuthError)) {
        const msg = (e as { code?: string }).code === 'busy' ? '正在处理上一条消息，请稍后再试' : errText(e);
        showToast(msg, 'error');
      }
    }
  } finally {
    streaming.value = false;
    abortCtrl = null;
    scrollBottom();
    void loadSessions(); // 刷新 messageCount / updatedAt
  }
}

function stopGen(): void {
  abortCtrl?.abort();
}

function onEnter(e: KeyboardEvent): void {
  if (e.shiftKey || composing) return;
  e.preventDefault();
  void send();
}

/* ================= 对话内上传 ================= */

async function onPickFiles(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  if (files.length === 0) return;
  const sessionId = await ensureSession();
  if (!sessionId) return;
  upBusy.value = true;
  try {
    for (const f of files) {
      try {
        const r = await uploadRaw(f, sessionId);
        uploads.value.push({ id: ++chipSeq, fileName: r.fileName, bytes: r.bytes, contextNote: r.contextNote });
        showToast(`已上传 → ${r.fileName}（${fmtBytes(r.bytes)}）`, 'success');
      } catch (e) {
        if (e instanceof AuthError) break;
        showToast(`上传失败 ${f.name}: ${errText(e)}`, 'error');
      }
    }
  } finally {
    upBusy.value = false;
  }
}

function removeChip(u: UploadChip): void {
  uploads.value = uploads.value.filter((x) => x.id !== u.id);
  showToast('已从注入列表移除（服务器文件保留）');
}

function onCleanUploads(): void {
  if (!upCleanArmed.value) {
    upCleanArmed.value = true; // 动词即确认：二次点击
    setTimeout(() => {
      upCleanArmed.value = false;
    }, 2600);
    return;
  }
  upCleanArmed.value = false;
  void (async () => {
    try {
      await api('/uploads', { method: 'DELETE' });
      uploads.value = [];
      showToast('上传目录已清空', 'success');
    } catch (e) {
      if (!(e instanceof AuthError)) showToast(errText(e), 'error');
    }
  })();
}

onMounted(() => {
  void loadSessions();
});
</script>

<template>
  <div class="chat">
    <!-- ===== 会话侧栏 ===== -->
    <aside class="sess-panel">
      <div class="h">
        <b>会话</b>
        <button class="primary new" :disabled="streaming" @click="createSession">＋ 新建</button>
      </div>
      <div class="sess-filter">
        <span class="ico">🔍</span>
        <input v-model="sessKw" type="text" placeholder="搜索会话 / 工作空间">
      </div>
      <div class="sess-list">
        <div
          v-for="w in filteredGroups"
          :key="w.id"
          class="ws-group"
          :class="{ collapsed: collapsedWs.has(w.id) }"
        >
          <div class="ws-head" :title="w.path" @click="toggleWs(w.id)">
            <span class="arrow">▼</span>
            <span class="dot" :style="{ background: wsColor(w.name) }"></span>
            <span class="nm">{{ w.name }}</span>
            <span v-if="w.current" class="cur">当前</span>
            <span class="cnt">{{ w.sessions.length }}</span>
          </div>
          <div
            v-for="s in w.sessions"
            :key="s.id"
            class="sess"
            :class="{ active: s.id === activeId }"
            @click="selectSession(s.id)"
          >
            <div class="t">
              <div class="n">{{ s.title || '新会话' }}</div>
              <div class="s">{{ s.messageCount }} 条 · {{ fmtTime(s.updatedAt) }}</div>
            </div>
            <button
              class="del"
              :class="{ armed: delArmedId === s.id }"
              :title="delArmedId === s.id ? '再次点击确认删除' : '删除会话'"
              @click.stop="onDelSession(s)"
            >
              {{ delArmedId === s.id ? '确认？' : '🗑' }}
            </button>
          </div>
        </div>
        <div v-if="filteredGroups.length === 0" class="empty">
          {{ sessKw.trim() ? '无匹配会话' : '暂无会话' }}
        </div>
      </div>
    </aside>

    <!-- ===== 主区 ===== -->
    <div class="chat-main">
      <div class="chat-head">
        <b>{{ activeMeta?.title || (activeId ? '会话' : '开始新对话') }}</b>
        <span v-if="activeMeta" class="sid">#{{ activeMeta.id }}</span>
        <span v-if="activeWs" class="ws-badge" :title="activeWs.path">📁 {{ activeWs.name }}</span>
        <span v-if="foreignActive" class="ro-badge">只读</span>
        <span class="spacer"></span>
        <span class="muted-hint">{{ streamChk ? 'SSE 流式' : '非流式' }}</span>
      </div>

      <div ref="msgsEl" class="msgs">
        <div class="msg-wrap">
          <div v-if="!activeId && messages.length === 0" class="chat-empty">
            选择左侧会话，或点击「＋ 新建」开始对话
          </div>
          <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
            <div class="ava">{{ m.role === 'user' ? '你' : 'L' }}</div>
            <div class="bubble">
              <div v-if="m.files?.length" class="msg-files">📎 {{ m.files.join('、') }}</div>
              <details v-for="(t, i) in m.tools" :key="i" class="tool-call">
                <summary>
                  <span class="arrow">▶</span>
                  <span class="tc-badge" :class="t.done ? 'ok' : 'run'">{{ t.done ? '✓' : '⟳' }} {{ t.tool }}</span>
                  <span class="tc-args">{{ t.args }}</span>
                </summary>
                <div class="tc-body">{{ t.result || '（执行中…）' }}</div>
              </details>
              <div v-if="m.role === 'assistant'" class="md" v-html="renderMarkdown(m.text)"></div>
              <div v-else class="plain">{{ m.text }}</div>
              <span v-if="m.streaming" class="cursor"></span>
              <div v-if="m.failed" class="fatal">⚠ {{ m.failedText }}</div>
              <div v-if="m.meta" class="meta-line">{{ m.meta }}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="composer">
        <div class="composer-inner">
          <div class="chips">
            <span v-for="u in uploads" :key="u.id" class="chip" :title="u.contextNote + '（将随下一条消息注入）'">
              📎 {{ u.fileName }}（{{ fmtBytes(u.bytes) }}）
              <button title="移除（不再注入，服务器文件保留）" @click="removeChip(u)">✕</button>
            </span>
          </div>
          <div class="box">
            <button class="attach" title="上传文件" :disabled="streaming || foreignActive" @click="upPopOpen = !upPopOpen">📎</button>
            <textarea
              v-model="draft"
              :disabled="foreignActive"
              :placeholder="foreignActive ? '跨工作空间会话仅支持查看与删除' : '输入消息，Enter 发送，Shift+Enter 换行'"
              @keydown.enter="onEnter"
              @compositionstart="composing = true"
              @compositionend="composing = false"
            ></textarea>
            <button v-if="streaming" class="stop" @click="stopGen">■ 停止</button>
            <button
              v-else
              class="primary send"
              :disabled="foreignActive || (!draft.trim() && uploads.length === 0)"
              @click="send"
            >
              发送
            </button>
          </div>
          <div class="meta">
            <label class="chk">
              <input v-model="streamChk" type="checkbox" :disabled="streaming"> 流式
            </label>
            <span class="hint">发送后自动附带 📎 文件的 contextNote</span>
          </div>

          <!-- 上传面板（文件选择框 + POST /uploads/raw） -->
          <div v-if="upPopOpen" class="up-pop">
            <div class="up-row">
              <button class="primary" :disabled="upBusy || streaming" @click="fileInput?.click()">
                {{ upBusy ? '上传中…' : '选择文件…' }}
              </button>
              <input ref="fileInput" type="file" multiple hidden @change="onPickFiles">
              <span class="muted-hint">支持多选 · 单文件上限 100MB</span>
            </div>
            <p class="up-note">
              上传成功后以 contextNote（[文件上传] 文件名 / 上传路径 / 大小）随下一条消息注入对话；
              chip ✕ 仅移除不再注入，「清空全部」删除服务器上传目录。
            </p>
            <div class="up-actions">
              <button class="clean" :class="{ armed: upCleanArmed }" :disabled="upBusy" @click="onCleanUploads">
                {{ upCleanArmed ? '确认清空？' : '清空全部' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== 布局 ===== */
.chat {
  display: flex;
  height: 100%;
  overflow: hidden;
}

/* ===== 会话侧栏 ===== */
.sess-panel {
  width: 220px;
  flex: none;
  background: var(--panel);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
}
.sess-panel .h {
  padding: 12px 12px 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sess-panel .h b { font-size: 13px; }
.sess-panel .h .new { padding: 4px 10px; font-size: 12.5px; }
.sess-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px;
}
.sess {
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 2px;
}
.sess:hover { background: var(--bg); }
.sess.active { background: var(--brand-weak); }
.sess .t { flex: 1; min-width: 0; }
.sess .t .n {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sess .t .s { font-size: 11px; color: var(--muted); }
.sess .del {
  visibility: hidden;
  border: none;
  background: none;
  color: var(--muted);
  font-size: 12px;
  padding: 0 3px;
}
.sess:hover .del { visibility: visible; }
.sess .del:hover, .sess .del.armed { color: var(--danger); }
.sess-list .empty { color: var(--muted); font-size: 12.5px; padding: 10px; text-align: center; }

/* ===== 会话过滤与工作空间分组 ===== */
.sess-filter {
  position: relative;
  margin: 0 12px 6px;
}
.sess-filter .ico {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 11px;
  opacity: 0.55;
  pointer-events: none;
}
.sess-filter input {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 9px 5px 26px;
  font-size: 12.5px;
  border-radius: 7px;
}
.ws-group { margin-bottom: 2px; }
.ws-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 6px 6px 3px;
  cursor: pointer;
  border-radius: 7px;
  user-select: none;
}
.ws-head:hover { background: var(--bg); }
.ws-head .arrow {
  font-size: 9px;
  color: var(--muted);
  transition: transform 0.15s;
  flex: none;
}
.ws-group.collapsed .ws-head .arrow { transform: rotate(-90deg); }
.ws-head .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.ws-head .nm {
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.ws-head .cur {
  font-size: 10px;
  color: var(--brand);
  background: var(--brand-weak);
  border-radius: 999px;
  padding: 1px 6px;
  flex: none;
}
.ws-head .cnt {
  font-size: 10.5px;
  color: var(--muted);
  background: var(--bg);
  border-radius: 999px;
  padding: 1px 6px;
  flex: none;
}
.ws-group.collapsed .sess { display: none; }
.ws-group .sess { margin-left: 10px; }
.chat-head .ws-badge {
  font-size: 11.5px;
  color: var(--muted);
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 2px 8px;
  white-space: nowrap;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chat-head .ro-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--warn);
  background: var(--warn-weak, rgba(180, 83, 9, 0.12));
  border-radius: 999px;
  padding: 2px 8px;
  flex: none;
}

/* ===== 主区 ===== */
.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}
.chat-head {
  padding: 10px 20px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  display: flex;
  align-items: center;
  gap: 10px;
}
.chat-head b { font-size: 14px; }
.chat-head .sid {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  color: var(--muted);
}
.chat-head .spacer { flex: 1; }
.muted-hint { font-size: 12px; color: var(--muted); }

/* ===== 消息流 ===== */
.msgs { flex: 1; overflow-y: auto; padding: 20px 0; }
.msg-wrap { max-width: 780px; margin: 0 auto; padding: 0 20px; }
.chat-empty {
  text-align: center;
  color: var(--muted);
  padding: 48px 0;
  font-size: 13.5px;
}
.msg { margin-bottom: 18px; display: flex; gap: 10px; }
.msg .ava {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
}
.msg.user { flex-direction: row-reverse; }
.msg.user .ava { background: var(--bg); border: 1px solid var(--line); }
.msg.assistant .ava { background: var(--brand); color: var(--brand-on); }
.bubble { max-width: 76%; padding: 9px 14px; border-radius: 12px; }
.msg.user .bubble {
  background: var(--brand-weak);
  border-top-right-radius: 4px;
}
.msg.user .plain { white-space: pre-wrap; word-break: break-word; }
.msg.assistant .bubble {
  background: var(--panel);
  border: 1px solid var(--line);
  border-top-left-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}
.msg .bubble p { margin: 0 0 8px; }
.msg .bubble p:last-child { margin-bottom: 0; }
.md :first-child { margin-top: 0; }
.md :last-child { margin-bottom: 0; }
.md pre {
  background: var(--code-bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  overflow-x: auto;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12.5px;
  margin: 8px 0;
}
.md code {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12.5px;
  background: var(--code-bg);
  border-radius: 4px;
  padding: 1px 5px;
}
.md pre code { background: none; padding: 0; }
.msg-files { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.meta-line { font-size: 11px; color: var(--muted); margin-top: 6px; }
.fatal {
  color: var(--danger);
  background: var(--danger-weak);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12.5px;
  margin-top: 8px;
}
.cursor {
  display: inline-block;
  width: 7px;
  height: 15px;
  background: var(--brand);
  vertical-align: -2px;
  margin-left: 2px;
  animation: blink 1s steps(1) infinite;
  border-radius: 1px;
}
@keyframes blink { 50% { opacity: 0; } }

/* ===== 工具调用折叠块 ===== */
.tool-call {
  border: 1px solid var(--line);
  border-radius: 9px;
  margin: 8px 0;
  overflow: hidden;
  background: var(--bg);
}
.tool-call summary {
  cursor: pointer;
  padding: 7px 12px;
  font-size: 12.5px;
  display: flex;
  align-items: center;
  gap: 8px;
  list-style: none;
  font-family: ui-monospace, Consolas, monospace;
}
.tool-call summary::-webkit-details-marker { display: none; }
.tool-call summary .arrow { transition: transform 0.15s; color: var(--muted); font-size: 10px; }
.tool-call[open] summary .arrow { transform: rotate(90deg); }
.tc-badge { font-weight: 600; }
.tc-badge.ok { color: var(--brand); }
.tc-badge.run { color: var(--warn); }
.tc-args {
  color: var(--muted);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tool-call .tc-body {
  padding: 8px 12px 10px;
  border-top: 1px solid var(--line);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: var(--muted);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 280px;
  overflow-y: auto;
}

/* ===== 输入区 ===== */
.composer {
  border-top: 1px solid var(--line);
  background: var(--panel);
  padding: 12px 20px 14px;
}
.composer-inner { max-width: 780px; margin: 0 auto; position: relative; }
.composer .box { display: flex; gap: 10px; align-items: flex-end; }
.composer textarea {
  flex: 1;
  resize: none;
  height: 44px;
  line-height: 1.5;
  padding: 10px 12px;
}
.composer .attach { height: 44px; padding: 0 12px; font-size: 16px; }
.composer .send { height: 44px; padding: 0 18px; }
.composer .stop { height: 44px; padding: 0 14px; color: var(--danger); border-color: var(--danger); }
.composer .meta {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 7px;
  font-size: 12px;
  color: var(--muted);
}
.composer label.chk { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.composer .hint { font-size: 11.5px; }

/* ===== 上传 chip 与面板 ===== */
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chips:not(:empty) { margin-bottom: 8px; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px 6px 3px 10px;
  font-size: 12px;
  max-width: 100%;
}
.chip button { border: none; background: none; padding: 0 3px; color: var(--muted); font-size: 12px; }
.chip button:hover { color: var(--danger); }
.up-pop {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 8px);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  padding: 14px 16px;
  z-index: 20;
}
.up-row { display: flex; gap: 10px; align-items: center; }
.up-note { font-size: 11.5px; color: var(--muted); margin: 8px 2px 0; }
.up-actions { display: flex; justify-content: flex-end; margin-top: 10px; }
.up-actions .clean {
  border: none;
  background: none;
  color: var(--danger);
  font-size: 12.5px;
  padding: 4px 8px;
}
.up-actions .clean.armed { background: var(--danger); color: #fff; border-radius: 6px; }

/* ===== 窄屏 ===== */
@media (max-width: 900px) {
  .sess-panel { display: none; }
}
</style>
