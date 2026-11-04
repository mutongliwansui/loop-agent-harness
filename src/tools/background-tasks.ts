// 后台任务表：进程级单例，管理 commandRun background 模式的任务状态与日志游标
// Task-20261022-002（需求 20261021-006）：D2 taskId 格式 / D3 日志落盘 / D6 孤儿检测 / D8 stop 幂等
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { debug } from '../debug.js';

/** 后台任务状态机：running → exited | killed；服务重启后运行中任务 → orphaned-*（D6） */
export type BackgroundTaskStatus =
  | 'running'
  | 'exited'
  | 'killed'
  | 'orphaned-running'
  | 'orphaned-exited';

export interface BackgroundTask {
  taskId: string; // bg_<hex8>_<秒级ts>（D2）
  pid?: number;
  command: string;
  cwd: string; // 解析后的绝对路径
  logPath: string;
  startedAt: number; // epoch ms
  status: BackgroundTaskStatus;
  exitCode?: number | null; // null=信号终止/未知（D6 orphaned-exited）
  finishedAt?: number;
  /** 日志读游标（字节偏移，随 commandLogs 不带参调用推进，D4） */
  cursor: number;
  /** 归属会话（需求 20261104-004 D5）：CLI 首轮未建会话时为空 */
  sessionId?: string;
  /** 完成通知已投递时间（需求 20261104-004 D3）：非空表示不再重复投递 */
  notifiedAt?: number;
}

/** 内存任务表上限：超出淘汰最老的已结束任务（日志与 .json 保留在磁盘） */
const MAX_TASKS = 200;
/** list() 返回上限 */
const LIST_LIMIT = 50;
/** orphaned-running 的 .json/.log 彻底放弃阈值 */
const PRUNE_ORPHANED_RUNNING_MS = 60 * 60 * 1000;
/** 日志清理默认值（需求 20261104-003，D3） */
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_TOTAL_MB = 100;

/** 生成 taskId：bg_<8位随机hex>_<秒级时间戳>（D2：随机段防同秒碰撞，时间戳人眼可排序） */
export function newTaskId(): string {
  return `bg_${randomBytes(4).toString('hex')}_${Math.floor(Date.now() / 1000)}`;
}

/** runs 目录：~/.loop-agent/runs/（D3 全局目录，不进工作空间不污染 git） */
let runsDirOverride: string | undefined;
/** 测试专用：覆盖 runs 目录（仅单测注入临时目录用） */
export function setRunsDirForTest(dir: string | undefined): void {
  runsDirOverride = dir;
}
export function runsDir(): string {
  return runsDirOverride ?? join(homedir(), '.loop-agent', 'runs');
}

/** 日志清理配置（需求 20261104-003 D3：init 启动时由 config.tools.backgroundLog 注入） */
export interface BackgroundLogPruneOptions {
  enabled: boolean;
  retentionDays: number;
  maxTotalMb: number;
}

export interface BackgroundLogPruneResult {
  /** 成对删除的 .json 数量（对应 .log 一并删除） */
  removedTasks: number;
  /** 单独删除的 .log 数量（无主日志、超量淘汰） */
  removedLogs: number;
  /** 释放字节数（日志 + JSON） */
  freedBytes: number;
}

let logPruneOptions: BackgroundLogPruneOptions = {
  enabled: true,
  retentionDays: DEFAULT_RETENTION_DAYS,
  maxTotalMb: DEFAULT_MAX_TOTAL_MB,
};

/** 注入清理配置（init 调用；单测/未注入场景使用默认值） */
export function configureBackgroundLogPrune(opts: Partial<BackgroundLogPruneOptions>): void {
  logPruneOptions = {
    enabled: opts.enabled ?? logPruneOptions.enabled,
    retentionDays: Math.max(0, opts.retentionDays ?? logPruneOptions.retentionDays),
    maxTotalMb: Math.max(0, opts.maxTotalMb ?? logPruneOptions.maxTotalMb),
  };
}

