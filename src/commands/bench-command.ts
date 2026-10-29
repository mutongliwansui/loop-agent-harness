// /model bench —— CLI 模型性能测速（需求 20261029-002）
//
// 设计约束（任务文档 1.4）：
// - 测量一律走 src/llm/bench.ts 的 runBench（同一套提示词、同一套口径），
//   绝不在 CLI 侧另写测量代码——否则与 WebUI 的数字不可比，测速就失去意义
// - 历史一律走 src/llm/bench-store.ts（与 WebUI 共享 ~/.loop-agent/model-bench/history.json）
// - 多模型严格串行（沿用 API 侧 D3），不暴露引擎的 concurrency
// - 表框与变化标记只用 ASCII（GBK 终端安全）
// - 唯一动 start.ts 的地方是把测速纳入 Ctrl+C 的 abort 目标（D7）

import { randomUUID } from 'node:crypto';
import type { AgentConfig } from '../config/schema.js';
import type { ModelCandidate } from '../llm/connectivity.js';
import {
  BENCH_PROMPTS,
  BENCH_TIERS,
  runBench,
  type BenchPromptKey,
  type BenchRunner as EngineRunner,
  type BenchSummary,
  type BenchTier,
} from '../llm/bench.js';
import {
  BENCH_HISTORY_KEEP,
  appendBenchHistory,
  defaultBenchRoot,
  hostOf,
  pruneRuns,
  queryHistory,
  readBenchHistory,
  type BenchHistoryEntry,
  type BenchHistoryFile,
} from '../llm/bench-store.js';
import { BenchLiveView } from '../ui/bench-view.js';
import { COLORS } from '../ui/colors.js';
import type { CommandContext } from './registry.js';

/** 单次最多对比几个模型（对齐 API 的 MAX_ALIASES） */
export const MAX_BENCH_ALIASES = 4;

/** 生效快照回落的虚拟别名（不写历史：它不在登记簿里，写进去会污染趋势） */
export const SNAPSHOT_ALIAS = '(当前快照)';

/** 参数取值区间（与 API 的 intIn 一致；CLI 交互态直接报错而非静默钳制） */
export const BENCH_LIMITS = {
  rounds: { min: 1, max: 10 },
  maxTokens: { min: 32, max: 1024 },
  timeoutSec: { min: 5, max: 180 },
  limit: { min: 1, max: BENCH_HISTORY_KEEP },
} as const;

// ===== 参数解析（纯函数） =====

export interface BenchPlan {
  /** 显式列出的别名（不含 --all 展开结果） */
  aliases: string[];
  /** --all：跑全部已登记（上限 4） */
  all: boolean;
  /** 走 history 分支 */
  history: boolean;
  help: boolean;
  json: boolean;
  tier: BenchTier;
  rounds: number;
  prompts: BenchPromptKey[];
  maxTokens: number;
  timeoutMs: number;
  bustCache: boolean;
  /** history 条数上限 */
  limit: number;
  /** 参数非法时的人话说明；非空即拒绝执行（不 throw，便于单测覆盖全部奇葩输入） */
  error?: string;
}

function intArg(
  flag: string,
  raw: string | undefined,
  range: { min: number; max: number },
): { value: number } | { error: string } {
  if (raw === undefined) return { error: `${flag} 缺少取值` };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < range.min || n > range.max) {
    return { error: `${flag} 需为 ${range.min}–${range.max} 的整数（当前「${raw}」）` };
  }
  return { value: n };
}

/**
 * 解析 `/model bench` 之后的整段参数（D8）：
 * - 位置参数：`history` 视为子命令，其余为模型别名
 * - 其余一律 `--flag`；未知 flag 直接报错（不猜）
 */
