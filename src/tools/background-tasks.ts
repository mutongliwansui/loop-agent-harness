// 后台任务表：进程级单例，管理 commandRun background 模式的任务状态与日志游标
// Task-20261022-002（需求 20261021-006）：D2 taskId 格式 / D3 日志落盘 / D6 孤儿检测 / D8 stop 幂等
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
}

/** 内存任务表上限：超出淘汰最老的已结束任务（日志与 .json 保留在磁盘） */
const MAX_TASKS = 200;
/** list() 返回上限 */
const LIST_LIMIT = 50;

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
    return { outcome: 'killed' as const, task: t };
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
