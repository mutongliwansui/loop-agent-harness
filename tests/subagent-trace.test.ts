/**
 * 20261107-002：子 Agent 过程轨迹装配单元测试
 *
 * 覆盖：迭代/思考/工具步骤按事件顺序装配、工具结果回填与失败标记、
 * 结束状态（done/failed/aborted），供 WebUI 过程区与后台结果卡片复用。
 */
import { describe, it, expect } from 'vitest';
import { applySubAgentEvent, createSubAgentTrace } from '../src/agent/subagent-trace.js';

const ev = (phase: Parameters<typeof applySubAgentEvent>[1]['phase'], extra = {}) => ({
  callId: 'call_1',
  phase,
  ...extra,
});

describe('子 Agent 轨迹装配', () => {
  it('新建轨迹为 running 空轨迹', () => {
    const t = createSubAgentTrace();
    expect(t.status).toBe('running');
    expect(t.iterations).toBe(0);
    expect(t.think).toEqual([]);
    expect(t.tools).toEqual([]);
  });

  it('按事件顺序装配迭代、思考与工具步骤', () => {
    const t = createSubAgentTrace();
    applySubAgentEvent(t, ev('iteration', { iteration: 1 }));
    applySubAgentEvent(t, ev('think', { iteration: 1, text: '先查记忆模块' }));
    applySubAgentEvent(t, ev('tool_start', { iteration: 1, tool: 'grep', args: { q: 'WorkingMemory' } }));
    applySubAgentEvent(t, ev('tool_end', { iteration: 1, tool: 'grep', result: 'src/memory/working.ts:59' }));
    applySubAgentEvent(t, ev('iteration', { iteration: 2 }));
    applySubAgentEvent(t, ev('tool_start', { iteration: 2, tool: 'fileRead', args: { path: 'a.ts' } }));
    applySubAgentEvent(t, ev('tool_end', { iteration: 2, tool: 'fileRead', result: '工具执行失败：路径不存在' }));
    applySubAgentEvent(t, ev('final', { text: '结论 A' }));

    expect(t.iterations).toBe(2);
    expect(t.think).toHaveLength(1);
    expect(t.think[0]).toEqual({ iteration: 1, text: '先查记忆模块' });
    expect(t.tools).toHaveLength(2);
    expect(t.tools[0]).toMatchObject({ name: 'grep', iteration: 1, ok: true });
    expect(t.tools[0].result).toContain('working.ts:59');
    expect(t.tools[1]).toMatchObject({ name: 'fileRead', iteration: 2, ok: false });
    expect(t.final).toBe('结论 A');
    expect(t.status).toBe('done');
  });

  it('同名工具按最近未回填步骤匹配，不会串到已完成的步骤', () => {
    const t = createSubAgentTrace();
    applySubAgentEvent(t, ev('tool_start', { iteration: 1, tool: 'grep', args: { q: 'a' } }));
    applySubAgentEvent(t, ev('tool_end', { tool: 'grep', result: '第一次结果' }));
    applySubAgentEvent(t, ev('tool_start', { iteration: 2, tool: 'grep', args: { q: 'b' } }));
    applySubAgentEvent(t, ev('tool_end', { tool: 'grep', result: '第二次结果' }));
    expect(t.tools[0].result).toBe('第一次结果');
    expect(t.tools[1].result).toBe('第二次结果');
  });

  it('error / aborted 终止状态正确', () => {
    const a = createSubAgentTrace();
    applySubAgentEvent(a, ev('error', { error: 'boom' }));
    expect(a.status).toBe('failed');

    const b = createSubAgentTrace();
    applySubAgentEvent(b, ev('aborted', { error: '已取消' }));
    expect(b.status).toBe('aborted');
  });

  it('tool_progress 回填最近一步耗时', () => {
    const t = createSubAgentTrace();
    applySubAgentEvent(t, ev('tool_start', { tool: 'shell' }));
    applySubAgentEvent(t, ev('tool_progress', { tool: 'shell', elapsedMs: 1200 }));
    expect(t.tools[0].elapsedMs).toBe(1200);
  });
});
