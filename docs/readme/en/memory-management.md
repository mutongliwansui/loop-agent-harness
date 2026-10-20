# 🧠 Memory Management

> [⬅ Back to README](../../../README.md)

A three-tier memory architecture (Tier Model) in the OpenClaw style. Core ideas: **files are the source of truth, indexes only accelerate; write and read paths are separated; promotion is gated.** Memory management complements session persistence (Task-11): session persistence solves "restore the last conversation," while memory management solves "accumulate knowledge across sessions."

### Three-tier Architecture

| Tier | Storage Form | Lifecycle | Auto in context | Description |
|---|---|---|---|---|
| **L1 Working** | In-memory `_chatHistory` | Single session | ✅ Always | Compacts automatically past a threshold (default 8000 tokens / 80% threshold, keeping the last 3 turns): first asks the LLM to extract key notes into L2, then injects a `[历史摘要]` placeholder (marked `is_show=false`, visible to the LLM, filtered on disk write) into the context; on-disk full history is the single source of truth, and in-memory compaction + on-disk restore share one `buildCompactedView` generator |
| **L2 Episodic** | `{cwd}/memory/YYYY-MM-DD.md` | Permanent archive | ❌ Retrieved on demand | Split by day; tool-call results are auto-recorded; recall via `/memory search` |
| **L3 Curated** | `{cwd}/SOUL.md` / `USER.md` / `MEMORY.md` | Permanent, always present | ✅ Injected on startup | Agent persona / user profile / distilled facts, always present in the System Prompt |

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
