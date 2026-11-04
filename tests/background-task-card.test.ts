// 需求 20261104-005：后台任务卡片纯函数（识别 / 状态映射 / 轮询节奏 / 格式化）
import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  formatDuration,
  isActive,
  isKnownStatus,
  parseBackgroundResult,
  pollDelay,
  statusLabel,
  statusTone,
} from '../webui/src/background-task-card.js';

describe('parseBackgroundResult', () => {
  it('识别合法 taskId 并从 args 补齐 command', () => {
    const info = parseBackgroundResult(
      JSON.stringify({ taskId: 'bg_abcdef12_1700000000', pid: 123 }),
      JSON.stringify({ command: 'npm run dev' }),
    );
    expect(info).toEqual({
      taskId: 'bg_abcdef12_1700000000',
      command: 'npm run dev',
      startedAt: 1700000000000,
    });
  });

  it('result 自带 command 时优先使用', () => {
    const info = parseBackgroundResult(
      JSON.stringify({ taskId: 'bg_abcdef12_1700000000', command: 'from-result' }),
      JSON.stringify({ command: 'from-args' }),
    );
    expect(info?.command).toBe('from-result');
  });

  it('非法 / 非 JSON / 无 taskId 返回 undefined', () => {
    expect(parseBackgroundResult('plain text output')).toBeUndefined();
    expect(parseBackgroundResult('[1,2]')).toBeUndefined();
    expect(parseBackgroundResult(JSON.stringify({ taskId: '../../etc/passwd' }))).toBeUndefined();
    expect(parseBackgroundResult(JSON.stringify({ foo: 1 }))).toBeUndefined();
  });
});

describe('状态映射', () => {
  it('statusTone 覆盖五态与退出码', () => {
    expect(statusTone('running')).toBe('run');
    expect(statusTone('exited', 0)).toBe('ok');
    expect(statusTone('exited', 1)).toBe('danger');
    expect(statusTone('killed')).toBe('warn');
    expect(statusTone('orphaned-running')).toBe('warn');
    expect(statusTone('orphaned-exited')).toBe('dim');
  });

  it('statusLabel 给中文文案', () => {
    expect(statusLabel('running')).toBe('运行中');
    expect(statusLabel('exited', 0)).toBe('已完成');
    expect(statusLabel('exited', 2)).toContain('退出码 2');
    expect(statusLabel('killed')).toBe('已停止');
    expect(statusLabel('orphaned-running')).toContain('失联');
  });

  it('isActive / isKnownStatus', () => {
    expect(isActive('running')).toBe(true);
    expect(isActive('orphaned-running')).toBe(true);
    expect(isActive('exited')).toBe(false);
    expect(isKnownStatus('exited')).toBe(true);
    expect(isKnownStatus('weird')).toBe(false);
  });
});

describe('轮询节奏（D1）', () => {
  it('运行中 2s，页面隐藏 15s；终态停止轮询', () => {
    expect(pollDelay('running', false)).toBe(2000);
    expect(pollDelay('running', true)).toBe(15000);
    expect(pollDelay('orphaned-running', false)).toBe(10000);
    expect(pollDelay('exited', false)).toBe(0);
    expect(pollDelay('killed', false)).toBe(0);
  });
});

describe('格式化', () => {
  it('耗时 mm:ss / h:mm:ss', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(65_000)).toBe('01:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(-1)).toBe('00:00');
  });

  it('日志大小 B / KB / MB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
