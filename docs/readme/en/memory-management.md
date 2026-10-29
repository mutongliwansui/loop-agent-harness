# 🧠 Memory Management

> [⬅ Back to README](../../../README.md)

A three-tier memory architecture (Tier Model) in the OpenClaw style. Core ideas: **files are the source of truth, indexes only accelerate; write and read paths are separated; promotion is gated.** Memory management complements session persistence (Task-11): session persistence solves "restore the last conversation," while memory management solves "accumulate knowledge across sessions."

### Three-tier Architecture

| Tier | Storage Form | Lifecycle | Auto in context | Description |
|---|---|---|---|---|
| **L1 Working** | In-memory `_chatHistory` | Single session | ✅ Always | Compacts automatically past a threshold (default 8000 tokens / 80% threshold, keeping the last 3 turns): first asks the LLM to extract key notes into L2, then injects a `[历史摘要]` placeholder (marked `is_show=false`, visible to the LLM, filtered on disk write) into the context; on-disk full history is the single source of truth, and in-memory compaction + on-disk restore share one `buildCompactedView` generator |
| **L2 Episodic** | `{workspace root}/memory/YYYY-MM-DD.md` | Permanent archive | ❌ Retrieved on demand | Split by day; tool-call results are auto-recorded; recall via `/memory search` |
| **L3 Curated** | `{workspace root}/SOUL.md` / `USER.md` / `MEMORY.md` | Permanent, always present | ✅ Injected on startup | Agent persona / user profile / distilled facts, always present in the System Prompt |

> **Multiple workspaces (serve mode)**: each workspace's memory kit is held by its WorkspaceRuntime (isolated by workspaceId) and its handles are released when the runtime is evicted from the LRU; the CLI single-workspace mode uses the launch directory — behavior is unchanged.

### Directory Structure

```
<workspace>/
├── SOUL.md                     # L3: agent persona and behavioral principles (system-generated, human-edited)
├── USER.md                     # L3: user profile (stable preferences, communication style, constraints)
├── MEMORY.md                   # L3: distilled facts (project knowledge, key decisions, known issues)
└── memory/                     # L2: episodic memory (split by day)
    ├── 2026-08-08.md
    ├── 2026-08-09.md
    └── ...
```

### L3 File Templates

```markdown
# SOUL - Agent Persona
## Core identity / Behavioral principles / Communication style

# USER - User Profile
## Basic info / Preferences / Constraints

# MEMORY - Distilled Facts
## Project knowledge / Key decisions / Known issues
```

Created automatically on first startup or when running `/memory curated list`; L3 content is injected into the System Prompt on every LLM call as a persistent "long-term memory" reference.

### CLI Examples

```
/memory status                          # Show memory system status (per-tier stats)
/memory curated list                    # List L3 core memory files (line/char counts)
/memory curated read user               # Read USER.md
/memory curated append memory "Decision: default to the DeepSeek model"  # Append a core memory
/memory episodic list                   # List L2 episodic memory logs
/memory episodic read 2026-08-09        # Read the log for a given date
/memory search 华锐                      # Search historical memory
/memory dream 3                         # Manually trigger a Dreaming pass (last 3 days)
/memory gate                            # Show Promotion Gate pending/eligible facts
```

### Programmatic Usage

```typescript
import {
  EpisodicMemory, CuratedMemory, WorkingMemory,
  PromotionGate, DreamingPipeline, MemoryIndex, VectorMemory, rrfMerge,
} from './src/memory/index.js';

// L2 episodic memory: daily write/read
const episodic = new EpisodicMemory(process.cwd());
await episodic.init();
await episodic.appendToday('- The user asked about a quote from 华锐');

// L3 curated memory: read/write SOUL / USER / MEMORY
const curated = new CuratedMemory(process.cwd());
await curated.init();
await curated.append('user', 'The user prefers email communication');

// L1 working memory: token estimation and compaction
const working = new WorkingMemory();
const needs = working.needsCompaction(messages);

// Promotion Gate + Dreaming: L2 → L3 promotion (different sources need different confirmation counts)
const gate = new PromotionGate(process.cwd());
await gate.init();
await gate.record('The user prefers email communication', 'owner_direct');

const dream = new DreamingPipeline({ gate, episodic, curated, llm });
const result = await dream.run(3);   // Scan the last 3 days; promote eligible facts to L3

// Hybrid retrieval: BM25 full-text + vectors (optional) merged and ranked via RRF
const index = new MemoryIndex();
index.add(day, content);
const vector = new VectorMemory();
const merged = rrfMerge(ftsHits, vectorHits);
```

