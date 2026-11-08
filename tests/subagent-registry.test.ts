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

  it('运行期 touch 刷新轮次与耗时，让 /subagents 在运行中就有实时数据（20261107-009 P2）', () => {
    subAgentRegistry.create({ taskId: 'sub_a', sessionId: 's1', task: 'A' });
    // 运行中：touch 前这两个字段是空的（只有 finish 才写）→ 前端只能显示静态文案
    expect(subAgentRegistry.get('sub_a')?.iterations).toBeUndefined();

    subAgentRegistry.touch('sub_a', { iterations: 2, elapsedMs: 1234 });
    expect(subAgentRegistry.get('sub_a')?.iterations).toBe(2);
    expect(subAgentRegistry.get('sub_a')?.elapsedMs).toBe(1234);
    expect(subAgentRegistry.get('sub_a')?.status).toBe('running');

    // 已完成/不存在：touch 不写入（避免完成结果被运行期采样覆盖）
    subAgentRegistry.finish('sub_a', { status: 'done', iterations: 5, elapsedMs: 9000 });
    subAgentRegistry.touch('sub_a', { iterations: 99, elapsedMs: 1 });
    expect(subAgentRegistry.get('sub_a')?.iterations).toBe(5);
    expect(subAgentRegistry.get('sub_a')?.elapsedMs).toBe(9000);

    subAgentRegistry.touch('missing', { iterations: 1 });
    expect(subAgentRegistry.get('missing')).toBeUndefined();
  });

  it('CLI 提示队列先进先出且 drain 后清空', () => {
    subAgentRegistry.pushCliNotice('✅ 完成 1');
    subAgentRegistry.pushCliNotice('❌ 失败 2');
    expect(subAgentRegistry.drainCliNotices()).toEqual(['✅ 完成 1', '❌ 失败 2']);
    expect(subAgentRegistry.drainCliNotices()).toEqual([]);
  });

  it('会话级完成通知：入队 → peek 不消费 → drain 清空；失败回滚插回队首（20261107-011）', () => {
    subAgentRegistry.enqueueNotice('s1', '通知A');
    subAgentRegistry.enqueueNotice('s1', '通知B');
    // peek 只看不取（主 run 收尾时判断是否要唤醒）
    expect(subAgentRegistry.peekNotices('s1')).toEqual(['通知A', '通知B']);
    expect(subAgentRegistry.peekNotices('s2')).toEqual([]);
    // drain 取走并清空
    expect(subAgentRegistry.drainNotices('s1')).toEqual(['通知A', '通知B']);
    expect(subAgentRegistry.peekNotices('s1')).toEqual([]);
    // 唤醒失败回滚：放回队首，交给后续 run 注入
    subAgentRegistry.enqueueNotice('s1', '通知C');
    subAgentRegistry.requeueNotices('s1', ['通知A', '通知B']);
    expect(subAgentRegistry.drainNotices('s1')).toEqual(['通知A', '通知B', '通知C']);
  });
});
