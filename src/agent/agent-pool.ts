// Agent 实例池（Task-20261021-002-05）：同工作空间多会话并发的核心。
//
// 背景：API 模式原为单例 agent（deps.runAgent 闭包捕获），_chatHistory/_workingMemory
// 等实例字段被多会话并发覆盖，靠 entry.inFlight（per-session）+ hasInFlight（per-space）兜底。
// 本池以「每个 run 一份 agent 实例」替代单例假设：
// - 同 sessionId 粘性复用（D4，性能优化非正确性依赖——历史由 API 层显式传入）
// - LRU 容量上限含 busy（D1 默认 4）；只淘汰空闲实例，busy 永不淘汰（D3）
// - 记忆子系统按 workspaceId 共享（D2）：initAgent 钩子注入共享 kit，禁止每实例自建
// - run 抛错的实例不复用（防脏状态），release 时 dispose 重建
// - 容量打满且全 busy 时 acquire 排队等待（先到先得，与现有 run 无时限一致）
//
// 不变量：
// - busy/idle 中同一 sessionId 最多一个实例（同会话串行由 entry.inFlight 保证，
//   并发 acquire 同一 sessionId 视为编程错误，直接抛错）
// - busy.size + idle.size <= capacity
// - reset() 后旧实例一律不再被复用（idle 全部 dispose；busy 实例归还时 dispose）

import type { AgentResult, AgentOptions } from '../types.js';
import { debug } from '../debug.js';
// 顶层静态 import：agent-pool 仅被 api/bootstrap（--serve 分支）引用，
// CLI 路径不加载本模块，因此不影响「CLI 不走池」的约束（api 侧本就静态依赖 react-agent）
import { ReActAgent } from './react-agent.js';

/** 池管理的最小实例面（ReActAgent 结构化子集；测试可注入 fake） */
export interface PooledAgent {
  run(input: string, options?: AgentOptions): Promise<AgentResult>;
  /** 释放实例持有的资源（sqlite 索引句柄等）；淘汰/重置时调用，需幂等 */
  dispose(): void;
}

export interface AgentPoolOptions<T extends PooledAgent = ReActAgent> {
  /** 池容量上限（含 busy 实例），默认 4 */
  capacity?: number;
  /** 实例工厂（默认 new ReActAgent()；测试注入 fake） */
  create?: () => T;
}

interface IdleEntry<T extends PooledAgent> {
  agent: T;
  lastUsed: number;
}

/**
 * Agent 实例池。T 默认 ReActAgent（bootstrap 直接拿到完整实例类型，
 * initAgent 钩子内可调 attachMemory 等实例方法）；测试注入 fake 时用
 * `new AgentPool({ create: () => fake })` 让 T 自动推断。
 */
export class AgentPool<T extends PooledAgent = ReActAgent> {
  private readonly capacity: number;
  private readonly idle = new Map<string, IdleEntry<T>>();
  private readonly busy = new Map<string, T>();
  /** reset() 时仍 busy 的实例：归还时 dispose 而不回池（防御：逻辑上 reset 时无 run） */
  private readonly dead = new Set<string>();
  /** 容量打满且全 busy 时 acquire 的排队队列（先到先得） */
  private readonly waiters: (() => void)[] = [];

  constructor(
    private readonly opts: AgentPoolOptions<T> = {},
    /** 仅对新建实例执行（如 attachMemory 共享记忆 kit） */
    private readonly initAgent: (a: T) => Promise<void> = async () => {},
  ) {
    this.capacity = Math.max(1, opts.capacity ?? 4);
  }

  /** 诊断：idle + busy 实例总数 */
  get size(): number {
    return this.idle.size + this.busy.size;
  }

  /**
   * 租用实例并标记 busy：
   * 1) 同 sessionId 空闲实例粘性复用；2) 有容量或可淘汰空闲实例则新建；
   * 3) 容量打满且全 busy → 排队等待 release，唤醒后重试。
   */
  async acquire(sessionId: string): Promise<T> {
    for (;;) {
      if (this.busy.has(sessionId)) {
        throw new Error(`会话 ${sessionId} 的 agent 实例正在使用中（同会话应串行）`);
      }
      const sticky = this.idle.get(sessionId);
      if (sticky) {
        this.idle.delete(sessionId);
        this.busy.set(sessionId, sticky.agent);
        return sticky.agent;
      }
      if (this.makeRoom()) {
        return await this.createNew(sessionId);
      }
      // 全 busy：排队等 release/reset 唤醒后重试
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /** 用完归还：failed 时 dispose 不回池；否则回空闲池并按容量淘汰最久未用空闲实例 */
  release(sessionId: string, failed = false): void {
    const agent = this.busy.get(sessionId);
    if (!agent) return;
    this.busy.delete(sessionId);
    if (failed || this.dead.delete(sessionId)) {
      agent.dispose();
    } else {
      this.idle.set(sessionId, { agent, lastUsed: Date.now() });
      this.evictIdleIfNeeded();
    }
    this.wakeOne();
  }

  /** withAgent：acquire → fn → finally release（fn 抛错则该实例 dispose 重建） */
  async withAgent<R>(sessionId: string, fn: (a: T) => Promise<R>): Promise<R> {
    const agent = await this.acquire(sessionId);
    let failed = false;
    try {
      return await fn(agent);
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      this.release(sessionId, failed);
    }
  }

  /** 释放本空间池：idle 全部 dispose；busy 实例标记死亡（归还时 dispose）；唤醒等待者 */
  reset(): void {
    for (const { agent } of this.idle.values()) agent.dispose();
    this.idle.clear();
    for (const sessionId of this.busy.keys()) this.dead.add(sessionId);
    for (const wake of this.waiters.splice(0)) wake();
    debug.log(`AgentPool 已重置（容量 ${this.capacity}）`);
  }

  /** 容量未满 → true；满但有空闲实例 → 淘汰最久未用的空闲实例后 true；全 busy → false */
  private makeRoom(): boolean {
    if (this.busy.size + this.idle.size < this.capacity) return true;
    const oldest = this.oldestIdle();
    if (!oldest) return false;
    this.idle.delete(oldest.key);
    oldest.entry.agent.dispose();
    return true;
  }

  /** 归还后超容量：淘汰最久未用空闲实例（刚归还的 lastUsed 最新，不会被选中） */
  private evictIdleIfNeeded(): void {
    while (this.busy.size + this.idle.size > this.capacity) {
      const oldest = this.oldestIdle();
      if (!oldest) break;
      this.idle.delete(oldest.key);
      oldest.entry.agent.dispose();
    }
  }

  private oldestIdle(): { key: string; entry: IdleEntry<T> } | null {
    let oldestKey: string | null = null;
    let oldestUsed = Infinity;
    for (const [key, entry] of this.idle) {
      if (entry.lastUsed < oldestUsed) {
        oldestUsed = entry.lastUsed;
        oldestKey = key;
      }
    }
    return oldestKey === null ? null : { key: oldestKey, entry: this.idle.get(oldestKey)! };
  }

  private async createNew(sessionId: string): Promise<T> {
    const agent = (this.opts.create ?? defaultCreate)() as T;
    this.busy.set(sessionId, agent);
    try {
      await this.initAgent(agent);
    } catch (e) {
      // 初始化失败（如记忆 kit 组装异常）：不占坑、不回池，唤醒等待者
      this.busy.delete(sessionId);
      agent.dispose();
      this.wakeOne();
      throw e;
    }
    return agent;
  }

  private wakeOne(): void {
    this.waiters.shift()?.();
  }
}

function defaultCreate(): PooledAgent {
  return new ReActAgent();
}
