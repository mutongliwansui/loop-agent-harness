// 模型性能测试运行注册表（需求 20261027-003 / 设计方案 §5.3）
//
// POST /models/bench 只负责「建 run + 立即返回 runId」，真正的测量在后台跑；
// 进度与结果经 GET /models/bench/:runId/stream（SSE）推给前端。
//
// 之所以不直接沿用 RunHub：RunHub 是会话 run 的事件缓冲（带 cursor 续传、
// 与 agent 事件强绑定），bench 需要的只是「按 runId 存事件 + 广播 + 一次性终态」，
// 语义更窄。这里独立实现，避免把两种 run 的生命周期搅在一起。

import type { BenchPromptKey, BenchSummary } from '../llm/bench.js';
import type { BenchRunConfig } from '../llm/bench-store.js';

export interface BenchEvent {
  event: string;
  data: unknown;
}

interface Listener {
  onEvent: (e: BenchEvent) => void;
  onEnd: () => void;
}

/** 单个模型的测试结果 */
export interface BenchModelResult {
  alias: string;
  model: string;
  baseUrlHost: string;
  summary: BenchSummary;
}

export type BenchRunStatus = 'running' | 'done' | 'aborted' | 'error';

/** 一次 bench run（可含多个模型，服务端串行，D3） */
export class BenchRun {
  status: BenchRunStatus = 'running';
  readonly controller = new AbortController();
  readonly events: BenchEvent[] = [];
  readonly results: BenchModelResult[] = [];
  readonly startedAt: Date;
  finishedAt: Date | null = null;
  error: string | null = null;
  private listeners = new Set<Listener>();

  constructor(
    readonly runId: string,
    readonly aliases: string[],
    readonly config: BenchRunConfig,
    /** 计划总轮次 = 模型数 × 提示词数 × 轮数 */
    readonly planTotal: number,
  ) {
    this.startedAt = new Date();
  }

  emit(event: string, data: unknown): void {
    const e: BenchEvent = { event, data };
    this.events.push(e);
    for (const l of this.listeners) {
      try {
        l.onEvent(e);
      } catch {
        // 单个订阅者写失败（连接已断）不影响其他订阅者
      }
    }
  }

  /** 订阅：先回放已有事件（断线重连幂等），已在终态则直接收尾 */
  subscribe(listener: Listener): () => void {
    for (const e of this.events) listener.onEvent(e);
    if (this.status !== 'running') {
      listener.onEnd();
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  finish(status: BenchRunStatus, error?: string): void {
    if (this.status !== 'running') return;
    this.status = status;
    this.finishedAt = new Date();
    if (error) this.error = error;
    for (const l of this.listeners) {
      try {
        l.onEnd();
      } catch {
        // 同上：连接已断的订阅者忽略
      }
    }
    this.listeners.clear();
  }

  stop(): void {
    if (this.status === 'running') this.controller.abort();
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  get planPrompts(): BenchPromptKey[] {
    return this.config.prompts;
  }
}

/** run 注册表（每进程一份；结束态保留一段时间供重连回放） */
export class BenchRunHub {
  private runs = new Map<string, BenchRun>();
  private timers = new Set<NodeJS.Timeout>();

  constructor(private readonly retainMs = 10 * 60 * 1000) {}

  add(run: BenchRun): BenchRun {
    this.runs.set(run.runId, run);
    const timer = setTimeout(() => {
      this.runs.delete(run.runId);
      this.timers.delete(timer);
    }, this.retainMs);
    timer.unref?.();
    this.timers.add(timer);
    return run;
  }

  get(runId: string): BenchRun | undefined {
    return this.runs.get(runId);
  }

  /** 进程退出 / server close：中断所有在跑的 run 并清定时器 */
  dispose(): void {
    for (const run of this.runs.values()) run.stop();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

/** 生成 runId：bench_<时间戳>_<随机后缀>（可读 + 不冲突） */
export function newBenchRunId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', 'T');
  const rand = Math.random().toString(36).slice(2, 6);
  return `bench_${ts}_${rand}`;
}
