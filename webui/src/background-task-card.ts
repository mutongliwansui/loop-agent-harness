// 后台任务卡片纯函数（需求 20261104-005 D1/D2/D4）
// 独立成 .ts 便于单测：组件只负责渲染与定时器编排。

/** 与后端 BackgroundTaskStatus 一致（本地声明，避免 webui 依赖后端源码） */
export type BackgroundTaskStatus =
  | 'running'
  | 'exited'
  | 'killed'
  | 'orphaned-running'
  | 'orphaned-exited';

/** 工具结果 JSON 识别出的后台任务信息 */
export interface BackgroundResultInfo {
  taskId: string;
  command: string;
  startedAt?: number;
}

const TASK_ID_RE = /^bg_[0-9a-f]{8}_\d+$/;

/** 从 taskId 解析秒级启动时间（bg_<hex8>_<秒>，D2） */
function startedAtFromTaskId(taskId: string): number | undefined {
  const sec = Number(taskId.split('_')[2]);
  return Number.isFinite(sec) ? sec * 1000 : undefined;
}

function safeParse(raw: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* 非 JSON / 中断残片 */
  }
  return undefined;
}

/**
 * 解析 commandRun 后台结果（D2）：仅认 {taskId} 结构，不改工具返回格式。
 * argsJson 用于补齐 command（结果 JSON 本身不含命令原文）。
 */
export function parseBackgroundResult(resultJson: string, argsJson?: string): BackgroundResultInfo | undefined {
  const obj = safeParse(resultJson);
  if (!obj) return undefined;
  const taskId = obj.taskId;
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) return undefined;
  const args = argsJson ? safeParse(argsJson) : undefined;
  const command = typeof obj.command === 'string'
    ? obj.command
    : typeof args?.command === 'string' ? args.command : '';
  return { taskId, command, startedAt: startedAtFromTaskId(taskId) };
}

export type Tone = 'run' | 'ok' | 'warn' | 'danger' | 'dim';

/** 状态 → 色调（3.3 状态映射） */
export function statusTone(status: string, exitCode?: number | null): Tone {
  switch (status) {
    case 'running': return 'run';
    case 'exited': return exitCode === 0 ? 'ok' : 'danger';
    case 'killed': return 'warn';
    case 'orphaned-running': return 'warn';
    default: return 'dim';
  }
}

/** 状态 → pill 文案 */
export function statusLabel(status: string, exitCode?: number | null): string {
  switch (status) {
    case 'running': return '运行中';
    case 'exited': return exitCode === 0 ? '已完成' : `失败（退出码 ${exitCode ?? '未知'}）`;
    case 'killed': return '已停止';
    case 'orphaned-running': return '失联（可能仍在运行）';
    case 'orphaned-exited': return '失联（已结束）';
    default: return '未知';
  }
}

/** 是否为可停止/可轮询的运行态 */
export function isActive(status: string): boolean {
  return status === 'running' || status === 'orphaned-running';
}

/** 轮询间隔（D1/D4）：0 = 停止轮询；页面隐藏时降频 15s */
export function pollDelay(status: string, hidden: boolean): number {
  if (status === 'running') return hidden ? 15000 : 2000;
  if (status === 'orphaned-running') return hidden ? 15000 : 10000;
  return 0;
}

/** 耗时展示：mm:ss（≥1h 时 h:mm:ss） */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 日志大小展示 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** 兜底：后端返回的字符串状态收敛到合法枚举（未知值走 dim 分支） */
export function isKnownStatus(status: string): status is BackgroundTaskStatus {
  return ['running', 'exited', 'killed', 'orphaned-running', 'orphaned-exited'].includes(status);
}