export function parseBenchArgs(argv: string[]): BenchPlan {
  const preset = BENCH_TIERS.quick;
  const plan: BenchPlan = {
    aliases: [],
    all: false,
    history: false,
    help: false,
    json: false,
    tier: 'quick',
    rounds: preset.rounds,
    prompts: [...preset.prompts],
    maxTokens: 256,
    timeoutMs: 60_000,
    bustCache: true,
    limit: BENCH_HISTORY_KEEP,
  };

  /** 显式覆盖项：档位预设与覆盖项的合并顺序必须固定（先档位，后显式） */
  let tierRaw: string | undefined;
  let roundsRaw: string | undefined;
  let promptsRaw: string | undefined;
  let maxTokensRaw: string | undefined;
  let timeoutRaw: string | undefined;
  let limitRaw: string | undefined;
  let positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined || tok === '') continue;

    if (!tok.startsWith('-')) {
      positionals.push(tok);
      continue;
    }

    const [flag, inline] = tok.includes('=') ? [tok.slice(0, tok.indexOf('=')), tok.slice(tok.indexOf('=') + 1)] : [tok, undefined];
    const value = (): string | undefined => (inline !== undefined ? inline : argv[++i]);
    /** 取 flag 的取值；缺失时置错误（循环结束后统一返回，避免半截配置） */
    const take = (name: string): string | undefined => {
      const v = value();
      if (v === undefined) plan.error = `${name} 缺少取值`;
      return v;
    };

    switch (flag) {
      case '--help':
      case '-h':
        plan.help = true;
        break;
      case '--all':
        plan.all = true;
        break;
      case '--json':
        plan.json = true;
        break;
      case '--no-bust-cache':
        plan.bustCache = false;
        break;
      case '--tier':
        tierRaw = take('--tier');
        break;
      case '--rounds':
        roundsRaw = take('--rounds');
        break;
      case '--prompts':
        promptsRaw = take('--prompts');
        break;
      case '--max-tokens':
        maxTokensRaw = take('--max-tokens');
        break;
      case '--timeout':
        timeoutRaw = take('--timeout');
        break;
      case '--limit':
        limitRaw = take('--limit');
        break;
      default:
        plan.error = `未知参数「${flag}」。可执行 /model bench help 查看用法`;
        return plan;
    }
  }

  if (plan.error) return plan;

  // 档位：先定 tier，再让显式项覆盖预设
  if (tierRaw !== undefined) {
    if (!(tierRaw in BENCH_TIERS)) {
      plan.error = `未知档位「${tierRaw}」，可选：${Object.keys(BENCH_TIERS).join(' / ')}`;
      return plan;
    }
    plan.tier = tierRaw as BenchTier;
    plan.rounds = BENCH_TIERS[plan.tier].rounds;
    plan.prompts = [...BENCH_TIERS[plan.tier].prompts];
  }

  if (roundsRaw !== undefined) {
    const r = intArg('--rounds', roundsRaw, BENCH_LIMITS.rounds);
    if ('error' in r) {
      plan.error = r.error;
      return plan;
    }
    plan.rounds = r.value;
  }

  if (promptsRaw !== undefined) {
    const keys = promptsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (keys.length === 0) {
      plan.error = `--prompts 需为非空列表，可选：${Object.keys(BENCH_PROMPTS).join(' / ')}`;
      return plan;
    }
    const out: BenchPromptKey[] = [];
    for (const k of keys) {
      if (!(k in BENCH_PROMPTS)) {
        plan.error = `未知提示词档位「${k}」，可选：${Object.keys(BENCH_PROMPTS).join(' / ')}`;
        return plan;
      }
      if (!out.includes(k as BenchPromptKey)) out.push(k as BenchPromptKey);
    }
    plan.prompts = out;
  }

  if (maxTokensRaw !== undefined) {
    const r = intArg('--max-tokens', maxTokensRaw, BENCH_LIMITS.maxTokens);
    if ('error' in r) {
      plan.error = r.error;
      return plan;
    }
    plan.maxTokens = r.value;
  }

  if (timeoutRaw !== undefined) {
    const r = intArg('--timeout', timeoutRaw, BENCH_LIMITS.timeoutSec);
    if ('error' in r) {
      plan.error = r.error;
      return plan;
    }
    plan.timeoutMs = r.value * 1000;
  }

  if (limitRaw !== undefined) {
    const r = intArg('--limit', limitRaw, BENCH_LIMITS.limit);
    if ('error' in r) {
      plan.error = r.error;
      return plan;
    }
    plan.limit = r.value;
  }

  // history 只认位置参数里的第一个词（避免把别的别名误当子命令）
  if (positionals[0] === 'history') {
    plan.history = true;
    positionals = positionals.slice(1);
  }
  plan.aliases = positionals;

  if (!plan.history && !plan.all && plan.aliases.length > MAX_BENCH_ALIASES) {
    plan.error = `一次最多对比 ${MAX_BENCH_ALIASES} 个模型（当前 ${plan.aliases.length} 个）`;
  }
  return plan;
}

