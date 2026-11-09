// 后台任务完成通知（需求 20261104-004）
//
// 数据流：backgroundTasks.finish/kill ──emit──▶ enqueue（读日志尾部 + 渲染）
//        ──▶ 进程级队列（按 sessionId 分桶） ──drain──▶ Agent 每轮 LLM 前注入 user 尾部消息
// 去重真源：runs/<taskId>.json 的 notifiedAt（D3），内存队列只是加速。
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BACKGROUND_NOTICE_CLOSE, BACKGROUND_NOTICE_OPEN } from '../types.js';
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
  /** 会话空闲时任务完成是否请求唤醒一轮 run（需求 20261108-002；仅 WebUI/服务模式消费） */
  wakeIdle: boolean;
}

let options: BackgroundNotifyOptions = { enabled: true, tailLines: 20, maxChars: 2000, wakeIdle: true };

/** 注入配置（init 调用；单测/未注入场景使用默认值） */
export function configureBackgroundNotify(opts: Partial<BackgroundNotifyOptions>): void {
  options = {
    enabled: opts.enabled ?? options.enabled,
    tailLines: Math.max(1, opts.tailLines ?? options.tailLines),
    maxChars: Math.max(100, opts.maxChars ?? options.maxChars),
    wakeIdle: opts.wakeIdle ?? options.wakeIdle,
  };
}

export function backgroundNotifyOptions(): BackgroundNotifyOptions {
  return { ...options };
}

// 20261105-001 D2：剥离 ANSI 转义序列（CSI 颜色/光标、OSC 标题/超链接、字符集选择、单字符序列），
// 避免彩色输出污染注入文本（模型 token）与界面渲染（ESC 显示为 □ 乱码）
const ANSI_RE = /\x1B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|\([0-9A-B]|[@-_])/g;

/** 净化日志文本：剥离 ANSI；行内 \r 覆写（进度条）取最终态（20261105-001 D1/D2） */
export function sanitizeLogText(text: string): string {
  if (!text) return '';
  return text
    .replace(ANSI_RE, '')
    .split('\n')
    .map((line) => {
      const i = line.lastIndexOf('\r');
      return i >= 0 ? line.slice(i + 1) : line;
    })
    .join('\n');
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

    let tail = sanitizeLogText(logTail).trimEnd();
    if (!tail) tail = '(无输出 / 日志已清理)';
    const lines = tail.split('\n');
    if (lines.length > tailLines) tail = lines.slice(-tailLines).join('\n');
    if (tail.length > maxChars) tail = `…${tail.slice(-maxChars)}`;

    return [
      BACKGROUND_NOTICE_OPEN,
      `taskId: ${task.taskId}`,
      `command: ${task.command}`,
      `status: ${statusLine(task)}`,
      `duration: ${durationSec}s`,
      'logTail:',
      tail,
      BACKGROUND_NOTICE_CLOSE,
    ].join('\n');
}

/** 通知文本边界（渲染与识别共用，定义见 types.ts，避免字符串漂移） */
export { BACKGROUND_NOTICE_CLOSE, BACKGROUND_NOTICE_OPEN, isBackgroundNoticeContent } from '../types.js';

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
    // 空闲唤醒（需求 20261108-002）：入队成功后请求 API 层唤醒该会话；
    // 无归属（sessionId=''）不唤醒——没有可定位的目标会话，维持纯被动注入。
    if (bucket) requestWake(bucket);
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

/**
 * 空闲唤醒监听器（需求 20261108-002）：任务在会话空闲期间完成时，
 * 由 API 层注册的回调以合成输入发起一轮 run 消费通知（镜像子 Agent 情况2 唤醒）。
 * 进程级单监听器（API server 创建时注册）；CLI 无运行循环，不注册即维持纯被动注入。
 */
type WakeListener = (sessionId: string) => void;
let wakeListener: WakeListener | null = null;

/** 注册空闲唤醒回调（返回注销函数；重复注册覆盖旧监听器） */
export function onBackgroundNoticeWake(listener: WakeListener): () => void {
  wakeListener = listener;
  return () => {
    if (wakeListener === listener) wakeListener = null;
  };
}

/** enqueueFromTask 内部通知：入队成功且 wakeIdle 开启时请求唤醒 */
function requestWake(sessionId: string): void {
  if (!options.wakeIdle) return;
  try {
    wakeListener?.(sessionId);
  } catch (e) {
    debug.log(`后台通知唤醒请求失败: ${e instanceof Error ? e.message : String(e)}`);
  }
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
      // 去重标记（需求 20261107-007 S3）：notifiedAt 落盘失败会导致进程重启后
      // restoreBackgroundNotices 把同一通知再补投一次（历史重复段的来源之一）。
      // 先重试两次；仍失败则**保留 queued 标记**——本进程内不会再入队，最多付出
      // 「跨重启重复一次」的代价，而不是每次都重复。
      if (markNotifiedWithRetry(notice.taskId)) {
        queued.delete(notice.taskId);
      } else {
        debug.log(
          `通知去重标记最终失败 ${notice.taskId}：本进程保留内存去重，重启后可能重复补投一次`,
        );
      }
    }
  }
  return texts;
}

/** 只看不取：run 收尾时判断是否需要兜底唤醒（需求 20261108-002） */
export function peekBackgroundNotices(sessionId: string): string[] {
  if (!options.enabled) return [];
  const buckets = sessionId && sessionId !== '' ? [sessionId, ''] : [''];
  const texts: string[] = [];
  for (const bucket of buckets) {
    const list = queues.get(bucket);
    if (!list) continue;
    for (const notice of list) texts.push(notice.text);
  }
  return texts;
}

/** notifiedAt 落盘（带重试）：返回是否成功 */
function markNotifiedWithRetry(taskId: string, attempts = 3): boolean {
  for (let i = 0; i < attempts; i++) {
    try {
      backgroundTasks.markNotified(taskId);
      return true;
    } catch (e) {
      if (i === attempts - 1) {
        debug.log(
          `通知去重标记失败 ${taskId}（第 ${i + 1} 次）: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  return false;
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

/** 测试专用：清空队列与去重集合（含唤醒监听器，避免跨用例泄漏） */
export function resetBackgroundNoticesForTest(): void {
  queues.clear();
  queued.clear();
  restoredSessions.clear();
  wakeListener = null;
}
