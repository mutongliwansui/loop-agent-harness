// 默认事件监听器：彩色日志输出
// 实现 AgentEvents 接口，作为 ReActAgent 的默认 events
import type {
  AgentEvents,
  AgentResult,
  LLMResponse,
  LLMStats,
  LLMStatsSummary,
} from '../types.js';

/** ANSI 颜色码 */
const COLOR = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  bold: '\x1b[1m',
} as const;

/**
 * 控制台彩色日志监听器
 *
 * 实现 AgentEvents 接口，作为 ReActAgent 的默认 events。
 * 通过 verbose=false 关闭输出；token 统计由 showTokenStats 独立控制（Task-15）。
 */
export class ConsoleLogger implements AgentEvents {
  constructor(
    private verbose: boolean = true,
    private showTokenStats: boolean = true,
  ) {}

  onStart(input: string): void {
    if (!this.verbose) return;
    console.log(
      `${COLOR.bold}${COLOR.yellow}━━━ ReAct Agent 启动 ━━━${COLOR.reset}`,
    );
    console.log(`${COLOR.gray}Query:${COLOR.reset} ${input}\n`);
  }

  onIterationStart(iteration: number, maxIterations: number): void {
    if (!this.verbose) return;
    console.log(
      `\n${COLOR.gray}━━━ 迭代 ${iteration + 1}/${maxIterations} ━━━${COLOR.reset}`,
    );
  }

  onLLMStream(delta: string): void {
    if (!this.verbose) return;
    // 流式输出 Thought：首次出现时打 [Thought] 前缀
    // 通过类实例字段记录是否已打前缀（每轮重置由 react-agent 控制）
    if (!this._thoughtHeaderPrinted) {
      process.stdout.write(`\n${COLOR.cyan}${COLOR.bold}[Thought]${COLOR.reset} `);
      this._thoughtHeaderPrinted = true;
    }
    process.stdout.write(delta);
  }

  onLLMEnd(response: LLMResponse): void {
    if (!this.verbose) return;
    // Thought 结束换行
    if (this._thoughtHeaderPrinted) {
      process.stdout.write('\n');
      this._thoughtHeaderPrinted = false;
    }
  }

  /**
   * 每轮统计：`[迭代 2/5] 上下文 3214/8000 (40%) | 输入 2588 | 输出 412 | 缓存 72.3% | 1.2s`
   * 受 showTokenStats 控制（独立于 verbose），接近/超过压缩阈值时上下文段黄色警示
   */
  onLLMStats(stats: LLMStats): void {
    if (!this.showTokenStats) return;

    const ctxPct =
      stats.contextMaxTokens > 0
        ? `${((stats.contextTokens / stats.contextMaxTokens) * 100).toFixed(0)}%`
        : '-';
    // 记忆未初始化（maxTokens=0）时只显示绝对值，不带比例
    const ctxText =
      stats.contextMaxTokens > 0
        ? `${stats.contextTokens}/${stats.contextMaxTokens} (${ctxPct})`
        : `${stats.contextTokens}`;
    const overThreshold =
      stats.contextThreshold > 0 && stats.contextTokens >= stats.contextThreshold;
    const ctx = overThreshold
      ? `${COLOR.yellow}${ctxText} ⚠${COLOR.reset}`
      : `${COLOR.gray}${ctxText}${COLOR.reset}`;
    const cache =
      stats.cacheHitRate !== undefined
        ? `${(stats.cacheHitRate * 100).toFixed(1)}%`
        : 'N/A';

    console.log(
      `${COLOR.gray}[迭代 ${stats.iteration + 1}/${stats.maxIterations}]${COLOR.reset} ` +
        `${COLOR.cyan}上下文${COLOR.reset} ${ctx} | ` +
        `${COLOR.cyan}输入${COLOR.reset} ${stats.promptTokens} | ` +
        `${COLOR.cyan}输出${COLOR.reset} ${stats.completionTokens} | ` +
        `${COLOR.cyan}缓存${COLOR.reset} ${cache} | ${(stats.elapsedMs / 1000).toFixed(1)}s`,
    );
  }

  /**
   * 会话统计汇总：`[统计汇总] 3 轮 | 总输入 7842 | 总输出 1230 | 总 token 9072 | 平均缓存命中 68.5% | 上下文峰值 4500/8000 (56%)`
   */
  onLLMStatsSummary(summary: LLMStatsSummary): void {
    if (!this.showTokenStats || summary.iterations === 0) return;

    const cache =
      summary.avgCacheHitRate !== undefined
        ? `${(summary.avgCacheHitRate * 100).toFixed(1)}%`
        : 'N/A';
    const peak =
      summary.peakContextMaxTokens > 0
        ? `${summary.peakContextTokens}/${summary.peakContextMaxTokens} ` +
          `(${((summary.peakContextTokens / summary.peakContextMaxTokens) * 100).toFixed(0)}%)`
        : `${summary.peakContextTokens}`;

    console.log(
      `${COLOR.gray}[统计汇总]${COLOR.reset} ${summary.iterations} 轮 | ` +
        `${COLOR.cyan}总输入${COLOR.reset} ${summary.totalPrompt} | ` +
        `${COLOR.cyan}总输出${COLOR.reset} ${summary.totalCompletion} | ` +
        `${COLOR.cyan}总 token${COLOR.reset} ${summary.totalTokens} | ` +
        `${COLOR.cyan}平均缓存命中${COLOR.reset} ${cache} | ` +
        `${COLOR.cyan}上下文峰值${COLOR.reset} ${peak}`,
    );
  }

  onToolStart(tool: string, args: Record<string, unknown>): void {
    if (!this.verbose) return;
    const argsStr = Object.keys(args).length
      ? JSON.stringify(args)
      : '(无参数)';
    console.log(
      `${COLOR.magenta}${COLOR.bold}[Action]${COLOR.reset} ${tool}(${COLOR.magenta}${argsStr}${COLOR.reset})`,
    );
  }

  onToolEnd(tool: string, result: string): void {
    if (!this.verbose) return;
    const indented = result.split('\n').join('\n  ');
    console.log(`${COLOR.green}[Observation]${COLOR.reset}\n  ${indented}`);
  }

  onFinal(answer: string): void {
    if (!this.verbose) return;
    console.log(
      `\n${COLOR.bold}${COLOR.green}━━━ Final Answer ━━━${COLOR.reset}\n${answer}\n`,
    );
  }

  onError(error: Error): void {
    if (!this.verbose) return;
    console.error(
      `\n${COLOR.red}${COLOR.bold}[Error]${COLOR.reset} ${COLOR.red}${error.message}${COLOR.reset}\n`,
    );
  }

  onEnd(result: AgentResult | null): void {
    if (!this.verbose) return;
    if (result) {
      console.log(
        `${COLOR.gray}━━━ 完成（${result.iterations} 轮，${result.steps.length} 步） ━━━${COLOR.reset}`,
      );
    }
  }

  /** 内部状态：标记当前轮 Thought 前缀是否已打印 */
  private _thoughtHeaderPrinted = false;
}

/** 默认日志实例（verbose=true） */
export const logger = new ConsoleLogger(true);
