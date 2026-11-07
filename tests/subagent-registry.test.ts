/**
 * 20261107-002：后台子任务注册表单元测试
 *
 * 覆盖：登记/按会话统计运行数、完成收敛、会话级中止、CLI 完成提示队列。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { subAgentRegistry } from '../src/agent/subagent-registry.js';

beforeEach(() => {
  subAgentRegistry.reset();
});

describe('后台子任务注册表', () => {
  it('登记后为 running，且可按会话统计并发数', () => {
    subAgentRegistry.create({ taskId: 'sub_a', sessionId: 's1', task: 'A' });
    subAgentRegistry.create({ taskId: 'sub_b', sessionId: 's1', task: 'B' });
    subAgentRegistry.create({ taskId: 'sub_c', sessionId: 's2', task: 'C' });

    expect(subAgentRegistry.countRunning('s1')).toBe(2);
    expect(subAgentRegistry.countRunning('s2')).toBe(1);
    expect(subAgentRegistry.countRunning()).toBe(3);
  });

  it('完成后不再计入运行数，并记录答案/耗时', () => {
    subAgentRegistry.create({ taskId: 'sub_a', sessionId: 's1', task: 'A' });
    const rec = subAgentRegistry.finish('sub_a', {
      status: 'done',
      answer: '结论 A',
      iterations: 3,
    });
    expect(rec?.status).toBe('done');
    expect(rec?.answer).toBe('结论 A');
    expect(rec?.iterations).toBe(3);
    expect(rec?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(rec?.controller).toBeUndefined();
    expect(subAgentRegistry.countRunning('s1')).toBe(0);
  });

  it('会话中止只影响该会话的运行中任务', () => {
    const a = new AbortController();
    const b = new AbortController();
    subAgentRegistry.create({ taskId: 'sub_a', sessionId: 's1', task: 'A', controller: a });
    subAgentRegistry.create({ taskId: 'sub_b', sessionId: 's2', task: 'B', controller: b });

    expect(subAgentRegistry.abortSession('s1')).toBe(1);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
  });

  it('list 按会话过滤；get 可取单条', () => {
    subAgentRegistry.create({ taskId: 'sub_a', sessionId: 's1', task: 'A' });
    subAgentRegistry.create({ taskId: 'sub_b', sessionId: 's2', task: 'B' });
    expect(subAgentRegistry.list('s1').map((t) => t.taskId)).toEqual(['sub_a']);
    expect(subAgentRegistry.get('sub_b')?.task).toBe('B');
    expect(subAgentRegistry.get('missing')).toBeUndefined();
  });

  it('CLI 提示队列先进先出且 drain 后清空', () => {
    subAgentRegistry.pushCliNotice('✅ 完成 1');
    subAgentRegistry.pushCliNotice('❌ 失败 2');
    expect(subAgentRegistry.drainCliNotices()).toEqual(['✅ 完成 1', '❌ 失败 2']);
    expect(subAgentRegistry.drainCliNotices()).toEqual([]);
  });
});
