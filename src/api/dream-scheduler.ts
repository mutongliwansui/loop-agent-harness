// 记忆晋升（Dreaming）调度器（Task-20261026-002 / 20261026-003）
//
// 背景：CLI 在 readline close 时跑 Dreaming，但 --serve 是常驻进程、「退出时晋升」对它不成立，
// 结果 WebUI 长期使用下 L3（SOUL/USER/MEMORY）不随对话演进。本模块补齐 serve 侧的三条触发路径：
//   1) 定时轮 —— 主力，跨天后才有新内容
//      · Task-20261026-002：固定间隔（startupDelayMin + intervalHours）
//      · Task-20261026-003：crontab 表达式（默认每天 03:00），保存即热生效免重启
//   2) 进程关停兜底（SIGINT/SIGTERM/SIGBREAK）—— 补最后一轮
//   3) 手动端点 POST /memory/dream —— 与上两者共用同一把进程内锁
//
// 设计约束（详见 docs/tasks/2026-10-26/task-20261026-002-记忆晋升自动化.md 与 task-20261026-003-01）：
// - D7 进程内单飞锁（Map<root, Promise>）：撞车即跳过不排队；跨进程不做文件锁
// - D8 定时触发遇同空间 in-flight run 让位（不抢对话的配额）；关停兜底不受此限
// - D3 读取窗口按「距上次处理的天数 +1」放大（上限 maxDaysBack），修补停机多日漏数
// - D12 定时器与超时定时器一律 unref，避免把进程/单测挂住
// - 零新依赖：只用 node: 内置（cron 引擎亦自写，见 ./cron.ts）
//
// Task-20261026-003 新增的四个运行期机制（方案 D4/D5/D7/D10）：
// - 分片等待：单次等待上限 MAX_WAIT_MS(6h)——setTimeout 最大 2^31-1ms≈24.8 天，超限会立即触发
// - 整分对齐 + 墙钟分钟键去重：DST 回拨时同一墙钟分钟出现两次，用 localMinuteKey 识别并跳过
// - 错过补跑宽限 misfireGraceMin：迟于触发点但在宽限内→补跑并标 catchup；超出→记「错过」不跑
// - 每轮重读配置兜底：cron 被别处改坏→回落间隔模式并暴露 cronError，不永久失灵

import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import type { AgentConfig } from '../config/schema.js';
import { debug } from '../debug.js';
import { DreamRunLog, truncateError } from '../memory/dream-runs.js';
import { workspaceId as toWorkspaceId } from '../session/store.js';
import { listMemoryWorkspaces } from './memory-workspaces.js';
import { loopAgentHome } from '../user-home.js';
import type { DreamRunRecord, DreamRunReason, DreamRunSkipReason } from '../memory/dream-runs.js';
import {
  describeCron,
  localMinuteKey,
  nextFireTime,
  nextFireTimes,
  neverFires,
  parseCron,
  timezoneOffsetMin,
} from './cron.js';
import type { CronFields } from './cron.js';
import type { WorkspaceRegistry } from './workspace-runtime.js';

/** 触发来源（与历史记录共用一套字面量，避免 api↔memory 循环依赖） */
export type DreamTriggerReason = DreamRunReason;

