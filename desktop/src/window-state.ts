/**
 * 窗口状态持久化（任务 20261112-007-03 / D3-1、D3-3）。
 *
 * 为什么不写进主工程 config.json（D3-1）：壳打包后只有自己的代码，无法复用主工程
 * 的分层 ConfigLoader；而窗口宽高位置本质是 UI 状态，不是业务配置。放
 * app.getPath('userData')（Win 下 %APPDATA%\LoopAgent）是 Electron 惯例，
 * 且 --serve 路径完全不受影响。主工程 config.json 结构零改动。
 *
 * 为什么位置必须做可见性校验（D3-3）：用户拔掉第二台显示器后，保存的位置落在
 * 不存在的屏幕上，窗口会「消失」——这是窗口状态持久化最常见的 bug。
 *
 * 本模块刻意不 import electron：单测在纯 node 下跑，Display.workArea 这类
 * Electron 对象由 main.ts 取出矩形后传进来。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 首次启动的窗口尺寸（缺省居中，由 Electron 决定位置） */
export const DEFAULT_WIDTH = 1440;
export const DEFAULT_HEIGHT = 900;

/**
 * 最小窗口尺寸（D3-7）。
 *
 * WebUI 在 ≤900px 会切窄屏布局（管理菜单改为浮层），缩到更小会明显难用，
 * 因此直接限制窗口边界而不是只靠 CSS。
 */
export const MIN_WIDTH = 1024;
export const MIN_HEIGHT = 700;

/** 可见性判定要求的最小交集边长（D3-3：≥100×100 像素） */
export const MIN_VISIBLE_SIZE = 100;

/** 位置未记录过时的缺省状态 */
export const DEFAULT_WINDOW_STATE: WindowState = {
  width: DEFAULT_WIDTH,
  height: DEFAULT_HEIGHT,
  maximized: false,
};

export interface WindowState {
  /** 未记录过位置时缺省，交由 Electron 居中 */
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

/** 屏幕工作区矩形（与 Electron 的 Display.workArea 结构兼容） */
export interface WorkAreaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 状态文件路径：userData 目录下（Win: %APPDATA%\LoopAgent\window-state.json） */
export function windowStatePath(userDataDir: string): string {
  return join(userDataDir, 'window-state.json');
}

/** 判断是否为可用的有限数字（挡掉 NaN / Infinity / null / 字符串） */
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 把宽高夹到 [最小值, 缺省值上限] 之间 */
function clampDimension(value: unknown, min: number, fallback: number): number {
  if (!isNum(value)) return fallback;
  return Math.max(min, Math.round(value));
}

/**
 * 把任意来源的状态夹到合法范围。
 *
 * 保存尺寸小于最小限制时（如用户曾用更小窗口的旧版本）夹到下限，
 * 避免恢复出一个「卡在最小尺寸以下」的窗口。
 */
export function clampToLimits(state: WindowState): WindowState {
  return {
    x: isNum(state.x) ? Math.round(state.x) : undefined,
    y: isNum(state.y) ? Math.round(state.y) : undefined,
    width: clampDimension(state.width, MIN_WIDTH, DEFAULT_WIDTH),
    height: clampDimension(state.height, MIN_HEIGHT, DEFAULT_HEIGHT),
    maximized: state.maximized === true,
  };
}

/**
 * 读窗口状态。
 *
 * 任何异常（文件不存在、非法 JSON、字段类型不对）都回落到缺省值，
 * 只记日志不抛错：窗口状态坏了不该阻断启动（3.3 边界表）。
 */
export function loadWindowState(
  userDataDir: string,
  log: (msg: string) => void = () => {},
): WindowState {
  const file = windowStatePath(userDataDir);
  if (!existsSync(file)) return { ...DEFAULT_WINDOW_STATE };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    log(`[window-state] 读取失败，使用缺省窗口大小：${String(err)}`);
    return { ...DEFAULT_WINDOW_STATE };
  }

  if (!raw || typeof raw !== 'object') {
    log('[window-state] 内容不是对象，使用缺省窗口大小');
    return { ...DEFAULT_WINDOW_STATE };
  }

  const obj = raw as Partial<WindowState>;
  const state = clampToLimits({
    x: obj.x,
    y: obj.y,
    width: obj.width as number,
    height: obj.height as number,
    maximized: obj.maximized === true,
  });
  // 只记了一半坐标（只有 x 没有 y）视为无位置，否则会用 0 当 y 把窗口顶到屏幕外
  if (state.x === undefined || state.y === undefined) {
    delete state.x;
    delete state.y;
  }
  return state;
}

/**
 * 写窗口状态（原子写：先写 .tmp 再 rename）。
 *
 * 直接覆盖原文件时若进程被杀，会留下半截 JSON，下次启动就读不出位置。
 * rename 在同一分区上是原子的，Windows 下也会覆盖已存在目标。
 *
 * 写入失败只记日志（只读目录 / 磁盘满），绝不影响用户使用（3.3 边界表）。
 */
export function saveWindowState(
  userDataDir: string,
  state: WindowState,
  log: (msg: string) => void = () => {},
): void {
  const file = windowStatePath(userDataDir);
  const tmp = `${file}.tmp`;
  const payload = JSON.stringify(
    { ...clampToLimits(state), savedAt: new Date().toISOString() },
    null,
    2,
  );
  try {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(tmp, payload, 'utf-8');
    renameSync(tmp, file);
  } catch (err) {
    log(`[window-state] 保存失败（不影响使用）：${String(err)}`);
    // 清掉可能残留的半截临时文件，避免下次启动误读
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
      /* 清理失败无所谓 */
    }
  }
}

/**
 * 判断保存的位置是否仍落在某块可见屏幕上（D3-3）。
 *
 * 判据是「与该显示器工作区的交集宽高都不小于 100px」，而不是「左上角是否在屏内」：
 * 后者会让一个只露出 1px 边缘的窗口通过校验，用户实际还是找不到它。
 */
export function isStateVisible(state: WindowState, workAreas: WorkAreaRect[]): boolean {
  if (!isNum(state.x) || !isNum(state.y)) return false;
  if (!Array.isArray(workAreas) || workAreas.length === 0) return true;

  return workAreas.some((area) => {
    const overlapW =
      Math.min(state.x! + state.width, area.x + area.width) - Math.max(state.x!, area.x);
    const overlapH =
      Math.min(state.y! + state.height, area.y + area.height) - Math.max(state.y!, area.y);
    return overlapW >= MIN_VISIBLE_SIZE && overlapH >= MIN_VISIBLE_SIZE;
  });
}
