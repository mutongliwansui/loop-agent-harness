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
import type { Spinner } from '../ui/spinner.js';

/** loading 文案中工具名单个名称的最大长度（超出截断，避免长行撑破终端） */
const MAX_TOOL_LABEL = 24;

/**
 * 控制台彩色日志监听器
 *
 * 实现 AgentEvents 接口，作为 ReActAgent 的默认 events。
 * 通过 verbose=false 关闭输出；token 统计由 showTokenStats 独立控制（Task-15）。
 * 可选注入 Spinner：仅在确实要打印时先 stop() 清行，避免与 loading 指示器混行（Task-20260930-001）。
 */
export class ConsoleLogger implements AgentEvents {
  constructor(
    private verbose: boolean = true,
    private showTokenStats: boolean = true,
    private spinner?: Spinner,
  ) {}

  /** 本轮（迭代）出现过的工具名，用于多工具并发时的 loading 文案合并 */
  private _roundTools: string[] = [];

  /** 内部状态：标记当前轮 Thought 前缀是否已打印 */
  private _thoughtHeaderPrinted = false;

  /** 截断过长工具名，保持 loading 行紧凑 */
  private shortName(name: string): string {
    return name.length > MAX_TOOL_LABEL ? `${name.slice(0, MAX_TOOL_LABEL - 1)}…` : name;
  }

  /** 合并本轮已启动的工具名（多工具并发时显示为「执行中：a、b…」） */
  private toolRunningText(elapsedSuffix = ''): string {
    const names = this._roundTools.map((n) => this.shortName(n));
    const base = names.length > 0 ? names.join('、') : '工具';
    return `执行中：${base}…${elapsedSuffix}`;
  }

  onStart(input: string): void {
    // 仅在确实会打印时才停指示器，避免 verbose=false 下的无谓清行
    if (this.verbose) {
      this.spinner?.stop();
      console.log(
        `${COLORS.bold}${COLORS.yellow}━━━ ReAct Agent 启动 ━━━${COLORS.reset}`,
      );
      console.log(`${COLORS.gray}Query:${COLORS.reset} ${input}\n`);
    }
    // 起停独立于 verbose：verbose=false 时也要显示 loading
    this.spinner?.start('思考中…');
  }

  onIterationStart(iteration: number, maxIterations: number): void {
    this._roundTools = [];
    if (this.verbose) {
      this.spinner?.stop();
      console.log(
        `\n${COLORS.gray}━━━ 迭代 ${iteration + 1}/${maxIterations} ━━━${COLORS.reset}`,
      );
    }
    this.spinner?.start(`思考中…（第 ${iteration + 1} 轮）`);
  }

  onLLMStream(delta: string): void {
    // 仅 verbose 时内容会被打印，才需要停止动画；
    // verbose=false 时保持指示器运转，避免提前留出空窗
    if (!this.verbose) return;
    this.spinner?.stop();
    // 流式输出 Thought：首次出现时打 [Thought] 前缀
    if (!this._thoughtHeaderPrinted) {
      process.stdout.write(`\n${COLORS.cyan}${COLORS.bold}[Thought]${COLORS.reset} `);
      this._thoughtHeaderPrinted = true;
    }
    process.stdout.write(delta);
  }

  onLLMEnd(response: LLMResponse): void {
    // verbose=false 时不打断指示器（无内容输出，无需清行，避免无谓闪动）
    if (!this.verbose) return;
    this.spinner?.stop();
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
    this.spinner?.stop();

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
    this.spinner?.stop();

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
    this._roundTools.push(tool);
    if (this.verbose) {
      this.spinner?.stop();
      const argsStr = Object.keys(args).length
        ? JSON.stringify(args)
        : '(无参数)';
      console.log(
        `${COLORS.magenta}${COLORS.bold}[Action]${COLORS.reset} ${tool}(${COLORS.magenta}${argsStr}${COLORS.reset})`,
      );
    }
    this.spinner?.start(this.toolRunningText());
  }

  /** 工具执行进度心跳：更新 loading 文案附带已用时（P2，长耗时工具可见进展） */
  onToolProgress(tool: string, elapsedMs: number): void {
    if (!this._roundTools.includes(tool)) this._roundTools.push(tool);
    this.spinner?.update(this.toolRunningText(`（${(elapsedMs / 1000).toFixed(0)}s）`));
  }