### Design Principles (Phases 1-5 delivered)

- **Files are the source of truth**: Markdown is plaintext — readable, diffable, version-controllable (a SQLite index is introduced in a later phase)
- **Write/read separation**: The reply path only retrieves, it doesn't extract memory; extraction goes through the Dreaming pipeline (triggered by `/memory dream` or automatically on exit)
- **Gated promotion**: Different sources (user-stated / tool output / web search) need different confirmation counts to be promoted to L3 (Promotion Gate implemented; view via `/memory gate`)
- **Hybrid retrieval**: BM25 full-text + vector retrieval (optional) merged and ranked via RRF. Enabled automatically once `episodic.vectorSearch` is configured; embedding failures degrade gracefully
- **Failure degradation**: Memory subsystem anomalies do not affect the main reply path
- **Disk order equals trajectory order**: L1 compaction uses `is_compact` only to distinguish "folded into the summary" from "kept", while the **on-disk array order always equals the original trajectory order**. When a single long turn is trimmed by the token budget, the current-turn user message preserved by the "task anchor pin" still precedes the messages it triggered, so a reloaded session never shows a user message after its own answers. Already-corrupted legacy sessions cannot be restored losslessly (the raw transcript is never persisted); use `node scripts/session-order-check.mjs` for a read-only diagnosis

### Auto-Promotion (`--serve` / WebUI)

The CLI runs Dreaming once on exit, but `--serve` is a long-lived process where "promote on exit" simply never happens. The server side therefore gets three trigger paths:

| Trigger | Timing | Notes |
| --- | --- | --- |
| **Scheduled (primary)** | Driven by `schedule.cron` (5-field crontab expression, default `0 3 * * *` = daily 03:00, **server local timezone**) | Only processes days *before* today; today's content waits for tomorrow. **No new content means no LLM call** (the incremental check returns early) |
| **Shutdown fallback** | On `Ctrl+C` (`SIGINT`) / `SIGTERM` / `SIGBREAK` | Promotes every loaded workspace serially within `shutdownBudgetMs` (default 30s); **a second Ctrl+C exits immediately** |
| **Manual** | `POST /memory/dream` or the WebUI "✦ Dream" button | Shares the same in-process lock as the automatic triggers |

#### cron expression

- **5 fields**: `minute hour day-of-month month day-of-week` (0-59 / 0-23 / 1-31 / 1-12 / 0-7, where both 0 and 7 mean Sunday). **No 6-field seconds form.**
- **Supported syntax**: `*`, lists `,`, ranges `-`, steps `/`; macros `@yearly` `@monthly` `@weekly` `@daily` `@hourly`.
- **Unsupported syntax**: `L` / `W` / `#` / `?` (Quartz extensions with no meaning under standard cron semantics).
- **Day-of-month and day-of-week are OR-ed when both are restricted** (vixie cron semantics): `0 3 1 * 1` means "the 1st of every month **or** every Monday at 03:00".
- **Hot reload**: writing `cron` reschedules immediately, **no restart required**; an invalid expression is rejected (400) and **neither persists nor disturbs the current schedule**.
- **Compatibility**: an empty `cron` string falls back to the legacy fixed-interval behaviour (`startupDelayMin` + `intervalHours`, both deprecated).

#### Rules and limits

