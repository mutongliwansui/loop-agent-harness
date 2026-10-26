// 记忆晋升（Dreaming）运行历史（Task-20261026-003-01 / 方案 D7、D8）
//
// 为什么独立文件而不塞进 .dreaming-state.json：
// - 后者承载「增量正确性」（lastProcessedDay / lastSummary），每次 run() 都会整文件重写；
//   把几十 KB 的数组跟着重写、且其损坏回退逻辑会连带丢失历史，风险不对等
// - 本文件只是展示数据：展示层 bug 不得污染增量状态；「清空历史」也不应触碰增量进度
//
// 设计要点：
// - 环形裁剪到 limit（默认 20，0 = 不落盘）
// - 写入用 tmp → rename 原子替换，避免半截文件；Windows 下同目录 rename 可覆盖
// - 一切异常（读损坏 / 写失败）只记 debug 日志，绝不抛出——历史是旁路，不允许影响晋升主链路
// - 只记「真跑」与「有意义跳过」：disabled / no-runtime 不入库（每轮都产生噪声，无观测价值）

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { debug } from '../debug.js';

/** 触发来源 */
export type DreamRunReason = 'schedule' | 'shutdown' | 'manual';

/** 未真正执行的原因（有值即 skippedBecause 摘要） */
export type DreamRunSkipReason = 'disabled' | 'busy' | 'already-running' | 'no-runtime' | 'missed';

/** 单条运行记录（对外直接给 WebUI 用） */
export interface DreamRunRecord {
  /** ISO 时间 */
  startedAt: string;
  /** ISO 时间 */
  finishedAt: string;
  durationMs: number;
  reason: DreamRunReason;
  /** 是否补跑（错过触发点但在宽限内） */
  catchup?: boolean;
  /** 后端口径：errors === 0；注意 promoted>0 且 !ok 时前端应展示「部分失败」 */
  ok: boolean;
  skippedBecause?: DreamRunSkipReason;
  /** 实际读取窗口（天） */
  daysBack: number;
  promoted: number;
  skipped: number;
  errors: number;
  /** 异常摘要（截断 200 字符） */
  errorMessage?: string;
}

/** 历史文件结构（version 预留升级位） */
interface RunsFile {
  version: number;
  runs: DreamRunRecord[];
}

const FILE_VERSION = 1;
/** errorMessage 截断长度（方案 D8） */
const ERROR_MAX = 200;

/** 异常信息摘要（截断 + 去换行） */
export function truncateError(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > ERROR_MAX ? `${one.slice(0, ERROR_MAX)}…` : one;
}

/** 容错解析：任何异常 / 结构不符都回落空列表 */
function parseRuns(raw: string): DreamRunRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const runs = (data as RunsFile | null)?.runs;
  if (!Array.isArray(runs)) return [];
  return runs.filter((r): r is DreamRunRecord => Boolean(r) && typeof (r as DreamRunRecord).startedAt === 'string');
}

/**
 * 晋升运行历史（单文件、环形、同步 IO）。
 *
 * 为何同步：单文件几十 KB，且写入发生在晋升链路收尾处；异步化会给主链路引入额外时序与
 * 「进程退出时写入丢失」的窗口，收益不抵复杂度。
 */
export class DreamRunLog {
  private readonly file: string;
  private readonly limit: number;

  constructor(opts: { file: string; limit: number }) {
    this.file = opts.file;
    this.limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 0;
  }

  /** 历史是否启用（limit=0 时完全不落盘，也不读盘） */
  get enabled(): boolean {
    return this.limit > 0;
  }

  /** 读历史（新 → 旧）；文件缺失 / 损坏返回空列表 */
  list(limit?: number): DreamRunRecord[] {
    if (!this.enabled) return [];
    const max = Number.isFinite(limit) && (limit as number) > 0 ? Math.floor(limit as number) : this.limit;
    try {
      if (!existsSync(this.file)) return [];
      const runs = parseRuns(readFileSync(this.file, 'utf-8'));
      // 文件内已按「新 → 旧」存储，直接截断
      return runs.slice(0, max);
    } catch (e) {
      debug.log(`[dream] 读取运行历史失败（按空列表处理）: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /** 追加一条（插到最前，环形裁剪）；失败只记 debug 日志 */
  append(rec: DreamRunRecord): void {
    if (!this.enabled) return;
    try {
      const prev = existsSync(this.file) ? parseRuns(readFileSync(this.file, 'utf-8')) : [];
      const runs = [rec, ...prev].slice(0, this.limit);
      this.write(runs);
    } catch (e) {
      debug.log(`[dream] 写入运行历史失败（忽略）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 清空历史，返回删除条数；失败返回 0 */
  clear(): number {
    if (!this.enabled) return 0;
    try {
      const prev = existsSync(this.file) ? parseRuns(readFileSync(this.file, 'utf-8')) : [];
      this.write([]);
      return prev.length;
    } catch (e) {
      debug.log(`[dream] 清空运行历史失败（忽略）: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    }
  }

  /** 原子写：先写 .tmp 再 rename 覆盖 */
  private write(runs: DreamRunRecord[]): void {
    const payload: RunsFile = { version: FILE_VERSION, runs };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    renameSync(tmp, this.file);
  }
}
