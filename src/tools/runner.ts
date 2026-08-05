// 工具执行器：统一执行工具，处理异常、超时、结果归一化
import type { Tool } from '../types.js';

export interface RunOptions {
  /** 超时毫秒数，默认 30000 */
  timeout?: number;
}

interface ToolCallItem {
  tool: Tool;
  args: Record<string, unknown>;
}

export class ToolRunner {
  /**
   * 执行单个工具
   *
   * 设计要点：
   * - 异常不抛出，捕获后转为"工具执行失败: xxx"字符串返回
   *   让 Agent 自行决定换思路（符合 ReAct 思想）
   * - 超时控制，避免工具卡死整个 Agent
   * - 结果归一化为字符串，便于 LLM 消费
   */
  async run(
    tool: Tool,
    args: Record<string, unknown>,
    options: RunOptions = {},
  ): Promise<string> {
    const timeout = options.timeout ?? 30000;
    try {
      const result = await this.withTimeout(tool.execute(args), timeout);
      // 结果归一化为字符串
      if (typeof result === 'string') return result;
      try {
        return JSON.stringify(result);
      } catch {
        return String(result);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 超时错误直接返回，不嵌套"工具执行失败"前缀
      if (msg.startsWith('工具执行超时')) return msg;
      return `工具执行失败: ${msg}`;
    }
  }

  /**
   * 并发执行多个工具
   *
   * 用于同一轮 LLM 返回多个 tool_calls 的场景。
   * 所有工具并行执行（Promise.all），结果顺序与输入一致。
   * 单个工具失败不影响其他工具，各自返回对应的 Observation。
   *
   * @param calls 工具调用列表
   * @param options 超时等选项（所有工具共享）
   */
  async runParallel(
    calls: ToolCallItem[],
    options: RunOptions = {},
  ): Promise<string[]> {
    return Promise.all(calls.map((c) => this.run(c.tool, c.args, options)));
  }

  /**
   * 给 Promise 加超时限制
   * 超时后 reject，原 Promise 仍会继续执行（无法真正取消），
   * 但 Agent 不会再等待它的结果。
   */
  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`工具执行超时 (${ms}ms)`));
      }, ms);
      p.then(
        (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}

/** 全局单例 */
export const runner = new ToolRunner();
