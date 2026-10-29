// 测速实时读数视图（需求 20261029-002 / 任务文档 D4）
//
// 两种形态：
// - TTY：固定 3 行「块」+ 原地重绘（沿用 spinner.ts 已验证的 `\r\x1b[K` 手法，
//   多行则先 `\x1b[<n>A` 回到块首再逐行擦写）
// - 非 TTY（管道 / CI / --json）：退化为「每轮一行」日志，绝不输出 \r 与转义序列
//
// 纪律：本视图只读样本、只画界面，不做任何测量与统计（口径统一在 llm/bench.ts）。

import { BENCH_PROMPTS, type BenchPromptKey, type BenchSample } from '../llm/bench.js';
import { COLORS } from './colors.js';

export interface BenchLiveOptions {
  /** 是否启用原地刷新，默认 process.stdout.isTTY === true */
  enabled?: boolean;
  /** 输出目标，默认 process.stdout.write（便于测试注入） */
  write?: (s: string) => void;
  /** 是否着色，默认跟随 enabled */
  colors?: boolean;
  /** token 事件节流（引擎每个 delta 都回调，不节流会把终端打满），默认 100ms */
  throttleMs?: number;
}

/** 一轮结果的非 TTY 单行摘要 */
export function sampleLine(
  alias: string,
  sample: BenchSample,
  opts: { roundTotal: number; colors?: boolean } = { roundTotal: 0 },
): string {
  const c = opts.colors ? COLORS : null;
  const promptLabel = BENCH_PROMPTS[sample.prompt]?.label ?? sample.prompt;
  const head = `[bench] ${alias} r${sample.round}/${opts.roundTotal || sample.round} ${promptLabel}`;
  if (!sample.ok) {
    const why = sample.errorKind ? `${sample.errorKind} ${sample.error ?? ''}`.trim() : sample.error ?? '失败';
    return c ? `${head} -> ${c.red}失败${c.reset} (${why})` : `${head} -> 失败 (${why})`;
  }
  const ttft = sample.ttftMs !== undefined ? `${Math.round(sample.ttftMs)}ms` : '-';
  const tps = sample.decodeTps !== undefined ? `${sample.decodeTps.toFixed(1)}tok/s` : '-';
  const tok = sample.outTokens !== undefined ? `${sample.outTokens}tok` : '-';
  const mark = sample.estimated ? ' ~est' : '';
  const body = `TTFT ${ttft} decode ${tps} ${tok}${mark}`;
  return c ? `${head} -> ${c.cyan}${body}${c.reset}` : `${head} -> ${body}`;
}

/**
 * 原地刷新的实时读数块（3 行）：
 *
 * ```
 *   [bench 1/2] deepseek-flash (deepseek-chat)
 *   轮次 1/1 · 短问答 · 已出 62 tok · 41.8 tok/s
 *   TTFT 812ms · 成功 1 / 失败 0
 * ```
 */
export class BenchLiveView {
  private readonly enabled: boolean;
  private readonly write: (s: string) => void;
  private readonly colors: boolean;
  private readonly throttleMs: number;

  /** 已绘制行数（0 = 当前没有块） */
  private drawn = 0;
  private lastTokenAt = 0;

  private alias = '';
  private model = '';
  private modelIndex = 0;
  private modelTotal = 0;

  private round = 0;
  private roundTotal = 0;
  private prompt: BenchPromptKey = 'short';

  private ttftMs: number | null = null;
  private outTokens = 0;
  private decodeTps: number | null = null;

  private okCount = 0;
  private failCount = 0;

  constructor(opts: BenchLiveOptions = {}) {
    this.enabled = opts.enabled ?? process.stdout.isTTY === true;
    this.write = opts.write ?? ((s) => process.stdout.write(s));
    this.colors = opts.colors ?? this.enabled;
    this.throttleMs = opts.throttleMs ?? 100;
  }

  get isLive(): boolean {
    return this.enabled;
  }

