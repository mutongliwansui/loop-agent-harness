// 记忆晋升（Dreaming）调度器（Task-20261026-002）
//
// 背景：CLI 在 readline close 时跑 Dreaming，但 --serve 是常驻进程、「退出时晋升」对它不成立，
// 结果 WebUI 长期使用下 L3（SOUL/USER/MEMORY）不随对话演进。本模块补齐 serve 侧的三条触发路径：
//   1) 定时轮（默认 24h，启动后 5 分钟首轮）—— 主力，跨天后才有新内容
//   2) 进程关停兜底（SIGINT/SIGTERM/SIGBREAK）—— 补最后一轮
//   3) 手动端点 POST /memory/dream —— 与上两者共用同一把进程内锁
//
// 设计约束（详见 docs/tasks/task-20261026-002-记忆晋升自动化.md）：
// - D7 进程内单飞锁（Map<root, Promise>）：撞车即跳过不排队；跨进程不做文件锁
// - D8 定时触发遇同空间 in-flight run 让位（不抢对话的配额）；关停兜底不受此限
// - D3 读取窗口按「距上次处理的天数 +1」放大（上限 maxDaysBack），修补停机多日漏数
// - D12 定时器与超时定时器一律 unref，避免把进程/单测挂住
// - 零新依赖：只用 node: 内置

import type { AgentConfig } from '../config/schema.js';
import { debug } from '../debug.js';
import type { WorkspaceRegistry } from './workspace-runtime.js';

/** 触发来源 */
export type DreamTriggerReason = 'schedule' | 'shutdown' | 'manual';

/** 提前结束原因（未真正跑 Dreaming） */
export type DreamSkipReason = 'disabled' | 'busy' | 'already-running' | 'no-runtime';

