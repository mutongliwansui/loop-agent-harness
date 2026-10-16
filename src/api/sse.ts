// SSE 输出层：帧写入 + AgentEvents 事件透传器（与 HTTP 路由/会话逻辑无关，便于并列新增 ws/openai 转发器）

import type { ServerResponse } from 'node:http';
import type { AgentEvents } from '../types.js';
import { serializeError } from './http-utils.js';

/** SSE 帧写入：`event: <type>\n` + `data: <JSON>\n\n` */
export function sseFrame(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * D4：AgentEvents 15 钩子 → SSE 事件透传器
 *
 * 命名规则：去 on 前缀 + camelCase 转 snake_case。
 * 序列化特例：Error → {name, message}。
 * `error` 是 Agent 内部非致命上报（可多次出现），终态由 API 层合成的 done / fatal 承担。
 */
export function createSseForwarder(write: (event: string, data: unknown) => void): AgentEvents {
  return {
    onStart: (input) => write('start', { input }),
    onIterationStart: (iteration, maxIterations) => write('iteration_start', { iteration, maxIterations }),
    onLLMStream: (delta) => write('llm_stream', { text: delta }),
    onLLMEnd: (response, iteration) => write('llm_end', { response, iteration }),
    onLLMStats: (stats) => write('llm_stats', { stats }),
    onLLMStatsSummary: (summary) => write('llm_stats_summary', { summary }),
    onToolStart: (tool, args) => write('tool_start', { tool, args }),
    onToolEnd: (tool, result) => write('tool_end', { tool, result }),
    onToolProgress: (tool, elapsedMs) => write('tool_progress', { tool, elapsedMs }),
    onToolCallDelta: (tool, accumulatedBytes, elapsedMs) =>
      write('tool_call_delta', { tool, accumulatedBytes, elapsedMs }),
    onCompaction: (info) => write('compaction', { info }),
    onFinal: (answer) => write('final', { answer }),
    onError: (error) => write('error', serializeError(error)),
    onWarning: (info) => write('warning', info),
    onEnd: (result) => write('end', { result }),
  };
}
