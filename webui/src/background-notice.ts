// 后台任务完成通知解析（需求 20261105-001 D3/D4/D7）
// 独立成 .ts 便于单测：组件只负责渲染与折叠交互。
import type { Tone } from './background-task-card.js';

/** 通知卡片视图数据（从 user 消息文本解析） */
export interface BackgroundNoticeInfo {
  taskId: string;
  command: string; // 可 ''
  statusText: string; // 原始 status 行，如 'exited (exitCode=1)'
  exitCode: number | null; // killed / 解析不出 → null
  killed: boolean;
  durationSec: number | null;
  logTail: string; // 已兜底剥离 ANSI（历史脏数据），可 ''
  logLines: number;
}

const OPEN = '<background_task_notification>';
const CLOSE = '</background_task_notification>';

// 与后端 background-notice.ts 同形正则（两侧各自独立实现，不跨端 import）
const ANSI_RE = /\x1B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|\([0-9A-B]|[@-_])/g;

/** 剥离 ANSI + 收敛 \r 行内覆写（渲染层兜底：历史已落盘的脏通知同样干净） */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

function collapseCarriageReturn(text: string): string {
  if (!text.includes('\r')) return text;
  return text
    .split('\n')
    .map((line) => {
      const i = line.lastIndexOf('\r');
      return i >= 0 ? line.slice(i + 1) : line;
    })
    .join('\n');
}

/**
 * D3 整体精确匹配：trim 后以开标签开头、闭标签结尾才视为通知；
 * D4 容错：缺 taskId / status 行不认识 → undefined（降级纯文本）；
 * command/duration/logTail 可缺省。
 */
export function parseBackgroundNotice(text: string): BackgroundNoticeInfo | undefined {
  // 旧版本通知曾被当作普通 user 消息，可能被 L2 记忆前缀包裹（20261105-001 D9 兼容）
  const MEMORY_END = '<<<LOOP_AGENT_MEMORY_END_7f3a9c2e>>>';
  const memAt = text.lastIndexOf(MEMORY_END);
  const body = memAt >= 0 ? text.slice(memAt + MEMORY_END.length) : text;
  const trimmed = body.trim();
  if (!trimmed.startsWith(OPEN) || !trimmed.endsWith(CLOSE)) return undefined;
  const inner = trimmed.slice(OPEN.length, trimmed.length - CLOSE.length).replace(/^\n+|\s+$/g, '');

  const tailIdx = inner.indexOf('\nlogTail:');
  const head = tailIdx >= 0 ? inner.slice(0, tailIdx) : inner;
  const rawTail = tailIdx >= 0 ? inner.slice(tailIdx + '\nlogTail:'.length).replace(/^\n/, '') : '';

  const fields = new Map<string, string>();
  for (const line of head.split('\n')) {
    const m = /^(\w+):[ \t]?(.*)$/.exec(line);
    if (m) fields.set(m[1], m[2]);
  }
  const taskId = fields.get('taskId') ?? '';
  const statusText = fields.get('status') ?? '';
  if (!taskId || !statusText) return undefined;

  const killed = /^killed/.test(statusText);
  const exited = /^exited/.test(statusText);
  if (!killed && !exited) return undefined; // status 行不认识 → 降级纯文本
  const codeMatch = /exitCode=(\d+)/.exec(statusText);

  const durText = fields.get('duration') ?? '';
  const durMatch = /^([\d.]+)s$/.exec(durText);

  const logTail = collapseCarriageReturn(stripAnsi(rawTail)).trimEnd();
  return {
    taskId,
    command: fields.get('command') ?? '',
    statusText,
    exitCode: codeMatch ? Number(codeMatch[1]) : null,
    killed,
    durationSec: durMatch ? Number(durMatch[1]) : null,
    logTail,
    logLines: logTail ? logTail.split('\n').length : 0,
  };
}

/** 通知状态 → 色调（复用任务卡片 Tone 体系） */
export function noticeTone(n: BackgroundNoticeInfo): Tone {
  if (n.killed) return 'warn';
  if (n.exitCode === 0) return 'ok';
  if (n.exitCode != null) return 'danger';
  return 'dim';
}

/** 通知状态 → pill 文案 */
export function noticeLabel(n: BackgroundNoticeInfo): string {
  if (n.killed) return '已停止';
  if (n.exitCode === 0) return '已完成';
  if (n.exitCode != null) return `失败（退出码 ${n.exitCode}）`;
  return '已结束';
}