  /**
   * 生成工具参数（tool_calls.arguments）阶段的可见进度
   * Task-20260930-001：Thought 文本结束到 [Action] 之间往往有长空窗（如 fileWrite 逐 token 生成整个文件内容），
   * 此处用 start（活跃则等价 update）刷新文案，附带累积体积与已用时，且绝不 stop（不产生清行闪动）
   */
  onToolCallDelta(tool: string, accumulatedBytes: number, elapsedMs: number): void {
    const size =
      accumulatedBytes < 1024
        ? `${accumulatedBytes}B`
        : `${(accumulatedBytes / 1024).toFixed(1)}KB`;
    const elapsed = elapsedMs >= 1000 ? ` / ${(elapsedMs / 1000).toFixed(0)}s` : '';
    this.spinner?.start(`生成参数：${this.shortName(tool)}…（${size}${elapsed}）`);
  }

  /**
   * L1 压缩提示：`[记忆] 上下文达阈值 4000 (4967)，触发压缩：提取 1234 字符 → 保留 7 条消息`
   * 失败时区分 skip（保留全部历史）/ archive（降级存档后压缩）
   * 受 verbose 控制
   */
  onCompaction(info: CompactionInfo): void {
    if (this.verbose) {
      this.spinner?.stop();

      if (info.failed) {
        const msg =
          info.fallback === 'archive'
            ? `压缩提取失败，已降级存档原始对话到 L2 并压缩（保留 ${info.keptMessages} 条消息）`
            : `压缩提取失败，已跳过压缩（保留全部 ${info.keptMessages} 条消息）`;
        console.log(
          `${COLORS.bold}${COLORS.red}[记忆]${COLORS.reset} ${COLORS.red}${msg}${COLORS.reset}`,
        );
      } else {
        console.log(
          `${COLORS.bold}${COLORS.yellow}[记忆]${COLORS.reset} ` +
            `${COLORS.yellow}上下文达阈值 ${info.threshold}（实际 ${info.contextTokens}），触发压缩${COLORS.reset}` +
            `${info.flushedChars > 0 ? `，提取 ${info.flushedChars} 字符` : ''}` +
            ` → 保留 ${info.keptMessages} 条消息`,
        );
      }
    }
    this.spinner?.start('思考中…');
  }

  onToolEnd(tool: string, result: string): void {
    if (!this.verbose) return;
    this.spinner?.stop();
    const indented = result.split('\n').join('\n  ');
    console.log(`${COLORS.green}[Observation]${COLORS.reset}\n  ${indented}`);
  }

  onFinal(answer: string): void {
    if (!this.verbose) return;
    this.spinner?.stop();
    console.log(
      `\n${COLORS.bold}${COLORS.green}━━━ Final Answer ━━━${COLORS.reset}\n${answer}\n`,
    );
  }

  onError(error: Error): void {
    if (!this.verbose) return;
    this.spinner?.stop();
    console.error(
      `\n${COLORS.red}${COLORS.bold}[Error]${COLORS.reset} ${COLORS.red}${error.message}${COLORS.reset}\n`,
    );
  }

  onWarning(info: { level: 'warning' | 'error'; message: string; context?: string }): void {
    if (!this.verbose) return;
    this.spinner?.stop();
    const tag = info.level === 'error' ? `${COLORS.red}[Error]` : `${COLORS.yellow}[Warning]`;
    const ctx = info.context ? ` ${COLORS.gray}(${info.context})${COLORS.reset}` : '';
    console.error(`\n${COLORS.bold}${tag}${COLORS.reset} ${info.level === 'error' ? COLORS.red : COLORS.yellow}${info.message}${COLORS.reset}${ctx}\n`);
  }

  onEnd(result: AgentResult | null): void {
    // result=null（如 run 抛错）时也必须 stop，避免动画残留
    this.spinner?.stop();
    if (!this.verbose) return;
    if (result) {
      console.log(
        `${COLORS.gray}━━━ 完成（${result.iterations} 轮，${result.steps.length} 步） ━━━${COLORS.reset}`,
      );
    }
  }
}

/** 默认日志实例（verbose=true） */
export const logger = new ConsoleLogger(true);