// ===== 目标解析（纯函数） =====

export interface BenchTarget {
  alias: string;
  profile: ModelCandidate;
  /** 来自生效快照（未登记）：显示别名 (当前快照)，且不写历史 */
  fromSnapshot: boolean;
}

export interface BenchTargetsResult {
  targets: BenchTarget[];
  /** 非空即整体拦截，一个请求都不发（D2） */
  errors: string[];
  /** --all 超限被忽略的别名（明确列出，不静默截断） */
  ignored: string[];
}

/** 把登记簿/生效快照解析成待测目标；任一目标不可测就整体失败 */
export function resolveBenchTargets(cfg: AgentConfig, plan: BenchPlan): BenchTargetsResult {
  const registered = Object.keys(cfg.models.profiles).sort();
  const errors: string[] = [];
  const ignored: string[] = [];

  let aliases: string[];
  if (plan.all) {
    aliases = registered.slice(0, MAX_BENCH_ALIASES);
    ignored.push(...registered.slice(MAX_BENCH_ALIASES));
    if (aliases.length === 0) {
      errors.push('登记簿为空（单模型模式），请先 /model add <别名> 登记模型，或直接 /model bench 测当前生效模型');
      return { targets: [], errors, ignored };
    }
  } else if (plan.aliases.length > 0) {
    aliases = plan.aliases;
  } else if (cfg.models.active) {
    aliases = [cfg.models.active];
  } else {
    // 未纳入多模型管理：回落生效快照，虚拟别名且不落历史
    if (!cfg.model.apiKey) {
      errors.push('当前生效模型未配置 apiKey，无法测速（/config set model.apiKey <key>）');
      return { targets: [], errors, ignored };
    }
    return {
      targets: [{ alias: SNAPSHOT_ALIAS, profile: { ...cfg.model }, fromSnapshot: true }],
      errors,
      ignored,
    };
  }

  const targets: BenchTarget[] = [];
  const missing: string[] = [];
  for (const alias of aliases) {
    const profile = cfg.models.profiles[alias];
    if (!profile) {
      missing.push(alias);
      continue;
    }
    if (!profile.apiKey) {
      errors.push(`模型「${alias}」未配置 apiKey，无法测速（/config set models.profiles.${alias}.apiKey <key>）`);
      continue;
    }
    targets.push({ alias, profile, fromSnapshot: false });
  }

  if (missing.length > 0) {
    const list = registered.length > 0 ? registered.join('、') : '（空）';
    errors.unshift(`未找到模型「${missing.join('、')}」。已登记: ${list}`);
  }

  return { targets, errors, ignored };
}

// ===== 表格渲染（纯函数） =====

/** 剥离 ANSI 转义，仅用于宽度计算 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** 显示宽度：CJK / 全角按 2 计（GBK 终端下中文占两格） */
export function visualWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

function padTo(s: string, width: number, align: 'left' | 'right'): string {
  const fill = ' '.repeat(Math.max(0, width - visualWidth(s)));
  return align === 'left' ? `${s}${fill}` : `${fill}${s}`;
}

