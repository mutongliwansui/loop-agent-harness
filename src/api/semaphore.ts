// 进程级 FIFO 信号量（Task-20261021-010-04 D18）：跨工作空间并发 run 的总闸门
//
// 背景：task-04 放开 per-space 互斥后，总并发 = 空间数 × 池容量，空间多时可能打爆
// LLM 限速。本信号量夹在各 runtime 的 runAgent 外层（WorkspaceRegistry.build 注入），
// 上限 min(maxRuntimes × poolCapacity, LOOP_AGENT_MAX_CONCURRENCY ?? 8)。
//
// - 零依赖、先到先得（FIFO）；排队不设超时（与现有 run 无时限语义一致）
// - 名额移交在释放方同步完成（activeCount 不抖），等待者不会插队

export class Semaphore {
  private activeCount = 0;
  private readonly queue: Array<() => void> = [];

  constructor(readonly max: number) {}

  /** 正在执行的 run 数 */
  get active(): number {
    return this.activeCount;
  }

  /** 排队等待的 run 数 */
  get pending(): number {
    return this.queue.length;
  }

  /** 取到名额后执行 fn；名额不足时 FIFO 排队（不超时、不拒绝） */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.max) {
      // 被唤醒时名额已由释放方计入 activeCount，这里不再重复计数
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.activeCount++;
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) {
        // 名额直接移交给队首等待者（activeCount 保持不变）
        next();
      } else {
        this.activeCount--;
      }
    }
  }
}
