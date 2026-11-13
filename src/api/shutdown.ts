// 关停状态机（任务 20261112-007-02 / D2-1）
//
// 背景：关停序列原先内联在 bootstrap.ts 的 onSignal 闭包里，只有信号一条触发路径。
// 桌面壳需要「关窗口」也走同一套序列（含 Dreaming 晋升），因此把「幂等判定」与
// 「序列实现」拆开：状态机只管「是否首次触发」，序列实现仍留在 bootstrap
// （那里才拿得到 dreamScheduler / server / mcp 等依赖）。
//
// 为什么必须共用一把标志：信号（Ctrl+C / 系统关机 SIGTERM/SIGBREAK）与 HTTP 端点
// （桌面壳关窗）可能同时到达。各自跑一遍 Dreaming 会重复整理、并可能并发写记忆索引。

export interface ShutdownState {
  /** 是否已在关停中（只读，供信号处理判断是否需要「二次信号强退」） */
  readonly shuttingDown: boolean;
  /**
   * 请求一次关停。
   * @returns true = 本次是首次触发，调用方（状态机）已安排序列执行；
   *          false = 已在关停中，本次被幂等忽略
   */
  request(reason: string): boolean;
}

/**
 * 创建关停状态机。
 * @param start 首次触发时的回调，用于启动真正的关停序列。
 *   刻意用 setImmediate 延后一拍（D2-2）：HTTP 端点需要先把 202 响应写出去，
 *   若同步执行关停，server.close() 会把尚未发完的响应吞掉，壳只能靠超时兜底。
 */
export function createShutdownState(start: (reason: string) => void): ShutdownState {
  let shuttingDown = false;

  return {
    get shuttingDown(): boolean {
      return shuttingDown;
    },
    request(reason: string): boolean {
      if (shuttingDown) return false;
      shuttingDown = true;
      setImmediate(() => start(reason));
      return true;
    },
  };
}
