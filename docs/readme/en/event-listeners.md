# 🎧 Event Listeners

> [⬅ Back to README](../../../README.md)

Inspired by LangChain callbacks, with support for **16 lifecycle hooks**. Any number of listeners can be stacked.

### Hook List

| Hook | Trigger Timing | Parameters |
|---|---|---|
| `onStart` | Agent begins execution | `input: string` |
| `onIterationStart` | Start of each iteration | `iteration: number, maxIterations: number` |
| `onLLMStream` | LLM streams a text chunk | `delta: string` |
| `onLLMEnd` | End of each LLM call | `response: LLMResponse, iteration: number` |
| `onToolStart` | A tool begins execution | `tool: string, args: Record<string, unknown>` |
| `onToolEnd` | A tool finishes execution | `tool: string, result: string` |
| `onToolProgress` | Tool execution progress heartbeat (Task-20260930-001; long-running tools report elapsed time every second) | `tool: string, elapsedMs: number` |
| `onToolCallDelta` | Streaming delta while generating tool arguments (tool_calls.arguments) (Task-20260930-001; covers the gap after Thought and before [Action]) | `tool: string, accumulatedBytes: number, elapsedMs: number` |
| `onCompactionStart` | L1 context exceeds the threshold; compaction starts (pre-compaction flush extraction in progress, including one extra LLM call) | `info: CompactionStartInfo` |
| `onCompaction` | L1 context hits the threshold and triggers compaction (Task-17) | `info: CompactionInfo` |
| `onFinal` | Agent produces the final answer | `answer: string` |
| `onError` | An error occurs | `error: Error` |
| `onWarning` | Non-fatal warning (level: warning/error) | `info: { level: 'warning' \| 'error'; message: string; context?: string }` |
| `onEnd` | Agent execution ends (success or failure) | `result: AgentResult \| null` |
| `onLLMStats` | End of each LLM call; outputs token stats (Task-15) | `stats: LLMStats` |
| `onLLMStatsSummary` | End of all iterations in the session; outputs summary stats (Task-15) | `summary: LLMStatsSummary` |

### Stacking Multiple Listeners

```typescript
import { agent } from './src/agent/react-agent.js';
import type { AgentEvents } from './src/types.js';

// Audit logger
const auditLogger: AgentEvents = {
  onToolStart: (tool, args) => {
    console.log(`[AUDIT] Tool call: ${tool}`);
  },
  onFinal: (answer) => {
    console.log(`[AUDIT] Final answer length: ${answer.length} chars`);
  },
};

// Metrics collector
const metricsCollector: AgentEvents = {
  onStart: () => { performance.mark('agent-start'); },
  onEnd: () => {
    performance.measure('agent-duration', 'agent-start');
    const duration = performance.getEntriesByName('agent-duration')[0].duration;
    console.log(`[METRICS] Duration: ${duration.toFixed(0)}ms`);
  },
};

const result = await agent.run('Help me search files', {
  events: [auditLogger, metricsCollector],
});
```

> **Note**: An error thrown by a single listener is caught and does not affect other listeners or the main loop.

### Run-level callbacks (passed alongside `events`)

Besides the `events` array, the second argument of `agent.run()` also accepts 4 **run-level callbacks**. Their semantics differ from lifecycle hooks: they carry no iteration context and only serve two scenarios — snapshot persistence and bridging sub-agent progress.

| Callback | When it fires | Arguments | Typical use |
|---|---|---|---|
| `onSnapshot` | After each tool iteration inside a run, throttled to a window (3 iterations or 30s); also forced once before compaction | `snapshot: AgentSnapshot` | Keep generated messages alive on a process crash (throttled transcript persistence); a failing callback is only logged and never affects the main flow |
| `onSubAgentStart` | When a background sub-task (`delegate` background) is submitted | `info: SubAgentStartInfo` | The API layer persists a "running" card immediately, still visible after refresh/restart |
| `onSubAgentEvent` | On progress events while a background sub-task runs | `info: SubAgentEventInfo` | The WebUI forwards it as the SSE `subagent_event`; the CLI does not inject it (it uses indented console logs instead) |
| `onSubAgentComplete` | When a background sub-task finishes | `info: SubAgentCompleteInfo` | Updates the result card and pushes a notification; without injection in the CLI it is printed straight to the terminal |

```typescript
await agent.run('Analyze these files', {
  onSnapshot: async (snap) => { await store.save(snap); },
  onSubAgentStart: (info) => { console.log(`sub-task started: ${info.taskId}`); },
  onSubAgentComplete: (info) => { console.log(`sub-task done: ${info.taskId}`); },
});
```
