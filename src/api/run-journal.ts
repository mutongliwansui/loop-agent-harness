// Run journal：run 生命周期轻量落盘（Task-20261021-002-06）
//
// 背景：RunHub 全在内存、终态仅保留 60s，服务重启后无法判断「上次运行是否跑到一半」。
// journal 把 run 的关键状态写到 <store 会话目录>/runs/<sessionId>.json（与会话文件同根，
// 随会话删除天然联动），启动时扫描 bootId 不匹配的 running 记录标记为 interrupted，
// 前端据此展示「上次运行被中断（服务已重启）」等注记。
//
// 设计要点：
// - D1 中断判定用 bootId（进程启动 UUID）+ pid 双因子：pid 仅诊断展示，不做存活探测
//   （重启后 pid 复用会误判存活）；bootId 不等即「非本进程所写」，必然中断
// - best-effort：所有 IO 失败静默（debug 日志），绝不阻塞 run 主链路
// - lastSeq 类补丁按 500ms 合并写盘（节流），终态类补丁（status 变更）立即写
// - interrupted 是 journal 独有状态，不进 RunStatus（后者描述本进程内 run 实时状态）

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionStore } from '../session/index.js';
import { debug } from '../debug.js';

/** journal 记录的 run 状态（interrupted 仅由启动扫描写入） */
export type RunJournalStatus = 'running' | 'done' | 'failed' | 'aborted' | 'interrupted';

/** run journal 单条记录（<sessionId>.json 全量内容） */
export interface RunJournal {
  runId: string;
  sessionId: string;
  status: RunJournalStatus;
  startedAt: number;
  finishedAt?: number;
  /** 写入时的进程 pid（仅诊断展示，不做存活探测） */
  pid: number;
  /** 写入进程的启动 UUID；与当前进程不同 → 该记录属已死进程 */
  bootId: string;
  /** 最近一次已知的事件序号（节流同步，仅供诊断，不是续传游标） */
  lastSeq?: number;
  iterations?: number;
}

/** lastSeq 类补丁的合并写盘窗口（D3：journal 用于判中断+概要，不追求精确） */
const FLUSH_INTERVAL_MS = 500;

/** 进程启动 UUID（进程内常量）：journal 记录的 bootId ≠ 此值 → 该 run 非本进程所写 */
const BOOT_ID = randomUUID();

/** 当前进程的 bootId（启动后不变） */
export function currentBootId(): string {
  return BOOT_ID;
}

/** journal 目录：<会话所在工作空间存储目录>/runs */
function journalDir(store: SessionStore, sessionId: string): string {
  return join(store.sessionsDir, 'runs');
}

/** journal 文件完整路径（跨空间：会话在兄弟空间时定位其文件所在目录） */
async function journalPath(store: SessionStore, sessionId: string): Promise<string> {
  const dir = await store.sessionDirOf(sessionId).catch(() => store.sessionsDir);
  return join(dir, 'runs', `${sessionId}.json`);
}

/**
 * 写入 journal（读-合并-写）：
 * - 含 status 变更（终态/新 run）→ 立即写盘
 * - 仅 lastSeq/iterations 等诊断字段 → 500ms 合并节流
 * 失败静默（debug 日志），不抛错。
 */
