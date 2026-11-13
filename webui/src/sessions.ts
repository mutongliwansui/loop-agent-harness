// 会话列表共享状态（原型-20261018-001：会话列表并入左侧菜单，App.vue 与 ChatView 共用）
// 延续 D4 风格：模块级单例 + 组合式 API，不引 Pinia。
// 职责边界：
//   store —— 列表数据（workspaces/搜索过滤/折叠）、activeId、删除、跨视图跳转意图
//   ChatView —— 消息加载/流式渲染/新建弹窗；挂载时经 registerChatBridge 把 selectSession、
//               openNewPop 挂进 store，App 侧栏点击委托执行；ChatView 未挂载（在管理页）时
//               记 pending 标记并跳 #/chat，由 ChatView 挂载时消费
import { computed, ref } from 'vue';
import { api, AuthError } from './api/client.js';
import { showToast } from './toast.js';
import { drop as dropStream, dropAndBroadcast } from './chat-stream.js';

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** 服务端 run 状态快照（GET /workspaces 注入；与 chat-stream 实时状态取并集展示） */
  running?: boolean;
  /** run journal 概要（GET /workspaces 注入，Task-20261021-002-06）：interrupted 时侧栏标 ⚠ */
  lastRun?: { status: string; finishedAt?: number } | null;
  /** 会话级模型选择（task-20261025-002 D7）：缺省=跟随全局激活 */
  modelAlias?: string;
}
export interface WorkspaceGroup {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastAccessedAt: string;
  sessions: SessionMeta[];
}

export const workspaces = ref<WorkspaceGroup[]>([]);
export const sessKw = ref('');
export const collapsedWs = ref<Set<string>>(new Set());
export const activeId = ref<string | null>(null);
export const delArmedId = ref<string | null>(null);

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 搜索过滤：命中空间名/路径保留整组，否则按会话标题过滤组内条目，空组丢弃。
 *
 * 需求 20261113-002 D7：**无关键词时也丢弃 0 会话分组**。后端 GET /workspaces 已过滤
 * （D5），前端再兜一层可覆盖「前端缓存了旧响应 / 连的是旧版后端」的窗口期。
 * 纯防御，不改变任何有会话分组的展示。
 */
export const filteredGroups = computed<WorkspaceGroup[]>(() => {
  const kw = sessKw.value.trim().toLowerCase();
  const nonEmpty = workspaces.value.filter((w) => w.sessions.length > 0);
  if (!kw) return nonEmpty;
  return nonEmpty
    .map((w) => {
      if (w.name.toLowerCase().includes(kw) || w.path.toLowerCase().includes(kw)) return w;
      const hit = w.sessions.filter((s) => (s.title || '').toLowerCase().includes(kw));
      return hit.length > 0 ? { ...w, sessions: hit } : null;
    })
    .filter((w): w is WorkspaceGroup => w !== null);
});

export const activeMeta = computed<SessionMeta | null>(() => {
  for (const w of workspaces.value) {
    const s = w.sessions.find((x) => x.id === activeId.value);
    if (s) return s;
  }
  return null;
});
export const activeWs = computed<WorkspaceGroup | null>(
  () => workspaces.value.find((w) => w.sessions.some((s) => s.id === activeId.value)) ?? null,
);
/** 活跃会话所属工作空间的路径（供 FilesView 根目录使用；task-05：跨空间会话不再切换服务端状态，FilesView 应跟随活跃会话） */
export const activeWsPath = computed(() => activeWs.value?.path ?? '');

/* ================= 列表操作 ================= */

const WS_COLORS = ['#0e9f6e', '#4f46e5', '#b45309', '#0e7490', '#be185d', '#7c3aed'];

export function wsColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = h * 31 + name.charCodeAt(i);
  return WS_COLORS[Math.abs(h) % WS_COLORS.length];
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function toggleWs(id: string): void {
  const next = new Set(collapsedWs.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedWs.value = next;
}

export async function loadSessions(): Promise<void> {
  try {
    const r = await api<{ workspaces: WorkspaceGroup[] }>('/workspaces');
    workspaces.value = r.workspaces;
  } catch (e) {
    if (!(e instanceof AuthError)) showToast(errText(e), 'error');
  }
}

export function onDelSession(s: SessionMeta): void {
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
      if (activeId.value === s.id) activeId.value = null; // ChatView watch 后清空消息
      dropStream(s.id);
      // 广播他页移除该会话（Task-20261021-002-07）：B 页收后 drop + 列表刷新
      dropAndBroadcast(s.id);
      showToast('会话已删除', 'success');
    } catch (e) {
      if (e instanceof AuthError) return;
      showToast((e as { code?: string }).code === 'busy' ? '会话正在处理消息，暂不能删除' : errText(e), 'error');
    }
  })();
}

/* ================= App 侧栏 → ChatView 桥接 ================= */
// 会话切换 / 新建弹窗依赖 ChatView 的流式与消息状态，不能在 store 里直接实现。

let selectHandler: ((id: string) => void) | null = null;
let newPopHandler: (() => void) | null = null;
let pendingSelectId: string | null = null;
let pendingNewPop = false;

export function registerChatBridge(handlers: { select: (id: string) => void; openNewPop: () => void } | null): void {
  selectHandler = handlers?.select ?? null;
  newPopHandler = handlers?.openNewPop ?? null;
}

/** 侧栏会话条目点击：ChatView 在场直接切换，否则跳回聊天页挂载时恢复 */
export function clickSession(id: string): void {
  if (selectHandler) selectHandler(id);
  else {
    pendingSelectId = id;
    location.hash = '#/chat';
  }
}

/** 「新建对话」按钮：打开新建弹窗（弹窗在 ChatView 内） */
export function requestNewChat(): void {
  if (newPopHandler) newPopHandler();
  else {
    pendingNewPop = true;
    location.hash = '#/chat';
  }
}

/** ChatView onMounted 消费跨视图意图 */
export function consumePendingNewPop(): boolean {
  const v = pendingNewPop;
  pendingNewPop = false;
  return v;
}

export function consumePendingSelect(): string | null {
  const v = pendingSelectId;
  pendingSelectId = null;
  return v;
}