export function backgroundLogPruneOptions(): BackgroundLogPruneOptions {
  return { ...logPruneOptions };
}

/** 任务终态监听（需求 20261104-004）：finish/kill 后同步广播，监听器异常仅 debug */
export type BackgroundFinishListener = (task: BackgroundTask) => void;
const finishListeners = new Set<BackgroundFinishListener>();

export function onBackgroundTaskFinished(listener: BackgroundFinishListener): () => void {
  finishListeners.add(listener);
  return () => finishListeners.delete(listener);
}

function emitFinished(task: BackgroundTask): void {
  for (const listener of finishListeners) {
    try {
      listener(task);
    } catch (e) {
      debug.log(`后台任务完成监听异常 ${task.taskId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** 任务状态 .json 持久化路径 */
function taskJsonPath(taskId: string): string {
  return join(runsDir(), `${taskId}.json`);
}

/**
 * 后台任务注册表
 *
 * - 内存 Map 为准（authoritative），每次变更同步落盘 `{taskId}.json`（写失败仅 debug，不影响主流程）
 * - 启动时 sweepOrphans()：扫磁盘上 status=running 的残留，按 pid 存活探测归为 orphaned-*（D6）
 */
export class BackgroundTaskRegistry {
  private tasks = new Map<string, BackgroundTask>();

  /** 注册新任务（spawn 成功后调用）；taskId 碰撞时重生成（3.4 边界表） */
  start(input: Omit<BackgroundTask, 'taskId' | 'status' | 'cursor'> & { taskId?: string }): BackgroundTask {
    let taskId = input.taskId ?? newTaskId();
    while (this.tasks.has(taskId)) taskId = newTaskId();
    const task: BackgroundTask = {
      ...input,
      taskId,
      status: 'running',
      cursor: 0,
    };
    this.tasks.set(taskId, task);
    this.evictIfNeeded();
    this.persist(task);
    return task;
  }

  get(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  /** 按 startedAt 倒序，最多 50 条（3.1） */
  list(): BackgroundTask[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, LIST_LIMIT);
  }

  /** 进程退出回调：置终态（killed 后回调先到则尊重回调结果，D8） */
  finish(taskId: string, exitCode: number | null): void {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== 'running') return;
    t.status = 'exited';
    t.exitCode = exitCode;
    t.finishedAt = Date.now();
    this.persist(t);
    emitFinished(t);
  }

  /** stop：置 killed 并返回语义；对非运行态幂等（D8）；orphaned-running 也可 stop（D6） */
  kill(taskId: string): { outcome: 'killed' | 'already-finished' | 'not-found'; task?: BackgroundTask } {
    const t = this.tasks.get(taskId);
    if (!t) return { outcome: 'not-found' as const };
    if (t.status !== 'running' && t.status !== 'orphaned-running') {
      return { outcome: 'already-finished' as const, task: t };
    }
    t.status = 'killed';
    t.finishedAt = Date.now();
    this.persist(t);
    emitFinished(t);
    return { outcome: 'killed' as const, task: t };
  }

  /**
   * 标记完成通知已投递（需求 20261104-004 D3）：内存命中直接落盘；
   * 内存无此任务（重启后从 runs 目录补投的场景）则读改写磁盘 JSON。
   */
  markNotified(taskId: string): void {
    const t = this.tasks.get(taskId);
    if (t) {
      if (t.notifiedAt) return;
      t.notifiedAt = Date.now();
      this.persist(t);
      return;
    }
    try {
      const path = taskJsonPath(taskId);
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as BackgroundTask;
      if (raw.notifiedAt) return;
      raw.notifiedAt = Date.now();
      writeFileSync(path, JSON.stringify(raw, null, 2));
    } catch (e) {
      debug.log(`通知标记落盘失败 ${taskId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 推进日志读游标（commandLogs 无参增量调用后） */
  advanceCursor(taskId: string, next: number): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.cursor = Math.max(t.cursor, next);
    this.persist(t);
  }

  /**
   * 孤儿清扫（进程启动时调用一次，D6）：
   * 扫 runs 目录所有 .json，status=running 的条目按 pid 存活探测：
   * - 存活 → orphaned-running（本进程不接管输出，仅可 commandStop）
   * - 已死 → orphaned-exited（exitCode 未知，保持原值/undefined）
   *
   * 注意：**本方法内部全是同步 I/O**，在 runs 目录积几千个旧文件时会卡 60s+
   * （2026-10-28 实测 13374 个 JSON 读取耗时 ~60s）。因此不应放在启动关键路径上。
   */
  async sweepOrphans(): Promise<void> {
    let names: string[];
    try {
      names = readdirSync(runsDir());
    } catch {
      return; // 目录不存在（从未有后台任务），静默
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(readFileSync(join(runsDir(), name), 'utf-8')) as BackgroundTask;
        if (raw.status !== 'running') continue;
        const alive = isPidAlive(raw.pid);
        raw.status = alive ? 'orphaned-running' : 'orphaned-exited';
        if (!alive) raw.finishedAt = raw.finishedAt ?? Date.now();
        // 重新入表（跨进程启动的记忆恢复，cursor 保留以便增量续读）
        this.tasks.set(raw.taskId, raw);
        this.persist(raw);
        debug.log(`后台任务孤儿标记: ${raw.taskId} → ${raw.status}`);
      } catch (e) {
        debug.log(`孤儿扫描跳过 ${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * 清理 runs 目录（需求 20261104-003）：
   * - 按天数：已结束任务的 `.json`+`.log` 超过 retentionDays 成对删除
   * - 按天数：无主 `.log`（`.json` 已不存在）超过 retentionDays 删除
   * - 按大小：剩余 `.log` 总量超过 maxTotalMb 时按 mtime 从旧删起
   * - 孤儿：status=orphaned-running 且超过 1h 的条目彻底放弃（沿用旧口径）
   *
   * 全程 stat 粗筛 + 少量 JSON 解析，13374 个文件实测 <1s；
   * 内存中仍活跃的任务（this.tasks）永不删除，避免误删正在写入的日志。
   */
  pruneRuns(override?: Partial<BackgroundLogPruneOptions>): BackgroundLogPruneResult {
    const result: BackgroundLogPruneResult = { removedTasks: 0, removedLogs: 0, freedBytes: 0 };
    const opts: BackgroundLogPruneOptions = { ...logPruneOptions, ...(override ?? {}) };
    if (!opts.enabled) return result;

    const dir = runsDir();
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return result; // 目录不存在（从未有后台任务），静默
    }

    const now = Date.now();
    const cutoff = now - Math.max(0, opts.retentionDays) * 24 * 60 * 60 * 1000;
    const orphanCutoff = now - PRUNE_ORPHANED_RUNNING_MS;
    const maxTotalBytes = Math.max(0, opts.maxTotalMb) * 1024 * 1024;

    // 一次 stat 收集日志元数据
    const logSize = new Map<string, number>();
    const logMtime = new Map<string, number>();
    for (const name of names) {
      if (!name.endsWith('.log')) continue;
      try {
        const st = statSync(join(dir, name));
        logSize.set(name.slice(0, -4), st.size);
        logMtime.set(name.slice(0, -4), st.mtimeMs);
      } catch { /* 并发删除，忽略 */ }
    }
    const jsonTaskIds = new Set(names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)));
    const deletedLogs = new Set<string>();

    const removeLog = (taskId: string): void => {
      const size = logSize.get(taskId) ?? 0;
      try {
        rmSync(join(dir, `${taskId}.log`));
        deletedLogs.add(taskId);
        result.freedBytes += size;
        result.removedLogs++;
      } catch { /* 已被删除，忽略 */ }
    };

    // 1) 按天数：已结束任务的 .json + .log 成对删除
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const taskId = name.slice(0, -5);
      if (this.tasks.has(taskId)) continue; // 活跃任务不删
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch { continue; }
      if (st.mtimeMs >= cutoff) continue;
      try {
        rmSync(path);
        result.removedTasks++;
        result.freedBytes += st.size;
      } catch { continue; }
      removeLog(taskId);
      jsonTaskIds.delete(taskId);
    }

    // 2) 按天数：无主 .log（对应 .json 不存在）超过保留期删除
    for (const [taskId, size] of logSize) {
      if (this.tasks.has(taskId) || deletedLogs.has(taskId)) continue;
      if (jsonTaskIds.has(taskId)) continue;
      if ((logMtime.get(taskId) ?? 0) >= cutoff) continue;
      try {
        rmSync(join(dir, `${taskId}.log`));
        deletedLogs.add(taskId);
        result.removedLogs++;
        result.freedBytes += size;
      } catch { /* 忽略 */ }
    }

    // 3) 孤儿：orphaned-running 超过 1h 彻底放弃（损坏 JSON 同样清理）
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const taskId = name.slice(0, -5);
      if (this.tasks.has(taskId)) continue;
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch { continue; }
      if (st.mtimeMs >= orphanCutoff) continue; // 还在窗口内
      let drop = false;
      try {
        const raw = JSON.parse(readFileSync(path, 'utf-8')) as BackgroundTask;
        drop = raw.status === 'orphaned-running';
      } catch {
        drop = true; // 损坏文件
      }
      if (!drop) continue;
      try {
        rmSync(path);
        result.removedTasks++;
        result.freedBytes += st.size;
      } catch { continue; }
      if (!deletedLogs.has(taskId) && logSize.has(taskId)) removeLog(taskId);
    }

    // 4) 按大小：剩余 .log 总量超限时从最旧删起（活跃任务跳过）
    const remaining = [...logSize.keys()]
      .filter((taskId) => !deletedLogs.has(taskId) && !this.tasks.has(taskId))
      .sort((a, b) => (logMtime.get(a) ?? 0) - (logMtime.get(b) ?? 0));
    let total = remaining.reduce((sum, taskId) => sum + (logSize.get(taskId) ?? 0), 0);
    for (const taskId of remaining) {
      if (total <= maxTotalBytes) break;
      const size = logSize.get(taskId) ?? 0;
      try {
        rmSync(join(dir, `${taskId}.log`));
        deletedLogs.add(taskId);
        result.removedLogs++;
        result.freedBytes += size;
        total -= size;
      } catch { /* 忽略 */ }
    }

    if (result.removedTasks + result.removedLogs > 0) {
      debug.log(
        `后台日志清理: 任务 ${result.removedTasks} 个、日志 ${result.removedLogs} 个、释放 ${Math.round(result.freedBytes / 1024)}KB`,
      );
    }
    return result;
  }

  /** 表上限淘汰：>200 时移除最老的已结束任务（running 永不淘汰） */
  private evictIfNeeded(): void {
    while (this.tasks.size > MAX_TASKS) {
      const finished = [...this.tasks.values()]
        .filter((t) => t.status !== 'running')
        .sort((a, b) => a.startedAt - b.startedAt)[0];
      if (!finished) return; // 全是 running（理论不可能），保住运行任务
      this.tasks.delete(finished.taskId);
    }
  }

  /** 同步落盘任务状态；写失败仅 debug（持久化是尽力而为，不阻塞主流程） */
  private persist(t: BackgroundTask): void {
    try {
      mkdirSync(runsDir(), { recursive: true });
      writeFileSync(taskJsonPath(t.taskId), JSON.stringify(t, null, 2));
    } catch (e) {
      debug.log(`任务状态落盘失败 ${t.taskId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** pid 存活探测（D6）：EPERM=存在但无权限（Windows 常见）视为存活 */
export function isPidAlive(pid?: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 进程级单例 */
export const backgroundTasks = new BackgroundTaskRegistry();
