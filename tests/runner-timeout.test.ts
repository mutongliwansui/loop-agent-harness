/**
 * ToolRunner 超时优先级测试（Task-20261010-001 3.2）
 * 覆盖：options.timeout ?? tool.timeoutMs ?? 30000 三级优先级
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToolRunner } from '../src/tools/runner.js';
import type { Tool } from '../src/types.js';

function neverTool(timeoutMs?: number): Tool {
  return {
    name: 'never',
    description: '永不完成的工具',
    parameters: { type: 'object', properties: {}, required: [] },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    execute: () => new Promise<string>(() => {}),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ToolRunner 超时优先级', () => {
  it('tool.timeoutMs 覆盖默认 30000（视觉工具 60s 依赖此行为）', async () => {
    vi.useFakeTimers();
    const runner = new ToolRunner();
    const p = runner.run(neverTool(50), {});
    const assertion = expect(p).resolves.toBe('工具执行超时 (50ms)');
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it('options.timeout 优先于 tool.timeoutMs', async () => {
    vi.useFakeTimers();
    const runner = new ToolRunner();
    const p = runner.run(neverTool(10_000), {}, { timeout: 60 });
    const assertion = expect(p).resolves.toBe('工具执行超时 (60ms)');
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  });

  it('两级都未设置时回退默认 30000', async () => {
    vi.useFakeTimers();
    const runner = new ToolRunner();
    const p = runner.run(neverTool(), {});
    const assertion = expect(p).resolves.toBe('工具执行超时 (30000ms)');
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('工具在超时前完成则正常返回不受影响', async () => {
    const fast: Tool = {
      name: 'fast',
      description: '快速完成',
      parameters: { type: 'object', properties: {}, required: [] },
      timeoutMs: 60_000,
      execute: async () => 'ok',
    };
    await expect(new ToolRunner().run(fast, {})).resolves.toBe('ok');
  });
});
