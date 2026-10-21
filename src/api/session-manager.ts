// 会话缓存与创建串行化（D5）：server 与 handlers 共享的会话状态层
//
// - Map 缓存历史（不含 system）；miss 时从 SessionStore 恢复（重启续聊）
// - createSession 排队执行，规避 store 秒级时间戳 id 的同秒覆盖

import { SessionStore } from '../session/index.js';
import type { ChatMessage } from '../types.js';
import { ApiHttpError } from './errors.js';

/** SessionMeta 的结构子集（避免引入 store 内部类型依赖） */
export interface SessionMetaLike {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** 内存中的会话条目：不含 system 的历史缓存 + 会话级互斥锁 */
export interface SessionEntry {
  history: ChatMessage[];
  inFlight: Promise<void> | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private createChain: Promise<unknown> = Promise.resolve();
  private lastCreateAt = 0;

  constructor(private readonly store: SessionStore) {}

  get(id: string): SessionEntry | undefined {
    return this.sessions.get(id);
  }

  set(id: string, entry: SessionEntry): void {
    this.sessions.set(id, entry);
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  /** 本空间内是否存在任意会话的 in-flight run（task-04：语义收窄为空间内；跨空间互斥已移除） */
  hasInFlight(): boolean {
    for (const entry of this.sessions.values()) {
      if (entry.inFlight) return true;
    }
    return false;
  }

  /** 取会话条目；缓存 miss 时从 SessionStore 恢复历史（不存在 → 404） */
  async ensureEntry(id: string): Promise<SessionEntry> {
    const cached = this.sessions.get(id);
    if (cached) return cached;
    let history: ChatMessage[];
    try {
      const data = await this.store.loadSession(id);
      // 恢复视图：system 由调用方重建 + is_compact!==true 的消息（含摘要消息），不含 system
      history = SessionStore.getRestoreMessages(data).filter((m) => m.role !== 'system');
    } catch {
      throw new ApiHttpError('not_found', `会话不存在: ${id}`);
    }
    const entry: SessionEntry = { history, inFlight: null };
    this.sessions.set(id, entry);
    return entry;
  }

  /**
   * createSession 串行化：store 内部生成秒级时间戳 id（sess_<wsId8>_<ts>，task-04 起含空间段），
   * 同空间同秒两次创建会互相覆盖文件，故排队执行并保证调用间隔 ≥ 1 秒（最多等待 3 次）。
   * task-04：串行链按 runtime 独立（每空间一个 SessionManager），跨空间创建不再互相等待。
   */
  createSessionSafe(firstMessage: string, messages: ChatMessage[]): Promise<SessionMetaLike> {
    const task = this.createChain.then(async () => {
      let waited = 0;
      while (Date.now() - this.lastCreateAt < 1050) {
        if (waited >= 3) {
          throw new ApiHttpError('internal', '会话创建冲突（同秒 id 粒度限制），请稍后重试');
        }
        await delay(1050 - (Date.now() - this.lastCreateAt));
        waited++;
      }
      const meta = await this.store.createSession(firstMessage, messages);
      this.lastCreateAt = Date.now();
      return meta;
    });
    this.createChain = task.catch(() => {}); // 失败不阻塞后续创建
    return task;
  }
}
