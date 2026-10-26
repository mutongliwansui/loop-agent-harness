// 模型性能测试前端映射层（需求 20261027-003）
//
// 只放纯函数：数值格式化、色档判定、条形图/迷你走势的几何计算、配置摘要文案。
// 无 DOM、无 fetch 依赖 → 可在 Node vitest 下直测（同 tool-meta.ts 的约定）。
//
// 色档阈值（与设计方案 §6 一致，可调）：
// - TTFT ≤ 800ms 好 / ≤ 2000ms 一般 / 更高差
// - 解码吞吐 ≥ 40 tok/s 好 / ≥ 20 一般 / 更低差
// - 成功率 100% 好 / ≥ 60% 一般 / 更低差

export type BenchTone = 'good' | 'warn' | 'bad' | 'none';

export interface PercentilesVM {
  p50: number | null;
  p90: number | null;
  min: number | null;
  max: number | null;
  count: number;
}

export interface BenchSampleVM {
  prompt: string;
  round: number;
  ok: boolean;
  ttftMs?: number;
  firstReasoningMs?: number;
  firstContentMs?: number;
  tpotMs?: number;
  itlP90Ms?: number;
  decodeTps?: number;
  e2eTps?: number;
  totalMs?: number;
  outTokens?: number;
  promptTokens?: number;
  cacheHitTokens?: number;
  estimated?: boolean;
  chunkCount?: number;
  suspectBuffered?: boolean;
  errorKind?: string;
  error?: string;
}

export interface BenchSummaryVM {
  samples: BenchSampleVM[];
  total: number;
  okCount: number;
  successRate: number;
  ttft: PercentilesVM;
  decodeTps: PercentilesVM;
  tpot: PercentilesVM;
  e2eTps: PercentilesVM;
  itlP90Ms: PercentilesVM;
  outTokens: PercentilesVM;
  estimated: boolean;
  suspectBuffered: boolean;
  totalTps: number | null;
  wallMs: number;
  aborted: boolean;
  errorKinds: Record<string, number>;
}

export interface BenchModelResultVM {
  alias: string;
  model: string;
  baseUrlHost: string;
  summary: BenchSummaryVM;
}

export interface BenchRunConfigVM {
  tier?: string;
  prompts: string[];
  rounds: number;
  maxTokens: number;
  bustCache: boolean;
  timeoutMs?: number;
  concurrency?: number;
}

export interface BenchHistoryEntryVM {
  runId: string;
  alias: string;
  model: string;
  baseUrlHost: string;
  startedAt: string;
  finishedAt: string;
  config: BenchRunConfigVM;
  summary: BenchSummaryVM;
}

/** 提示词档位中文名（与后端 BENCH_PROMPTS.label 对齐，前端不 import 后端模块） */
export const PROMPT_LABELS: Record<string, string> = {
  short: '短问答',
  medium: '中文写作',
  code: '代码改写',
};

export const TIER_LABELS: Record<string, string> = {
  quick: '快速',
  standard: '标准',
};

export function promptLabel(key: string): string {
  return PROMPT_LABELS[key] ?? key;
}

/** 时间：null/undefined → 破折号；< 1000ms 取整毫秒，否则秒（两位小数） */
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** 吞吐：一位小数；空值破折号（不写 0，0 是「有数据但极慢」的明确语义） */
export function fmtTps(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toFixed(1);
}

