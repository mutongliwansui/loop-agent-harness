// 零依赖的自绘 loading 指示器
// Braille 帧在多数现代终端可正常渲染；Windows 旧版控制台/缺字形终端退化到 ASCII 帧
export const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const ASCII_FRAMES = ['|', '/', '-', '\\'];

/**
 * 依据运行环境挑选默认帧序列（可在测试中注入 platform/env）
 *
 * 规则：
 * - `LOOP_AGENT_SPINNER=ascii|braille` 显式指定优先；
 * - Windows 且非 Windows Terminal（无 WT_SESSION）、非 VS Code 终端时退回 ASCII；
 * - 其余环境使用 Braille。
 */
export function detectFrames(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const forced = env.LOOP_AGENT_SPINNER?.toLowerCase();
  if (forced === 'ascii') return ASCII_FRAMES;
  if (forced === 'braille') return BRAILLE_FRAMES;
  if (platform === 'win32' && !env.WT_SESSION && env.TERM_PROGRAM !== 'vscode') {
    return ASCII_FRAMES;
  }
  return BRAILLE_FRAMES;
}

export interface SpinnerOptions {
  /** 是否启用动画，默认 process.stdout.isTTY === true */
  enabled?: boolean;
  /** 输出目标，默认 process.stdout.write（便于测试注入） */
  write?: (s: string) => void;
  /** 帧间隔，默认 80ms */
  intervalMs?: number;
  /** 动画帧序列，默认由 detectFrames() 按环境挑选；可显式传 ASCII 兼容缺字形终端 */
  frames?: string[];
}

/**
 * 自绘 loading 指示器（零依赖）
 *
 * 通过 `\r\x1b[K` 原地重绘，非 TTY 环境自动禁用，可注入输出目标便于单测。
 */
export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private text = '';
  private active = false;
  private readonly enabled: boolean;
  private readonly write: (s: string) => void;
  private readonly intervalMs: number;
  private readonly frames: string[];

  constructor(opts: SpinnerOptions = {}) {
    this.enabled = opts.enabled ?? process.stdout.isTTY === true;
    this.write = opts.write ?? ((s) => process.stdout.write(s));
    this.intervalMs = opts.intervalMs ?? 80;
    this.frames = opts.frames ?? detectFrames();
  }

  get isActive(): boolean {
    return this.active;
  }

  /** 启动/更新指示器（重复调用视为更新文案） */
  start(text: string): void {
    if (!this.enabled) return;
    this.text = text;
    if (this.active) {
      this.render();
      return;
    }
    this.active = true;
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % this.frames.length;
      this.render();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  update(text: string): void {
    if (!this.enabled || !this.active) return;
    this.text = text;
    this.render();
  }

  /** 停止并清行；可传入收尾文案（会换行保留） */
  stop(finalText?: string): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.enabled) {
      this.write('\r\x1b[K');
      if (finalText) this.write(`${finalText}\n`);
    }
  }

  private render(): void {
    this.write(
      `\r\x1b[K\x1b[36m${this.frames[this.frame % this.frames.length]}\x1b[0m ${this.text}`,
    );
  }
}
