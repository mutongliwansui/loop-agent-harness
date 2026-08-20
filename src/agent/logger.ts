// 默认事件监听器：彩色日志输出
// 实现 AgentEvents 接口，作为 ReActAgent 的默认 events
import type {
  AgentEvents,
  AgentResult,
  CompactionInfo,
  LLMResponse,
  LLMStats,
  LLMStatsSummary,
} from '../types.js';
import { COLORS } from '../ui/colors.js';

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
      `${COLORS.bold}${COLORS.yellow}━━━ ReAct Agent 启动 ━━━${COLORS.reset}`,
    );
    console.log(`${COLORS.gray}Query:${COLORS.reset} ${input}\n`);
  }

  onIterationStart(iteration: number, maxIterations: number): void {
    if (!this.verbose) return;
    console.log(
      `\n${COLORS.gray}━━━ 迭代 ${iteration + 1}/${maxIterations} ━━━${COLORS.reset}`,
    );
  }

  onLLMStream(delta: string): void {
    if (!this.verbose) return;
    // 流式输出 Thought：首次出现时打 [Thought] 前缀
    // 通过类实例字段记录是否已打前缀（每轮重置由 react-agent 控制）
    if (!this._thoughtHeaderPrinted) {
      process.stdout.write(`\n${COLORS.cyan}${COLORS.bold}[Thought]${COLORS.reset} `);
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
      ? `${COLORS.yellow}${ctxText} ⚠${COLORS.reset}`
      : `${COLORS.gray}${ctxText}${COLORS.reset}`;
    const cache =
      stats.cacheHitRate !== undefined
        ? `${(stats.cacheHitRate * 100).toFixed(1)}%`
        : 'N/A';

    console.log(
      `${COLORS.gray}[迭代 ${stats.iteration + 1}/${stats.maxIterations}]${COLORS.reset} ` +
        `${COLORS.cyan}上下文${COLORS.reset} ${ctx} | ` +
        `${COLORS.cyan}输入${COLORS.reset} ${stats.promptTokens} | ` +
        `${COLORS.cyan}输出${COLORS.reset} ${stats.completionTokens} | ` +
        `${COLORS.cyan}缓存${COLORS.reset} ${cache} | ${(stats.elapsedMs / 1000).toFixed(1)}s`,
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
      `${COLORS.gray}[统计汇总]${COLORS.reset} ${summary.iterations} 轮 | ` +
        `${COLORS.cyan}总输入${COLORS.reset} ${summary.totalPrompt} | ` +
        `${COLORS.cyan}总输出${COLORS.reset} ${summary.totalCompletion} | ` +
        `${COLORS.cyan}总 token${COLORS.reset} ${summary.totalTokens} | ` +
        `${COLORS.cyan}平均缓存命中${COLORS.reset} ${cache} | ` +
        `${COLORS.cyan}上下文峰值${COLORS.reset} ${peak}`,
    );
  }

  onToolStart(tool: string, args: Record<string, unknown>): void {
    if (!this.verbose) return;
    const argsStr = Object.keys(args).length
      ? JSON.stringify(args)
      : '(无参数)';
    console.log(
      `${COLORS.magenta}${COLORS.bold}[Action]${COLORS.reset} ${tool}(${COLORS.magenta}${argsStr}${COLORS.reset})`,
    );
  }

  /**
   * L1 压缩提示：`[记忆] 上下文达阈值 4000 (4967)，触发压缩：提取 1234 字符 → 保留 7 条消息`
   * 失败时区分 skip（保留全部历史）/ archive（降级存档后压缩）
   * 受 verbose 控制
   */
  onCompaction(info: CompactionInfo): void {
    if (!this.verbose) return;

    if (info.failed) {
      const msg =
        info.fallback === 'archive'
          ? `压缩提取失败，已降级存档原始对话到 L2 并压缩（保留 ${info.keptMessages} 条消息）`
          : `压缩提取失败，已跳过压缩（保留全部 ${info.keptMessages} 条消息）`;
      console.log(
        `${COLORS.bold}${COLORS.red}[记忆]${COLORS.reset} ${COLORS.red}${msg}${COLORS.reset}`,
      );
      return;
    }

    console.log(
      `${COLORS.bold}${COLORS.yellow}[记忆]${COLORS.reset} ` +
        `${COLORS.yellow}上下文达阈值 ${info.threshold}（实际 ${info.contextTokens}），触发压缩${COLORS.reset}` +
        `${info.flushedChars > 0 ? `，提取 ${info.flushedChars} 字符` : ''}` +
        ` → 保留 ${info.keptMessages} 条消息`,
    );
  }

  onToolEnd(tool: string, result: string): void {
    if (!this.verbose) return;
    const indented = result.split('\n').join('\n  ');
    console.log(`${COLORS.green}[Observation]${COLORS.reset}\n  ${indented}`);
  }

  onFinal(answer: string): void {
    if (!this.verbose) return;
    console.log(
      `\n${COLORS.bold}${COLORS.green}━━━ Final Answer ━━━${COLORS.reset}\n${answer}\n`,
    );
  }

  onError(error: Error): void {
    if (!this.verbose) return;
    console.error(
      `\n${COLORS.red}${COLORS.bold}[Error]${COLORS.reset} ${COLORS.red}${error.message}${COLORS.reset}\n`,
    );
  }

  onWarning(info: { level: 'warning' | 'error'; message: string; context?: string }): void {
    if (!this.verbose) return;
    const tag = info.level === 'error' ? `${COLORS.red}[Error]` : `${COLORS.yellow}[Warning]`;
    const ctx = info.context ? ` ${COLORS.gray}(${info.context})${COLORS.reset}` : '';
    console.error(`\n${COLORS.bold}${tag}${COLORS.reset} ${info.level === 'error' ? COLORS.red : COLORS.yellow}${info.message}${COLORS.reset}${ctx}\n`);
  }

  onEnd(result: AgentResult | null): void {
    if (!this.verbose) return;
    if (result) {
      console.log(
        `${COLORS.gray}━━━ 完成（${result.iterations} 轮，${result.steps.length} 步） ━━━${COLORS.reset}`,
      );
    }
  }

  /** 内部状态：标记当前轮 Thought 前缀是否已打印 */
  private _thoughtHeaderPrinted = false;
}

/** 默认日志实例（verbose=true） */
export const logger = new ConsoleLogger(true);
