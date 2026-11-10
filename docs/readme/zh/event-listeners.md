# 🎧 事件监听器

> [⬅ 返回 README](../../../README.md)

参考 LangChain callbacks 设计，支持 **16 个生命周期钩子**。可叠加任意数量的监听器。

### 钩子列表

| 钩子 | 触发时机 | 参数 |
|---|---|---|
| `onStart` | Agent 开始执行 | `input: string` |
| `onIterationStart` | 每轮迭代开始 | `iteration: number, maxIterations: number` |
| `onLLMStream` | LLM 流式输出文本片段 | `delta: string` |
| `onLLMEnd` | 每轮 LLM 调用结束 | `response: LLMResponse, iteration: number` |
| `onToolStart` | 工具开始执行 | `tool: string, args: Record<string, unknown>` |
| `onToolEnd` | 工具执行结束 | `tool: string, result: string` |
| `onToolProgress` | 工具执行进度心跳（Task-20260930-001，长耗时工具每秒上报已用时） | `tool: string, elapsedMs: number` |
| `onToolCallDelta` | 生成工具参数（tool_calls.arguments）的流式增量（Task-20260930-001，覆盖 Thought 后到 [Action] 的空窗） | `tool: string, accumulatedBytes: number, elapsedMs: number` |
| `onCompactionStart` | L1 上下文超阈值，压缩开始（pre-compaction flush 提取进行中，期间有一次额外 LLM 调用） | `info: CompactionStartInfo` |
| `onCompaction` | L1 上下文达阈值触发压缩（Task-17） | `info: CompactionInfo` |
| `onFinal` | Agent 给出最终答案 | `answer: string` |
| `onError` | 发生错误 | `error: Error` |
| `onWarning` | 非致命告警（level: warning/error） | `info: { level: 'warning' \| 'error'; message: string; context?: string }` |
| `onEnd` | Agent 执行结束（成功或失败） | `result: AgentResult \| null` |
| `onLLMStats` | 每轮 LLM 调用结束，输出 token 统计（Task-15） | `stats: LLMStats` |
| `onLLMStatsSummary` | 会话全部迭代结束，输出汇总统计（Task-15） | `summary: LLMStatsSummary` |

### 多个监听器叠加

```typescript
import { agent } from './src/agent/react-agent.js';
import type { AgentEvents } from './src/types.js';

// 日志记录器
const auditLogger: AgentEvents = {
  onToolStart: (tool, args) => {
    console.log(`[AUDIT] 调用工具: ${tool}`);
  },
  onFinal: (answer) => {
    console.log(`[AUDIT] 最终答案长度: ${answer.length} 字符`);
  },
};

// 性能监控器
const metricsCollector: AgentEvents = {
  onStart: () => { performance.mark('agent-start'); },
  onEnd: () => {
    performance.measure('agent-duration', 'agent-start');
    const duration = performance.getEntriesByName('agent-duration')[0].duration;
    console.log(`[METRICS] 耗时: ${duration.toFixed(0)}ms`);
  },
};

const result = await agent.run('帮我搜索文件', {
  events: [auditLogger, metricsCollector],
});
```

> **注意**：单个监听器抛错会被捕获，不影响其他监听器与主循环。

### run 级回调（与 events 并列传参）

除 `events` 数组外，`agent.run()` 的第二个参数还支持 4 个 **run 级回调**，语义与用途和生命周期钩子不同：它们不带迭代上下文，只服务于「快照落盘」与「子 Agent 过程桥接」两类场景。

| 回调 | 触发时机 | 参数 | 典型用途 |
|---|---|---|---|
| `onSnapshot` | run 内每个工具迭代结束后按节流窗口（3 次迭代或 30s）调用；压缩前强制调用一次 | `snapshot: AgentSnapshot` | 进程崩溃时保留已产生的消息（transcript 节流落盘）；回调失败只记日志，不影响主流程 |
| `onSubAgentStart` | 后台子任务（`delegate` background）提交时 | `info: SubAgentStartInfo` | API 层立即落盘「运行中」卡片，刷新/重启后仍可见 |
| `onSubAgentEvent` | 后台子任务运行过程中的过程事件 | `info: SubAgentEventInfo` | WebUI 转发为 SSE `subagent_event`；CLI 不注入（走缩进控制台日志） |
| `onSubAgentComplete` | 后台子任务完成时 | `info: SubAgentCompleteInfo` | 更新结果卡片并推送通知；CLI 未注入时直接打印到终端 |

```typescript
await agent.run('分析这批文件', {
  onSnapshot: async (snap) => { await store.save(snap); },
  onSubAgentStart: (info) => { console.log(`子任务开始: ${info.taskId}`); },
  onSubAgentComplete: (info) => { console.log(`子任务完成: ${info.taskId}`); },
});
```