/** 提前结束原因（未真正跑 Dreaming） */
export type DreamSkipReason = DreamRunSkipReason;

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
  /** Task-20261026-003 D5：本次是否为「错过触发点后补跑」 */
  catchup?: boolean;
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
  /** @deprecated Task-20261026-003：改用 cron；仅 `intervalMode==='interval'` 时有意义 */
  intervalHours: number;
  /** @deprecated Task-20261026-003：同上 */
  startupDelayMin: number;
  /** Task-20261026-003：当前 cron 表达式（空串 = 未启用 cron） */
  cron: string;
  /** Task-20261026-003：cron 是否可解析（空串视为 true，表示「未使用」） */
  cronValid: boolean;
  /** Task-20261026-003：cron 解析失败原因（cronValid=false 时有值） */
  cronError?: string;
  /** Task-20261026-003：cron 中文可读描述（如「每天 03:00」） */
  describe?: string;
  /** Task-20261026-003：服务器本地时区偏置（分钟，东八区为 480） */
  timezoneOffsetMin: number;
  /** Task-20261026-003：错过补跑宽限（分钟） */
  misfireGraceMin: number;
  /** Task-20261026-003：当前实际调度模式 */
  intervalMode: 'cron' | 'interval';
  /** Task-20261026-003：未来若干次触发时刻（ISO，按当前 cron 实时计算） */
  nextRunTimes: string[];
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
  /** 进程级配置读取（定时节奏、关停预算、onExit、记忆配置；需求 20261112-008：记忆配置也一律读全局） */
  getConfig: () => AgentConfig;
  log: (msg: string) => void;
  /** 时钟注入（单测用；默认 Date.now） */
  now?: () => number;
  /** 定时器工厂注入（单测用；默认 setTimeout + unref） */
  createTimer?: (fn: () => void, ms: number) => DreamTimer;
  /**
   * 全空间参与（需求 20261027-004 D4）：定时轮/关停兜底遍历改为
   * 「磁盘枚举候选空间（sessions ∪ memory 目录）→ 逐空间磁盘预判 → 需要跑才懒装载」。
   * 缺省 false（遍历 registry.list()，与原行为一致）——bootstrap 显式开启；
   * 既有单测用 fake registry（仅 peek/list）+ 临时 userDir 场景不受影响。
   */
  enumerateAllSpaces?: boolean;
  /** 记忆/会话索引根目录（枚举用；缺省 ~/.loop-agent；单测注入临时目录） */
  userDir?: string;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** 单次定时器等待上限（D4）：setTimeout 超过 2^31-1ms≈24.8 天会立即触发 */
const MAX_WAIT_MS = 6 * HOUR_MS;
/** 历史文件名（与 .dreaming-state.json 同目录、职责分离，见 memory/dream-runs.ts 头注） */
const RUNS_FILE = '.dreaming-runs.json';
/** 历史条数默认值（与 types.ts 默认值一致） */
const DEFAULT_HISTORY_LIMIT = 20;

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

