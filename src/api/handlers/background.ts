// 后台任务 HTTP 端点（需求 20261104-005 D7）
//
// 背景：WebUI 的 commandRun 后台结果需要卡片化展示，而后台任务是进程级资源、
// 不绑定会话路径；因此单独提供只读查询 + 幂等停止三条端点，沿用统一 token 鉴权。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HandlerContext, Route } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { sendJson } from '../http-utils.js';
import { backgroundTasks, isPidAlive, runsDir, type BackgroundTask } from '../../tools/background-tasks.js';
import { killProcessTree } from '../../tools/process-tree.js';

/** taskId 白名单格式：bg_<hex8>_<秒级时间戳>（同时防路径穿越） */
const TASK_ID_RE = /^bg_[0-9a-f]{8}_\d+$/;
/** logs?tail=1 读取的尾部字节数 */
const TAIL_BYTES = 2048;
/** logs?tail=1 返回的尾行数 */
const TAIL_LINES = 20;

/**
 * 解析任务：优先内存（本进程启动的），未命中回落 runs 目录的 .json
 * （页面刷新/服务重启后历史卡片仍能读到状态）。
 */
function loadTask(taskId: string): BackgroundTask | undefined {
  if (!TASK_ID_RE.test(taskId)) return undefined;
  const inMemory = backgroundTasks.get(taskId);
  if (inMemory) return inMemory;
  try {
    return JSON.parse(readFileSync(join(runsDir(), `${taskId}.json`), 'utf-8')) as BackgroundTask;
  } catch {
    return undefined;
  }
}

function requireTask(taskId: string): BackgroundTask {
  const task = loadTask(taskId);
  if (!task) throw new ApiHttpError('not_found', `后台任务不存在: ${taskId}`);
  return task;
}

function safeSize(logPath: string): number {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

/** 读尾部字节区间（fd + readSync，避免整文件载入） */
function readTail(logPath: string, from: number, to: number): string {
  const fd = openSync(logPath, 'r');
  try {
    const actual = Math.min(to - from, Math.max(0, fstatSync(fd).size - from));
    if (actual <= 0) return '';
    const buf = Buffer.alloc(actual);
    const read = readSync(fd, buf, 0, actual, from);
    return buf.toString('utf-8', 0, read);
  } finally {
    closeSync(fd);
  }
}

/** GET /background/:taskId：状态快照（前端轮询） */
async function handleGetTask(
  _ctx: HandlerContext,
  _req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
): Promise<void> {
  const task = requireTask(taskId);
  const logSize = safeSize(task.logPath);
  sendJson(res, 200, {
    taskId: task.taskId,
    command: task.command,
    status: task.status,
    exitCode: task.exitCode ?? null,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt ?? null,
    durationMs: (task.finishedAt ?? Date.now()) - task.startedAt,
    logSize,
    cursor: task.cursor,
  });
}

/** GET /background/:taskId/logs?tail=1：日志尾部（最后 20 行 / 2KB） */
async function handleGetLogs(
  _ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
): Promise<void> {
  const task = requireTask(taskId);
  const size = safeSize(task.logPath);
  if (size === 0) {
    // 任务存在但日志缺失/为空：cleaned=true 供前端显示「已清理」
    const cleaned = !safeStatExists(task.logPath);
    sendJson(res, 200, { taskId, tail: '', size: 0, truncated: false, cleaned });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const tailMode = url.searchParams.get('tail') === '1';
  const from = tailMode ? Math.max(0, size - TAIL_BYTES) : 0;
  const to = tailMode ? size : Math.min(size, TAIL_BYTES);
  let text: string;
  try {
    text = readTail(task.logPath, from, to);
  } catch (e) {
    throw new ApiHttpError('internal', `日志读取失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  let truncated = to < size;
  if (tailMode) {
    const lines = text.split('\n');
    if (lines.length > TAIL_LINES) {
      text = lines.slice(-TAIL_LINES).join('\n');
      truncated = true;
    }
  }
  sendJson(res, 200, { taskId, tail: text, size, truncated, cleaned: false });
}

function safeStatExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** POST /background/:taskId/stop：幂等停止（与 commandStop 同口径） */
async function handleStopTask(
  _ctx: HandlerContext,
  _req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
): Promise<void> {
  const task = requireTask(taskId);

  if (task.status === 'orphaned-running') {
    // 跨进程孤儿：本进程无 exit 回调，探测存活后直接杀
    if (!isPidAlive(task.pid)) {
      task.status = 'orphaned-exited';
      task.finishedAt = Date.now();
      backgroundTasks.advanceCursor(taskId, 0); // 触发 persist
      sendJson(res, 200, { taskId, stopped: false, alreadyStopped: true, status: task.status });
      return;
    }
  }

  const r = backgroundTasks.kill(taskId);
  if (r.outcome === 'already-finished') {
    sendJson(res, 200, { taskId, stopped: false, alreadyStopped: true, status: r.task?.status });
    return;
  }
  const current = r.task ?? task;
  if (r.outcome === 'killed' && current.pid) await killProcessTree(current.pid);
  sendJson(res, 200, { taskId, stopped: true, alreadyStopped: false, status: 'killed' });
}

export function backgroundRoutes(): Route[] {
  return [
    { method: 'GET', path: '/background/:taskId', handler: (ctx, req, res, p) => handleGetTask(ctx, req, res, p.taskId) },
    { method: 'GET', path: '/background/:taskId/logs', handler: (ctx, req, res, p) => handleGetLogs(ctx, req, res, p.taskId) },
    { method: 'POST', path: '/background/:taskId/stop', handler: (ctx, req, res, p) => handleStopTask(ctx, req, res, p.taskId) },
  ];
}
