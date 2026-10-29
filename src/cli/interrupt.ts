// CLI 的 Ctrl+C（SIGINT）分派逻辑（Task-20261029-001 D1）。
//
// 为什么单独抽成纯函数：
// Ctrl+C 的真实行为要覆盖「回答中 / 收尾中 / 确认中 / 空闲 / Dreaming 中」五种状态，
// 若直接写成 start.ts 里的一串 if，就只能靠真实终端手按验证；抽成纯函数后可对
// 全部状态组合与优先级顺序做零成本单测（tests/cli-interrupt.test.ts）。
//
// 语义总览（用户视角）：
//   - 模型正在回答        → 只中断本次回答，进程不退出
//   - 正在停止（已 abort）→ 忽略，提示"正在停止…"，绝不退出（防连按两下送命）
//   - y/N 确认中          → 取消确认（等价回答 n），不中断任务、不退出
//   - Dreaming 收尾中     → 立即强退（rl 已关闭，不再有正常退出路径）
//   - 空闲                → 第一次提示并开窗口，窗口内第二次才退出（防误触）

/** 收到 SIGINT 时 CLI 的运行时状态 */
export interface SigintState {
  /** 有任务在跑（命令分发或 agent.run 尚未结束） */
  running: boolean;
  /** 已发出 abort、但 run 尚未返回（收尾中） */
  aborting: boolean;
  /** y/N 确认中（rl.question 未 settle） */
  confirming: boolean;
  /** readline 已关闭（退出链路：Dreaming 收尾中） */
  exiting: boolean;
  /**
   * 本轮是否持有 AbortController（可被 abort）。
   * 普通提问为 true；斜杠命令执行为 false（命令没有取消语义，只能提示稍候）。
   */
  abortable: boolean;
  /** 空闲态本次按键是否落在"退出确认窗口"内（由 resolveExitArm 计算，调用方维护时间戳） */
  exitArmed: boolean;
}

/** Ctrl+C 应执行的动作 */
export type SigintAction =
  /** 中断当前回答（abort 本轮 run） */
  | 'abort-run'
  /** 忙但不可中断（命令执行中 / 正在停止）：仅提示，不做任何事 */
  | 'ignore-busy'
  /** 取消 y/N 确认（视为回答 n） */
  | 'cancel-confirm'
  /** Dreaming 收尾中：立即强退 */
  | 'force-exit'
  /** 空闲第一次：开启退出确认窗口并提示 */
  | 'arm-exit'
  /** 空闲且窗口内第二次：执行退出 */
  | 'exit';

/**
 * 根据当前状态决定 Ctrl+C 的动作。
 *
 * 优先级（自上而下短路，顺序即语义）：
 *   1. exiting        → force-exit   （rl 已关，只可能在做 Dreaming，强退是唯一出口）
 *   2. confirming     → cancel-confirm（撤回答，不动任务）
 *   3. aborting       → ignore-busy  （正在停止，连按不退出、不重复 abort）
 *   4. running && abortable → abort-run
 *   5. running        → ignore-busy  （命令执行中，没有取消语义）
 *   6. 空闲           → exitArmed ? exit : arm-exit
 *
 * 关键：aborting 必须排在 running 之前——abort 之后 run 仍未返回，此时 running 依然为 true，
 * 若不先判断 aborting 就会重复 abort 并错过"绝不退出"的保护。
 */
export function decideSigint(s: SigintState): SigintAction {
  if (s.exiting) return 'force-exit';
  if (s.confirming) return 'cancel-confirm';
  if (s.aborting) return 'ignore-busy';
  if (s.running) return s.abortable ? 'abort-run' : 'ignore-busy';
  return s.exitArmed ? 'exit' : 'arm-exit';
}

/** 空闲退出确认窗口默认时长（毫秒）：3 秒内连按两次视为"确实要退出" */
export const EXIT_WINDOW_MS = 3000;

/**
 * 判定本次空闲态 Ctrl+C 是否落在退出确认窗口内。
 *
 * @param lastArmAt 上一次 arm-exit 的时间戳（毫秒）；0/未设置表示窗口未开启
 * @param now       当前时间戳（毫秒）
 * @param windowMs  窗口时长（默认 EXIT_WINDOW_MS）
 * @returns true 表示窗口内（应退出）；false 表示需要重新开窗
 *
 * 边界：窗口正好等于 windowMs 时仍算窗口内（含右端点），避免临界抖动。
 */
export function resolveExitArm(
  lastArmAt: number,
  now: number,
  windowMs: number = EXIT_WINDOW_MS,
): boolean {
  if (!lastArmAt || lastArmAt <= 0) return false;
  // lastArmAt > now（时钟回拨等异常）时按"窗口内"处理更安全：宁可多提示一次也不误退
  const delta = now - lastArmAt;
  if (delta < 0) return true;
  return delta <= windowMs;
}
