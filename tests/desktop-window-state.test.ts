// 窗口状态持久化单测（任务 20261112-007-03 / D3-1、D3-3）
//
// 重点不是「能读写」，而是最容易被忽略的三类坏输入：
// 文件损坏、位置落到已断开的显示器外、旧版本存下的过小尺寸。
// 这几种情况一旦处理错，表现是「窗口不见了」或「窗口小到没法用」，
// 用户无法自行恢复，只能删配置文件。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadWindowState,
  saveWindowState,
  isStateVisible,
  windowStatePath,
  clampToLimits,
  DEFAULT_WINDOW_STATE,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
  MIN_VISIBLE_SIZE,
  type WorkAreaRect,
} from '../desktop/src/window-state.js';

/** 常见单屏：1920×1080，工作区去掉任务栏 */
const SCREEN_1080: WorkAreaRect[] = [{ x: 0, y: 0, width: 1920, height: 1040 }];
/** 双屏左右并排，第二屏在右侧 */
const SCREEN_DUAL: WorkAreaRect[] = [
  { x: 0, y: 0, width: 1920, height: 1040 },
  { x: 1920, y: 0, width: 1920, height: 1040 },
];

describe('desktop/window-state', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loop-shell-ws-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('状态文件位于 userData 目录下，名为 window-state.json', () => {
    expect(windowStatePath(dir)).toBe(join(dir, 'window-state.json'));
  });

  it('文件不存在时返回缺省尺寸且不带位置', () => {
    const s = loadWindowState(dir);
    expect(s).toEqual(DEFAULT_WINDOW_STATE);
    expect(s.x).toBeUndefined();
    expect(s.y).toBeUndefined();
    expect(s.width).toBe(DEFAULT_WIDTH);
    expect(s.height).toBe(DEFAULT_HEIGHT);
  });

  it('写入后能原样读回位置、尺寸与最大化状态', () => {
    saveWindowState(dir, { x: 240, y: 120, width: 1600, height: 950, maximized: true });
    const s = loadWindowState(dir);
    expect(s).toEqual({ x: 240, y: 120, width: 1600, height: 950, maximized: true });
  });

  it('写入的文件带 savedAt 时间戳，便于排障', () => {
    saveWindowState(dir, { x: 10, y: 10, width: 1200, height: 800, maximized: false });
    const raw = JSON.parse(readFileSync(windowStatePath(dir), 'utf-8'));
    expect(typeof raw.savedAt).toBe('string');
    expect(new Date(raw.savedAt).toString()).not.toBe('Invalid Date');
  });

  it('原子写不留下 .tmp 残留文件', () => {
    saveWindowState(dir, { x: 1, y: 2, width: 1200, height: 800, maximized: false });
    expect(existsSync(`${windowStatePath(dir)}.tmp`)).toBe(false);
  });

  // 设计 3.3 边界表：状态文件损坏/非法 JSON → 忽略并用默认值，记录日志，不阻塞启动
  it('非法 JSON 时回落缺省值并记录日志，不抛错', () => {
    writeFileSync(windowStatePath(dir), '{ not json', 'utf-8');
    const logs: string[] = [];
    const s = loadWindowState(dir, (m) => logs.push(m));
    expect(s).toEqual(DEFAULT_WINDOW_STATE);
    expect(logs.join('\n')).toContain('window-state');
  });

  it('内容不是对象（如数组/字符串/null）时回落缺省值', () => {
    for (const bad of ['[]', '"abc"', 'null', '42']) {
      writeFileSync(windowStatePath(dir), bad, 'utf-8');
      expect(loadWindowState(dir)).toEqual(DEFAULT_WINDOW_STATE);
    }
  });

  it('尺寸非法（NaN/缺失/字符串）时回落缺省尺寸', () => {
    writeFileSync(
      windowStatePath(dir),
      JSON.stringify({ x: 10, y: 10, width: 'abc', height: null }),
      'utf-8',
    );
    const s = loadWindowState(dir);
    expect(s.width).toBe(DEFAULT_WIDTH);
    expect(s.height).toBe(DEFAULT_HEIGHT);
  });

  // 设计 3.3：保存尺寸小于最小限制 → 夹到 minWidth/minHeight
  it('尺寸小于最小限制时被夹到下限（D3-7 的边界保护）', () => {
    writeFileSync(
      windowStatePath(dir),
      JSON.stringify({ x: 10, y: 10, width: 400, height: 300, maximized: false }),
      'utf-8',
    );
    const s = loadWindowState(dir);
    expect(s.width).toBe(MIN_WIDTH);
    expect(s.height).toBe(MIN_HEIGHT);
  });

  it('只记录了一半坐标时视为无位置（否则用 0 当 y 会把窗口顶出屏幕）', () => {
    writeFileSync(windowStatePath(dir), JSON.stringify({ x: 100, width: 1200, height: 800 }), 'utf-8');
    const s = loadWindowState(dir);
    expect(s.x).toBeUndefined();
    expect(s.y).toBeUndefined();
    expect(s.width).toBe(1200);
  });

  it('maximized 非布尔真值时按 false 处理', () => {
    writeFileSync(
      windowStatePath(dir),
      JSON.stringify({ x: 0, y: 0, width: 1200, height: 800, maximized: 'yes' }),
      'utf-8',
    );
    expect(loadWindowState(dir).maximized).toBe(false);
  });

  // 设计 3.3：状态文件只读/磁盘满 → 静默忽略（仅日志），不影响使用
  it('写入失败时只记日志不抛错', () => {
    // 用一个不可能创建的路径（把文件当目录用）制造写入失败
    const filePath = join(dir, 'as-file');
    writeFileSync(filePath, 'x', 'utf-8');
    const logs: string[] = [];
    expect(() =>
      saveWindowState(filePath, { x: 0, y: 0, width: 1200, height: 800, maximized: false }, (m) =>
        logs.push(m),
      ),
    ).not.toThrow();
    expect(logs.join('\n')).toContain('保存失败');
  });

  it('userData 目录不存在时自动创建', () => {
    const nested = join(dir, 'a', 'b', 'c');
    saveWindowState(nested, { x: 5, y: 5, width: 1200, height: 800, maximized: false });
    expect(existsSync(windowStatePath(nested))).toBe(true);
  });

  it('clampToLimits 把浮点坐标取整，避免读到 3.0000001 这类值', () => {
    const s = clampToLimits({
      x: 10.7,
      y: 20.2,
      width: 1200.6,
      height: 800.4,
      maximized: false,
    });
    expect(s.x).toBe(11);
    expect(s.y).toBe(20);
    expect(s.width).toBe(1201);
    expect(s.height).toBe(800);
  });

  describe('isStateVisible（D3-3 多显示器校验）', () => {
    it('窗口完全在屏幕内 → 可见', () => {
      expect(isStateVisible({ x: 100, y: 100, width: 1200, height: 800, maximized: false }, SCREEN_1080)).toBe(
        true,
      );
    });

    it('位置落到已断开的第二屏 → 不可见（拔掉显示器后启动的典型场景）', () => {
      const offscreen = { x: 1920 + 100, y: 100, width: 1200, height: 800, maximized: false };
      expect(isStateVisible(offscreen, SCREEN_1080)).toBe(false);
      // 同一位置在双屏环境下是可见的，证明判定以「当前显示器集合」为准
      expect(isStateVisible(offscreen, SCREEN_DUAL)).toBe(true);
    });

    it('坐标为 99999 这种离谱值 → 不可见', () => {
      expect(isStateVisible({ x: 99999, y: 100, width: 1200, height: 800, maximized: false }, SCREEN_1080)).toBe(
        false,
      );
    });

    it('只露出不足 100px 的边缘 → 仍判不可见（防止「看得见 1px 但找不到」）', () => {
      // 窗口右侧只与屏幕左侧重叠 60px（< MIN_VISIBLE_SIZE）
      const barely = { x: -1200 + 60, y: 100, width: 1200, height: 800, maximized: false };
      expect(isStateVisible(barely, SCREEN_1080)).toBe(false);
      // 重叠达到 100px 则放行
      const enough = { x: -1200 + MIN_VISIBLE_SIZE, y: 100, width: 1200, height: 800, maximized: false };
      expect(isStateVisible(enough, SCREEN_1080)).toBe(true);
    });

    it('部分越界但主体在屏内 → 可见（允许用户把窗口拖出一点）', () => {
      const s = { x: 1500, y: 900, width: 1200, height: 800, maximized: false };
      expect(isStateVisible(s, SCREEN_1080)).toBe(true);
    });

    it('没有位置信息 → 不可见（交给 Electron 居中）', () => {
      expect(isStateVisible(DEFAULT_WINDOW_STATE, SCREEN_1080)).toBe(false);
    });

    it('显示器列表为空时放行（宁可居中也不要误判成不可见）', () => {
      const s = { x: 100, y: 100, width: 1200, height: 800, maximized: false };
      expect(isStateVisible(s, [])).toBe(true);
    });

    it('垂直方向完全越界也算不可见（显示器在窗口上方的情形）', () => {
      const s = { x: 100, y: 5000, width: 1200, height: 800, maximized: false };
      expect(isStateVisible(s, SCREEN_1080)).toBe(false);
    });
  });

  // 与任务 03 设计 3.3 的对照：夹取后再存，能保证下一轮读到的仍合法
  it('存 → 读 → 再存 后状态稳定（夹取是幂等的）', () => {
    const first = { x: 12, y: 34, width: 1300, height: 860, maximized: false };
    saveWindowState(dir, first);
    const loaded = loadWindowState(dir);
    saveWindowState(dir, loaded);
    expect(loadWindowState(dir)).toEqual(loaded);
  });

  it('mkdirSync 生成的目录可被后续读回（递归创建语义）', () => {
    const nested = join(dir, 'x', 'y');
    mkdirSync(nested, { recursive: true });
    saveWindowState(nested, { x: 1, y: 1, width: 1100, height: 720, maximized: false });
    expect(loadWindowState(nested).x).toBe(1);
  });
});
