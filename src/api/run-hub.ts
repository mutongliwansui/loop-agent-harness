// RunHub：run 事件注册表 + 编号环形缓冲 + 多订阅者 fan-out（Task-20261021-001 P0）
//
// 背景：原实现把 SSE 直接写进 HTTP 响应，客户端断开（切页面/刷新）后事件即丢弃，
// 重新进入只能看到节流落盘的快照。RunHub 让 run 与连接解耦：
// - 每个会话至多一个 run（与会话级互斥一致），事件带单调递增 seq
// - 事件先入缓冲再 fan-out，晚到的订阅者可用 cursor 续传
// - 缓冲有事件数 + 字节数双上限，溢出从头部丢弃（订阅方落后过多时由调用方发 reset）
// - run 结束后保留 RUN_RETAIN_AFTER_FINISH_MS，供刚断开的客户端重连补齐终态

import { randomUUID } from 'node:crypto';

/** 事件数上限 */
export const RUN_BUFFER_MAX_EVENTS = 2000;
/** 事件字节数上限（按 JSON 序列化后的 UTF-8 字节粗略计量） */
export const RUN_BUFFER_MAX_BYTES = 2 * 1024 * 1024;
/** run 结束后缓冲保留时长（重连补齐终态的窗口） */
export const RUN_RETAIN_AFTER_FINISH_MS = 60_000;

export type RunStatus = 'running' | 'done' | 'failed';

/** 缓冲/下发的事件单元 */
export interface RunEvent {
  seq: number;
  event: string;
  data: unknown;
}

export interface RunSnapshot {
  runId: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
}

export type RunSubscriber = (ev: RunEvent) => void;

export interface RunSubscription {
  /** run 已结束且回放完毕（无需再等实时事件） */
  finished: boolean;
  /** 解除订阅（连接断开时调用；run 本身不受影响） */
  unsubscribe: () => void;
}

interface RunState {
  runId: string;
  seq: number;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  buffer: RunEvent[];
  bytes: number;
  subscribers: Set<RunSubscriber>;
  retainTimer?: NodeJS.Timeout;
}

/** 估算事件占用字节（event 名 + 序列化载荷） */
function eventBytes(ev: RunEvent): number {
  let json: string;
  try {
    json = JSON.stringify(ev.data) ?? '';
  } catch {
    json = '';
  }
  return Buffer.byteLength(ev.event, 'utf8') + Buffer.byteLength(json, 'utf8');
}

export class RunHub {
  private readonly runs = new Map<string, RunState>();

  /** 开始一次 run（替换同会话的旧状态）；返回 runId */
  start(sessionId: string): string {
    const prev = this.runs.get(sessionId);
    if (prev?.retainTimer) clearTimeout(prev.retainTimer);
    const state: RunState = {
      runId: randomUUID(),
      seq: 0,
      status: 'running',
      startedAt: Date.now(),
      buffer: [],
      bytes: 0,
      subscribers: new Set(),
    };
    this.runs.set(sessionId, state);
    return state.runId;
  }

  /** 追加事件：分配 seq → 入缓冲 → fan-out；无运行中 run 返回 0 */
  publish(sessionId: string, event: string, data: unknown): number {
    const state = this.runs.get(sessionId);
    if (!state || state.status !== 'running') return 0;
    const ev: RunEvent = { seq: ++state.seq, event, data };
    state.buffer.push(ev);
    state.bytes += eventBytes(ev);
    this.trim(state);

    for (const sub of [...state.subscribers]) {
      try {
        sub(ev);
      } catch {
        state.subscribers.delete(sub); // 写失败的连接直接摘除，不影响其它订阅者
      }
    }
    return ev.seq;
  }

  /**
   * 结束 run：先发布终态事件（保证晚到订阅者可回放）→ 置状态 → 断开实时订阅 → 定时清理。
   * 返回终态事件的 seq（无 run 时为 0）。
   */
  finish(sessionId: string, status: Exclude<RunStatus, 'running'>, terminal: { event: string; data: unknown }): number {
    const state = this.runs.get(sessionId);
    if (!state) return 0;
    const seq = this.publish(sessionId, terminal.event, terminal.data);
    state.status = status;
    state.finishedAt = Date.now();
    state.subscribers.clear();
    if (state.retainTimer) clearTimeout(state.retainTimer);
    const timer = setTimeout(() => {
      if (this.runs.get(sessionId) === state) this.runs.delete(sessionId);
    }, RUN_RETAIN_AFTER_FINISH_MS);
    timer.unref?.();
    state.retainTimer = timer;
    return seq;
  }

  /**
   * 订阅：同步回放 seq > cursor 的事件，未结束则挂入实时订阅。
   * 无 run（已过期或从未运行）返回 null。
   */
  subscribe(sessionId: string, cursor: number, write: RunSubscriber): RunSubscription | null {
    const state = this.runs.get(sessionId);
    if (!state) return null;
    for (const ev of state.buffer) {
      if (ev.seq > cursor) write(ev);
    }
    if (state.status !== 'running') {
      return { finished: true, unsubscribe: () => {} };
    }
    state.subscribers.add(write);
    return {
      finished: false,
      unsubscribe: () => {
        state.subscribers.delete(write);
      },
    };
  }

  /** cursor 之后的必要事件是否已被缓冲丢弃（需要先发 reset 让客户端重建历史） */
  isCursorStale(sessionId: string, cursor: number): boolean {
    const state = this.runs.get(sessionId);
    if (!state || state.buffer.length === 0) return false;
    return cursor < state.buffer[0].seq - 1;
  }

  /** 当前缓冲中最小的 seq（无缓冲时为 0） */
  oldestSeq(sessionId: string): number {
    const state = this.runs.get(sessionId);
    return state && state.buffer.length > 0 ? state.buffer[0].seq : 0;
  }

  /** run 概况（无记录 → null） */
  snapshot(sessionId: string): RunSnapshot | null {
    const state = this.runs.get(sessionId);
    if (!state) return null;
    return {
      runId: state.runId,
      status: state.status,
      startedAt: state.startedAt,
      ...(state.finishedAt !== undefined ? { finishedAt: state.finishedAt } : {}),
    };
  }

  isRunning(sessionId: string): boolean {
    return this.runs.get(sessionId)?.status === 'running';
  }

  /** 丢弃会话的 run 记录（删除会话时调用） */
  drop(sessionId: string): void {
    const state = this.runs.get(sessionId);
    if (state?.retainTimer) clearTimeout(state.retainTimer);
    this.runs.delete(sessionId);
  }

  /** 释放全部保留定时器（服务关停/单测清理） */
  dispose(): void {
    for (const state of this.runs.values()) {
      if (state.retainTimer) clearTimeout(state.retainTimer);
    }
    this.runs.clear();
  }

  /** 双上限裁剪：至少保留最新一条（避免单条超大事件把缓冲清空） */
  private trim(state: RunState): void {
    while (
      state.buffer.length > 1 &&
      (state.buffer.length > RUN_BUFFER_MAX_EVENTS || state.bytes > RUN_BUFFER_MAX_BYTES)
    ) {
      const dropped = state.buffer.shift();
      if (!dropped) break;
      state.bytes -= eventBytes(dropped);
    }
    if (state.bytes < 0) state.bytes = 0;
  }
}