/** 单次晋升结果（对外可观测，同时用于日志与状态展示） */
export interface DreamRunSummary {
  root: string;
  /** workspaceId（日志里取前 8 位） */
  workspaceId: string;
  reason: DreamTriggerReason;
  ok: boolean;
  /** 实际读取窗口（D3 放大后） */
  daysBack: number;
  promoted: number;
  skipped: number;
  errors: number;
  /** 有值表示未真正执行（不做 LLM 调用） */
  skippedBecause?: DreamSkipReason;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

/** 单个工作空间的晋升状态（GET /memory/status 的 dreaming 字段） */
export interface DreamSchedulerStatus {
  /** 记忆与 Dreaming 是否均启用 */
  enabled: boolean;
  /** 定时轮是否启用（memory.dreaming.schedule.enabled） */
  scheduleEnabled: boolean;
  intervalHours: number;
  startupDelayMin: number;
  /** 该空间当前是否有晋升在跑 */
  running: boolean;
  lastRunAt?: string;
  lastSummary?: {
    reason: DreamTriggerReason;
    promoted: number;
    skipped: number;
    errors: number;
    ok: boolean;
  };
  lastProcessedDay?: string;
  /** 下一次定时轮的预计时间（ISO；未注册定时器时为空） */
  nextRunAt?: string;
}

/** 可注入的定时器句柄（默认实现基于 setTimeout 并 unref） */
export interface DreamTimer {
  cancel(): void;
}

export interface DreamSchedulerDeps {
  registry: WorkspaceRegistry;
  /** 进程级配置读取（定时节奏、关停预算、onExit；每空间的记忆配置另由 runtime 的 configLoader 读） */
  getConfig: () => AgentConfig;
  log: (msg: string) => void;
  /** 时钟注入（单测用；默认 Date.now） */
  now?: () => number;
  /** 定时器工厂注入（单测用；默认 setTimeout + unref） */
  createTimer?: (fn: () => void, ms: number) => DreamTimer;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** 默认定时器：一次性 setTimeout，句柄 unref（D12） */
function defaultTimer(fn: () => void, ms: number): DreamTimer {
  const t = setTimeout(fn, ms);
  // unref 后该定时器不再是「唯一待办」时允许进程自然退出（避免调度器把进程挂住）
  if (typeof t.unref === 'function') t.unref();
  return { cancel: () => clearTimeout(t) };
}

/** 取正整数配置，非法时回落默认并记一条日志 */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 计算本次实际读取窗口（D3）。
 *
 * 现状问题：readRecentDays(N) 从今天往前逐日探测 N 天，而增量只处理 < 今天 的天。
 * 若进程停机超过 daysBack 天，中间那些天永远读不到、永远晋升不了。
 * 因此按「今天 − lastProcessedDay + 1」放大，并以 daysBack 为下限、maxDaysBack 为上限。
 */
export function computeEffectiveDaysBack(
  lastProcessedDay: string,
  nowMs: number,
  cfg: { daysBack?: number; maxDaysBack?: number },
): number {
  const base = positive(cfg.daysBack, 3);
  const max = Math.max(positive(cfg.maxDaysBack, 30), base);
  if (!lastProcessedDay) return base;
  const last = Date.parse(`${lastProcessedDay}T00:00:00Z`);
  if (!Number.isFinite(last)) return base;
  // 与 DreamingPipeline 的 day 口径一致：new Date().toISOString().split('T')[0]（UTC 日期）
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const diffDays = Math.round((today - last) / DAY_MS);
  if (diffDays <= 0) return base; // 时钟回拨 / 未来日期：不做放大
  return Math.min(Math.max(diffDays + 1, base), max);
}

/** 错误信息提取 */
function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class DreamScheduler {
  private readonly registry: WorkspaceRegistry;
  private readonly getConfig: () => AgentConfig;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly createTimer: (fn: () => void, ms: number) => DreamTimer;

  /** D7 单飞锁：每空间一个在跑任务 */
  private readonly inflight = new Map<string, Promise<DreamRunSummary>>();
  /** 最近一次执行记录（内存态；权威值另存 .dreaming-state.json） */
  private readonly records = new Map<
    string,
    { lastRunAt?: string; lastSummary?: DreamSchedulerStatus['lastSummary'] }
  >();
  /** 当前挂着的定时器（同一时刻至多一个） */
  private timer: DreamTimer | null = null;
  /** 下一次定时轮时间戳 */
  private nextRunAt?: number;
  /** 已停止（关停后不再注册定时轮） */
  private stopped = false;
  /** 定时轮进行中（防重入） */
  private ticking = false;

  constructor(deps: DreamSchedulerDeps) {
    this.registry = deps.registry;
    this.getConfig = deps.getConfig;
    this.log = deps.log;
    this.now = deps.now ?? (() => Date.now());
    this.createTimer = deps.createTimer ?? defaultTimer;
  }

  /** 注册定时轮（schedule.enabled=false 时什么也不做；关停兜底由 onExit 独立控制） */
  start(): void {
    this.stopped = false;
    const schedule = this.getConfig().memory.dreaming.schedule;
    if (schedule?.enabled === false) {
      debug.log('[dream] schedule.enabled=false，不注册定时轮');
      return;
    }
    const delay = positive(schedule?.startupDelayMin, 5) * MINUTE_MS;
    debug.log(`[dream] 定时轮已注册：首轮 ${Math.round(delay / MINUTE_MS)} 分钟后，间隔 ${positive(schedule?.intervalHours, 24)}h`);
    this.scheduleNext(delay);
  }

  /** 停掉当前定时器并拒绝后续定时轮（幂等） */
  stop(): void {
    this.stopped = true;
    this.nextRunAt = undefined;
    if (this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
  }

  /** 释放（server.close 调用，与 stop 等价，语义化命名） */
  dispose(): void {
    this.stop();
  }

  /**
   * 定时轮：遍历全部已装载 runtime 逐个尝试（D8：有 in-flight run 的空间本轮让位）。
   * 返回每个空间的摘要（含跳过），便于日志与单测断言。
   */
  async tick(): Promise<DreamRunSummary[]> {
    if (this.stopped) return [];
    if (this.ticking) {
      debug.log('[dream] 上一轮定时任务仍在执行，本轮跳过');
      return [];
    }
    const mem = this.getConfig().memory;
    if (!mem.enabled || mem.dreaming.enabled === false) {
      debug.log('[dream] memory/dreaming 未启用，定时轮跳过');
      return [];
    }
    this.ticking = true;
    const out: DreamRunSummary[] = [];
    try {
      for (const rt of this.registry.list()) {
        out.push(await this.runFor(rt.root, 'schedule'));
      }
    } finally {
      this.ticking = false;
    }
    return out;
  }

  /**
   * 单空间单飞执行（D7）。
   * 撞车、配置关闭、无 runtime、同空间有对话在跑（仅 schedule）→ 返回 skippedBecause 的摘要，不做 LLM 调用。
   * 内部异常一律收敛为 ok=false 的摘要，绝不向调用方抛出（保证关停链路不中断）。
   */
  async runFor(root: string, reason: DreamTriggerReason): Promise<DreamRunSummary> {
    const startedMs = this.now();
    const startedAt = new Date(startedMs).toISOString();
    const rt = this.registry.peek(root);
    if (!rt) return this.skipSummary(root, '', reason, 'no-runtime', startedAt, startedMs);

    const mem = rt.configLoader.load().config.memory;
    if (!mem.enabled || mem.dreaming.enabled === false) {
      return this.skipSummary(root, rt.id, reason, 'disabled', startedAt, startedMs);
    }
    if (this.inflight.has(root)) {
      return this.skipSummary(root, rt.id, reason, 'already-running', startedAt, startedMs);
    }
    // D8：定时轮不与对话抢配额；关停兜底此时已无新对话，不设此限
    if (reason === 'schedule' && rt.sessions.hasInFlight()) {
      return this.skipSummary(root, rt.id, reason, 'busy', startedAt, startedMs);
    }

    const task = (async (): Promise<DreamRunSummary> => {
      let daysBack = positive(mem.dreaming.daysBack, 3);
      try {
        const kit = await rt.getMemoryKit();
        const state = await kit.dream.getState();
        daysBack = computeEffectiveDaysBack(state.lastProcessedDay, this.now(), mem.dreaming);
        const result = await kit.dream.run(
          daysBack,
          (m) => debug.log(`[dream][${rt.id.slice(0, 8)}] ${m}`),
          {
            dedupeEnabled: mem.curated.dedupe.enabled,
            batchByDay: mem.dreaming.batchByDay,
            incremental: mem.dreaming.incremental,
          },
        );
        const ok = result.errors.length === 0;
        await kit.dream.recordRun({
          reason,
          promoted: result.promoted.length,
          skipped: result.skipped.length,
          errors: result.errors.length,
          ok,
        });
        return this.finishSummary(root, rt.id, reason, daysBack, {
          ok,
          promoted: result.promoted.length,
          skipped: result.skipped.length,
          errors: result.errors.length,
          startedAt,
          startedMs,
        });
      } catch (e) {
        this.log(`[api] dream ${reason} ws=${rt.id.slice(0, 8)} 异常: ${msgOf(e)}`);
        return this.finishSummary(root, rt.id, reason, daysBack, {
          ok: false,
          promoted: 0,
          skipped: 0,
          errors: 1,
          startedAt,
          startedMs,
        });
      }
    })();

    // 先落锁再 await（task 体内已让出执行权，此处仍是同一个同步片，不存在竞态窗口）
    this.inflight.set(root, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(root);
    }
  }

  /**
   * 关停兜底（D4/D5）：立刻拒绝新定时轮 → 串行处理全部已装载 runtime → 受总预算约束。
   * 超时后不再等待（LLM 调用无法回滚，本轮属 best-effort），打印警告后由调用方继续关停。
   */
  async runAllForShutdown(budgetMs: number): Promise<DreamRunSummary[]> {
    this.stop(); // D5：先停调度器
    const mem = this.getConfig().memory;
    if (!mem.enabled || mem.dreaming.enabled === false) {
      debug.log('[dream] 关停兜底跳过：记忆或 Dreaming 未启用');
      return [];
    }
    if (mem.dreaming.onExit === false) {
      this.log('[api] dream shutdown 跳过（memory.dreaming.onExit=false）');
      return [];
    }

    const out: DreamRunSummary[] = [];
    const work = (async (): Promise<void> => {
      for (const rt of this.registry.list()) {
        out.push(await this.runFor(rt.root, 'shutdown'));
      }
    })();

    const budget = positive(budgetMs, 30_000);
    // 用容器持有句柄：executor 内的赋值 TS 控制流分析看不到，直接 let 会被窄化为 null
    const handle: { timer: DreamTimer | null } = { timer: null };
    const timeout = new Promise<'timeout'>((resolve) => {
      handle.timer = this.createTimer(() => resolve('timeout'), budget);
    });
    const winner = await Promise.race([work.then(() => 'done' as const), timeout]);
    handle.timer?.cancel();

    if (winner === 'timeout') {
      this.log(`[api] dream shutdown 超出预算 ${budget}ms，停止等待（未完成的空间本轮放弃）`);
    }
    return out;
  }

  /** 该空间当前是否有晋升在跑（供 handler 同步判定，避免 HTTP 请求阻塞到晋升结束） */
  isRunning(root: string): boolean {
    return this.inflight.has(root);
  }

  /** 查询某空间的晋升状态（未装载的 runtime 返回 null） */
  async statusFor(root: string): Promise<DreamSchedulerStatus | null> {
    const rt = this.registry.peek(root);
    if (!rt) return null;
    const mem = rt.configLoader.load().config.memory;
    const schedule = mem.dreaming.schedule;
    const rec = this.records.get(root);
    const status: DreamSchedulerStatus = {
      enabled: mem.enabled && mem.dreaming.enabled !== false,
      scheduleEnabled: schedule?.enabled !== false,
      intervalHours: positive(schedule?.intervalHours, 24),
      startupDelayMin: positive(schedule?.startupDelayMin, 5),
      running: this.inflight.has(root),
      lastRunAt: rec?.lastRunAt,
      lastSummary: rec?.lastSummary,
      nextRunAt: this.nextRunAt ? new Date(this.nextRunAt).toISOString() : undefined,
    };
    if (!status.enabled) return status;
    // 状态文件是权威值：内存态（本次进程）优先，缺失时回落磁盘（上次进程留下的记录）
    try {
      const kit = await rt.getMemoryKit();
      const st = await kit.dream.getState();
      if (st.lastProcessedDay) status.lastProcessedDay = st.lastProcessedDay;
      if (!status.lastRunAt && st.lastRunAt) status.lastRunAt = st.lastRunAt;
      if (!status.lastSummary && st.lastSummary) status.lastSummary = st.lastSummary;
    } catch (e) {
      debug.log(`[dream] 读取增量状态失败: ${msgOf(e)}`);
    }
    return status;
  }

  // ---- 内部 ----

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.nextRunAt = this.now() + delayMs;
    this.timer = this.createTimer(() => {
      this.timer = null;
      void this.onTimer();
    }, delayMs);
  }

  private async onTimer(): Promise<void> {
    try {
      await this.tick();
    } catch (e) {
      this.log(`[api] dream 定时轮异常: ${msgOf(e)}`);
    }
    if (this.stopped) return;
    const schedule = this.getConfig().memory.dreaming.schedule;
    if (schedule?.enabled === false) return;
    this.scheduleNext(positive(schedule?.intervalHours, 24) * HOUR_MS);
  }

  private finishSummary(
    root: string,
    workspaceId: string,
    reason: DreamTriggerReason,
    daysBack: number,
    p: { ok: boolean; promoted: number; skipped: number; errors: number; startedAt: string; startedMs: number },
  ): DreamRunSummary {
    const finishedMs = this.now();
    const summary: DreamRunSummary = {
      root,
      workspaceId,
      reason,
      ok: p.ok,
      daysBack,
      promoted: p.promoted,
      skipped: p.skipped,
      errors: p.errors,
      startedAt: p.startedAt,
      finishedAt: new Date(finishedMs).toISOString(),
      durationMs: Math.max(0, finishedMs - p.startedMs),
    };
    this.records.set(root, {
      lastRunAt: summary.finishedAt,
      lastSummary: {
        reason,
        promoted: p.promoted,
        skipped: p.skipped,
        errors: p.errors,
        ok: p.ok,
      },
    });
    this.logSummary(summary);
    return summary;
  }

  private skipSummary(
    root: string,
    workspaceId: string,
    reason: DreamTriggerReason,
    skippedBecause: DreamSkipReason,
    startedAt: string,
    startedMs: number,
  ): DreamRunSummary {
    const finishedMs = this.now();
    const summary: DreamRunSummary = {
      root,
      workspaceId,
      reason,
      ok: false,
      daysBack: 0,
      promoted: 0,
      skipped: 0,
      errors: 0,
      skippedBecause,
      startedAt,
      finishedAt: new Date(finishedMs).toISOString(),
      durationMs: Math.max(0, finishedMs - startedMs),
    };
    this.logSummary(summary);
    return summary;
  }

  /** 统一日志格式，便于 grep：`[api] dream schedule ws=xxxxxxxx 窗口=4d 晋升=3 跳过=1 错误=0 用时=8.2s` */
  private logSummary(s: DreamRunSummary): void {
    const ws = s.workspaceId ? s.workspaceId.slice(0, 8) : '-';
    if (s.skippedBecause) {
      this.log(`[api] dream ${s.reason} ws=${ws} 跳过（${s.skippedBecause}）`);
      return;
    }
    this.log(
      `[api] dream ${s.reason} ws=${ws} 窗口=${s.daysBack}d 晋升=${s.promoted} 跳过=${s.skipped} 错误=${s.errors} 用时=${(s.durationMs / 1000).toFixed(1)}s`,
    );
  }
}