- **Mutual exclusion**: at most one promotion per workspace at a time; a latecomer is skipped (the manual endpoint returns `accepted:false`) — no queueing, no duplicate promotions.
- **Never competes with chat**: the scheduled round yields when a conversation is in flight in that workspace; the shutdown fallback is exempt (no new conversations then).
- **Gap repair**: the read window widens to "days since last processed day + 1", capped by `maxDaysBack` (default 30), so days missed during downtime are not lost forever.
- **Misfire catch-up**: when sleep or a clock rollback makes the run late but still within `misfireGraceMin` (default 60 minutes), it runs once and is flagged `catchup`; beyond that grace it only records a "missed" entry and **does not run** (so a boot does not trigger a burst of rounds).
- **Day rollover and DST**: the scheduler dedupes on a *local wall-clock minute key* and never waits more than 6 hours in one slice (avoiding the 24.8-day `setTimeout` ceiling), so a DST fall-back does not double-fire and a spring-forward does not silently skip a long stretch.
- **Observability**: the `dreaming` field of `GET /memory/status` (see [HTTP API](./http-api.md)) exposes `cron` / `describe` / `nextRunAt` / `nextRunTimes` / `running`; the WebUI memory page's "Auto-promotion" card edits it in place with a live preview of upcoming runs.
- **Run history**: `{L2 dir}/.dreaming-runs.json` keeps a ring buffer of the latest `historyLimit` runs (default 20, `0` = no history) with time / source (scheduled·manual·shutdown) / result / read window / promoted·skipped·errors / duration — separate from the incremental state file.
- **Incremental state**: `{L2 dir}/.dreaming-state.json` stores `lastProcessedDay` plus `lastRunAt` / `lastSummary`.
- **Turning it off**: `memory.dreaming.schedule.enabled=false` stops only the scheduler (the shutdown fallback still runs); `memory.dreaming.onExit=false` stops only the shutdown fallback; `memory.dreaming.enabled=false` stops everything.
- **Known limits**: running the CLI and `--serve` against the same workspace has no cross-process file lock — `lastProcessedDay` idempotency plus dedupe/merge covers it; on Windows, closing the console window may not give any cleanup chance (no graceful signal).

### WebUI Memory Page (Four Tabs)

The WebUI "Memory" page is reorganized into four tabs by data dimension (`#/memory?tab=<key>`; state lives in the hash, so refresh/share restores the view):

| Tab | Content | Data sources |
| --- | --- | --- |
| **Scheduled** | Auto-promotion cron config + run history (with an "All workspaces / Current workspace" scope toggle) + tier summary + Gate decisions | `GET /memory/status`, `GET /memory/dream/preview`, `GET /memory/dream/history?scope=all\|ws`, `DELETE /memory/dream/history` |
| **L2 Episodic** | Workspace → session → scope/tag three-level filter + day window, grouped by day; entry headers (session id / scope / tag) are parsed on the frontend | `GET /memory/episodic?limit=<1-90>[&ws=<id>]` + `GET /memory/workspaces` |
| **L3 Curated** | Global shared (SOUL/USER, unaffected by workspace switching) vs. workspace-level (MEMORY) two columns; switch workspace via the top-right dropdown | `GET /memory/curated[?ws=<id>]` |
| **Search** | L2 semantic search (current workspace) | `GET /memory/search?q=` |

Companion endpoints:

- **`GET /memory/workspaces`**: aggregates workspaces that "have sessions ∪ have memory", returning `{id, name, path, hasMemory, hasSession}[]` — the session side comes from scanning session indexes, the memory side from scanning `{memoryDir}/*/` directories; memory-only "orphan workspaces" are listed too (used by the L2/L3 workspace dropdowns).
- **`GET /memory/episodic` / `GET /memory/curated` accept `?ws=<id or absolute path>`**: read memory for a specific workspace (routed through WorkspaceRuntime with canonical checks; unknown workspace → 404); omitted falls back to the **default workspace (most recently used)** — no longer bound to the startup directory as of req. 20261027-004.
- **`GET /memory/dream/history?scope=all|ws`**: with `all`, aggregates `.dreaming-runs.json` of all workspaces via file scan (no loaded runtime required), each row annotated with `workspaceId/workspaceName/workspacePath`; `ws` (default) = the default workspace's (most recently used) single file.
- **`DELETE /memory/dream/history?scope=all|ws[&ws=<id>]`**: clearing follows the selected scope; with `all`, records in every workspace are cleared (files kept, contents emptied, idempotent).
