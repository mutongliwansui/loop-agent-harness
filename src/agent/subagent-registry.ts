/**
 * 后台子任务注册表（需求 20261107-002 D5/D6/D8/D9）
 *
 * 进程内单例，只保存运行期状态（不落盘）：
 * - 供 `delegate({ background: true })` 登记任务、前台查询进度、会话删除时统一中止；
 * - 完成结果由 API 层/CLI 通过回调落盘或打印，注册表本身只做内存记账；
 * - 进程重启后 running 记录全部丢失，由 API 层在加载会话时标注 interrupted（D9）。
 */
import type { SubAgentTrace } from '../types.js';

export type SubAgentTaskStatus = 'running' | 'done' | 'failed' | 'aborted';

/** 后台子任务内存记录 */
export interface SubAgentTaskRecord {
  taskId: string;
  sessionId?: string;
  task: string;
  status: SubAgentTaskStatus;
  startedAt: number;
  finishedAt?: number;
  elapsedMs?: number;
  answer?: string;
  error?: string;
  iterations?: number;
  trace?: SubAgentTrace;
  /** 运行期取消控制器（不参与序列化） */
  controller?: AbortController;
}

class SubAgentRegistry {
  private readonly tasks = new Map<string, SubAgentTaskRecord>();
  /** CLI 后台完成提示队列：在下一次用户输入前 drain 打印（D13，避免和输入行抢光标） */
  private readonly cliNotices: string[] = [];

  create(record: Omit<SubAgentTaskRecord, 'status' | 'startedAt'>): SubAgentTaskRecord {
    const full: SubAgentTaskRecord = { ...record, status: 'running', startedAt: Date.now() };
    this.tasks.set(full.taskId, full);
    return full;
  }

  /** 某个会话当前运行中的后台任务数（并发上限判定） */
  countRunning(sessionId?: string): number {
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.status !== 'running') continue;
      if (sessionId && t.sessionId !== sessionId) continue;
      n++;
    }
    return n;
  }

  get(taskId: string): SubAgentTaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  list(sessionId?: string): SubAgentTaskRecord[] {
    const all = Array.from(this.tasks.values());
    return sessionId ? all.filter((t) => t.sessionId === sessionId) : all;
  }

  /**
   * 运行期进度更新（需求 20261107-009 P2 / task-006 B7）。
   *
   * 只有完成时 `finish` 才写 iterations/elapsedMs，运行中查询只能拿到 0 →
   * 前端 running 卡片只能显示静态「任务执行中…」。过程事件到达时同步刷新这两个字段，
   * 让 `GET /sessions/:id/subagents` 在**运行中**就带回真实轮次与耗时（2s 轮询驱动 UI）。
   */
  touch(taskId: string, patch: { iterations?: number; elapsedMs?: number }): void {
    const rec = this.tasks.get(taskId);
    if (!rec || rec.status !== 'running') return;
    if (patch.iterations !== undefined) rec.iterations = patch.iterations;
    if (patch.elapsedMs !== undefined) rec.elapsedMs = patch.elapsedMs;
  }

  finish(
    taskId: string,
    patch: Partial<Omit<SubAgentTaskRecord, 'taskId' | 'startedAt'>> & {
      status: SubAgentTaskStatus;
    },
  ): SubAgentTaskRecord | undefined {
    const rec = this.tasks.get(taskId);
    if (!rec) return undefined;
    Object.assign(rec, patch, {
      finishedAt: rec.finishedAt ?? Date.now(),
      elapsedMs: patch.elapsedMs ?? Date.now() - rec.startedAt,
    });
    if (rec.iterations === undefined && patch.iterations !== undefined) {
      rec.iterations = patch.iterations;
    }
    // 完成即释放取消控制器引用
    delete rec.controller;
    return rec;
  }

  /** 会话删除/取消时中止该会话下全部后台任务（D11） */
  abortSession(sessionId: string, reason = '会话已取消'): number {
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.status !== 'running' || t.sessionId !== sessionId) continue;
      t.controller?.abort(reason);
      n++;
    }
    return n;
  }

  // ===== CLI 提示队列（D13） =====

  pushCliNotice(text: string): void {
    this.cliNotices.push(text);
  }

  drainCliNotices(): string[] {
    return this.cliNotices.splice(0, this.cliNotices.length);
  }

  /** 单测清理 */
  reset(): void {
    this.tasks.clear();
    this.cliNotices.length = 0;
  }
}

export const subAgentRegistry = new SubAgentRegistry();
