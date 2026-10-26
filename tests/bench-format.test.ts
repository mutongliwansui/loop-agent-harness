/**
 * 模型性能测试前端映射层单测（需求 20261027-003）
 *
 * webui/src/bench-format.ts 是不含 DOM/fetch 的纯函数层，可在 Node 下直测。
 * 覆盖：数字/时间/百分比格式化、色档阈值、分位文案（样本不足）、错误归类、
 * 配置摘要、预估 token、对比排序与最优判定、条形图宽度、迷你走势与脉冲条几何、变化率、时间格式化、结论文案。
 */
import { describe, it, expect } from 'vitest';
import {
  barPct,
  bestIndex,
  changePct,
  configSummary,
  dominantError,
  errorLabel,
  estimateTokens,
  fmtMs,
  fmtP,
  fmtPct,
  fmtTps,
  fmtWhen,
  promptLabel,
  pulseBars,
  sortResults,
  sparkPoints,
  successTone,
  tpsTone,
  ttftTone,
  verdictText,
  type BenchModelResultVM,
  type BenchSummaryVM,
} from '../webui/src/bench-format.js';

function summary(over: Partial<BenchSummaryVM> = {}): BenchSummaryVM {
  const p = (v: number | null, count = 3): BenchSummaryVM['ttft'] => ({
    p50: v,
    p90: v,
    min: v,
    max: v,
    count,
  });
  return {
    samples: [],
    total: 3,
    okCount: 3,
    successRate: 1,
    ttft: p(500),
    decodeTps: p(50),
    tpot: p(20),
    e2eTps: p(40),
    itlP90Ms: p(25),
    outTokens: p(100),
    estimated: false,
    suspectBuffered: false,
    totalTps: null,
    wallMs: 3000,
    aborted: false,
    errorKinds: {},
    ...over,
  };
}

function result(alias: string, over: Partial<BenchSummaryVM> = {}): BenchModelResultVM {
  return { alias, model: `model-${alias}`, baseUrlHost: 'api.example.com', summary: summary(over) };
}

describe('格式化', () => {
  it('fmtMs：< 1s 取毫秒整数，≥ 1s 用秒（两位小数），空值破折号', () => {
    expect(fmtMs(0)).toBe('0ms');
    expect(fmtMs(799.6)).toBe('800ms');
    expect(fmtMs(1000)).toBe('1.00s');
    expect(fmtMs(12345)).toBe('12.35s');
    expect(fmtMs(null)).toBe('—');
    expect(fmtMs(undefined)).toBe('—');
    expect(fmtMs(Number.NaN)).toBe('—');
  });

  it('fmtTps：一位小数，0 与空值语义不同（0 照出，空值破折号）', () => {
    expect(fmtTps(45.67)).toBe('45.7');
    expect(fmtTps(0)).toBe('0.0');
    expect(fmtTps(null)).toBe('—');
  });

  it('fmtPct：四舍五入到整数百分比', () => {
    expect(fmtPct(1)).toBe('100%');
    expect(fmtPct(0.666)).toBe('67%');
    expect(fmtPct(0)).toBe('0%');
    expect(fmtPct(null)).toBe('—');
  });

  it('fmtP：p90 且样本 < 3 时写「样本不足」而不是破折号（假精确防线）', () => {
    const few = { p50: 500, p90: null, min: 400, max: 600, count: 2 };
    expect(fmtP(few, 'p90')).toBe('样本不足');
    expect(fmtP(few, 'p50')).toBe('500ms');
    const none = { p50: null, p90: null, min: null, max: null, count: 0 };
    expect(fmtP(none, 'p90')).toBe('—');
  });

  it('fmtWhen：ISO → MM-DD HH:mm；非法串原样截断', () => {
    const iso = new Date(2026, 9, 27, 9, 5).toISOString();
    expect(fmtWhen(iso)).toBe('10-27 09:05');
    expect(fmtWhen('garbage-input-string')).toBe('garbage-input-st');
  });
});

