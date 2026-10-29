/**
 * /model bench 单测（需求 20261029-002）
 *
 * 覆盖：
 * - parseBenchArgs 全分支（档位预设合并顺序、覆盖项、= 形式、未知 flag、非法区间、history、--all 上限）
 * - resolveBenchTargets（active 回落、快照回落、未登记/缺 apiKey 整体拦截、--all 超限列出被忽略项）
 * - renderBenchTable（多模型最优标记、中文宽度对齐、无色环境只留 *）
 * - renderDeltaLines（相比上次的 ASCII 变化标记）
 * - BenchLiveView 双模式（TTY 原地刷新有 \r/\x1b；非 TTY 逐轮一行、零转义）
 * - createBenchRunner 端到端（fake 引擎不联网）：结果表 + 落盘 + --json 纯 JSON +
 *   中断汇总 + 快照不落盘 + 前置拦截不发请求 + history 分支
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig, ModelConfig, ModelProfile } from '../src/config/schema.js';
import type { BenchSummary, Percentiles } from '../src/llm/bench.js';
import type { BenchHistoryEntry, BenchHistoryFile } from '../src/llm/bench-store.js';
import type { CommandContext } from '../src/commands/registry.js';
import {
  MAX_BENCH_ALIASES,
  SNAPSHOT_ALIAS,
  createBenchRunner,
  parseBenchArgs,
  renderBenchTable,
  renderDeltaLines,
  renderHistoryTable,
  resolveBenchTargets,
  truncByWidth,
  visualWidth,
  type BenchRow,
} from '../src/commands/bench-command.js';
import { BenchLiveView, sampleLine } from '../src/ui/bench-view.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

// ===== 夹具 =====

function model(over: Partial<ModelConfig> = {}): ModelConfig {
  return { name: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-main-9999', temperature: 0, ...over };
}

function profile(over: Partial<ModelProfile> = {}): ModelProfile {
  return { name: 'glm-4.6', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-glm-abcd', ...over };
}

function cfg(opts: { active?: string; profiles?: Record<string, ModelProfile>; model?: ModelConfig } = {}): AgentConfig {
  return {
    model: opts.model ?? model(),
    models: { active: opts.active ?? '', profiles: opts.profiles ?? {} },
  } as unknown as AgentConfig;
}

function pct(v: number | null, count = 1): Percentiles {
  return { p50: v, p90: v, min: v, max: v, count: v === null ? 0 : count };
}

function mkSummary(
  over: {
    ttft?: number | null;
    tpot?: number | null;
    decode?: number | null;
    e2e?: number | null;
    itl?: number | null;
    okCount?: number;
    total?: number;
    aborted?: boolean;
    errorKinds?: BenchSummary['errorKinds'];
    suspectBuffered?: boolean;
    estimated?: boolean;
  } = {},
): BenchSummary {
  const total = over.total ?? 1;
  const okCount = over.okCount ?? total;
  return {
    samples: [],
    total,
    okCount,
    successRate: total > 0 ? okCount / total : 0,
    ttft: pct(over.ttft === undefined ? 812 : over.ttft),
    decodeTps: pct(over.decode === undefined ? 41.8 : over.decode),
    tpot: pct(over.tpot === undefined ? 23.9 : over.tpot),
    e2eTps: pct(over.e2e === undefined ? 38.2 : over.e2e),
    itlP90Ms: pct(over.itl === undefined ? 31 : over.itl),
    outTokens: pct(100),
    estimated: over.estimated ?? false,
    suspectBuffered: over.suspectBuffered ?? false,
    totalTps: null,
    wallMs: 2500,
    aborted: over.aborted ?? false,
    errorKinds: over.errorKinds ?? {},
  };
}

function makeCtx(config: AgentConfig): {
  ctx: CommandContext;
  lines: string[];
  errors: string[];
  abortables: (AbortController | null)[];
} {
  const lines: string[] = [];
  const errors: string[] = [];
  const abortables: (AbortController | null)[] = [];
  const ctx = {
    configLoader: { load: () => ({ config, sources: {} }) },
    out: {
      log: (s: string) => lines.push(s),
      error: (s: string) => errors.push(s),
      blank: () => lines.push(''),
      data: () => {},
    },
    setAbortable: (c: AbortController | null) => abortables.push(c),
  } as unknown as CommandContext;
  return { ctx, lines, errors, abortables };
}

const text = (lines: string[]): string => stripAnsi(lines.join('\n'));

// ===== 参数解析 =====

describe('parseBenchArgs', () => {
  it('无参：默认 quick 档 + 默认值', () => {
    const p = parseBenchArgs([]);
    expect(p.error).toBeUndefined();
    expect(p.tier).toBe('quick');
    expect(p.rounds).toBe(1);
    expect(p.prompts).toEqual(['short']);
    expect(p.maxTokens).toBe(256);
    expect(p.timeoutMs).toBe(60_000);
    expect(p.bustCache).toBe(true);
    expect(p.aliases).toEqual([]);
    expect(p.all).toBe(false);
  });

  it('位置参数只当别名；history 作为第一个词才是子命令', () => {
    expect(parseBenchArgs(['a', 'b']).aliases).toEqual(['a', 'b']);
    const h = parseBenchArgs(['history', 'a']);
    expect(h.history).toBe(true);
    expect(h.aliases).toEqual(['a']);
    // history 不在首位 → 当普通别名（不猜）
    const notSub = parseBenchArgs(['a', 'history']);
    expect(notSub.history).toBe(false);
    expect(notSub.aliases).toEqual(['a', 'history']);
  });

  it('--tier standard 覆盖档位预设；显式 --rounds/--prompts 再覆盖档位', () => {
    const p = parseBenchArgs(['--tier', 'standard']);
    expect(p.tier).toBe('standard');
    expect(p.prompts.length).toBe(2);
    expect(p.rounds).toBe(3);

    const o = parseBenchArgs(['--tier', 'standard', '--rounds', '5', '--prompts', 'code']);
    expect(o.tier).toBe('standard');
    expect(o.rounds).toBe(5);
    expect(o.prompts).toEqual(['code']);
  });

  it('支持 --flag=value 形式', () => {
    const p = parseBenchArgs(['--rounds=4', '--max-tokens=512', '--timeout=30', '--limit=5']);
    expect(p.rounds).toBe(4);
    expect(p.maxTokens).toBe(512);
    expect(p.timeoutMs).toBe(30_000);
    expect(p.limit).toBe(5);
  });

  it('--prompts 去重并保持顺序', () => {
    expect(parseBenchArgs(['--prompts', 'short,short,code']).prompts).toEqual(['short', 'code']);
  });

  it('未知 flag / 未知档位 / 未知提示词分别报错（不 throw）', () => {
    expect(parseBenchArgs(['--nope']).error).toMatch(/未知参数/);
    expect(parseBenchArgs(['--tier', 'ultra']).error).toMatch(/未知档位/);
    expect(parseBenchArgs(['--prompts', 'long']).error).toMatch(/未知提示词档位/);
    expect(parseBenchArgs(['--prompts', ' , ']).error).toMatch(/非空列表/);
  });

  it('区间非法或非整数报错', () => {
    expect(parseBenchArgs(['--rounds', '0']).error).toMatch(/--rounds 需为 1–10/);
    expect(parseBenchArgs(['--rounds', '2.5']).error).toMatch(/--rounds/);
    expect(parseBenchArgs(['--max-tokens', '8']).error).toMatch(/--max-tokens 需为 32–1024/);
    expect(parseBenchArgs(['--timeout', '600']).error).toMatch(/--timeout 需为 5–180/);
    expect(parseBenchArgs(['--limit', '0']).error).toMatch(/--limit/);
    expect(parseBenchArgs(['--rounds']).error).toMatch(/缺少取值/);
  });

  it('别名超过上限报错', () => {
    const many = Array.from({ length: MAX_BENCH_ALIASES + 1 }, (_, i) => `m${i}`);
    expect(parseBenchArgs(many).error).toMatch(new RegExp(`最多对比 ${MAX_BENCH_ALIASES} 个`));
  });

  it('--all / --json / --no-bust-cache / --help', () => {
    const p = parseBenchArgs(['--all', '--json', '--no-bust-cache']);
    expect(p.all).toBe(true);
    expect(p.json).toBe(true);
    expect(p.bustCache).toBe(false);
    expect(parseBenchArgs(['-h']).help).toBe(true);
    expect(parseBenchArgs(['--help']).help).toBe(true);
  });
});

// ===== 目标解析 =====

describe('resolveBenchTargets', () => {
  it('无参默认 active；无 active 回落生效快照且标记 fromSnapshot', () => {
    const a = resolveBenchTargets(cfg({ active: 'glm', profiles: { glm: profile() } }), parseBenchArgs([]));
    expect(a.errors).toEqual([]);
    expect(a.targets.map((t) => t.alias)).toEqual(['glm']);
    expect(a.targets[0]!.fromSnapshot).toBe(false);

    const snap = resolveBenchTargets(cfg({ active: '' }), parseBenchArgs([]));
    expect(snap.errors).toEqual([]);
    expect(snap.targets[0]!.alias).toBe(SNAPSHOT_ALIAS);
    expect(snap.targets[0]!.fromSnapshot).toBe(true);
    expect(snap.targets[0]!.profile.name).toBe('deepseek-v4-flash');
  });

  it('别名不存在：整体拦截并列出已登记别名', () => {
    const r = resolveBenchTargets(
      cfg({ active: 'glm', profiles: { glm: profile() } }),
      parseBenchArgs(['ghost']),
    );
    expect(r.targets).toEqual([]);
    expect(r.errors[0]).toMatch(/未找到模型「ghost」/);
    expect(r.errors[0]).toMatch(/已登记: glm/);
  });

  it('缺 apiKey：整体拦截并给出配置路径', () => {
    const r = resolveBenchTargets(
      cfg({ active: 'a', profiles: { a: profile(), b: profile({ apiKey: '' }) } }),
      parseBenchArgs(['a', 'b']),
    );
    expect(r.targets.map((t) => t.alias)).toEqual(['a']);
    expect(r.errors.join()).toMatch(/models\.profiles\.b\.apiKey/);
  });

  it('快照回落时 apiKey 为空同样拦截', () => {
    const r = resolveBenchTargets(cfg({ model: model({ apiKey: '' }) }), parseBenchArgs([]));
    expect(r.errors[0]).toMatch(/当前生效模型未配置 apiKey/);
  });

  it('--all 取前 4 个并明确列出被忽略项；登记簿为空时报错', () => {
    const profiles: Record<string, ModelProfile> = {};
    for (const k of ['e', 'd', 'c', 'b', 'a']) profiles[k] = profile();
    const r = resolveBenchTargets(cfg({ active: 'a', profiles }), parseBenchArgs(['--all']));
    expect(r.targets.map((t) => t.alias)).toEqual(['a', 'b', 'c', 'd']);
    expect(r.ignored).toEqual(['e']);

    const empty = resolveBenchTargets(cfg({ active: '' }), parseBenchArgs(['--all']));
    expect(empty.errors[0]).toMatch(/登记簿为空/);
  });
});

// ===== 表格渲染 =====

describe('renderBenchTable', () => {
  it('单模型不标最优；列齐全；表框纯 ASCII', () => {
    const lines = renderBenchTable([{ alias: 'glm', model: 'glm-4.6', summary: mkSummary() }], { colors: false });
    const body = lines.join('\n');
    for (const h of ['别名', '型号', 'TTFT', 'TPOT', '解码 TPS', '端到端 TPS', 'ITL p90', '成功率', '样本']) {
      expect(body).toContain(h);
    }
    expect(body).toContain('812ms');
    expect(body).toContain('41.8');
    expect(body).toContain('100%');
    expect(body).toContain('1/1');
    expect(body).not.toContain('*812ms');
    // 表框只用 + - |（GBK 安全）
    for (const line of lines) expect(line).toMatch(/^[|+][\x20-\x7e\u4e00-\u9fa5\u00b7]*[|+]$/u);
  });

  it('多模型逐列标最优：TTFT/TPOT/ITL 取最小，TPS 取最大', () => {
    const rows: BenchRow[] = [
      { alias: 'fast', model: 'm1', summary: mkSummary({ ttft: 400, tpot: 20, decode: 60, e2e: 50, itl: 25 }) },
      { alias: 'slow', model: 'm2', summary: mkSummary({ ttft: 900, tpot: 40, decode: 20, e2e: 18, itl: 60 }) },
    ];
    const body = renderBenchTable(rows, { colors: false }).join('\n');
    expect(body).toContain('*400ms');
    // 不是最优 → 不应有 *
    expect(body).not.toContain('*900ms');
    expect(body).toContain('*60.0');
    expect(body).not.toContain('*20.0');
  });

  it('有颜色时最优项包绿色，且宽度计算忽略转义', () => {
    const rows: BenchRow[] = [
      { alias: 'a', model: 'm', summary: mkSummary({ ttft: 400 }) },
      { alias: 'b', model: 'm', summary: mkSummary({ ttft: 900 }) },
    ];
    const colored = renderBenchTable(rows, { colors: true });
    const plain = renderBenchTable(rows, { colors: false });
    expect(colored.join('')).toContain('\x1b[32m*400ms\x1b[0m');
    // 着色不影响对齐：剥色后逐行等宽
    const widths = colored.map((l) => visualWidth(l));
    expect(new Set(widths).size).toBe(1);
    expect(colored.map(stripAnsi)).toEqual(plain);
  });

  it('visualWidth：中文按 2 计；truncByWidth 截断加 ~', () => {
    expect(visualWidth('别名')).toBe(4);
    expect(visualWidth('abc')).toBe(3);
    expect(visualWidth('\x1b[31m别名\x1b[0m')).toBe(4);
    expect(truncByWidth('deepseek-v4-flash-ultra', 10)).toBe('deepseek-~');
  });
});

describe('renderDeltaLines', () => {
  it('有历史时给出 ASCII 变化百分比（不用 ▲▼）', () => {
    const lines = renderDeltaLines(
      [
        {
          alias: 'glm',
          prev: mkSummary({ ttft: 1000, decode: 40 }),
          cur: mkSummary({ ttft: 800, decode: 50 }),
          tier: 'standard',
        },
      ],
      { colors: false },
    );
    expect(lines[0]).toContain('相比上次（standard）：glm');
    expect(lines[0]).toContain('TTFT 1.00s -> 800ms (-20.0%)');
    expect(lines[0]).toContain('解码 40.0 -> 50.0 (+25.0%)');
    expect(lines[0]).not.toMatch(/[▲▼]/);
  });

  it('无历史则不输出', () => {
    expect(renderDeltaLines([{ alias: 'a', prev: null, cur: mkSummary(), tier: 'quick' }], { colors: false })).toEqual([]);
  });
});

describe('renderHistoryTable', () => {
  it('渲染时间/别名/档位/指标', () => {
    const entry: BenchHistoryEntry = {
      runId: 'r1',
      alias: 'glm',
      model: 'glm-4.6',
      baseUrlHost: 'open.bigmodel.cn',
      startedAt: '2026-10-29T03:04:05.000Z',
      finishedAt: '2026-10-29T03:05:05.000Z',
      config: { tier: 'quick', prompts: ['short'], rounds: 1, maxTokens: 256, bustCache: true },
      summary: mkSummary(),
    };
    const body = renderHistoryTable([entry], { colors: false }).join('\n');
    expect(body).toContain('glm');
    expect(body).toContain('quick');
    expect(body).toContain('812ms');
  });
});

// ===== 实时视图 =====

describe('BenchLiveView', () => {
  it('非 TTY：逐轮一行、零 \\r 与转义', () => {
    const chunks: string[] = [];
    const view = new BenchLiveView({ enabled: false, colors: false, write: (s) => chunks.push(s) });
    view.startModel({ alias: 'glm', model: 'glm-4.6', index: 1, total: 1 });
    view.onRoundStart({ round: 1, total: 1, promptKey: 'short' });
    view.onFirstToken(812);
    view.onToken(50, 1500);
    view.onSample({
      prompt: 'short',
      round: 1,
      ok: true,
      ttftMs: 812,
      decodeTps: 41.8,
      e2eTps: 38.2,
      tpotMs: 23.9,
      itlP90Ms: 31,
      outTokens: 100,
      totalMs: 2500,
    });
    view.finish();
    const out = chunks.join('');
    expect(out).not.toContain('\r');
    expect(out).not.toContain('\x1b');
    expect(out).toContain('[bench] glm r1/1 短问答 -> TTFT 812ms decode 41.8tok/s 100tok');
  });

  it('TTY：原地刷新用 \\r\\x1b[K，finish() 擦除整块', () => {
    const chunks: string[] = [];
    const view = new BenchLiveView({ enabled: true, colors: false, write: (s) => chunks.push(s), throttleMs: 0 });
    view.startModel({ alias: 'glm', model: 'glm-4.6', index: 1, total: 2 });
    view.onRoundStart({ round: 1, total: 1, promptKey: 'short' });
    view.onFirstToken(812);
    view.onToken(50, 1500);
    view.finish();
    const out = chunks.join('');
    expect(out).toContain('\r\x1b[K');
    expect(out).toContain('[bench 1/2]');
    // 3 行块：向上移动 2 行
    expect(out).toContain('\x1b[2A');
    // finish 后回到块首（最后一次上移）
    expect(view.isLive).toBe(true);
  });

  it('onToken 节流：窗口内的连续回调只重绘一次', () => {
    const chunks: string[] = [];
    const view = new BenchLiveView({ enabled: true, colors: false, write: (s) => chunks.push(s), throttleMs: 1000 });
    // 一次重绘会写多个 chunk（3 行 + 换行），故用「块首行出现次数」度量重绘次数
    const headCount = (): number => chunks.filter((s) => s.includes('[bench 1/1]')).length;
    view.startModel({ alias: 'a', model: 'm', index: 1, total: 1 });
    view.onFirstToken(100);
    const before = headCount();
    view.onToken(10, 200);
    view.onToken(20, 300);
    view.onToken(30, 400);
    expect(headCount() - before).toBe(1);
  });

  it('sampleLine：失败样本带错误分类', () => {
    const line = sampleLine('glm', {
      prompt: 'short',
      round: 2,
      ok: false,
      errorKind: 'auth',
      error: 'apiKey 无效或无权限',
    }, { roundTotal: 3, colors: false });
    expect(line).toBe('[bench] glm r2/3 短问答 -> 失败 (auth apiKey 无效或无权限)');
  });
});

// ===== 端到端（fake 引擎，不联网） =====

describe('createBenchRunner', () => {
  let runBenchMock: ReturnType<typeof vi.fn>;
  let history: BenchHistoryFile;

  beforeEach(() => {
    history = { version: 1, runs: [] };
    runBenchMock = vi.fn(async () => mkSummary());
  });

  function runner(opts: { tty?: boolean; appendFail?: boolean } = {}) {
    return createBenchRunner({
      runBench: runBenchMock as never,
      benchRoot: 'D:/tmp/bench-root-unused',
      isTTY: opts.tty ?? false,
      now: () => new Date('2026-10-29T00:00:00.000Z'),
      newRunId: () => 'run-fixed',
      readHistory: async () => history,
      appendHistory: async (_root, entry) => {
        if (opts.appendFail) throw new Error('磁盘只读');
        history = { version: 1, runs: [entry, ...history.runs] };
      },
    });
  }

  const benchCfg = cfg({
    active: 'glm',
    profiles: { glm: profile(), slow: profile({ name: 'slow-1' }) },
  });

  it('无参测当前激活模型；结果表 + 落盘 + 释放 abortable', async () => {
    const { ctx, lines, abortables } = makeCtx(benchCfg);
    await runner().execute([], ctx);

    expect(runBenchMock).toHaveBeenCalledTimes(1);
    const arg = runBenchMock.mock.calls[0]![0] as { model: { name: string }; rounds: number; prompts: string[] };
    expect(arg.model.name).toBe('glm-4.6');
    expect(arg.rounds).toBe(1);
    expect(arg.prompts).toEqual(['short']);

    const out = text(lines);
    expect(out).toContain('测速结果');
    expect(out).toContain('812ms');
    expect(out).toContain('快速档只跑 1 轮');
    // 历史落盘：alias / host / tier
    expect(history.runs).toHaveLength(1);
    expect(history.runs[0]!.alias).toBe('glm');
    expect(history.runs[0]!.baseUrlHost).toBe('open.bigmodel.cn');
    expect(history.runs[0]!.config.tier).toBe('quick');
    // abortable 注册后释放
    expect(abortables.at(-1)).toBeNull();
  });

  it('多模型串行 + 并排表格', async () => {
    const { ctx, lines } = makeCtx(benchCfg);
    await runner().execute(['glm', 'slow'], ctx);
    expect(runBenchMock).toHaveBeenCalledTimes(2);
    const out = text(lines);
    expect(out).toContain('glm');
    expect(out).toContain('slow');
  });

  it('别名不存在：开跑前整体拦截，一个请求都不发', async () => {
    const { ctx, lines } = makeCtx(benchCfg);
    await runner().execute(['ghost', 'glm'], ctx);
    expect(runBenchMock).not.toHaveBeenCalled();
    expect(text(lines)).toContain('未找到模型「ghost」');
  });

  it('快照回落不写历史', async () => {
    const { ctx } = makeCtx(cfg({ active: '' }));
    await runner().execute([], ctx);
    expect(runBenchMock).toHaveBeenCalledTimes(1);
    expect(history.runs).toEqual([]);
  });

  it('历史写入失败只告警，不影响结果', async () => {
    const { ctx, lines } = makeCtx(benchCfg);
    await runner({ appendFail: true }).execute([], ctx);
    const out = text(lines);
    expect(out).toContain('812ms');
    expect(out).toContain('历史写入失败（不影响本次结果）');
  });

  it('--json：stdout 纯 JSON，字段与 API 一致', async () => {
    const { ctx, lines } = makeCtx(benchCfg);
    await runner().execute(['glm', '--json'], ctx);
    const raw = lines.join('\n');
    const parsed = JSON.parse(raw) as {
      runId: string;
      config: { tier: string; rounds: number };
      aborted: boolean;
      results: { alias: string; model: string; summary: BenchSummary }[];
    };
    expect(parsed.runId).toBe('run-fixed');
    expect(parsed.config.tier).toBe('quick');
    expect(parsed.aborted).toBe(false);
    expect(parsed.results[0]!.alias).toBe('glm');
    expect(parsed.results[0]!.summary.ttft.p50).toBe(812);
    // 无任何非 JSON 噪音（进度行 / 表格 / 空行）
    expect(raw.trimStart().startsWith('{')).toBe(true);
    expect(raw).not.toContain('测速结果');
    expect(raw).not.toContain('[bench]');
  });

  it('中断：汇总已采样本、照常落盘、标题标注已中断 n/m、进程语义不抛错', async () => {
    // standard 档 = 2 档提示词 × 3 轮 = 计划 6 轮，实际只采到 2 轮就中断
    runBenchMock.mockImplementation(async () => mkSummary({ total: 2, okCount: 2, aborted: true }));
    const { ctx, lines } = makeCtx(benchCfg);
    await runner().execute(['glm', '--tier', 'standard'], ctx);
    const out = text(lines);
    expect(out).toContain('已中断 2/6 轮');
    expect(history.runs).toHaveLength(1);
    expect(history.runs[0]!.summary.aborted).toBe(true);
  });

  it('失败样本计入成功率并展示分类', async () => {
    runBenchMock.mockImplementation(async () =>
      mkSummary({ total: 3, okCount: 1, errorKinds: { auth: 2 } }),
    );
    const { ctx, lines } = makeCtx(benchCfg);
    await runner().execute(['glm'], ctx);
    const out = text(lines);
    expect(out).toContain('33%');
    expect(out).toContain('失败样本：auth×2');
  });

  it('--no-bust-cache 额外提示缓存收益', async () => {
    const { ctx, lines } = makeCtx(benchCfg);
    await runner().execute(['glm', '--no-bust-cache'], ctx);
    expect(text(lines)).toContain('未破坏前缀缓存');
    const arg = runBenchMock.mock.calls[0]![0] as { bustCache: boolean };
    expect(arg.bustCache).toBe(false);
  });

  it('help 与参数错误都不发请求', async () => {
    const a = makeCtx(benchCfg);
    await runner().execute(['--help'], a.ctx);
    expect(text(a.lines)).toContain('/model bench');
    expect(runBenchMock).not.toHaveBeenCalled();

    const b = makeCtx(benchCfg);
    await runner().execute(['--bogus'], b.ctx);
    expect(text(b.lines)).toContain('未知参数');
    expect(runBenchMock).not.toHaveBeenCalled();
  });

  it('history 分支：无记录给提示；有记录出历史表', async () => {
    const empty = makeCtx(benchCfg);
    await runner().execute(['history'], empty.ctx);
    expect(text(empty.lines)).toContain('暂无测速历史');

    history = {
      version: 1,
      runs: [
        {
          runId: 'r1',
          alias: 'glm',
          model: 'glm-4.6',
          baseUrlHost: 'open.bigmodel.cn',
          startedAt: '2026-10-29T03:04:05.000Z',
          finishedAt: '2026-10-29T03:05:05.000Z',
          config: { tier: 'quick', prompts: ['short'], rounds: 1, maxTokens: 256, bustCache: true },
          summary: mkSummary({ ttft: 700 }),
        },
      ],
    };
    const filled = makeCtx(benchCfg);
    await runner().execute(['history', 'glm'], filled.ctx);
    const out = text(filled.lines);
    expect(out).toContain('测速历史');
    expect(out).toContain('700ms');
    expect(runBenchMock).not.toHaveBeenCalled();
  });

  it('history --json 只输出 JSON', async () => {
    history = { version: 1, runs: [] };
    const { ctx, lines } = makeCtx(benchCfg);
    await runner().execute(['history', '--json'], ctx);
    const parsed = JSON.parse(lines.join('\n')) as { alias: string | null; entries: unknown[] };
    expect(parsed.alias).toBeNull();
    expect(parsed.entries).toEqual([]);
  });
});