  /** 开始测一个新模型（会先擦掉上一个模型的块） */
  startModel(info: { alias: string; model: string; index: number; total: number }): void {
    this.erase();
    this.alias = info.alias;
    this.model = info.model;
    this.modelIndex = info.index;
    this.modelTotal = info.total;
    this.round = 0;
    this.roundTotal = 0;
    this.ttftMs = null;
    this.outTokens = 0;
    this.decodeTps = null;
    this.okCount = 0;
    this.failCount = 0;
    if (this.enabled) this.render();
    else this.write(`[bench] ${info.alias} (${info.model}) 开始测速 ${info.index}/${info.total}\n`);
  }

  onRoundStart(info: { round: number; total: number; promptKey: BenchPromptKey }): void {
    this.round = info.round;
    this.roundTotal = info.total;
    this.prompt = info.promptKey;
    this.ttftMs = null;
    this.outTokens = 0;
    this.decodeTps = null;
    if (this.enabled) this.render();
  }

  onFirstToken(ms: number): void {
    this.ttftMs = ms;
    if (this.enabled) this.render();
  }

  /** 每个非空 delta 回调（内部节流） */
  onToken(outTokens: number, elapsedMs: number): void {
    this.outTokens = outTokens;
    // 解码速度 = 首个非空 delta 之后的产出速率（与引擎 decodeTps 同口径）
    if (this.ttftMs !== null && elapsedMs > this.ttftMs && outTokens > 1) {
      this.decodeTps = ((outTokens - 1) / (elapsedMs - this.ttftMs)) * 1000;
    }
    if (!this.enabled) return;
    const now = Date.now();
    if (now - this.lastTokenAt < this.throttleMs) return;
    this.lastTokenAt = now;
    this.render();
  }

  onSample(sample: BenchSample): void {
    if (sample.ok) this.okCount += 1;
    else this.failCount += 1;
    if (this.enabled) {
      this.render();
      return;
    }
    this.write(`${sampleLine(this.alias, sample, { roundTotal: this.roundTotal, colors: this.colors })}\n`);
  }

  /** 结束绘制，为结果表格让出位置（幂等） */
  finish(): void {
    this.erase();
  }

  // ---- 内部 ----

  private erase(): void {
    if (!this.enabled || this.drawn === 0) {
      this.drawn = 0;
      return;
    }
    const n = this.drawn;
    this.write(`\x1b[${n - 1}A`); // 回到块首行
    for (let i = 0; i < n; i++) {
      this.write('\r\x1b[K');
      if (i < n - 1) this.write('\n');
    }
    this.write(`\x1b[${n - 1}A`); // 擦完再回块首，后续输出从块首开始
    this.drawn = 0;
  }

  private lines(): string[] {
    const c = this.colors ? COLORS : null;
    const dim = (s: string): string => (c ? `${c.gray}${s}${c.reset}` : s);
    const accent = (s: string): string => (c ? `${c.cyan}${s}${c.reset}` : s);

    const head = `  ${accent(`[bench ${this.modelIndex}/${this.modelTotal}]`)} ${this.alias} ${dim(`(${this.model})`)}`;
    const promptLabel = BENCH_PROMPTS[this.prompt]?.label ?? this.prompt;
    const tps = this.decodeTps !== null ? `${this.decodeTps.toFixed(1)} tok/s` : '…';
    const mid = `  ${dim('轮次')} ${this.round}/${this.roundTotal} · ${promptLabel} · ${dim('已出')} ${this.outTokens} tok · ${tps}`;
    const ttft = this.ttftMs !== null ? `${Math.round(this.ttftMs)}ms` : '…';
    const last = `  ${dim('TTFT')} ${ttft} · ${dim('成功')} ${this.okCount} / ${dim('失败')} ${this.failCount}`;
    return [head, mid, last];
  }

  private render(): void {
    if (!this.enabled) return;
    const lines = this.lines();
    if (this.drawn > 0) this.write(`\x1b[${this.drawn - 1}A`);
    for (let i = 0; i < lines.length; i++) {
      this.write(`\r\x1b[K${lines[i]}`);
      if (i < lines.length - 1) this.write('\n');
    }
    this.drawn = lines.length;
  }
}
