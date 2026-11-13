# 🧠 Memory Management

> [⬅ Back to README](../../../README.md)

A three-tier memory architecture (Tier Model) in the OpenClaw style. Core ideas: **files are the source of truth, indexes only accelerate; write and read paths are separated; promotion is gated.** Memory management complements session persistence (Task-11): session persistence solves "restore the last conversation," while memory management solves "accumulate knowledge across sessions."

### Three-tier Architecture

| Tier | Storage Form | Lifecycle | Auto in context | Description |
|---|---|---|---|---|
| **L1 Working** | In-memory `_chatHistory` | Single session | ✅ Always | Compacts automatically past a threshold (default 8000 tokens / 80% threshold, keeping the last 3 turns): first asks the LLM to extract key notes into L2, then injects a `[历史摘要]` placeholder (marked `is_show=false`, visible to the LLM, filtered on disk write) into the context; when the current-turn user message falls into the dropped region the placeholder also carries a `[当前问题]` section with its raw text (requirement 20261113-008, concatenated by code, counted against the 800-char summary budget); on-disk full history is the single source of truth, and in-memory compaction + on-disk restore share one `buildCompactedView` generator |
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
- **Session isolation (fail-closed)**: Every L2 write must carry a `scope`; `session`-scoped entries also require a `sessionId`, otherwise the write is rejected (no bare entries). Context retrieval returns only `global` entries plus `session` entries of the current `sessionId`; legacy entries without a scope are invisible to the agent. Management entry points such as `/memory search` and `GET /memory/search` explicitly query with `scope: 'all'`
- **Disk order equals trajectory order**: L1 compaction uses `is_compact` only to distinguish "folded into the summary" from "kept", and the **on-disk array order always equals the original trajectory order** — compaction only decides *which* messages are archived, it never moves a message elsewhere (requirement 20261113-008 removed the historical "task anchor pin", which used to lift the current-turn user message out of the dropped region and insert it at the head of the kept region, producing "answers before the question" in long sessions). When a single long turn is trimmed by the token budget, the current-turn user message is archived in place and its **raw text is carried by a `[当前问题]` section inside the summary placeholder** (concatenated by code, not re-stated by the LLM, counted against the 800-char summary budget), so archiving never costs the model the original question. Before writing, a `msgId` `(timestamp, seq)` monotonicity check runs and **only warns — it never reorders**. Already-corrupted legacy sessions cannot be restored losslessly (the raw transcript is never persisted); use `node scripts/session-order-check.mjs` for a read-only diagnosis

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
| **Scheduled** | Auto-promotion cron config + run history (with an "All workspaces / Selected workspace" scope toggle; the selected mode requires picking a workspace explicitly) + tier summary + Gate decisions | `GET /memory/status`, `GET /memory/dream/preview`, `GET /memory/dream/history?scope=all\|ws[&ws=<id>]`, `DELETE /memory/dream/history[?scope=&ws=]` |
| **L2 Episodic** | Workspace → session → scope/tag three-level filter + day window, grouped by day; entry headers (session id / scope / tag) are parsed on the frontend | `GET /memory/episodic?limit=<1-90>&ws=<id>` + `GET /memory/workspaces` |
| **L3 Curated** | Global shared (SOUL/USER, unaffected by workspace switching) vs. workspace-level (MEMORY) two columns; switch workspace via the top-right dropdown | `GET /memory/curated?ws=<id>` |
| **Search** | L2 semantic search **inside the selected workspace**; the badge shows the selected workspace name | `GET /memory/search?q=&ws=<id>` |

> **Workspace selection semantics (req. 20261113-004)**: all four tabs share one "current workspace". On entering the page the first workspace that has memory is selected automatically, and the choice is written to the hash `?ws=` (refresh/share restores it). The UI offers no "default / startup workspace" option — with no selection (fresh install, empty list) the tabs show an empty state and issue no requests. The backend's "omitted = process startup workspace" semantics is unchanged; the UI simply no longer triggers it.

Companion endpoints:

- **`GET /memory/workspaces`**: aggregates workspaces that "have sessions ∪ have memory", returning `{id, name, path, hasMemory, hasSession}[]` — the session side comes from scanning session indexes, the memory side from scanning `{memoryDir}/*/` directories; memory-only "orphan workspaces" are listed too (used by the L2/L3 workspace dropdowns).
- **`GET /memory/episodic` / `GET /memory/curated` / `GET /memory/search` accept `?ws=<id or absolute path>`**: read memory for a specific workspace (canonical checks; unknown workspace → 404) and echo `ws: {id, path}`; omitted falls back to the **startup workspace** (no longer drifting with the most-recently-used one as of req. 20261113-001; the UI always passes `ws` since req. 20261113-004).
- **`GET /memory/dream/history?scope=all|ws[&ws=<id>]`**: with `all`, aggregates `.dreaming-runs.json` of all workspaces via file scan (no loaded runtime required), each row annotated with `workspaceId/workspaceName/workspacePath`; `ws` with `ws=` reads the given workspace and annotates the same tri fields (orphan workspaces are readable via their memory directory instead of 404).
- **`DELETE /memory/dream/history?scope=all|ws[&ws=<id>]`**: clearing follows the selected scope; with `all`, records in every workspace are cleared, with `scope=ws&ws=` only that workspace (files kept, contents emptied, idempotent).

### Manual compaction and context usage (20261106-005)

Automatic compaction still runs only inside a run when the threshold is crossed; these endpoints support explicit actions on an idle session and do not change the automatic policy:

- **`GET /sessions/:id/context`** returns `{contextTokens, maxTokens, threshold, percent, keepRecentTurns, source}`. When real `llm_stats` exist the latest `prompt_tokens` is used (`source=stats`); historical sessions fall back to a local message estimate (`source=estimate`). Usage is in-memory only and never persisted. `keepRecentTurns` lets the WebUI pre-check whether anything is compactable — when the visible model-call count is within the retention window and usage is below the compaction threshold, the compact button is disabled with an explanatory note.
- **`POST /sessions/:id/compact`** forces one L1 compaction while idle (409 if a run is in flight). With nothing to drop it returns `{ok:false, reason:'nothing_to_compact'}` and **does not call the LLM**; on success it reuses the compaction archiving pipeline and writes dropped messages to L2 (`tag=compaction`).
- **`POST /sessions/:id/retry {seq}`** is a replace-style retry. `seq` targets an assistant answer in the restored session view; the backend finds the user text of that turn, truncates everything after it (overwriting storage) and regenerates. Retrying a middle turn deletes later exchanges, so the WebUI asks for confirmation first.

The WebUI shows two indicators in the action bar of the last assistant answer: a percentage ring (context usage; hover reveals the compact button) and a Token chip (this round's cumulative tokens; hover expands to total input / total output / total tokens / average cache-hit rate). The chip is fed by per-iteration `llm_stats` accumulation during streaming and overwritten by the authoritative `llm_stats_summary` when the run ends (requirement 20261106-006); cache-hit rate = `prompt_cache_hit ÷ prompt_tokens`, shown as N/A when the provider returns no cache fields.
