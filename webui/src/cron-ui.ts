// 记忆页「自动晋升」定时交互的纯函数（需求 20261026-003 / 任务 20261026-003-02 D11）
//
// 设计原则：前端**不实现** cron 解析与下一次触发计算——一律调 GET /memory/dream/preview，
// 由 src/api/cron.ts 单点提供，避免双实现漂移。本文件只做两件事：
//   ① 图形档位（每天 / 每周）与 cron 字符串互转；
//   ② 时间文案格式化（绝对 / 相对 / 耗时）。
// 无副作用、无 DOM 依赖，便于单测与在多个组件间复用。

/** 触发时间输入档位：每天 HH:mm / 每周 X HH:mm / 自定义 cron */
export type CronMode = 'daily' | 'weekly' | 'cron';

/** 图形档位的完整状态（自定义档时以 raw 为准） */
export interface CronUiState {
  mode: CronMode;
  hour: number;
  minute: number;
  /** 星期：0=周日 … 6=周六（与 cron 的 day-of-week 口径一致） */
  dow: number;
  /** 自定义档的 cron 原文 */
  raw: string;
}

/** 星期标签（索引即 cron day-of-week） */
export const DOW_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** 默认档位：每天 03:00（与后端 memory.dreaming.schedule.cron 默认值一致） */
export const DEFAULT_STATE: CronUiState = { mode: 'daily', hour: 3, minute: 0, dow: 1, raw: '0 3 * * *' };

/** 两位补零 */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 整数夹取（用于输入框容错，非数字回落默认值） */
export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** 「每天 HH:mm」→ cron（`m h * * *`） */
export function hhmmToCron(hour: number, minute: number): string {
  return `${clampInt(minute, 0, 59, 0)} ${clampInt(hour, 0, 23, 3)} * * *`;
}

/** 「每周 X HH:mm」→ cron（`m h * * dow`，周日写 0） */
export function weeklyToCron(dow: number, hour: number, minute: number): string {
  return `${clampInt(minute, 0, 59, 0)} ${clampInt(hour, 0, 23, 3)} * * ${clampInt(dow, 0, 6, 1)}`;
}

/** 由界面状态得到最终 cron 表达式（自定义档原样返回，空白回落默认值） */
export function buildCron(s: Pick<CronUiState, 'mode' | 'hour' | 'minute' | 'dow' | 'raw'>): string {
  if (s.mode === 'cron') return s.raw.trim() || DEFAULT_STATE.raw;
  if (s.mode === 'weekly') return weeklyToCron(s.dow, s.hour, s.minute);
  return hhmmToCron(s.hour, s.minute);
}

/** 单个字段是否为纯数字（反解档位用） */
function asNum(part: string | undefined, min: number, max: number): number | null {
  if (!part || !/^\d+$/.test(part)) return null;
  const n = Number(part);
  return n >= min && n <= max ? n : null;
}

/**
 * cron → 图形档位反解。
 * 命中「每天 / 每周」的规则形态时回填对应档位，否则落自定义档并保留原文。
 */
export function cronToState(expr: string): CronUiState {
  const raw = (expr ?? '').trim();
  const base: CronUiState = { ...DEFAULT_STATE, raw: raw || DEFAULT_STATE.raw };
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return { ...base, mode: 'cron' };

  const minute = asNum(parts[0], 0, 59);
  const hour = asNum(parts[1], 0, 23);
  if (minute === null || hour === null || parts[2] !== '*' || parts[3] !== '*') {
    return { ...base, mode: 'cron' };
  }
  // 每天：`m h * * *`
  if (parts[4] === '*') return { ...base, mode: 'daily', hour, minute };
  // 每周：`m h * * d`（周日容忍 7）
  const dow = parts[4] === '7' ? 0 : asNum(parts[4], 0, 6);
  if (dow === null) return { ...base, mode: 'cron' };
  return { ...base, mode: 'weekly', hour, minute, dow };
}

/** ISO 字符串 → 本地 `YYYY-MM-DD HH:mm`（无法解析时原样返回） */
export function fmtLocal(iso?: string | number | null): string {
  if (iso === undefined || iso === null || iso === '') return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** ISO 字符串 → 本地 `MM-DD HH:mm`（列表里省年份） */
export function fmtShort(iso?: string | number | null): string {
  if (iso === undefined || iso === null || iso === '') return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 相对时间文案：「还有 4 小时 47 分」/「已过期 3 分」。
 * 与设计原型 rel() 一致：只列非零单位；不足 1 分钟时给出秒数。
 */
export function relText(target: string | number, nowMs: number = Date.now()): string {
  const t = typeof target === 'number' ? target : new Date(target).getTime();
  if (!Number.isFinite(t)) return '—';
  const ms = t - nowMs;
  const sec = Math.max(0, Math.round(Math.abs(ms) / 1000));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d} 天`);
  if (h) parts.push(`${h} 小时`);
  if (m) parts.push(`${m} 分`);
  if (!d && !h && !m) parts.push(`${s} 秒`);
  return `${ms >= 0 ? '还有' : '已过期'} ${parts.join(' ')}`;
}

/** 耗时文案：`123.1s` / `2m03s`（与设计原型 dur() 一致） */
export function durText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${pad2(s)}s`;
}

/** 时区偏移（分钟，东八区为 480）→ `UTC+08:00` */
export function tzLabel(offsetMin: number | undefined | null): string {
  if (typeof offsetMin !== 'number' || !Number.isFinite(offsetMin)) return '服务器本地时间';
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(Math.round(offsetMin));
  return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}