export async function writeJournal(
  store: SessionStore,
  sessionId: string,
  patch: Partial<RunJournal>,
): Promise<void> {
  try {
    const path = await journalPath(store, sessionId);
    await mkdir(join(path, '..'), { recursive: true });
    const prev = await readJournalFile(path);

    const statusChanged = patch.status !== undefined && patch.status !== prev?.status;
    if (!statusChanged) {
      // 诊断字段补丁：500ms 合并（同会话 pending 补丁覆盖合并，只刷一次盘）
      const pendingItem = pending.get(sessionId);
      if (pendingItem && pendingItem.path === path) {
        pendingItem.patch = { ...pendingItem.patch, ...patch };
        return;
      }
      const timer = setTimeout(() => {
        void flushPending(store, sessionId);
      }, FLUSH_INTERVAL_MS);
      timer.unref?.();
      pending.set(sessionId, { path, patch, timer });
      return;
    }

    // 终态类：把挂起的诊断补丁一并并入（挂起字段尚未落盘，prev 里读不到）立即写
    const hang = pending.get(sessionId);
    const hangPatch = hang && hang.path === path ? hang.patch : undefined;
    if (hang) {
      clearTimeout(hang.timer);
      pending.delete(sessionId);
    }
    const effectivePatch = hangPatch ? { ...hangPatch, ...patch } : patch;
    const mergedFinal = mergeJournal(sessionId, prev, effectivePatch);
    await writeFile(path, JSON.stringify(mergedFinal, null, 2), 'utf-8');
  } catch (e) {
    debug.log(`[run-journal] 写入失败（不影响主流程）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 挂起的节流补丁 */
interface PendingPatch {
  path: string;
  patch: Partial<RunJournal>;
  timer?: NodeJS.Timeout;
}

/** 会话 → 挂起补丁（500ms 窗口内合并） */
const pending = new Map<string, PendingPatch>();

async function flushPending(store: SessionStore, sessionId: string): Promise<void> {
  const item = pending.get(sessionId);
  if (!item) return;
  pending.delete(sessionId);
  try {
    const prev = await readJournalFile(item.path);
    const merged = mergeJournal(sessionId, prev, item.patch);
    await mkdir(join(item.path, '..'), { recursive: true });
    await writeFile(item.path, JSON.stringify(merged, null, 2), 'utf-8');
  } catch (e) {
    debug.log(`[run-journal] 节流落盘失败（不影响主流程）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** prev + patch 合并成完整 journal（writeJournal / flushPending 共用的字段级归并） */
function mergeJournal(
  sessionId: string,
  prev: RunJournal | null,
  patch: Partial<RunJournal>,
): RunJournal {
  return {
    runId: patch.runId ?? prev?.runId ?? '',
    sessionId: patch.sessionId ?? prev?.sessionId ?? sessionId,
    status: patch.status ?? prev?.status ?? 'running',
    startedAt: patch.startedAt ?? prev?.startedAt ?? Date.now(),
    ...(patch.finishedAt !== undefined || prev?.finishedAt !== undefined
      ? { finishedAt: patch.finishedAt ?? prev?.finishedAt }
      : {}),
    pid: patch.pid ?? prev?.pid ?? process.pid,
    bootId: patch.bootId ?? prev?.bootId ?? BOOT_ID,
    ...(patch.lastSeq !== undefined || prev?.lastSeq !== undefined
      ? { lastSeq: patch.lastSeq ?? prev?.lastSeq }
      : {}),
    ...(patch.iterations !== undefined || prev?.iterations !== undefined
      ? { iterations: patch.iterations ?? prev?.iterations }
      : {}),
  };
}

/** 读取 journal 文件（损坏/不存在 → null，不抛错） */
async function readJournalFile(path: string): Promise<RunJournal | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as RunJournal;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.status !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** 读取会话的 journal（损坏/不存在 → null） */
export async function readJournal(store: SessionStore, sessionId: string): Promise<RunJournal | null> {
  try {
    return await readJournalFile(await journalPath(store, sessionId));
  } catch {
    return null;
  }
}

/**
 * 启动扫描：status==='running' 且 bootId ≠ 当前进程 → 改写 interrupted。
 * 扫描 sessions 根目录下全部工作空间的 runs/（跨空间僵尸 run 一并收敛）。
 * 返回处理条数。fire-and-forget 调用（bootstrap 不等待）。
 */
export async function reconcileInterruptedOnBoot(store: SessionStore): Promise<number> {
  let count = 0;
  try {
    // <userDir>/sessions/ 根目录：其下每个 <workspaceId>/runs/*.json 都属于某个会话。
    // journalDir = <root>/<workspaceId>/runs，上跳两级到 sessions 根
    const sessionsRoot = join(journalDir(store, ''), '..', '..');
    let workspaceDirs: string[];
    try {
      workspaceDirs = (await readdir(sessionsRoot, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => join(sessionsRoot, d.name));
    } catch {
      return 0; // sessions 根不可读：跳过扫描
    }
    for (const wsDir of workspaceDirs) {
      const runsDir = join(wsDir, 'runs');
      let files: string[];
      try {
        files = (await readdir(runsDir)).filter((f) => f.endsWith('.json'));
      } catch {
        continue; // 该空间无 runs/：跳过
      }
      for (const f of files) {
        const path = join(runsDir, f);
        const jr = await readJournalFile(path);
        if (!jr || jr.status !== 'running' || jr.bootId === BOOT_ID) continue;
        try {
          const fixed: RunJournal = {
            ...jr,
            status: 'interrupted',
            finishedAt: Date.now(),
          };
          await writeFile(path, JSON.stringify(fixed, null, 2), 'utf-8');
          count++;
          void writeRunLog({
            ts: new Date().toISOString(),
            sessionId: jr.sessionId,
            runId: jr.runId,
            event: 'interrupted',
            status: 'interrupted',
          });
        } catch {
          // 单文件失败继续处理其余
        }
      }
    }
  } catch (e) {
    debug.log(`[run-journal] 启动扫描失败（不影响启动）: ${e instanceof Error ? e.message : String(e)}`);
  }
  return count;
}

/** 删除会话的 journal（不存在则静默） */
export async function dropJournal(store: SessionStore, sessionId: string): Promise<void> {
  const item = pending.get(sessionId);
  if (item) {
    clearTimeout(item.timer);
    pending.delete(sessionId);
  }
  try {
    await unlink(await journalPath(store, sessionId));
  } catch {
    // 文件不存在/目录不可写：静默
  }
}

// ===== run-log（runs-YYYY-MM-DD.jsonl 诊断流） =====

/** run 生命周期诊断日志单条记录 */
export interface RunLogEntry {
  ts: string;
  sessionId: string;
  runId: string;
  event: 'start' | 'finish' | 'abort' | 'interrupted' | 'failed';
  status?: RunJournalStatus;
  durationMs?: number;
  iterations?: number;
}

/**
 * run 生命周期诊断日志（Task-20261021-002-06 D5 的轻量实现：格式自定、独立于 llm-logger），
 * 输出 ~/.loop-agent/logs/runs-YYYY-MM-DD.jsonl（按日切分，同 llm-logger 目录风格）。
 */
export async function writeRunLog(entry: RunLogEntry): Promise<void> {
  try {
    const { homedir } = await import('node:os');
    const { appendFile } = await import('node:fs/promises');
    const dir = join(homedir(), '.loop-agent', 'logs');
    await mkdir(dir, { recursive: true });
    const date = new Date().toISOString().split('T')[0];
    await appendFile(join(dir, `runs-${date}.jsonl`), JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // 静默：诊断日志绝不影响主流程
  }
}