/** 百分比 */
export function fmtPct(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${Math.round(ratio * 100)}%`;
}

/** 分位数文本：样本不足（p90 为 null）时明确写「样本不足」而不是 — */
export function fmtP(p: PercentilesVM, key: 'p50' | 'p90'): string {
  const v = p[key];
  if (v === null || v === undefined) return key === 'p90' && p.count > 0 && p.count < 3 ? '样本不足' : '—';
  return fmtMs(v);
}

export function ttftTone(ms: number | null | undefined): BenchTone {
  if (ms === null || ms === undefined) return 'none';
  if (ms <= 800) return 'good';
  if (ms <= 2000) return 'warn';
  return 'bad';
}

export function tpsTone(v: number | null | undefined): BenchTone {
  if (v === null || v === undefined) return 'none';
  if (v >= 40) return 'good';
  if (v >= 20) return 'warn';
  return 'bad';
}

export function successTone(rate: number | null | undefined): BenchTone {
  if (rate === null || rate === undefined) return 'none';
  if (rate >= 1) return 'good';
  if (rate >= 0.6) return 'warn';
  return 'bad';
}

/** 错误分类中文名（与后端 BenchErrorKind 对应） */
export const ERROR_LABELS: Record<string, string> = {
  auth: 'apiKey 无效',
  not_found: '模型/地址错误',
  rate_limit: '429 限流',
  timeout: '超时',
  network: '连接异常',
  server: '服务端错误',
  aborted: '已中断',
  unknown: '未知错误',
};

export function errorLabel(kind: string | undefined): string {
  if (!kind) return '失败';
  return ERROR_LABELS[kind] ?? kind;
}

/** 主错误（计数最多的那类），用于失败卡标题 */
export function dominantError(kinds: Record<string, number> | undefined): { kind: string; label: string; count: number } | null {
  const entries = Object.entries(kinds ?? {});
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  const [kind, count] = entries[0];
  return { kind, label: errorLabel(kind), count };
}

/** 配置摘要：标准 · 3 轮 × 短+中 · max 256 · 破坏缓存 · 60s */
export function configSummary(cfg: BenchRunConfigVM | null | undefined): string {
  if (!cfg) return '';
  const tier = cfg.tier ? TIER_LABELS[cfg.tier] ?? cfg.tier : '自定义';
  const prompts = cfg.prompts.map(promptLabel).join('+') || '—';
  const cache = cfg.bustCache ? '破坏缓存' : '复用缓存';
  const timeout = cfg.timeoutMs ? `${Math.round(cfg.timeoutMs / 1000)}s` : '60s';
  const conc = cfg.concurrency && cfg.concurrency > 1 ? ` · 并发 ${cfg.concurrency}` : '';
  return `${tier} · ${cfg.rounds} 轮 × ${prompts} · max ${cfg.maxTokens} · ${cache} · ${timeout}${conc}`;
}

/** 预估 token 上限（配置页「预计上限」文案用）：模型数 × 提示词数 × 轮数 × maxTokens */
export function estimateTokens(aliases: number, prompts: number, rounds: number, maxTokens: number): number {
  return Math.max(0, aliases) * Math.max(0, prompts) * Math.max(0, rounds) * Math.max(0, maxTokens);
}

export type SortKey = 'ttft' | 'tps';

/**
 * 对比排序：TTFT 升序（越短越好）；吞吐降序（越高越好）。
 * 没有有效数据的模型沉到末尾（不参与「最优」判定）。
 */
export function sortResults(results: BenchModelResultVM[], by: SortKey): BenchModelResultVM[] {
  const value = (r: BenchModelResultVM): number | null =>
    by === 'ttft' ? r.summary.ttft.p50 : r.summary.decodeTps.p50;
  return [...results].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return a.alias.localeCompare(b.alias);
    if (va === null) return 1;
    if (vb === null) return -1;
    return by === 'ttft' ? va - vb : vb - va;
  });
}

/** 最优者下标（无有效数据返回 -1） */
export function bestIndex(results: BenchModelResultVM[], by: SortKey): number {
  const sorted = sortResults(results, by);
  const v = by === 'ttft' ? sorted[0]?.summary.ttft.p50 : sorted[0]?.summary.decodeTps.p50;
  if (v === null || v === undefined) return -1;
  return results.findIndex((r) => r === sorted[0]);
}

/**
 * 对比条宽度百分比（0~100，最优者恒为 100）：
 * - TTFT：按「占比」反算，best/value（越短越长）
 * - 吞吐：value/best（越高越长）
 */
export function barPct(value: number | null | undefined, best: number | null | undefined, by: SortKey): number {
  if (value === null || value === undefined || best === null || best === undefined) return 0;
  if (value <= 0 || best <= 0) return 0;
  const raw = by === 'ttft' ? (best / value) * 100 : (value / best) * 100;
  return Math.max(0, Math.min(100, Number.isFinite(raw) ? raw : 0));
}

/** 迷你走势折线点串（w×h 视口内的 polyline points） */
export function sparkPoints(values: number[], w: number, h: number, pad = 2): string {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length === 0) return '';
  if (nums.length === 1) return `${pad},${(h / 2).toFixed(1)} ${(w - pad).toFixed(1)},${(h / 2).toFixed(1)}`;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min;
  const stepX = (w - pad * 2) / (nums.length - 1);
  // 全等序列（span = 0）画在中线：若按 (v-min)/1 算会全部贴到底边，
  // 视觉上等于「一直最差」，与事实（稳定无波动）相反。
  if (span === 0) {
    const mid = (h / 2).toFixed(1);
    return nums.map((_v, i) => `${(pad + stepX * i).toFixed(1)},${mid}`).join(' ');
  }
  return nums
    .map((v, i) => {
      const x = pad + stepX * i;
      const y = pad + (1 - (v - min) / span) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** token 脉冲竖条（每根 = 一个非空 chunk，高度按间隔反比：间隔越短条越高） */
export interface PulseBar {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function pulseBars(intervals: number[], w: number, h: number): PulseBar[] {
  const list = intervals.slice(-120);
  if (list.length === 0) return [];
  const max = Math.max(...list, 1);
  const barW = Math.max(1, Math.min(6, w / (list.length * 1.6)));
  const gap = barW * 0.6;
  return list.map((itv, i) => {
    const ratio = Math.max(0.12, 1 - itv / max);
    const barH = Math.max(2, ratio * h);
    return { x: i * (barW + gap), y: h - barH, w: barW, h: barH };
  });
}

/** 变化率（当前 vs 上次，用于历史行的 ↑↓ 标色）：上次为空返回 null */
export function changePct(prev: number | null | undefined, cur: number | null | undefined): number | null {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return null;
  if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev === 0) return null;
  return ((cur - prev) / prev) * 100;
}

/** ISO 时间 → MM-DD HH:mm（固定的本地时区，不用 Intl 以避免环境差异） */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 结论一句话（完成态顶部用，不做模型评价，只陈述事实） */
export function verdictText(r: BenchModelResultVM | null | undefined): string {
  if (!r) return '';
  const s = r.summary;
  if (s.okCount === 0) return '本次没有成功轮次，指标为空';
  const ttft = fmtMs(s.ttft.p50);
  const tps = fmtTps(s.decodeTps.p50);
  const base = `TTFT ${ttft} · 解码 ${tps} tok/s`;
  if (s.suspectBuffered) return `${base}（疑似被网关缓冲，TPS 仅供参考）`;
  if (s.estimated) return `${base}（服务商未回 usage，token 数为估算）`;
  return base;
}
