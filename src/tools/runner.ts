// 工具执行器：统一执行工具，处理异常、超时、取消、结果归一化
// Task-20261021-002-01：新增 signal 支持（raceAbort + 取消冒泡例外）
import type { Tool, ToolContext } from '../types.js';
import { AgentAbortedError } from '../types.js';
import { currentWorkspaceRoot } from '../runtime/workspace-context.js';

export interface RunOptions {
  /** 超时毫秒数，默认 30000 */
  timeout?: number;
  /** run 级取消信号；aborted 后抛出 AgentAbortedError（携带空 partial，由 agent 层换绑完整快照） */
  signal?: AbortSignal;
  /**
   * 空间根（Task-20261021-010-02 D3 显式优先）：
   * agent 传入 → 缺省回落 ALS → 再回落 process.cwd()（CLI / 单测语义不变）。
   */
  workspaceRoot?: string;
}

interface ToolCallItem {
  tool: Tool;
  args: Record<string, unknown>;
}

/** LLM/Tool 层无法构造完整 partial，先抛空快照，由 agent 主循环（task-02）换绑 */
function emptyPartialAborted(): AgentAbortedError {
  return new AgentAbortedError({ messages: [], transcript: [], steps: [], iterations: 0 });
}

export class ToolRunner {
  /**
   * 执行单个工具
   *
   * 设计要点：
   * - 异常不抛出，捕获后转为"工具执行失败: xxx"字符串返回
   *   让 Agent 自行决定换思路（符合 ReAct 思想）
   * - **唯一例外**：用户取消（AgentAbortedError）必须冒泡而非归一化为失败 Observation——
   *   否则 ReAct 会把"用户取消了"当"工具失败"再重试一轮，白烧 token（设计方案 D10）。
   *   识别依据：错误对象带 `aborted === true` 标记位。
   * - 超时控制，避免工具卡死整个 Agent
   * - 结果归一化为字符串，便于 LLM 消费
   * - 取消（signal）：与工具完成竞速，abort 先到则立即抛 AgentAbortedError；
   *   工具 Promise 仍会自然跑完（结果被丢弃），不会悬挂泄漏
   */
  async run(
    tool: Tool,
    args: Record<string, unknown>,
    options: RunOptions = {},
  ): Promise<string> {
    const timeout = options.timeout ?? tool.timeoutMs ?? 30000;
    const signal = options.signal;
    try {
      // ctx 注入：工具可感知取消信号（如 commandRun 杀子进程树）与空间根（D3 三级取值）
      const workspaceRoot = options.workspaceRoot ?? currentWorkspaceRoot() ?? process.cwd();
      const ctx: ToolContext = { signal, workspaceRoot };
      const exec$ = tool.execute(args, ctx);
      const raced = signal ? this.raceAbort(exec$, signal) : exec$;
      const result = await this.withTimeout(raced, timeout);
      // 结果归一化为字符串
      if (typeof result === 'string') return result;
      try {
        return JSON.stringify(result);
      } catch {
        return String(result);
      }
    } catch (e) {
      // 取消冒泡：ToolRunner"异常不抛出"契约的唯一例外（见方法注释）
      if ((e as { aborted?: boolean }).aborted === true) throw e;
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
   * 取消（signal）：任一工具被 abort 时整体 reject AgentAbortedError；
   * 其余工具 Promise 仍会自然跑完（结果被丢弃），不会悬挂泄漏。
   *
   * @param calls 工具调用列表
   * @param options 超时/取消信号等选项（所有工具共享）
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

  /**
   * abort 与工具完成竞速
   *
   * - abort 先到：reject AgentAbortedError（工具 Promise 仍会跑完，结果被丢弃）
   * - 工具先完成：正常返回结果，并移除 abort 监听（避免监听器泄漏）
   * - signal 已 aborted：立即 reject，不再调用方等待
   */
  private raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(emptyPartialAborted());
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(emptyPartialAborted());
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }
}

/** 全局单例 */
export const runner = new ToolRunner();
