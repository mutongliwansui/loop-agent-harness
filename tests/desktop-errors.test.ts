import { describe, it, expect } from 'vitest';
import { toUserFacing } from '../desktop/src/errors';
import { BackendNotFoundError } from '../desktop/src/backend-path';
import { PortUnavailableError } from '../desktop/src/port';
import { HealthTimeoutError } from '../desktop/src/health';

/**
 * 错误映射（D1-9）单测：确保失败时给用户看的是可行动的中文提示，
 * 而不是 Error 栈——这是「不白屏」的兜底。
 */
describe('toUserFacing', () => {
  it('后端缺失：提示重新安装，并列出查找路径', () => {
    const info = toUserFacing(new BackendNotFoundError(['C:\\a\\loop-agent-core.exe', 'C:\\b']));
    expect(info.title).toContain('后端');
    expect(info.detail).toContain('重新安装');
    expect(info.detail).toContain('C:\\a\\loop-agent-core.exe');
  });

  it('端口耗尽：提示释放端口或改配置', () => {
    const info = toUserFacing(new PortUnavailableError([3000, 3001, 3002]));
    expect(info.detail).toContain('3000');
    expect(info.detail).toContain('api.port');
  });

  it('健康超时：区分「后端提前退出」与「就绪超时」', () => {
    const exited = toUserFacing(new HealthTimeoutError(3000, { backendExited: true }));
    expect(exited.detail).toContain('退出');

    const slow = toUserFacing(new HealthTimeoutError(3000, { backendExited: false }));
    expect(slow.detail).toContain('就绪');
  });

  it('健康超时把后端 tail 透传给错误窗', () => {
    const info = toUserFacing(new HealthTimeoutError(3000, { tail: 'Error: boom' }));
    expect(info.tail).toBe('Error: boom');
  });

  it('未知错误也有标题与原文，不吞信息', () => {
    const info = toUserFacing(new Error('随便什么错'));
    expect(info.title.length).toBeGreaterThan(0);
    expect(info.detail).toContain('随便什么错');
  });

  // 任务 20261112-007-03（D3-5）：运行中后端意外退出走错误页，
  // 原因（退出码/信号）必须出现在正文，否则用户只看到「已意外停止」不知道查什么
  it('后端意外退出：标题点明停止，正文含退出原因，日志尾部透传', () => {
    const info = toUserFacing({
      name: 'BackendExitedError',
      message: '退出码 1 / 信号 SIGTERM',
      tail: '[api] fatal: boom',
    });
    expect(info.title).toContain('意外停止');
    expect(info.detail).toContain('退出码 1');
    expect(info.detail).toContain('信号 SIGTERM');
    expect(info.detail).toContain('重试');
    expect(info.tail).toBe('[api] fatal: boom');
  });

  it('后端意外退出且原因缺失时也不出现 undefined 字样', () => {
    const info = toUserFacing({ name: 'BackendExitedError' });
    expect(info.detail).not.toContain('undefined');
    expect(info.detail).toContain('未知');
  });

  it('非 Error 值（字符串/undefined）也不崩', () => {
    expect(() => toUserFacing('纯字符串')).not.toThrow();
    expect(() => toUserFacing(undefined)).not.toThrow();
  });
});
