# 📊 LLM Token Stats

> [⬅ Back to README](../../../README.md)

The agent has built-in LLM token stats (Task-15): after each LLM call it prints context/input/output tokens and cache hit rate; after the session ends it prints a session-level summary (total tokens, average cache hit rate, context peak).

```
[Iteration 2/5] Context 3214/8000 (40%) | Input 2588 | Output 412 | Cache 72.3% | 1.2s
[Stats Summary] 3 rounds | Total input 7842 | Total output 1230 | Total tokens 9072 | Avg cache hit 68.5% (first 45.0% / subsequent 80.1%) | Context peak 4500/8000 (56%)
```

- **Toggle**: Config `agent.showTokenStats` (defaults to `true`); once disabled, stats lines are no longer printed
- **Events**: Listen to `onLLMStats` (per round) and `onLLMStatsSummary` (session end) for structured data
- **Context warning**: When context tokens approach/exceed the L1 compaction threshold, the stats line is highlighted in yellow
- **Dual hit-rate views** (20261021-008): the summary line appends "(first x% / subsequent y%)" after the average — the first iteration includes cold-start misses of system prompt/tool schemas and is naturally lower; **the subsequent-iterations rate (`subsequentIterationsHitRate`) is the primary metric for prefix-cache optimization**. Both only count rounds that report cache fields (N/A when the provider offers none)

## Prefix-cache friendliness (20261021-008)

DeepSeek-style prefix caches only hit when the request matches byte-for-byte from token 0. Context assembly therefore keeps the request sequence stable within one run:

1. **Run-level freeze of L2 retrieval results**: retrieval runs once per run (same userMessage + sessionId); entries written to L2 by tools mid-run never alter the injected content of the current run (visible to the next run), and timeout-induced "injected ↔ clean" prefix flips are eliminated
2. **Single source for the system prompt**: every round reuses the system prompt built in the first round of `run()` (including workspaceDir / vision sections) instead of rebuilding it independently
3. **L3 Curated caching**: memory files are re-read only when mtime+size change; otherwise the previously assembled sections are reused
4. **Effect**: within one run, the request sequence is byte-for-byte stable except for appended tail messages, so prefixes from iteration 2 onward hit reliably
