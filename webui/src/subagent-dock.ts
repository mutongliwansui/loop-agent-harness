// 后台子任务指示器的纯展示逻辑（2026-11-07 样式重设计）
//
// 组件只负责布局与交互，取数/格式化/裁剪规则集中在这里，便于 Node vitest 直测。
// 数据源沿用 SubAgentTaskVM（GET /sessions/:id/subagents 轮询快照），本模块不引入 Vue。
import type { SubAgentTaskVM } from './chat-stream.js';

/** 收起态最多展示的任务 chip 数，超出折叠为「+N」 */
export const DOCK_MAX_CHIPS = 3;
/** 单任务时 chip 里任务短名的最大长度 */
export const DOCK_SHORT_TITLE_MAX = 18;
/** 展开行失败摘要的最大长度 */
export const DOCK_ERROR_MAX = 60;

/** 毫秒 → 「42s」/「2m14s」（与过程区 fmtSecs 的「10s 以下带小数」不同，这里只到秒） */
export function formatDockElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** 任务当前耗时：运行中按本地走表（接口 elapsedMs 只是 2s 采样点），终态用落盘值 */
export function dockTaskElapsed(task: SubAgentTaskVM, now: number): number {
  if (task.status === 'running') return Math.max(0, now - (task.startedAt ?? now));
  return Math.max(0, task.elapsedMs ?? 0);
}

/** 收起态聚合耗时：运行中任务的最大耗时（无任务时 0） */
export function dockTotalElapsed(tasks: SubAgentTaskVM[], now: number): number {
  return tasks.reduce((max, t) => Math.max(max, dockTaskElapsed(t, now)), 0);
}

/** 收起态 chips：序号与展开列表一致，最多 DOCK_MAX_CHIPS 个 */
export interface DockChip {
  taskId: string;
  /** 从 1 开始的序号 */
  index: number;
  /** 已耗时文案 */
  elapsed: string;
  /** 完整任务标题（chip 的 title 提示用） */
  title: string;
}

export function dockChips(tasks: SubAgentTaskVM[], now: number, max = DOCK_MAX_CHIPS): DockChip[] {
  return tasks.slice(0, Math.max(0, max)).map((t, i) => ({
    taskId: t.taskId,
    index: i + 1,
    elapsed: formatDockElapsed(dockTaskElapsed(t, now)),
    title: dockTaskTitle(t.task),
  }));
}

/** 超出 chip 上限的任务数（0 表示不显示「+N」） */
export function dockOverflow(count: number, max = DOCK_MAX_CHIPS): number {
  return Math.max(0, count - max);
}

/** 任务标题：折叠空白为单行；空描述给占位文案 */
export function dockTaskTitle(task: string | undefined): string {
  const one = (task ?? '').replace(/\s+/g, ' ').trim();
  return one || '（无描述）';
}

/** 单任务时 chip 里的短名：超长截断加省略号 */
export function dockShortTitle(task: string | undefined, max = DOCK_SHORT_TITLE_MAX): string {
  const one = dockTaskTitle(task);
  if (one === '（无描述）') return '';
  const chars = [...one];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : one;
}

/** 失败摘要：首个非空行、截 DOCK_ERROR_MAX 字 */
export function dockErrorLine(error: string | undefined, max = DOCK_ERROR_MAX): string {
  const line = (error ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? '';
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : line;
}

/** 展开行状态词（收起态计数固定用「运行中」） */
export function dockStatusLabel(status: SubAgentTaskVM['status']): string {
  switch (status) {
    case 'running':
      return '进行中';
    case 'done':
      return '完成';
    case 'failed':
      return '失败';
    case 'aborted':
      return '已取消';
    default:
      return '已中断';
  }
}
