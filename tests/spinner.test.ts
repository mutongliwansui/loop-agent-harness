/**
 * Spinner 单元测试：开关、帧渲染、清行、ASCII 兜底、依赖注入
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Spinner,
  detectFrames,
  BRAILLE_FRAMES,
  ASCII_FRAMES,
} from '../src/ui/spinner.js';

function collector() {
  const chunks: string[] = [];
  return { chunks, write: (s: string) => chunks.push(s) };
}

describe('Spinner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('enabled=false 时 start/stop 不产生任何输出', () => {
    const { chunks, write } = collector();
    const s = new Spinner({ enabled: false, write, frames: ['|'], intervalMs: 80 });
    s.start('思考中…');
    vi.advanceTimersByTime(500);
    s.stop();
    expect(s.isActive).toBe(false);
    expect(chunks.join('')).toBe('');
  });

  it('enabled=true 时 start 输出帧、stop 输出 \\r\\x1b[K 清行', () => {
    const { chunks, write } = collector();
    const s = new Spinner({ enabled: true, write, frames: ['|'], intervalMs: 80 });
    s.start('思考中…');
    expect(s.isActive).toBe(true);
    expect(chunks.join('')).toContain('思考中…');
    s.stop();
    expect(chunks[chunks.length - 1]).toBe('\r\x1b[K');
    expect(s.isActive).toBe(false);
  });

  it('定时器推进时切换帧序列', () => {
    const { chunks, write } = collector();
    const s = new Spinner({ enabled: true, write, frames: ['a', 'b', 'c'], intervalMs: 50 });
    s.start('x');
    vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(50);
    const joined = chunks.join('');
    expect(joined).toContain('a');
    expect(joined).toContain('b');
    expect(joined).toContain('c');
    s.stop();
  });

  it('传入 ASCII frames 后渲染字符为 ASCII（Braille 兜底）', () => {
    const { chunks, write } = collector();
    const s = new Spinner({ enabled: true, write, frames: ['|', '/', '-', '\\'], intervalMs: 40 });
    s.start('执行中：grep…');
    vi.advanceTimersByTime(40);
    const joined = chunks.join('');
    expect(joined).toContain('|');
    expect(joined).toContain('/');
    expect(joined).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    s.stop();
  });

  it('重复 start 视为更新文案，update 仅在活跃时生效', () => {
    const { chunks, write } = collector();
    const s = new Spinner({ enabled: true, write, frames: ['|'], intervalMs: 80 });
    s.start('一');
    s.start('二');
    expect(s.isActive).toBe(true);
    s.update('三');
    const joined = chunks.join('');
    expect(joined).toContain('一');
    expect(joined).toContain('二');
    expect(joined).toContain('三');
    s.stop();
  });

  it('stop 非活跃时为 no-op；可传入收尾文案换行保留', () => {
    const { chunks, write } = collector();
    const s = new Spinner({ enabled: true, write, frames: ['|'], intervalMs: 80 });
    s.stop();
    expect(chunks).toHaveLength(0);
    s.start('x');
    s.stop('收尾');
    const joined = chunks.join('');
    expect(joined).toContain('\r\x1b[K');
    expect(joined).toContain('收尾\n');
  });
});

describe('detectFrames（P1 4.7 缺字形终端回落）', () => {
  it('非 Windows 平台使用 Braille 帧', () => {
    expect(detectFrames('darwin', {})).toEqual(BRAILLE_FRAMES);
    expect(detectFrames('linux', {})).toEqual(BRAILLE_FRAMES);
  });

  it('Windows 旧版控制台（无 WT_SESSION）回落 ASCII 帧', () => {
    expect(detectFrames('win32', {})).toEqual(ASCII_FRAMES);
  });

  it('Windows Terminal / VS Code 终端保留 Braille 帧', () => {
    expect(detectFrames('win32', { WT_SESSION: 'abc' })).toEqual(BRAILLE_FRAMES);
    expect(detectFrames('win32', { TERM_PROGRAM: 'vscode' })).toEqual(BRAILLE_FRAMES);
  });

  it('环境变量 LOOP_AGENT_SPINNER 可强制指定帧序列', () => {
    expect(detectFrames('darwin', { LOOP_AGENT_SPINNER: 'ascii' })).toEqual(ASCII_FRAMES);
    expect(detectFrames('win32', { LOOP_AGENT_SPINNER: 'braille' })).toEqual(BRAILLE_FRAMES);
  });
});
