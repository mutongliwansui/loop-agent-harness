// Tab-sync：同源多标签页派生状态广播（Task-20261021-002-07）
//
// 背景：chat-stream 的 states 是各标签页独立的模块级 Map，A 页发起/完成的 run、
// 已读状态、删除操作，B 页完全无感。本模块提供四类派生状态消息的广播与订阅：
// run-started / run-finished / unread-cleared / session-dropped。
//
// 设计要点（任务文档 D1/D8）：
// - 只传派生状态，不传消息体：内容永远以服务端为准，接收方只做「唤醒 + 对齐」
// - 通道首选 BroadcastChannel('loop-agent')：同源限定、不回环到发送者、无持久化副作用
// - 缺失时降级 localStorage 随机键 + storage 事件：写后 500ms 删除 + at 去重 +
//   排除自身刚写的键（防自收与双投递）

export type TabMsg =
  | { t: 'run-started'; id: string; runId?: string; at: number }
  | { t: 'run-finished'; id: string; status: 'done' | 'failed' | 'aborted'; durationMs?: number; at: number }
  | { t: 'unread-cleared'; id: string; at: number }
  | { t: 'session-dropped'; id: string; at: number };

export type TabMsgType = TabMsg['t'];

/** 分配式 Omit：直接写 Omit<TabMsg,'at'> 会塌缩成联合公共键（丢 status/durationMs 等） */
export type TabMsgInput = TabMsg extends infer U ? (U extends TabMsg ? Omit<U, 'at'> : never) : never;

const CHANNEL_NAME = 'loop-agent';
const LS_PREFIX = '__la_tab__';
/** 降级通道同一条消息可能经多次 storage 事件到达：按 `${t}:${id}:${at}` 去重的窗口 */
const DEDUP_WINDOW_MS = 1000;

let bc: BroadcastChannel | null = null;
try {
  bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;
} catch {
  bc = null; // 隐私模式等环境下构造即抛：走降级通道
}

/** 自身刚写的 localStorage 键（降级通道防自收） */
let lastWrittenKey = '';
/** 已投递消息去重表（键 → 清理定时器） */
const seen = new Map<string, ReturnType<typeof setTimeout>>();

type Listener = (m: TabMsg) => void;
const listeners = new Set<Listener>();

/** 分发一条消息给本页订阅者（去重 + 排除自身写入） */
function dispatch(raw: unknown, sourceKey: string | null): void {
  if (sourceKey && sourceKey === lastWrittenKey) return;
  let m: TabMsg;
  try {
    const p = raw as TabMsg;
    if (!p || typeof p !== 'object' || typeof p.t !== 'string' || typeof p.id !== 'string') return;
    m = p;
  } catch {
    return;
  }
  const key = `${m.t}:${m.id}:${m.at}`;
  if (seen.has(key)) return;
  seen.set(
    key,
    setTimeout(() => seen.delete(key), DEDUP_WINDOW_MS),
  );
  for (const fn of [...listeners]) {
    try {
      fn(m);
    } catch {
      listeners.delete(fn); // 单个订阅者异常不拖垮其它
    }
  }
}

/** 广播一条派生状态消息到其它标签页（at 自动补齐；失败静默） */
export function postTab(msg: TabMsgInput): void {
  const full = { ...msg, at: Date.now() } as TabMsg;
  if (bc) {
    try {
      bc.postMessage(full);
    } catch {
      /* 序列化失败等：静默 */
    }
    return;
  }
  // 降级：localStorage 随机键写入 → 其它标签页 storage 事件 → 500ms 后删除
  try {
    const w = typeof window !== 'undefined' ? window : undefined;
    if (!w?.localStorage) return;
    const key = `${LS_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    lastWrittenKey = key;
    w.localStorage.setItem(key, JSON.stringify(full));
    setTimeout(() => {
      try {
        w.localStorage.removeItem(key);
      } catch {
        /* 静默 */
      }
    }, 500);
  } catch {
    /* 隐私模式等：静默 */
  }
}

/**
 * 订阅其它标签页的广播；返回反注册函数。
 * 主通道走 BroadcastChannel.onmessage；降级通道监听 window storage 事件
 * （浏览器只在「其它」标签页触发 storage，天然不回环）。
 */
export function onTab(fn: Listener): () => void {
  listeners.add(fn);
  if (bc) bc.onmessage = (e: MessageEvent): void => dispatch(e.data, null);
  const w = typeof window !== 'undefined' ? window : undefined;
  if (!bc && w) {
    w.addEventListener('storage', onStorage);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) {
      if (bc) bc.onmessage = null;
      w?.removeEventListener('storage', onStorage);
      for (const t of seen.values()) clearTimeout(t);
      seen.clear();
    }
  };
}

/** storage 事件处理：只认本模块前缀的键 */
function onStorage(e: StorageEvent): void {
  if (!e.key || !e.key.startsWith(LS_PREFIX) || e.newValue === null) return;
  try {
    dispatch(JSON.parse(e.newValue) as TabMsg, e.key);
  } catch {
    /* 半行 JSON 等：静默 */
  }
}
