// 模型性能测试历史落盘（需求 20261027-003 / 设计方案 §5.4）
//
// 路径：~/.loop-agent/model-bench/history.json（与 sessions/ memory/ logs/ 同级惯例）
// 纪律：
// - 每模型（alias）只留最近 BENCH_HISTORY_KEEP 次，超出裁剪
// - 只存 baseUrlHost，绝不落 apiKey（新的持久化面不引入密钥）
// - 写入沿用「同目录临时文件 + rename」原子写法（与 session/store.ts 一致）

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BenchPromptKey, BenchSummary } from './bench.js';

/** 默认根目录 */
export function defaultBenchRoot(): string {
  return join(homedir(), '.loop-agent', 'model-bench');
}

/** 每个模型保留的历史条数 */
export const BENCH_HISTORY_KEEP = 20;

/** 历史文件版本（结构变更时递增，读取侧按缺省容错） */
export const BENCH_HISTORY_VERSION = 1;

/** 一次测试的配置快照 */
export interface BenchRunConfig {
  tier?: string;
  prompts: BenchPromptKey[];
  rounds: number;
  maxTokens: number;
  bustCache: boolean;
  timeoutMs?: number;
  concurrency?: number;
}

/** 一条历史记录 */
export interface BenchHistoryEntry {
  runId: string;
  alias: string;
  /** 被测时的型号快照（同名不同版本会让趋势断裂，故单独存） */
  model: string;
  /** 被测时的地址主机（不含路径与密钥） */
  baseUrlHost: string;
  startedAt: string;
  finishedAt: string;
  config: BenchRunConfig;
  summary: BenchSummary;
}

export interface BenchHistoryFile {
  version: number;
  runs: BenchHistoryEntry[];
}

export function benchHistoryPath(root: string): string {
  return join(root, 'history.json');
}

/** host 提取（解析失败时回落原始串的前 64 字符，绝不返回含凭证的完整 URL） */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl.replace(/\/\/[^@]*@/, '//').slice(0, 64);
  }
}

/** 读历史（文件缺失 / 损坏一律返回空表，不抛错——历史是附属能力） */
export async function readBenchHistory(root: string): Promise<BenchHistoryFile> {
  try {
    const raw = await readFile(benchHistoryPath(root), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BenchHistoryFile>;
    const runs = Array.isArray(parsed?.runs) ? parsed.runs.filter(isEntry) : [];
    return { version: typeof parsed?.version === 'number' ? parsed.version : BENCH_HISTORY_VERSION, runs };
  } catch {
    return { version: BENCH_HISTORY_VERSION, runs: [] };
  }
}

function isEntry(v: unknown): v is BenchHistoryEntry {
  const e = v as BenchHistoryEntry | null;
  return !!e && typeof e.runId === 'string' && typeof e.alias === 'string' && typeof e.startedAt === 'string';
}

/** 按 alias 裁剪到最近 keep 条（keep 之后追加的排前面：数组按「新→旧」存） */
export function pruneRuns(runs: BenchHistoryEntry[], keep = BENCH_HISTORY_KEEP): BenchHistoryEntry[] {
  const byAlias = new Map<string, number>();
  const out: BenchHistoryEntry[] = [];
  for (const r of runs) {
    const n = byAlias.get(r.alias) ?? 0;
    if (n >= keep) continue;
    byAlias.set(r.alias, n + 1);
    out.push(r);
  }
  return out;
}

/** 追加一条记录并原子写回（超限的旧记录被裁掉） */
export async function appendBenchHistory(
  root: string,
  entry: BenchHistoryEntry,
  keep = BENCH_HISTORY_KEEP,
): Promise<BenchHistoryFile> {
  const current = await readBenchHistory(root);
  const runs = pruneRuns([entry, ...current.runs], keep);
  const payload: BenchHistoryFile = { version: BENCH_HISTORY_VERSION, runs };
  const file = benchHistoryPath(root);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  return payload;
}

/**
 * 查询历史：
 * - 带 alias → 该模型最近 n 次（新→旧）
 * - 不带 alias → 每个模型最近一次（模型页首屏「性能」列用）
 */
export function queryHistory(
  all: BenchHistoryFile,
  opts: { alias?: string; limit?: number } = {},
): BenchHistoryEntry[] {
  const limit = Math.max(1, Math.min(BENCH_HISTORY_KEEP, opts.limit ?? BENCH_HISTORY_KEEP));
  if (opts.alias) return all.runs.filter((r) => r.alias === opts.alias).slice(0, limit);
  const seen = new Set<string>();
  const out: BenchHistoryEntry[] = [];
  for (const r of all.runs) {
    if (seen.has(r.alias)) continue;
    seen.add(r.alias);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}
