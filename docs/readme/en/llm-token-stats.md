# 📊 LLM Token Stats

> [⬅ Back to README](../../../README.md)

The agent has built-in LLM token stats (Task-15): after each LLM call it prints context/input/output tokens and cache hit rate; after the session ends it prints a session-level summary (total tokens, average cache hit rate, context peak).

```
[Iteration 2/5] Context 3214/8000 (40%) | Input 2588 | Output 412 | Cache 72.3% | 1.2s
[Stats Summary] 3 rounds | Total input 7842 | Total output 1230 | Total tokens 9072 | Avg cache hit 68.5% | Context peak 4500/8000 (56%)
```

- **Toggle**: Config `agent.showTokenStats` (defaults to `true`); once disabled, stats lines are no longer printed
- **Events**: Listen to `onLLMStats` (per round) and `onLLMStatsSummary` (session end) for structured data
- **Context warning**: When context tokens approach/exceed the L1 compaction threshold, the stats line is highlighted in yellow
