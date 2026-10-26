// 记忆页「自动晋升」相关的共享类型（需求 20261026-003 / 任务 20261026-003-02）
//
// 单独成文件的原因：`<script setup>` 里不能写 `export`（SFC 编译期报错），
// 而 DreamStatus / DreamRunRecord 需要被视图与两个子组件共用。

/** GET /memory/status 的 dreaming 字段（D9 扩展后；intervalHours/startupDelayMin 为兼容保留，已废弃） */
export interface DreamStatus {
  enabled: boolean;
  scheduleEnabled: boolean;
  running: boolean;
  /** 当前生效的 cron 表达式（intervalMode==='interval' 时为空串） */
  cron: string;
  cronValid: boolean;
  cronError?: string;
  /** 中文可读描述，如「每天 03:00」 */
  describe?: string;
  /** 服务器本地时区偏移（分钟，东八区 480） */
  timezoneOffsetMin: number;
  misfireGraceMin: number;
  intervalMode: 'cron' | 'interval';
  /** 未来若干次触发时刻（ISO，服务器已按本地时区算好） */
  nextRunTimes: string[];
  nextRunAt?: string;
  lastProcessedDay?: string;
  lastRunAt?: string;
  lastSummary?: { reason: string; promoted: number; skipped: number; errors: number; ok: boolean };
  /** @deprecated cron 生效时忽略，仅兼容旧服务端 */
  intervalHours?: number;
  /** @deprecated cron 生效时忽略，仅兼容旧服务端 */
  startupDelayMin?: number;
}

/** 单条运行记录（对应 src/memory/dream-runs.ts 的 DreamRunRecord） */
export interface DreamRunRecord {
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
  reason: 'schedule' | 'manual' | 'shutdown';
  catchup?: boolean;
  ok: boolean;
  skippedBecause?: 'busy' | 'already-running' | 'missed' | 'disabled' | 'no-runtime';
  daysBack: number;
  promoted: number;
  skipped: number;
  errors: number;
  errorMessage?: string;
}