describe('色档阈值（设计方案 §6）', () => {
  it('TTFT：≤800 好 / ≤2000 一般 / 更高差 / 空 none', () => {
    expect(ttftTone(800)).toBe('good');
    expect(ttftTone(801)).toBe('warn');
    expect(ttftTone(2000)).toBe('warn');
    expect(ttftTone(2001)).toBe('bad');
    expect(ttftTone(null)).toBe('none');
    expect(ttftTone(undefined)).toBe('none');
  });

  it('TPS：≥40 好 / ≥20 一般 / 更低差', () => {
    expect(tpsTone(40)).toBe('good');
    expect(tpsTone(39.9)).toBe('warn');
    expect(tpsTone(20)).toBe('warn');
    expect(tpsTone(19.9)).toBe('bad');
    expect(tpsTone(null)).toBe('none');
  });

  it('成功率：100% 好 / ≥60% 一般 / 更低差', () => {
    expect(successTone(1)).toBe('good');
    expect(successTone(0.6)).toBe('warn');
    expect(successTone(0.59)).toBe('bad');
    expect(successTone(null)).toBe('none');
  });
});

describe('文案映射', () => {
  it('promptLabel / errorLabel：未知键原样返回，不吞信息', () => {
    expect(promptLabel('short')).toBe('短问答');
    expect(promptLabel('weird')).toBe('weird');
    expect(errorLabel('rate_limit')).toBe('429 限流');
    expect(errorLabel('custom_kind')).toBe('custom_kind');
    expect(errorLabel(undefined)).toBe('失败');
  });

  it('dominantError：取计数最多的一类（并列时取先出现的）', () => {
    expect(dominantError({ auth: 2, timeout: 1 })).toEqual({ kind: 'auth', label: 'apiKey 无效', count: 2 });
    expect(dominantError({})).toBeNull();
    expect(dominantError(undefined)).toBeNull();
  });

  it('configSummary：档位 · 轮次×提示词 · max · 缓存 · 超时（并发 >1 才追加）', () => {
    const cfg = { tier: 'standard', prompts: ['short', 'medium'], rounds: 3, maxTokens: 256, bustCache: true, timeoutMs: 60_000 };
    expect(configSummary(cfg)).toBe('标准 · 3 轮 × 短问答+中文写作 · max 256 · 破坏缓存 · 60s');
    expect(configSummary({ ...cfg, tier: undefined })).toContain('自定义');
    expect(configSummary({ ...cfg, bustCache: false })).toContain('复用缓存');
    expect(configSummary({ ...cfg, concurrency: 2 })).toContain('并发 2');
    expect(configSummary(null)).toBe('');
  });

  it('estimateTokens：模型数 × 提示词数 × 轮数 × maxTokens，负数归零', () => {
    expect(estimateTokens(2, 2, 3, 256)).toBe(3072);
    expect(estimateTokens(-1, 2, 3, 256)).toBe(0);
  });
});

