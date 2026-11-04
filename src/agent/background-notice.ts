// 后台任务完成通知（需求 20261104-004）
//
// 数据流：backgroundTasks.finish/kill ──emit──▶ enqueue（读日志尾部 + 渲染）
//        ──▶ 进程级队列（按 sessionId 分桶） ──drain──▶ Agent 每轮 LLM 前注入 user 尾部消息
// 去重真源：runs/<taskId>.json 的 notifiedAt（D3），内存队列只是加速。
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug.js';
import {
  backgroundTasks,
  onBackgroundTaskFinished,
  runsDir,
  type BackgroundTask,
} from '../tools/background-tasks.js';

export interface BackgroundNotice {
  sessionId: string;
  taskId: string;
  text: string;
  finishedAt: number;
}

export interface BackgroundNotifyOptions {
  enabled: boolean;
  tailLines: number;
  maxChars: number;
}

let options: BackgroundNotifyOptions = { enabled: true, tailLines: 20, maxChars: 2000 };

/** 注入配置（init 调用；单测/未注入场景使用默认值） */
export function configureBackgroundNotify(opts: Partial<BackgroundNotifyOptions>): void {
  options = {
    enabled: opts.enabled ?? options.enabled,
    tailLines: Math.max(1, opts.tailLines ?? options.tailLines),
    maxChars: Math.max(100, opts.maxChars ?? options.maxChars),
  };
}

export function backgroundNotifyOptions(): BackgroundNotifyOptions {
  return { ...options };
}

/** 按会话分桶的待投递队列；'' 为无归属桶（CLI 首轮尚未建会话） */
const queues = new Map<string, BackgroundNotice[]>();
/** 进程内去重：同一 taskId 不重复入队 */
const queued = new Set<string>();
/** 已完成补投扫描的会话：避免每轮 run 都遍历 runs 目录（文件多时可达秒级） */
const restoredSessions = new Set<string>();

/** 读取日志尾部：只读最后 64KB，避免长日志整文件加载 */
function readLogTail(logPath: string): string {
  try {
    const st = statSync(logPath);
    if (st.size === 0) return '';
    const readBytes = Math.min(st.size, 64 * 1024);
    const fd = openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(readBytes);
      readSync(fd, buf, 0, readBytes, st.size - readBytes);
      let text = buf.toString('utf8');
      // 从文件中间开始读取时首行可能残缺，丢弃到第一个换行
      const nl = text.indexOf('\n');
      if (nl >= 0 && nl < 200) text = text.slice(nl + 1);
      return text;
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

function statusLine(task: BackgroundTask): string {
  if (task.status === 'killed') return 'killed（用户停止）';
  if (task.exitCode == null) return 'exited (exitCode=未知)';
  return `exited (exitCode=${task.exitCode})`;
}

/** 渲染注入文本（≤ tailLines 行 / maxChars 字符的日志尾部） */
function renderNotice(task: BackgroundTask, logTail: string): string {
    const tailLines = options.tailLines;
    const maxChars = options.maxChars;
    const startedAt = task.startedAt ?? Date.now();
    const finishedAt = task.finishedAt ?? Date.now();
    const durationSec = Math.max(0, (finishedAt - startedAt) / 1000).toFixed(1);

    let tail = logTail.trimEnd();
    if (!tail) tail = '(无输出 / 日志已清理)';
    const lines = tail.split('\n');
    if (lines.length > tailLines) tail = lines.slice(-tailLines).join('\n');
    if (tail.length > maxChars) tail = `…${tail.slice(-maxChars)}`;

    return [
      '<background_task_notification>',
      `taskId: ${task.taskId}`,
      `command: ${task.command}`,
      `status: ${statusLine(task)}`,
      `duration: ${durationSec}s`,
      'logTail:',
      tail,
      '</background_task_notification>',
    ].join('\n');
}

function enqueueFromTask(task: BackgroundTask): void {
  if (!options.enabled) return;
  if (task.notifiedAt) return;
  if (queued.has(task.taskId)) return;
  if (task.status !== 'exited' && task.status !== 'killed') return;

  try {
    const logTail = readLogTail(task.logPath);
    const notice: BackgroundNotice = {
      sessionId: task.sessionId ?? '',
      taskId: task.taskId,
      text: renderNotice(task, logTail),
      finishedAt: task.finishedAt ?? Date.now(),
    };
    const bucket = notice.sessionId;
    const list = queues.get(bucket) ?? [];
    list.push(notice);
    queues.set(bucket, list);
    queued.add(task.taskId);
    debug.log(`后台任务完成通知入队: ${task.taskId} → 会话 ${bucket || '(无归属)'}`);
  } catch (e) {
    // D6：通知失败不得影响主流程
    debug.log(`后台任务通知生成失败 ${task.taskId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** finish/kill 监听入口（幂等安装） */
let installed = false;
export function installBackgroundNoticeForwarder(): void {
  if (installed) return;
  installed = true;
  onBackgroundTaskFinished(enqueueFromTask);
}

/** 取走某会话的通知（同时取无归属桶），并落盘 notifiedAt（D3） */
export function drainBackgroundNotices(sessionId: string): string[] {
  if (!options.enabled) return [];
  const buckets = sessionId && sessionId !== '' ? [sessionId, ''] : [''];
  const texts: string[] = [];
  for (const bucket of buckets) {
    const list = queues.get(bucket);
    if (!list || list.length === 0) continue;
    queues.delete(bucket);
    for (const notice of list) {
      texts.push(notice.text);
      queued.delete(notice.taskId);
      try {
        backgroundTasks.markNotified(notice.taskId);
      } catch (e) {
        debug.log(`通知去重标记失败 ${notice.taskId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return texts;
}

/**
 * 恢复补投（D1 恢复路径）：扫 runs 目录里同会话、已结束、未投递的任务，
 * 按 finishedAt 升序入队。只处理 7 天内（与日志保留期一致），避免翻出陈年旧账。
 */
export function restoreBackgroundNotices(sessionId: string, dir: string = runsDir()): number {
  if (!options.enabled || !sessionId) return 0;
  if (restoredSessions.has(sessionId)) return 0;
  restoredSessions.add(sessionId);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const restored: BackgroundTask[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as BackgroundTask;
      if (raw.sessionId !== sessionId) continue;
      if (raw.notifiedAt) continue;
      if (raw.status !== 'exited' && raw.status !== 'killed') continue;
      const finishedAt = raw.finishedAt ?? raw.startedAt ?? 0;
      if (finishedAt < cutoff) continue;
      if (queued.has(raw.taskId)) continue;
      restored.push(raw);
    } catch {
      /* 损坏 JSON 跳过 */
    }
  }
  restored.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  for (const task of restored) enqueueFromTask(task);
  return restored.length;
}

/** 测试专用：清空队列与去重集合 */
export function resetBackgroundNoticesForTest(): void {
  queues.clear();
  queued.clear();
  restoredSessions.clear();
}
