// 后台任务管理三工具：commandStatus / commandLogs / commandStop
// Task-20261022-002（需求 20261021-006，D1 独立工具、D4 增量日志、D8 幂等 stop）
import { statSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import type { Tool, ToolContext } from '../types.js';
import {
  backgroundTasks,
  isPidAlive,
  type BackgroundTask,
} from './background-tasks.js';
import { killProcessTree } from './process-tree.js';
import { decodeByteRange } from './command-run-output.js';

/** 单次 commandLogs 返回上限（D4：超出截断并提示继续调用） */
const LOG_CHUNK_MAX = 8 * 1024;
/** tail 模式读最近尾部字节数（D4 被否决项中保留的布尔 tail） */
const TAIL_BYTES = 2048;

/** 单行紧凑 JSON（LLM 上下文友好，1.4 约束） */
function compact(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

/** 任务摘要行（list 场景） */
function taskLine(t: BackgroundTask): string {
  return compact({
    taskId: t.taskId,
    status: t.status,
    exitCode: t.exitCode ?? null,
    command: t.command.length > 60 ? `${t.command.slice(0, 60)}…` : t.command,
    startedAt: new Date(t.startedAt).toISOString(),
  });
}

// ===== commandStatus =====

export const commandStatus: Tool = {
  name: 'commandStatus',
  description:
    '查询后台任务状态，返回 status / 退出码 / 耗时 / 日志大小；不带 taskId 时列出最近 5 个任务。',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '后台任务 id' },
    },
  },
  async execute(args) {
    const taskId = args.taskId ? String(args.taskId) : '';
    if (!taskId) {
      const recent = backgroundTasks.list().slice(0, 5);
      if (recent.length === 0) return '当前没有后台任务记录';
      return compact({
        hint: '以下为最近 5 个后台任务（新→旧），取 taskId 继续查询',
        tasks: recent.map(taskLine),
      });
    }
    const t = backgroundTasks.get(taskId);
    if (!t) return notFound(taskId);
    const logSize = safeStatSize(t.logPath);
    return compact({
      taskId: t.taskId,
      status: t.status,
      exitCode: t.exitCode ?? null,
      pid: t.pid ?? null,
      durationMs: (t.finishedAt ?? Date.now()) - t.startedAt,
      logSize,
      command: t.command,
      hint:
        t.status === 'running'
          ? '任务运行中：可 commandLogs({taskId, tail:true}) 查看最新输出'
          : t.status === 'exited'
            ? `任务已退出（${Math.round(((t.finishedAt ?? Date.now()) - t.startedAt) / 1000)}s 前），可用 commandLogs 读取完整日志`
            : t.status === 'killed'
              ? '任务已被终止'
              : `任务为孤儿状态（${t.status}，服务重启前启动）：日志仍可读取`,
    });
  },
};

// ===== commandLogs =====

export const commandLogs: Tool = {
  name: 'commandLogs',
  description:
    '增量读取后台任务日志：默认从上次读到的位置续读到文件尾部并推进游标；tail=true 只读最近 2KB 尾部（不推进游标）。单次上限 8KB。',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '后台任务 id' },
      sinceOffset: { type: 'number', description: '起始字节偏移（从 0 起，用于回读历史区间）' },
      tail: { type: 'boolean', description: '只读最近 2KB 尾部（运行中任务看进度）' },
    },
    required: ['taskId'],
  },
  async execute(args) {
    const taskId = String(args.taskId ?? '');
    const t = backgroundTasks.get(taskId);
    if (!t) return notFound(taskId);

    let size = 0;
    try {
      size = statSync(t.logPath).size;
    } catch {
      return compact({ taskId, status: t.status, error: '日志文件不存在（可能已被清理）' });
    }

    let from = t.cursor;
    if (typeof args.sinceOffset === 'number') from = Math.max(0, Math.floor(args.sinceOffset));
    if (args.tail === true) from = Math.max(0, size - TAIL_BYTES);

    const to = Math.min(size, from + LOG_CHUNK_MAX);
    if (from >= size) {
      return compact({ taskId, status: t.status, output: '', nextOffset: from, truncated: false, hasMore: false });
    }

    let output = '';
    try {
      output = readRange(t.logPath, from, to);
    } catch (e) {
      return compact({ taskId, status: t.status, error: `日志读取失败: ${e instanceof Error ? e.message : String(e)}` });
    }

    const truncated = to < size;
    // 无参增量调用才推进游标；显式 sinceOffset/tail 是「旁观读」，不动游标（D4）
    if (typeof args.sinceOffset !== 'number' && args.tail !== true) {
      backgroundTasks.advanceCursor(taskId, to);
    }
    return compact({
      taskId,
      status: t.status,
      output,
      nextOffset: to,
      truncated,
      hasMore: to < size,
      hint: truncated ? '日志未读完，继续调用 commandLogs 获取后续内容' : undefined,
    });
  },
};

// ===== commandStop =====

export const commandStop: Tool = {
  name: 'commandStop',
  description:
    '终止后台任务，杀掉其进程树（Windows taskkill /T /F；POSIX 进程组）。幂等；会话停止不会自动终止后台任务。',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '后台任务 id' },
    },
    required: ['taskId'],
  },
  async execute(args) {
    const taskId = String(args.taskId ?? '');
    const t = backgroundTasks.get(taskId);
    if (!t) return notFound(taskId);

    if (t.status === 'orphaned-running') {
      // 跨进程启动的孤儿：本进程没有 exit 回调，探测存活后直接杀（D6）
      if (!isPidAlive(t.pid)) {
        t.status = 'orphaned-exited';
        t.finishedAt = Date.now();
        backgroundTasks.advanceCursor(taskId, 0); // 触发 persist（cursor 不回退）
        return compact({ taskId, status: t.status, pid: t.pid ?? null, note: '进程已自行退出' });
      }
    }

    const r = backgroundTasks.kill(taskId);
    if (r.outcome === 'not-found') return notFound(taskId);
    if (r.outcome === 'already-finished') {
      return compact({ taskId, status: r.task?.status, pid: r.task?.pid ?? null, note: '任务已结束，无需终止' });
    }
    // running / orphaned-running：真正杀进程树
    if (t.pid) await killProcessTree(t.pid);
    return compact({ taskId, status: 'killed', pid: t.pid ?? null });
  },
};

// ===== 内部工具函数 =====

function notFound(taskId: string): string {
  return compact({ error: `任务不存在: ${taskId}（可能从未创建、已被淘汰或拼写错误）` });
}

function safeStatSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/** 读 [from,to) 字节区间（fd + readSync，避免整文件载入内存） */
function readRange(path: string, from: number, to: number): string {
  const fd = openSync(path, 'r');
  try {
    const len = to - from;
    // 防御：文件被截断变短时按实际大小收口
    const actual = Math.min(len, Math.max(0, fstatSync(fd).size - from));
    if (actual <= 0) return '';
    const buf = Buffer.alloc(actual);
    const read = readSync(fd, buf, 0, actual, from);
    // 增量读的起止都可能落在多字节字符中间，且 Windows 命令输出可能是 GBK：
    // 统一走编码探测，避免中文日志在命令卡片里变成 `�`
    return decodeByteRange(buf.subarray(0, read));
  } finally {
    closeSync(fd);
  }
}
