// 子 Agent 过程轨迹装配（需求 20261107-002 D3/D4）
// Agent 层（后台结果卡片）与 API 层（delegate 工具消息落盘）共用同一套装配规则。
import type { SubAgentEventInfo, SubAgentToolStep, SubAgentTrace } from '../types.js';

/** 新建运行中的轨迹 */
export function createSubAgentTrace(): SubAgentTrace {
  return {
    status: 'running',
    iterations: 0,
    think: [],
    tools: [],
    startedAt: Date.now(),
  };
}

/** 把一条过程事件合入轨迹（原地修改） */
export function applySubAgentEvent(trace: SubAgentTrace, info: SubAgentEventInfo): void {
  switch (info.phase) {
    case 'start':
      trace.startedAt = info.elapsedMs !== undefined ? Date.now() - info.elapsedMs : Date.now();
      break;
    case 'iteration':
      trace.iterations = Math.max(trace.iterations, info.iteration ?? 0);
      break;
    case 'think':
      if (info.text) trace.think.push({ iteration: info.iteration ?? 1, text: info.text });
      break;
    case 'tool_start':
      trace.tools.push({
        name: info.tool ?? 'unknown',
        args: info.args,
        iteration: info.iteration,
      });
      break;
    case 'tool_end': {
      const step = findPendingStep(trace.tools, info.tool);
      if (step) {
        step.result = info.result;
        step.ok = !(info.result ?? '').startsWith('工具执行失败');
        if (info.elapsedMs !== undefined) step.elapsedMs = info.elapsedMs;
      }
      break;
    }
    case 'tool_progress': {
      if (info.elapsedMs === undefined) break;
      const last = trace.tools[trace.tools.length - 1];
      if (last) last.elapsedMs = info.elapsedMs;
      break;
    }
    case 'final':
      trace.final = info.text;
      trace.status = 'done';
      break;
    case 'error':
      trace.status = 'failed';
      break;
    case 'aborted':
      trace.status = 'aborted';
      break;
  }
}

/** 找到最近一个同名且尚未回填结果的工具步骤（并发同名工具的近似归属） */
function findPendingStep(steps: SubAgentToolStep[], tool?: string): SubAgentToolStep | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.name === tool && step.result === undefined) return step;
  }
  return undefined;
}
