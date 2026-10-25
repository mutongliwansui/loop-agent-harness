// xterm 实例封装（Task-20261027-001）
//
// 关键点：xterm 用 canvas/webgl 绘制，**不认 CSS 变量**。
// 主题切换时必须显式读取 `--term-*` 令牌并重设 `term.options.theme`，
// 否则切到深色后终端仍是浅底（原型验收时已确认这一点）。
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/** xterm 主题结构（字段名由 xterm 定义，值来自 CSS 令牌） */
export interface TermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent?: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** 从 :root 上读一个 CSS 自定义属性（未定义时回退） */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * 读取当前主题下的终端配色。
 * 每次调用都会重新 getComputedStyle，因此 data-theme 变化后能取到新值。
 */
export function readTermTheme(): TermTheme {
  return {
    background: cssVar('--term-bg', '#fbfcfd'),
    foreground: cssVar('--term-fg', '#24292f'),
    cursor: cssVar('--term-cursor', '#0e9f6e'),
    cursorAccent: cssVar('--term-bg', '#fbfcfd'),
    selectionBackground: cssVar('--term-sel', 'rgba(14,159,110,.18)'),
    black: cssVar('--term-black', '#24292f'),
    red: cssVar('--term-red', '#c0392b'),
    green: cssVar('--term-green', '#0e9f6e'),
    yellow: cssVar('--term-yellow', '#b45309'),
    blue: cssVar('--term-blue', '#1f6feb'),
    magenta: cssVar('--term-magenta', '#8b5cf6'),
    cyan: cssVar('--term-cyan', '#0d9488'),
    white: cssVar('--term-white', '#6b7280'),
    brightBlack: cssVar('--term-bright-black', '#8a919b'),
    brightRed: cssVar('--term-bright-red', '#db4437'),
    brightGreen: cssVar('--term-bright-green', '#12b981'),
    brightYellow: cssVar('--term-bright-yellow', '#d97706'),
    brightBlue: cssVar('--term-bright-blue', '#3b82f6'),
    brightMagenta: cssVar('--term-bright-magenta', '#a78bfa'),
    brightCyan: cssVar('--term-bright-cyan', '#14b8a6'),
    brightWhite: cssVar('--term-bright-white', '#4b5563'),
  };
}

export interface TermHandle {
  term: Terminal;
  fit: FitAddon;
  /** 应用当前 CSS 令牌配色（主题切换后调用） */
  applyTheme: () => void;
  /** 计算并返回 fit 后的行列数；容器不可见（0 宽高）时返回 null */
  fitNow: () => { cols: number; rows: number } | null;
  dispose: () => void;
}

/**
 * 创建终端实例。
 * - 渲染器用默认 canvas（兼容优先；WebGL 需额外 addon，P2 再开）
 * - 字体带中文回退：Windows 上不含 'Microsoft YaHei UI' 时 CJK 会用丑陋的兜底字形
 */
export function createTerm(el: HTMLElement): TermHandle {
  const term = new Terminal({
    fontFamily: "ui-monospace, 'Cascadia Mono', 'Cascadia Code', Consolas, 'Microsoft YaHei UI', monospace",
    fontSize: 12.5,
    lineHeight: 1.62,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 5000,
    // 显式声明 Unicode 宽度处理，CJK 与 emoji 对齐更稳
    convertEol: false,
    allowProposedApi: true,
    theme: readTermTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  const applyTheme = (): void => {
    term.options.theme = readTermTheme();
  };

  const fitNow = (): { cols: number; rows: number } | null => {
    // 容器隐藏（display:none / 宽高为 0）时 fit() 会算出荒谬尺寸，跳过
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return null;
    try {
      fit.fit();
    } catch {
      return null;
    }
    return { cols: term.cols, rows: term.rows };
  };

  return {
    term,
    fit,
    applyTheme,
    fitNow,
    dispose: () => {
      try {
        term.dispose();
      } catch {
        /* 已销毁 */
      }
    },
  };
}