describe('对比排序与最优判定', () => {
  const a = result('a', { ttft: { p50: 900, p90: null, min: 800, max: 1000, count: 3 }, decodeTps: { p50: 30, p90: null, min: 25, max: 35, count: 3 } });
  const b = result('b', { ttft: { p50: 300, p90: null, min: 250, max: 400, count: 3 }, decodeTps: { p50: 80, p90: null, min: 70, max: 90, count: 3 } });
  const empty = result('c', {
    okCount: 0,
    successRate: 0,
    ttft: { p50: null, p90: null, min: null, max: null, count: 0 },
    decodeTps: { p50: null, p90: null, min: null, max: null, count: 0 },
  });

  it('TTFT 升序：越短越靠前，无数据沉底', () => {
    expect(sortResults([a, empty, b], 'ttft').map((r) => r.alias)).toEqual(['b', 'a', 'c']);
  });

  it('吞吐降序：越高越靠前，无数据沉底', () => {
    expect(sortResults([a, empty, b], 'tps').map((r) => r.alias)).toEqual(['b', 'a', 'c']);
  });

  it('bestIndex：返回在原始数组中的下标；全无数据 → -1', () => {
    const list = [a, b];
    expect(bestIndex(list, 'ttft')).toBe(1);
    expect(bestIndex(list, 'tps')).toBe(1);
    expect(bestIndex([empty], 'ttft')).toBe(-1);
    expect(bestIndex([], 'ttft')).toBe(-1);
  });

  it('barPct：最优者恒 100%；TTFT 按占比反算；非法值 0', () => {
    expect(barPct(300, 300, 'ttft')).toBe(100);
    expect(barPct(900, 300, 'ttft')).toBeCloseTo(33.33, 1);
    expect(barPct(30, 80, 'tps')).toBeCloseTo(37.5, 2);
    expect(barPct(80, 80, 'tps')).toBe(100);
    expect(barPct(null, 300, 'ttft')).toBe(0);
    expect(barPct(0, 300, 'tps')).toBe(0);
    expect(barPct(100, 0, 'tps')).toBe(0);
  });
});

describe('几何：迷你走势与脉冲条', () => {
  it('sparkPoints：空数组空串；单点落在水平中线；多点首末贴边内缩 pad', () => {
    expect(sparkPoints([], 60, 20)).toBe('');
    expect(sparkPoints([5], 60, 20)).toBe('2,10.0 58.0,10.0');

    const pts = sparkPoints([1, 2, 3], 60, 20, 2).split(' ');
    expect(pts).toHaveLength(3);
    expect(pts[0].startsWith('2.0,')).toBe(true); // 最小值在下边（y = h - pad）
    expect(pts[0].endsWith(',18.0')).toBe(true);
    expect(pts[2].endsWith(',2.0')).toBe(true); // 最大值在上边
    expect(pts[2].startsWith('58.0,')).toBe(true);
  });

  it('sparkPoints：所有值相同也不除零（落中线）', () => {
    const pts = sparkPoints([7, 7, 7], 40, 20).split(' ');
    expect(pts.every((p) => p.endsWith(',10.0'))).toBe(true);
  });

  it('pulseBars：条数对齐输入（最多 120），高度在 [2, h] 内且间隔越小越高', () => {
    const bars = pulseBars([100, 10, 50], 120, 40);
    expect(bars).toHaveLength(3);
    for (const b of bars) {
      expect(b.h).toBeGreaterThanOrEqual(2);
      expect(b.h).toBeLessThanOrEqual(40);
      expect(b.y + b.h).toBeCloseTo(40, 5);
    }
    expect(bars[1].h).toBeGreaterThan(bars[2].h); // 10ms 间隔比 50ms 高
    expect(pulseBars([], 120, 40)).toEqual([]);
  });

  it('pulseBars：超过 120 个间隔只取最近 120 个', () => {
    const many = Array.from({ length: 200 }, (_, i) => i + 1);
    expect(pulseBars(many, 300, 40)).toHaveLength(120);
  });
});

describe('变化率与结论文案', () => {
  it('changePct：正常计算；上次为 0 或空值 → null（不显示 ∞）', () => {
    expect(changePct(100, 120)).toBeCloseTo(20, 5);
    expect(changePct(100, 80)).toBeCloseTo(-20, 5);
    expect(changePct(0, 80)).toBeNull();
    expect(changePct(null, 80)).toBeNull();
    expect(changePct(100, null)).toBeNull();
  });

  it('verdictText：陈述事实；缓冲/估算各追加一句限定', () => {
    expect(verdictText(result('a'))).toBe('TTFT 500ms · 解码 50.0 tok/s');
    expect(verdictText(result('a', { suspectBuffered: true }))).toContain('网关缓冲');
    expect(verdictText(result('a', { estimated: true }))).toContain('估算');
    expect(verdictText(result('a', { okCount: 0, successRate: 0 }))).toContain('没有成功轮次');
    expect(verdictText(null)).toBe('');
  });
});
