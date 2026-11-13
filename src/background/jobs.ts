// 后台任务统一读模型（需求 20261112-006）
//
// 背景：后台命令任务（background-tasks）与后台子 Agent 任务（subagent-registry）
// 是两套独立机制，查询、展示与状态词各走各的，导致「模型只能查命令任务、Dock 只能看
// 子任务」。本模块只做**只读聚合**：统一状态词、会话过滤、排序与上限，不接管两个
// registry 的写入、持久化、通知与停止语义。
import type { SubAgentTrace } from '../types.js';
import { subAgentRegistry, type SubAgentTaskRecord } from '../agent/subagent-registry.js';
import { backgroundTasks, type BackgroundTask } from '../tools/background-tasks.js';

export type JobKind = 'command' | 'subagent';

/** 统一状态词：running=运行中；done=成功结束；failed=失败；stopped=被停止；lost=失联/中断 */
export type JobStatus = 'running' | 'done' | 'failed' | 'stopped' | 'lost';

/** 统一任务摘要（读模型输出） */
export interface JobSummary {
  id: string;
  kind: JobKind;
  sessionId?: string;
  /** 命令任务为命令原文；子任务为任务描述 */
  title: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  elapsedMs?: number;
  /** 子任务已跑轮次（运行中由过程事件刷新） */
  iterations?: number;
  error?: string;
  /** 子任务过程轨迹（运行中过程区同步用；命令任务无） */
  trace?: SubAgentTrace;
  canStop: boolean;
  canReadLogs: boolean;
}

export interface ListJobsOptions {
  /** 会话过滤；未提供时返回全部 */
  sessionId?: string;
  /** 配合 sessionId：是否把 sessionId 为空的无归属任务一起返回（默认 true） */
  includeUnowned?: boolean;
  kind?: JobKind;
  status?: JobStatus;
  /** 默认 50，最大 100 */
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** 命令任务状态映射：保留「失联」语义，不伪造统一生命周期 */
export function commandStatusOf(t: BackgroundTask): JobStatus {
  switch (t.status) {
    case 'running':
      return 'running';
    case 'exited':
      return t.exitCode === 0 ? 'done' : 'failed';
    case 'killed':
      return 'stopped';
    case 'orphaned-running':
    case 'orphaned-exited':
      return 'lost';
    default:
      return 'lost';
  }
}

/** 子任务状态映射 */
export function subAgentStatusOf(t: SubAgentTaskRecord): JobStatus {
  switch (t.status) {
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'aborted':
      return 'stopped';
    default:
      return 'lost';
  }
}

function commandElapsed(t: BackgroundTask, now: number): number {
  const end = t.finishedAt ?? now;
  return Math.max(0, end - t.startedAt);
}

function subAgentElapsed(t: SubAgentTaskRecord, now: number): number {
  if (t.status === 'running') {
    return Math.max(0, now - t.startedAt);
  }
  return Math.max(0, t.elapsedMs ?? (t.finishedAt ?? now) - t.startedAt);
}

export function toCommandJob(t: BackgroundTask, now = Date.now()): JobSummary {
  const status = commandStatusOf(t);
  return {
    id: t.taskId,
    kind: 'command',
    sessionId: t.sessionId,
    title: t.command,
    status,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    elapsedMs: commandElapsed(t, now),
    canStop: status === 'running' || status === 'lost',
    canReadLogs: true,
  };
}

export function toSubAgentJob(t: SubAgentTaskRecord, now = Date.now()): JobSummary {
  return {
    id: t.taskId,
    kind: 'subagent',
    sessionId: t.sessionId,
    title: t.task,
    status: subAgentStatusOf(t),
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    elapsedMs: subAgentElapsed(t, now),
    iterations: t.iterations,
    error: t.error,
    trace: t.trace,
    canStop: false,
    canReadLogs: false,
  };
}

function matchSession(job: JobSummary, sessionId: string, includeUnowned: boolean): boolean {
  if (job.sessionId === sessionId) return true;
  return includeUnowned && !job.sessionId;
}

function compareStartedAt(a: JobSummary, b: JobSummary): number {
  return b.startedAt - a.startedAt;
}

/**
 * 聚合列表：命令任务 + 子任务，统一过滤、倒序与截断。
 * 不修改任何 registry；读取时的 elapsedMs 按当前时间计算。
 */
export function listJobs(opts: ListJobsOptions = {}): JobSummary[] {
  const now = Date.now();
  const includeUnowned = opts.includeUnowned ?? true;
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));

  const jobs: JobSummary[] = [
    ...backgroundTasks.list().map((t) => toCommandJob(t, now)),
    ...subAgentRegistry.list().map((t) => toSubAgentJob(t, now)),
  ];

  return jobs
    .filter((j) => (opts.kind ? j.kind === opts.kind : true))
    .filter((j) => (opts.status ? j.status === opts.status : true))
    .filter((j) =>
      opts.sessionId
        ? matchSession(j, opts.sessionId, includeUnowned)
        : true,
    )
    .sort(compareStartedAt)
    .slice(0, limit);
}

/** 按 ID 查询（两类任务统一入口；未知返回 undefined） */
export function getJob(id: string): JobSummary | undefined {
  const now = Date.now();
  const command = backgroundTasks.get(id);
  if (command) return toCommandJob(command, now);
  const sub = subAgentRegistry.get(id);
  if (sub) return toSubAgentJob(sub, now);
  return undefined;
}