/** 按显示宽度截断（超出加 ~ 后缀），避免长模型名把表格拉爆 */
export function truncByWidth(s: string, max: number): string {
  if (visualWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = visualWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}~`;
}

function fmtMs(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-';
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
}

function fmtRate(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-';
  return v.toFixed(1);
}

function fmtPct(rate: number | null | undefined): string {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '-';
  return `${Math.round(rate * 100)}%`;
}

/** 找最优列下标（值越界/为 null 的跳过；并列取第一个） */
function bestIndexOf(values: (number | null)[], dir: 'min' | 'max'): number {
  let idx = -1;
  let best = dir === 'min' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  values.forEach((v, i) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    if (dir === 'min' ? v < best : v > best) {
      best = v;
      idx = i;
    }
  });
  return idx;
}

export interface BenchRow {
  alias: string;
  model: string;
  summary: BenchSummary;
}

/** 列宽构造 + 表框（ASCII only，GBK 安全） */
function buildTable(
  header: string[],
  body: string[][],
  aligns: ('left' | 'right')[],
): string[] {
  const widths = header.map((h, i) =>
    Math.max(visualWidth(h), ...body.map((r) => visualWidth(r[i] ?? ''))),
  );
  const sep = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  const line = (cells: string[]): string =>
    `|${cells.map((c, i) => ` ${padTo(c, widths[i] ?? 0, aligns[i] ?? 'left')} `).join('|')}|`;
  return [sep, line(header), sep, ...body.map(line), sep];
}

const BENCH_COLUMNS: { title: string; align: 'left' | 'right' }[] = [
  { title: '别名', align: 'left' },
  { title: '型号', align: 'left' },
  { title: 'TTFT', align: 'right' },
  { title: 'TPOT', align: 'right' },
  { title: '解码 TPS', align: 'right' },
  { title: '端到端 TPS', align: 'right' },
  { title: 'ITL p90', align: 'right' },
  { title: '成功率', align: 'right' },
  { title: '样本', align: 'right' },
];

/**
 * 结果表（D5）：七列指标 + 型号 + 样本；多模型时逐列标记最优（绿色 `*` 前缀，
 * 无色环境只留 `*`——颜色不是唯一信息载体）。
 */
export function renderBenchTable(rows: BenchRow[], opts: { colors: boolean }): string[] {
  const c = opts.colors ? COLORS : null;
  const mark = (s: string, isBest: boolean): string => {
    if (!isBest) return s;
    return c ? `${c.green}*${s}${c.reset}` : `*${s}`;
  };

  const multi = rows.length > 1;
  const ttftBest = multi ? bestIndexOf(rows.map((r) => r.summary.ttft.p50), 'min') : -1;
  const tpotBest = multi ? bestIndexOf(rows.map((r) => r.summary.tpot.p50), 'min') : -1;
  const decodeBest = multi ? bestIndexOf(rows.map((r) => r.summary.decodeTps.p50), 'max') : -1;
  const e2eBest = multi ? bestIndexOf(rows.map((r) => r.summary.e2eTps.p50), 'max') : -1;
  const itlBest = multi ? bestIndexOf(rows.map((r) => r.summary.itlP90Ms.p90), 'min') : -1;

  const body = rows.map((r, i) => {
    const s = r.summary;
    return [
      truncByWidth(r.alias, 16),
      truncByWidth(r.model, 22),
      mark(fmtMs(s.ttft.p50), i === ttftBest),
      mark(fmtMs(s.tpot.p50), i === tpotBest),
      mark(fmtRate(s.decodeTps.p50), i === decodeBest),
      mark(fmtRate(s.e2eTps.p50), i === e2eBest),
      mark(fmtMs(s.itlP90Ms.p90), i === itlBest),
      fmtPct(s.successRate),
      `${s.okCount}/${s.total}`,
    ];
  });

  return buildTable(
    BENCH_COLUMNS.map((col) => col.title),
    body,
    BENCH_COLUMNS.map((col) => col.align),
  );
}

const HISTORY_COLUMNS: { title: string; align: 'left' | 'right' }[] = [
  { title: '时间', align: 'left' },
  { title: '别名', align: 'left' },
  { title: '型号', align: 'left' },
  { title: '档位', align: 'left' },
  { title: 'TTFT', align: 'right' },
  { title: '解码 TPS', align: 'right' },
  { title: '成功率', align: 'right' },
  { title: '样本', align: 'right' },
];

/** 本地时间 MM-DD HH:mm（历史表用；ISO 太长会把表格拉宽） */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 历史表（D10） */
export function renderHistoryTable(entries: BenchHistoryEntry[], opts: { colors: boolean }): string[] {
  const body = entries.map((e) => [
    fmtWhen(e.startedAt),
    truncByWidth(e.alias, 16),
    truncByWidth(e.model, 22),
    e.config.tier ?? '-',
    fmtMs(e.summary.ttft.p50),
    fmtRate(e.summary.decodeTps.p50),
    fmtPct(e.summary.successRate),
    `${e.summary.okCount}/${e.summary.total}`,
  ]);
  const table = buildTable(
    HISTORY_COLUMNS.map((col) => col.title),
    body,
    HISTORY_COLUMNS.map((col) => col.align),
  );
  // 表格内的数字/文本统一不着色：历史是回看用，颜色只会让长表更吵
  void opts;
  return table;
}

/** 「相比上次」（D5 补充）：表格保持纯净宽度，变化单独成行 */
export function renderDeltaLines(
  items: { alias: string; prev: BenchSummary | null; cur: BenchSummary; tier: string }[],
  opts: { colors: boolean },
): string[] {
  const c = opts.colors ? COLORS : null;
  const lines: string[] = [];
  for (const it of items) {
    const prev = it.prev;
    if (!prev) continue;
    const parts: string[] = [];

    const pairs: { label: string; a: number | null; b: number | null; unit: 'ms' | 'rate'; better: 'low' | 'high' }[] = [
      { label: 'TTFT', a: prev.ttft.p50, b: it.cur.ttft.p50, unit: 'ms', better: 'low' },
      { label: '解码', a: prev.decodeTps.p50, b: it.cur.decodeTps.p50, unit: 'rate', better: 'high' },
    ];
    for (const p of pairs) {
      if (typeof p.a !== 'number' || typeof p.b !== 'number' || p.a === 0) continue;
      const deltaPct = ((p.b - p.a) / p.a) * 100;
      const fmt = (v: number): string => (p.unit === 'ms' ? fmtMs(v) : fmtRate(v));
      // 变化符号用 ASCII +/-（不用 ▲▼：GBK 下宽度不确定会错位）
      const sign = deltaPct >= 0 ? '+' : '';
      const text = `${p.label} ${fmt(p.a)} -> ${fmt(p.b)} (${sign}${deltaPct.toFixed(1)}%)`;
      const good = p.better === 'low' ? deltaPct < 0 : deltaPct > 0;
      parts.push(c ? `${good ? c.green : c.yellow}${text}${c.reset}` : text);
    }
    if (parts.length > 0) {
      lines.push(`  相比上次（${it.tier}）：${it.alias} ${parts.join('，')}`);
    }
  }
  return lines;
}

// ===== 用法文本 =====

export function benchUsageLines(): string[] {
  return [
    `${COLORS.bold}/model bench${COLORS.reset} ${COLORS.gray}— 模型性能测速（与 WebUI 同一引擎、同一份历史）${COLORS.reset}`,
    `  ${COLORS.bold}/model bench${COLORS.reset}                     测当前激活模型（快速档，秒级）`,
    `  ${COLORS.bold}/model bench${COLORS.reset} <别名…>              横向对比（最多 ${MAX_BENCH_ALIASES} 个，串行）`,
    `  ${COLORS.bold}/model bench${COLORS.reset} --all               测全部已登记模型（取前 ${MAX_BENCH_ALIASES} 个）`,
    `  ${COLORS.bold}/model bench history${COLORS.reset} [别名]      查看历史（缺省每模型最近一次）`,
    '',
    `${COLORS.gray}可选参数：${COLORS.reset}`,
    `  --tier quick|standard   档位（quick=1 档 1 轮，standard=2 档 3 轮），默认 quick`,
    `  --rounds 1-10           每档轮数（覆盖档位预设）`,
    `  --prompts short,medium,code  提示词档位（覆盖档位预设）`,
    `  --max-tokens 32-1024    输出上限，默认 256`,
    `  --timeout 5-180         单轮超时（秒），默认 60`,
    `  --no-bust-cache         不破坏前缀缓存（TTFT 含缓存收益，跨模型不可比）`,
    `  --json                  只输出 JSON（CI / 脚本用）`,
    `  --limit 1-${BENCH_HISTORY_KEEP}           history 条数上限`,
    '',
    `${COLORS.gray}测速中按 Ctrl+C 只中断测速（已完成样本照常汇总与落盘），进程不退出${COLORS.reset}`,
  ];
}

// ===== 命令主体 =====

export interface BenchDeps {
  /** 测量引擎（默认 runBench；单测注入 fake，不联网） */
  runBench?: EngineRunner;
  /** 历史根目录（默认 ~/.loop-agent/model-bench） */
  benchRoot?: string;
  now?: () => Date;
  readHistory?: (root: string) => Promise<BenchHistoryFile>;
  appendHistory?: (root: string, entry: BenchHistoryEntry) => Promise<unknown>;
  /** 视图工厂（单测注入可控 write） */
  createView?: (opts: { enabled: boolean; colors: boolean; quiet: boolean }) => BenchLiveView;
  /** stdout 是否 TTY（默认读 process.stdout.isTTY） */
  isTTY?: boolean;
  /** 结果输出（默认 ctx.out；--json 时同样走 stdout） */
  newRunId?: () => string;
}

export interface BenchCommand {
  execute: (argv: string[], ctx: CommandContext) => Promise<void>;
}

/** 组装测量配置快照（写进历史，便于日后解释「当时怎么测的」） */
function buildRunConfig(plan: BenchPlan): BenchHistoryEntry['config'] {
  return {
    tier: plan.tier,
    prompts: [...plan.prompts],
    rounds: plan.rounds,
    maxTokens: plan.maxTokens,
    bustCache: plan.bustCache,
    timeoutMs: plan.timeoutMs,
  };
}

export function createBenchRunner(deps: BenchDeps = {}): BenchCommand {
  const runFn = deps.runBench ?? runBench;
  const now = deps.now ?? ((): Date => new Date());
  const readHistory = deps.readHistory ?? readBenchHistory;
  const appendHistory = deps.appendHistory ?? ((root, entry) => appendBenchHistory(root, entry));
  const benchRoot = (): string => deps.benchRoot ?? defaultBenchRoot();
  const isTTY = (): boolean => deps.isTTY ?? process.stdout.isTTY === true;
  const newRunId = deps.newRunId ?? ((): string => `bench-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);

  async function printHistory(ctx: CommandContext, plan: BenchPlan): Promise<void> {
    const colors = isTTY() && !plan.json;
    const root = benchRoot();
    const file = await readHistory(root);
    const alias = plan.aliases[0];
    const entries = queryHistory(file, alias ? { alias, limit: plan.limit } : { limit: plan.limit });

    if (plan.json) {
      ctx.out.log(JSON.stringify({ alias: alias ?? null, entries }, null, 2));
      return;
    }

    ctx.out.blank();
    if (entries.length === 0) {
      ctx.out.log(
        alias
          ? `${COLORS.gray}模型「${alias}」暂无测速历史${COLORS.reset}`
          : `${COLORS.gray}暂无测速历史；先跑一次 /model bench${COLORS.reset}`,
      );
      ctx.out.log(`${COLORS.gray}历史文件: ${root}${COLORS.reset}`);
      ctx.out.blank();
      return;
    }
    ctx.out.log(
      `${COLORS.bold}测速历史${COLORS.reset}${COLORS.gray}（${alias ? `模型 ${alias}` : '每模型最近一次'}，共 ${entries.length} 条）${COLORS.reset}`,
    );
    for (const line of renderHistoryTable(entries, { colors })) ctx.out.log(line);
    ctx.out.log(`${COLORS.gray}历史文件: ${root}${COLORS.reset}`);
    ctx.out.blank();
  }

  async function runOnce(ctx: CommandContext, plan: BenchPlan): Promise<void> {
    const { config: cfg } = ctx.configLoader.load();
    const { targets, errors, ignored } = resolveBenchTargets(cfg, plan);

    if (!plan.json) ctx.out.blank();
    if (errors.length > 0) {
      // --json 时错误走 stderr，保证 stdout 只有 JSON（D9）
      for (const e of errors) {
        if (plan.json) ctx.out.error(`✗ ${e}`);
        else ctx.out.log(`${COLORS.red}✗ ${e}${COLORS.reset}`);
      }
      if (!plan.json) ctx.out.blank();
      return;
    }

    const colors = isTTY() && !plan.json;
    // --json：静默视图（内存里跑，没有任何进度输出，stdout 只留 JSON）
    const view =
      deps.createView?.({ enabled: isTTY() && !plan.json, colors, quiet: plan.json })
      ?? new BenchLiveView({
        enabled: isTTY() && !plan.json,
        colors,
        ...(plan.json ? { write: () => {} } : {}),
      });

    const runId = newRunId();
    const startedAt = now();
    const config = buildRunConfig(plan);
    const plannedPerModel = plan.prompts.length * plan.rounds;

    // 「上次」必须在开跑前读：跑完落盘后最新一条就是本次
    const prevByAlias = new Map<string, BenchSummary>();
    if (!plan.json) {
      try {
        const file = await readHistory(benchRoot());
        for (const t of targets) {
          const [latest] = queryHistory(file, { alias: t.alias, limit: 1 });
          if (latest) prevByAlias.set(t.alias, latest.summary);
        }
      } catch {
        /* 历史读失败不影响测速 */
      }
    }

    const controller = new AbortController();
    ctx.setAbortable?.(controller);

    const rows: BenchRow[] = [];
    const warnings: string[] = [];
    let abortedAny = false;
    let writeFailures = 0;

    try {
      for (let i = 0; i < targets.length; i++) {
        const target = targets[i]!;
        if (controller.signal.aborted) {
          abortedAny = true;
          break;
        }
        view.startModel({ alias: target.alias, model: target.profile.name, index: i + 1, total: targets.length });

        const summary = await runFn({
          model: target.profile,
          prompts: plan.prompts,
          rounds: plan.rounds,
          maxTokens: plan.maxTokens,
          timeoutMs: plan.timeoutMs,
          bustCache: plan.bustCache,
          signal: controller.signal,
          onRoundStart: (info) => view.onRoundStart({ round: info.round, total: info.total, promptKey: info.prompt }),
          onFirstToken: (ms) => view.onFirstToken(ms),
          onToken: (outTokens, elapsedMs) => view.onToken(outTokens, elapsedMs),
          onSample: (sample) => view.onSample(sample),
        });
        view.finish();

        if (summary.aborted) abortedAny = true;
        rows.push({ alias: target.alias, model: target.profile.name, summary });

        // 落盘（D6）：快照回落不写（不在登记簿里，写进去会污染趋势）
        if (!target.fromSnapshot && summary.total > 0) {
          const entry: BenchHistoryEntry = {
            runId,
            alias: target.alias,
            model: target.profile.name,
            baseUrlHost: hostOf(target.profile.baseUrl),
            startedAt: startedAt.toISOString(),
            finishedAt: now().toISOString(),
            config,
            summary,
          };
          try {
            await appendHistory(benchRoot(), entry);
          } catch (e) {
            writeFailures += 1;
            warnings.push(`历史写入失败（不影响本次结果）：${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (summary.aborted) break;
      }
    } finally {
      view.finish();
      ctx.setAbortable?.(null);
    }

    // ---- 输出 ----
    if (plan.json) {
      ctx.out.log(
        JSON.stringify(
          {
            runId,
            config,
            aborted: abortedAny,
            results: rows.map((r) => ({
              alias: r.alias,
              model: r.model,
              summary: r.summary,
            })),
          },
          null,
          2,
        ),
      );
      if (warnings.length > 0) {
        for (const w of warnings) ctx.out.error(`${COLORS.gray}${w}${COLORS.reset}`);
      }
      return;
    }

    for (const w of warnings) ctx.out.log(`${COLORS.gray}${w}${COLORS.reset}`);

    const tierLabel = BENCH_TIERS[plan.tier].label;
    const doneTotal = rows.reduce((acc, r) => acc + r.summary.total, 0);
    const plannedTotal = plannedPerModel * targets.length;
    const abortedNote = abortedAny ? `，已中断 ${doneTotal}/${plannedTotal} 轮` : '';
    ctx.out.log(
      `${COLORS.bold}测速结果${COLORS.reset}${COLORS.gray}（${tierLabel}档 · ${plan.prompts.length} 档提示词 × ${plan.rounds} 轮${abortedNote}）${COLORS.reset}`,
    );
    for (const line of renderBenchTable(rows, { colors })) ctx.out.log(line);

    // 相比上次（仅对人类可读输出；--json 已在上面 return）
    const deltaLines = renderDeltaLines(
      rows.map((r) => ({ alias: r.alias, prev: prevByAlias.get(r.alias) ?? null, cur: r.summary, tier: plan.tier })),
      { colors },
    );
    for (const line of deltaLines) ctx.out.log(line);

    // 失败分类（D3：失败样本必须显性展示，不静默丢弃）
    for (const r of rows) {
      const kinds = Object.entries(r.summary.errorKinds ?? {});
      if (kinds.length === 0) continue;
      const text = kinds.map(([k, n]) => `${k}×${n}`).join('，');
      ctx.out.log(`${COLORS.yellow}  ${r.alias} 失败样本：${text}${COLORS.reset}`);
    }

    for (const alias of ignored) {
      ctx.out.log(`${COLORS.yellow}  已忽略 ${alias}（一次最多对比 ${MAX_BENCH_ALIASES} 个模型）${COLORS.reset}`);
    }
    for (const r of rows) {
      if (r.summary.suspectBuffered) {
        ctx.out.log(`${COLORS.yellow}  ${r.alias} 疑似被网关攒包（分块几乎同时到达），TPS 不可信${COLORS.reset}`);
      }
      if (r.summary.estimated) {
        ctx.out.log(`${COLORS.gray}  ${r.alias} 部分样本的 token 数为估算值（服务商未回 usage）${COLORS.reset}`);
      }
    }

    // 脚注（D12 / 缓存提示）
    if (plan.tier === 'quick' && plan.rounds <= 1 && plan.prompts.length <= 1) {
      ctx.out.log(
        `${COLORS.gray}  注：快速档只跑 1 轮，TTFT 含连接建立开销；严谨对比请用 --tier standard（多轮取 p50）${COLORS.reset}`,
      );
    }
    if (!plan.bustCache) {
      ctx.out.log(`${COLORS.yellow}  ⚠ 本次未破坏前缀缓存，TTFT 含缓存命中收益，不可与其它模型直接比${COLORS.reset}`);
    }
    if (writeFailures > 0) {
      ctx.out.log(`${COLORS.gray}  ${writeFailures} 个模型的历史未写入，见上方警告${COLORS.reset}`);
    }
    ctx.out.blank();
  }

  return {
    async execute(argv, ctx) {
      const plan = parseBenchArgs(argv);

      if (plan.help) {
        if (!plan.json) ctx.out.blank();
        for (const line of benchUsageLines()) ctx.out.log(line);
        if (!plan.json) ctx.out.blank();
        return;
      }
      if (plan.error) {
        if (plan.json) {
          ctx.out.error(`✗ ${plan.error}`);
          return;
        }
        ctx.out.blank();
        ctx.out.log(`${COLORS.red}✗ ${plan.error}${COLORS.reset}`);
        ctx.out.blank();
        return;
      }
      if (plan.history) {
        await printHistory(ctx, plan);
        return;
      }
      await runOnce(ctx, plan);
    },
  };
}

/** 供 model-command 复用的默认实例（真实依赖） */
export const benchCommand: BenchCommand = createBenchRunner();

/** 单测用：裁剪历史（re-export 便于断言裁剪规则与 CLI 侧一致） */
export { pruneRuns };
