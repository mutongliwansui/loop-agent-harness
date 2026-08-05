// 默认事件监听器：彩色日志输出
// 实现 AgentEvents 接口，作为 ReActAgent 的默认 events
import type { AgentEvents, AgentResult, LLMResponse } from '../types.js';

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
 * 通过 verbose=false 关闭输出。
 */
export class ConsoleLogger implements AgentEvents {
  constructor(private verbose: boolean = true) {}

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