/** 取非负整数配置（0 合法，如 misfireGraceMin=0 / historyLimit=0） */
function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** 历史条数归一化（默认 20；上限 200 防止单文件无限膨胀） */
function normalizeHistoryLimit(value: number | undefined): number {
  return Math.min(Math.floor(nonNegative(value, DEFAULT_HISTORY_LIMIT)), 200);
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
  /** D4：全空间参与开关（bootstrap 显式开启；既有单测缺省 false 行为不变） */
  private readonly enumerateAllSpaces: boolean;
  /** D4：枚举用用户根（缺省 ~/.loop-agent） */
  private readonly userDir: string;

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
  /** Task-20261026-003：当前调度模式 */
  private mode: 'cron' | 'interval' = 'interval';
  /** Task-20261026-003：cron 解析结果缓存（mode==='cron' 时有值） */
  private fields?: CronFields;
  /** Task-20261026-003：cron 解析失败原因（回落间隔模式时暴露给 status） */
  private cronError?: string;
  /** Task-20261026-003 D4：最近一次触发过的本地墙钟分钟键（DST 回拨去重） */
  private lastFireKey?: string;

  constructor(deps: DreamSchedulerDeps) {
    this.registry = deps.registry;
    this.getConfig = deps.getConfig;
    this.log = deps.log;
    this.now = deps.now ?? (() => Date.now());
    this.createTimer = deps.createTimer ?? defaultTimer;
    this.enumerateAllSpaces = deps.enumerateAllSpaces === true;
    this.userDir = deps.userDir ?? loopAgentHome();
  }

  /** 注册定时轮（schedule.enabled=false 时什么也不做；关停兜底由 onExit 独立控制） */
  start(): void {
    this.stopped = false;
    this.applySchedule(true);
  }

  /**
   * Task-20261026-003 D10：保存 cron 后热重排（PUT /memory/dream/schedule 成功后调用）。
   * 取消现定时器 → 重读配置 → 按新 cron 排下一次；`enabled:false` 时只清定时器并置空 nextRunAt。
   * 正在跑的定时轮不受影响（单飞锁保证）。
   */
  reschedule(): void {
    if (this.stopped) return;
    this.applySchedule(false);
  }

  /** 停掉当前定时器并拒绝后续定时轮（幂等） */
  stop(): void {
    this.stopped = true;
    this.nextRunAt = undefined;
    this.clearTimer();
  }

  /** 释放（server.close 调用，与 stop 等价，语义化命名） */
  dispose(): void {
    this.stop();
  }

  /**
   * 全空间手动触发（需求 20261113-001 D4）：逐空间 runFor(reason)，不要求 ws。
   *
   * 与 `tick()` 的差别只有一处——**不做 `busy` 跳过**：
   * `tick()` 的 `reason==='schedule'` 会让「该空间有对话在跑」的空间本轮让位，
   * 那是定时轮的配额礼貌；而用户点「立即梳理」是显式意图，不该被对话挡住。
   * 单飞（同一空间重复触发）仍由 `runFor` 内的 `inflight` 兜底，且这里再叠一层
   * `ticking` 防重入，避免连点两次起两轮全空间扫描。
   */
  async runAll(reason: DreamTriggerReason = 'manual'): Promise<DreamRunSummary[]> {
    if (this.ticking) {
      debug.log('[dream] 上一轮全空间任务仍在执行，本次跳过');
      return [];
    }
    this.ticking = true;
    const out: DreamRunSummary[] = [];
    try {
      for (const root of await this.enumerateCandidateRoots()) {
        // 预判口径与定时轮一致：空转空间零 LLM（磁盘小文件粗筛）
        if (this.enumerateAllSpaces && !(await this.shouldAttempt(root))) {
          out.push(
            this.skipSummary(root, toWorkspaceId(root), reason, 'no-new-content', new Date(this.now()).toISOString(), this.now()),
          );
          continue;
        }
        out.push(await this.runFor(root, reason));
      }
    } finally {
      this.ticking = false;
    }
    return out;
  }

  /** 全空间是否存在在跑的晋升（供 handler 同步判定，避免阻塞到晋升结束） */
  async isAnyRunning(): Promise<boolean> {
    const roots = await this.enumerateCandidateRoots();
    return roots.some((root) => this.inflight.has(root));
  }

  /**
   * 定时轮：遍历全部已装载 runtime 逐个尝试（D8：有 in-flight run 的空间本轮让位）。
   * 返回每个空间的摘要（含跳过），便于日志与单测断言。
   *
   * @param opts.catchup Task-20261026-003 D5：本次是否为错过触发点后的补跑
   */
  async tick(opts?: { catchup?: boolean }): Promise<DreamRunSummary[]> {
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
      // D4：全空间参与——磁盘枚举 + 预判，候选不再局限于已装载 runtime
      for (const root of await this.enumerateCandidateRoots()) {
        // 预判（磁盘小文件粗筛，空转零 LLM 零 runtime）；放行后 runFor 内真实增量判定兜底
        if (this.enumerateAllSpaces && !(await this.shouldAttempt(root))) {
          out.push(
            this.skipSummary(root, toWorkspaceId(root), 'schedule', 'no-new-content', new Date(this.now()).toISOString(), this.now()),
          );
          continue;
        }
        out.push(await this.runFor(root, 'schedule', opts));
      }
    } finally {
      this.ticking = false;
    }
    return out;
  }

  /**
   * D4 第一步：磁盘枚举候选空间根（enumerateAllSpaces=false 时回落 registry.list()）。
   * 复用 listMemoryWorkspaces（sessions meta ∪ memory 目录；孤儿空间 path='' 跳过），
   * 枚举失败按空集（与定时轮「单侧失败不 500」同哲学）。
   */
  private async enumerateCandidateRoots(): Promise<string[]> {
    if (!this.enumerateAllSpaces) {
      return this.registry.list().map((rt) => rt.root);
    }
    try {
      const list = await listMemoryWorkspaces({
        sessionsDir: join(this.userDir, 'sessions'),
        memoryDir: join(this.userDir, 'memory'),
      });
      return list.map((w) => w.path).filter((p) => p.length > 0);
    } catch (e) {
      debug.log(`[dream] 空间枚举失败（按空集处理）: ${msgOf(e)}`);
      return [];
    }
  }

  /**
   * D4 第二步：逐空间磁盘预判（空转空间每 tick 只读 2 个小文件，零 LLM 零 runtime）。
   * - 无状态文件 → true（首次参与，交给真实增量判定兜底）
   * - lastProcessedDay 落后于昨天（UTC）→ true（有未处理天）
   * - lastRunAt 距今超过调度周期（intervalHours）→ true（周期兜底，防 lastProcessedDay 口径漂移）
   * - 其余 → false（no-new-content）
   * 读不到/解析失败一律 true（宁多跑一次粗筛后的空轮，不漏真增量）。
   */
  private async shouldAttempt(root: string): Promise<boolean> {
    const wsId = toWorkspaceId(root);
    const stateFile = join(this.userDir, 'memory', wsId, '.dreaming-state.json');
    let raw: string;
    try {
      raw = await readFile(stateFile, 'utf-8');
    } catch {
      return true; // 无状态文件：首次/新空间，放行
    }
    try {
      const state = JSON.parse(raw) as { lastProcessedDay?: string; lastRunAt?: string };
      const nowMs = this.now();
      const yesterdayUtc = new Date(nowMs - DAY_MS).toISOString().slice(0, 10);
      if (state.lastProcessedDay && state.lastProcessedDay < yesterdayUtc) return true;
      const intervalHours = positive(this.getConfig().memory.dreaming.schedule?.intervalHours, 24);
      if (state.lastRunAt) {
        const last = Date.parse(state.lastRunAt);
        if (!Number.isFinite(last) || nowMs - last > intervalHours * HOUR_MS) return true;
      } else {
        return true; // 从未记录运行时间：放行
      }
      return false;
    } catch {
      return true; // 状态文件损坏：放行，真实增量判定兜底
    }
  }

  /**
   * 单空间单飞执行（D7）。
   * 撞车、配置关闭、无 runtime、同空间有对话在跑（仅 schedule）→ 返回 skippedBecause 的摘要，不做 LLM 调用。
   * 内部异常一律收敛为 ok=false 的摘要，绝不向调用方抛出（保证关停链路不中断）。
   */
  async runFor(
    root: string,
    reason: DreamTriggerReason,
    opts?: { catchup?: boolean },
  ): Promise<DreamRunSummary> {
    const startedMs = this.now();
    const startedAt = new Date(startedMs).toISOString();
    const catchup = opts?.catchup === true;
    // D4：懒装载——未装载空间经 getCanonical 现建 runtime（目录失效收敛为摘要不抛错）
    let rt = this.registry.peek(root);
    if (!rt && this.enumerateAllSpaces) {
      try {
        rt = await this.registry.getCanonical(root);
      } catch (e) {
        return this.skipSummary(root, '', reason, 'no-runtime', startedAt, startedMs, catchup, msgOf(e));
      }
    }
    if (!rt) return this.skipSummary(root, '', reason, 'no-runtime', startedAt, startedMs, catchup);

    const mem = this.getConfig().memory;
    if (!mem.enabled || mem.dreaming.enabled === false) {
      return this.skipSummary(root, rt.id, reason, 'disabled', startedAt, startedMs, catchup);
    }
    if (this.inflight.has(root)) {
      return this.skipSummary(root, rt.id, reason, 'already-running', startedAt, startedMs, catchup);
    }
    // D8：定时轮不与对话抢配额；关停兜底此时已无新对话，不设此限
    if (reason === 'schedule' && rt.sessions.hasInFlight()) {
      return this.skipSummary(root, rt.id, reason, 'busy', startedAt, startedMs, catchup);
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
          catchup,
        });
      } catch (e) {
        const message = msgOf(e);
        this.log(`[api] dream ${reason} ws=${rt.id.slice(0, 8)} 异常: ${message}`);
        return this.finishSummary(root, rt.id, reason, daysBack, {
          ok: false,
          promoted: 0,
          skipped: 0,
          errors: 1,
          startedAt,
          startedMs,
          catchup,
          errorMessage: message,
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
      // D4：关停兜底同样全空间参与（enumerateAllSpaces=false 时与原行为一致）
      for (const root of await this.enumerateCandidateRoots()) {
        out.push(await this.runFor(root, 'shutdown'));
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
    const mem = this.getConfig().memory;
    const schedule = mem.dreaming.schedule;
    const rec = this.records.get(root);
    const nowMs = this.now();
    const cron = (schedule?.cron ?? '').trim();
    const parsed = cron ? parseCron(cron) : null;
    const fields = parsed?.ok ? parsed.fields : undefined;
    const status: DreamSchedulerStatus = {
      enabled: mem.enabled && mem.dreaming.enabled !== false,
      scheduleEnabled: schedule?.enabled !== false,
      // deprecated 一版（D14）：cron 生效时前端不再消费
      intervalHours: positive(schedule?.intervalHours, 24),
      startupDelayMin: positive(schedule?.startupDelayMin, 5),
      cron,
      // 空 cron 表示「未使用 cron」，不算非法
      cronValid: parsed === null ? true : parsed.ok,
      cronError: parsed && !parsed.ok ? parsed.error : this.cronError,
      describe: fields ? describeCron(fields) : undefined,
      timezoneOffsetMin: timezoneOffsetMin(nowMs),
      misfireGraceMin: nonNegative(schedule?.misfireGraceMin, 60),
      intervalMode: this.mode,
      nextRunTimes: fields ? nextFireTimes(fields, nowMs, 3).map((t) => new Date(t).toISOString()) : [],
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
  /**
   * 全空间聚合的晋升状态（需求 20261113-001 D5）。
   *
   * 为什么需要它：`statusFor(root)` 的 root 只影响 `running` / `lastRunAt` /
   * `lastProcessedDay` / `lastSummary` 四项，**其余全是全局配置推导**（cron、nextRunTimes、
   * intervalMode…）。而调度器本身早已全空间参与（`enumerateAllSpaces`），
   * 传单个 root 只是为了满足签名——语义上不成立。handler 侧更没有理由凭空挑一个空间。
   *
   * 聚合口径（不装载 runtime，直接读磁盘与内存）：
   * - 全局字段：直接复用「任一空间」的推导结果（与 root 无关）；
   * - `running`：任一空间在跑即为 true；
   * - `lastRunAt`：取全部空间中最新的一个（用户视角是「最近一次梳理」）；
   * - `lastSummary`：跟随 `lastRunAt` 的归属空间；
   * - `lastProcessedDay`：取全部空间中最小的一个（最落后 = 最需要关注）。
   */
  async statusAll(): Promise<DreamSchedulerStatus> {
    const roots = await this.enumerateCandidateRoots();
    const mem = this.getConfig().memory;
    const schedule = mem.dreaming.schedule;
    const nowMs = this.now();
    const cron = (schedule?.cron ?? '').trim();
    const parsed = cron ? parseCron(cron) : null;
    const fields = parsed?.ok ? parsed.fields : undefined;

    const status: DreamSchedulerStatus = {
      enabled: mem.enabled && mem.dreaming.enabled !== false,
      scheduleEnabled: schedule?.enabled !== false,
      intervalHours: positive(schedule?.intervalHours, 24),
      startupDelayMin: positive(schedule?.startupDelayMin, 5),
      cron,
      cronValid: parsed === null ? true : parsed.ok,
      cronError: parsed && !parsed.ok ? parsed.error : this.cronError,
      describe: fields ? describeCron(fields) : undefined,
      timezoneOffsetMin: timezoneOffsetMin(nowMs),
      misfireGraceMin: nonNegative(schedule?.misfireGraceMin, 60),
      intervalMode: this.mode,
      nextRunTimes: fields ? nextFireTimes(fields, nowMs, 3).map((t) => new Date(t).toISOString()) : [],
      running: roots.some((root) => this.inflight.has(root)),
      nextRunAt: this.nextRunAt ? new Date(this.nextRunAt).toISOString() : undefined,
    };
    if (!status.enabled) return status;

    // ---- 逐空间聚合「最近一次」与「最落后一天」 ----
    let latestMs = Number.NEGATIVE_INFINITY;
    for (const root of roots) {
      // 内存记录（本进程跑过的）优先，缺省回落磁盘状态文件（上个进程留下的）
      const rec = this.records.get(root);
      const disk = await this.readStateFile(root);
      const runAt = rec?.lastRunAt ?? disk.lastRunAt;
      if (runAt) {
        const ms = Date.parse(runAt);
        if (Number.isFinite(ms) && ms > latestMs) {
          latestMs = ms;
          status.lastRunAt = runAt;
          status.lastSummary = rec?.lastSummary ?? disk.lastSummary ?? status.lastSummary;
        }
      }
      const day = disk.lastProcessedDay;
      if (day && (status.lastProcessedDay === undefined || day < status.lastProcessedDay)) {
        status.lastProcessedDay = day;
      }
    }
    return status;
  }

  /**
   * 读单个空间的状态文件（供 statusAll 聚合；不装载 runtime）。
   * 读不到/解析失败一律返回空对象——聚合口径下单个空间坏掉不该影响整体。
   */
  private async readStateFile(root: string): Promise<{
    lastProcessedDay?: string;
    lastRunAt?: string;
    lastSummary?: DreamSchedulerStatus['lastSummary'];
  }> {
    const file = join(this.userDir, 'memory', toWorkspaceId(root), '.dreaming-state.json');
    try {
      const raw = await readFile(file, 'utf-8');
      const st = JSON.parse(raw) as {
        lastProcessedDay?: string;
        lastRunAt?: string;
        lastSummary?: DreamSchedulerStatus['lastSummary'];
      };
      return st ?? {};
    } catch {
      return {};
    }
  }


  // ---- Task-20261026-003：运行历史读写（供 /memory/dream/history 端点） ----

  /** 读某空间的运行历史（新 → 旧）；runtime 未装载返回 null */
  async historyFor(root: string, limit?: number): Promise<DreamRunRecord[] | null> {
    if (!this.registry.peek(root)) return null;
    const log = await this.logFor(root);
    return log ? log.list(limit) : [];
  }

  /** 清空某空间的运行历史，返回删除条数；runtime 未装载返回 null */
  async clearHistory(root: string): Promise<number | null> {
    if (!this.registry.peek(root)) return null;
    const log = await this.logFor(root);
    return log ? log.clear() : 0;
  }

  // ---- 内部：调度 ----

  private clearTimer(): void {
    if (this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
  }

  /**
   * 按当前配置（重）排定时器。
   * @param isFirst true = 进程首次注册（间隔模式下用 startupDelayMin，避开启动期初始化）
   */
  private applySchedule(isFirst: boolean): void {
    this.clearTimer();
    if (this.stopped) return;
    const schedule = this.getConfig().memory.dreaming.schedule;

    if (schedule?.enabled === false) {
      this.nextRunAt = undefined;
      this.mode = 'interval';
      this.fields = undefined;
      this.cronError = undefined;
      return;
    }

    const cron = (schedule?.cron ?? '').trim();
    if (cron) {
      const parsed = parseCron(cron);
      if (parsed.ok && !neverFires(parsed.fields, this.now())) {
        this.mode = 'cron';
        this.fields = parsed.fields;
        this.cronError = undefined;
        this.scheduleNextByCron();
        return;
      }
      // D10 兜底：配置被别处改坏 → 回落间隔模式并保留错误原因（status 暴露），不永久失灵
      this.cronError = parsed.ok ? '该表达式不会触发' : parsed.error;
      debug.log(`[dream] cron「${cron}」不可用（${this.cronError}），回落间隔模式`);
    } else {
      this.cronError = undefined;
    }

    this.mode = 'interval';
    this.fields = undefined;
    const delay = isFirst
      ? positive(schedule?.startupDelayMin, 5) * MINUTE_MS
      : positive(schedule?.intervalHours, 24) * HOUR_MS;
    debug.log(`[dream] 定时轮已注册（间隔模式）：${Math.round(delay / MINUTE_MS)} 分钟后触发`);
    this.scheduleNext(delay);
  }

  /** 按 cron 排下一次：分片等待（≤6h），到点由 onTimer 重算（D4） */
  private scheduleNextByCron(): void {
    if (this.stopped) return;
    const fields = this.fields;
    if (!fields) return;
    const nowMs = this.now();
    const next = nextFireTime(fields, nowMs);
    if (next === null) {
      // 理论上 applySchedule 已用 neverFires 拦过；防御性兜底
      this.nextRunAt = undefined;
      this.cronError = '该表达式不会触发';
      debug.log(`[dream] cron「${fields.expr}」无可用触发点，定时轮停摆`);
      return;
    }
    this.nextRunAt = next;
    const delay = Math.min(Math.max(next - nowMs, 0), MAX_WAIT_MS);
    debug.log(
      `[dream] cron「${fields.expr}」下次 ${new Date(next).toISOString()}，本次等待 ${Math.round(delay / MINUTE_MS)} 分钟`,
    );
    this.timer = this.createTimer(() => {
      this.timer = null;
      void this.onTimer();
    }, delay);
  }

  /** 间隔模式排下一次（cron 为空 / 不可用时的回落） */
  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.nextRunAt = this.now() + delayMs;
    this.timer = this.createTimer(() => {
      this.timer = null;
      void this.onTimer();
    }, delayMs);
  }

  private async onTimer(): Promise<void> {
    if (this.stopped) return;
    try {
      if (this.mode === 'cron' && this.fields) {
        await this.onCronTimer();
      } else {
        await this.tick();
      }
    } catch (e) {
      this.log(`[api] dream 定时轮异常: ${msgOf(e)}`);
    }
    if (this.stopped) return;
    // D10：每轮结束重读配置并重新解析 cron，避免「配置被改坏后调度器永久失灵」
    this.applySchedule(false);
  }

  /** cron 模式的到点判定：分片未到期 → 重排；墙钟键重复 → 跳过；超出宽限 → 记错过 */
  private async onCronTimer(): Promise<void> {
    const target = this.nextRunAt;
    if (target === undefined) return;
    const nowMs = this.now();
    if (nowMs < target) {
      // 只是 6h 分片到点，真正触发时刻还没到——由 onTimer 末尾重排下一片
      return;
    }

    const key = localMinuteKey(target);
    if (key === this.lastFireKey) {
      // DST 回拨：同一本地墙钟分钟第二次到达，跳过（坑 3）
      debug.log(`[dream] 墙钟分钟 ${key} 已触发过（DST 回拨），跳过本轮`);
      return;
    }
    this.lastFireKey = key;

    const grace = nonNegative(this.getConfig().memory.dreaming.schedule?.misfireGraceMin, 60) * MINUTE_MS;
    const late = nowMs - target;
    if (late > grace) {
      this.log(
        `[api] dream 定时轮错过：迟 ${Math.round(late / MINUTE_MS)} 分钟 > 宽限 ${Math.round(grace / MINUTE_MS)} 分钟，不补跑`,
      );
      this.recordMissed(target, late);
      return;
    }
    // 超过 1 分钟才视为补跑（正常到点受事件循环抖动影响，通常几十毫秒）
    await this.tick({ catchup: late >= MINUTE_MS });
  }

  // ---- 内部：摘要与历史 ----

  private finishSummary(
    root: string,
    workspaceId: string,
    reason: DreamTriggerReason,
    daysBack: number,
    p: {
      ok: boolean;
      promoted: number;
      skipped: number;
      errors: number;
      startedAt: string;
      startedMs: number;
      catchup?: boolean;
      errorMessage?: string;
    },
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
    if (p.catchup) summary.catchup = true;
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
    this.appendHistory(root, summary, p.errorMessage);
    return summary;
  }

  private skipSummary(
    root: string,
    workspaceId: string,
    reason: DreamTriggerReason,
    skippedBecause: DreamSkipReason,
    startedAt: string,
    startedMs: number,
    catchup?: boolean,
    errorMessage?: string,
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
    if (catchup) summary.catchup = true;
    this.logSummary(summary);
    this.appendHistory(root, summary, errorMessage);
    return summary;
  }

  /** D5：错过触发点（超出宽限）→ 为每个空间记一条「错过」，不跑 Dreaming */
  private recordMissed(targetMs: number, lateMs: number): void {
    for (const rt of this.registry.list()) {
      const summary: DreamRunSummary = {
        root: rt.root,
        workspaceId: rt.id,
        reason: 'schedule',
        ok: false,
        daysBack: 0,
        promoted: 0,
        skipped: 0,
        errors: 0,
        skippedBecause: 'missed',
        startedAt: new Date(targetMs).toISOString(),
        finishedAt: new Date(this.now()).toISOString(),
        durationMs: 0,
      };
      this.logSummary(summary);
      this.appendHistory(rt.root, summary, `错失触发点：迟 ${Math.round(lateMs / MINUTE_MS)} 分钟，超出补跑宽限`);
    }
  }

  /** 历史落盘（旁路：异步 fire-and-forget，任何异常只记 debug 日志，绝不影响晋升结果） */
  private appendHistory(root: string, summary: DreamRunSummary, errorMessage?: string): void {
    // D8：配置关闭 / 无 runtime 期间每轮都会产生噪声，不入库
    if (summary.skippedBecause === 'disabled' || summary.skippedBecause === 'no-runtime') return;
    void (async () => {
      try {
        const log = await this.logFor(root);
        if (!log) return;
        const rec: DreamRunRecord = {
          startedAt: summary.startedAt,
          finishedAt: summary.finishedAt,
          durationMs: summary.durationMs,
          reason: summary.reason,
          ok: summary.ok,
          daysBack: summary.daysBack,
          promoted: summary.promoted,
          skipped: summary.skipped,
          errors: summary.errors,
        };
        if (summary.catchup) rec.catchup = true;
        if (summary.skippedBecause) rec.skippedBecause = summary.skippedBecause;
        if (errorMessage) rec.errorMessage = truncateError(errorMessage);
        log.append(rec);
      } catch (e) {
        debug.log(`[dream] 记录运行历史失败（忽略）: ${msgOf(e)}`);
      }
    })();
  }

  /** 构造某空间的运行历史读写器（limit<=0 时返回 null，表示不落盘） */
  private async logFor(root: string): Promise<DreamRunLog | null> {
    const rt = this.registry.peek(root);
    if (!rt) return null;
    const limit = normalizeHistoryLimit(this.getConfig().memory.dreaming.historyLimit);
    if (limit <= 0) return null;
    const kit = await rt.getMemoryKit();
    return new DreamRunLog({ file: join(kit.episodic.getMemoryDir(), RUNS_FILE), limit });
  }

  /** 统一日志格式，便于 grep：`[api] dream schedule ws=xxxxxxxx 窗口=4d 晋升=3 跳过=1 错误=0 用时=8.2s` */
  private logSummary(s: DreamRunSummary): void {
    const ws = s.workspaceId ? s.workspaceId.slice(0, 8) : '-';
    const tail = s.catchup ? '（补跑）' : '';
    if (s.skippedBecause) {
      this.log(`[api] dream ${s.reason} ws=${ws} 跳过（${s.skippedBecause}）${tail}`);
      return;
    }
    // 晋升/跳过/错误全为 0 表示本轮无事可做，不打日志避免刷屏
    if (s.promoted === 0 && s.skipped === 0 && s.errors === 0) return;
    this.log(
      `[api] dream ${s.reason} ws=${ws} 窗口=${s.daysBack}d 晋升=${s.promoted} 跳过=${s.skipped} 错误=${s.errors} 用时=${(s.durationMs / 1000).toFixed(1)}s${tail}`,
    );
  }
}
