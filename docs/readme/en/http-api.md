# 🌐 HTTP API Server (--serve)

> [⬅ Back to README](../../../README.md)


Run the Agent as a long-lived REST service callable over HTTP (zero new dependencies, built on `node:http`).

### Starting

```bash
npm run serve
# or
npx tsx src/index.ts --serve

# Temporarily override the port (highest priority, not persisted)
npm run serve -- --port 3001

# Or via env var (Windows PowerShell: $env:LOOP_AGENT_PORT=3001; npm run serve)
LOOP_AGENT_PORT=3001 npm run serve
```

```
HTTP API 服务已启动
  地址:    http://127.0.0.1:3000
  鉴权:    仅本机（未配置 api.token）
  端点:    /health · /status · /sessions · /uploads · /config · /tools · /models · /mcp · /skills · /memory
  提示:    Ctrl+C 退出；配置变更需重启生效
```

### Configuration & Auth

A new `api` section in `config.json`:

```json
{
  "api": {
    "port": 3000,
    "host": "127.0.0.1",
    "token": ""
  }
}
```

```bash
/config set api.token my-secret   # Takes effect after restarting the server
```

Three auth modes:

- **Empty token** → only loopback requests (`127.0.0.1` / `::1`) are accepted; others get 403
- **Non-empty token** → every request must carry `Authorization: Bearer <token>`, otherwise 401
- **Non-loopback host binding** (e.g. `0.0.0.0`) without a token → startup is refused (prevents exposing the LAN unprotected)

### Endpoints

#### Sessions & System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health probe `{status, version, model}` |
| POST | `/sessions` | Create an empty session; the body **must** carry `{workspacePath}` (`title` optional; missing or blank → 400 `bad_request`) → 201 `{id, title, createdAt, workspace: {path, id, switched}}`. The session is **created directly in that workspace** without switching the "current workspace" (`switched` is kept for compatibility and is always `false`) |
| GET | `/sessions` | Sessions of the **named workspace** `{sessions: [...]}`; `?ws=` (absolute path) is **required** — missing or blank → 400 `bad_request` (no fallback to the process startup workspace); use `GET /workspaces` for the cross-workspace overview |
| GET | `/workspaces` | Cross-workspace aggregate `{workspaces: [{id, name, path, createdAt, lastAccessedAt, sessions}]}` (workspaces are fully peers — **no "current workspace" marker**; session entries carry `running` and a `lastRun` summary) |
| GET | `/sessions/:id` | Session detail `{meta, messages, run, lastRun, workspace}` (locates the owning workspace by id and reads from it — **pure read, no server-state change**; `messages` is the full history, system and compaction-summary messages carry `is_show=false` for the frontend to filter) |
| DELETE | `/sessions/:id` | Delete a session `{deleted: true}` (409 while in-flight in its owning workspace; runs in other workspaces are unaffected) |
| POST | `/sessions/:id/messages` | Send a message (SSE streaming by default; `"stream": false` for JSON; the owning workspace is located by id) |
| GET | `/sessions/:id/subagents` | Background sub-agent list snapshot (requirement 20261107-002 D9): `{items: [{taskId, status, task, elapsedMs, iterations, …}]}`; kept for existing callers |
| GET | `/sessions/:id/jobs` | Unified background job snapshot (requirement 20261112-006): `{items: [{id, kind: command\|subagent, title, status: running\|done\|failed\|stopped\|lost, startedAt, elapsedMs, canStop, …}], run}`; scope = current session + unowned jobs, polled every 2s by the WebUI indicator |

**Workspace files (`/fs/*`)**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/fs/dirs?path=` | Server-side directory browser used by the "pick a workspace" dialog → `{path, parent, dirs, drives}`. When `path` is omitted the starting point is the **most-recently-used workspace**, falling back to `os.homedir()` when there is none (requirement 20261113-001 D3: MRU is only a *recommendation* here, no longer an implicit workspace) |
| GET | `/fs/tree?path=&ws=` | One level of the workspace tree; `ws` is **required** — missing `ws` returns 400, unknown workspace 403 (requirement 20261113-001 D2) |
| GET | `/fs/file?path=&ws=` | Read a text file (`ws` required; >512KB truncated, binary rejected) |
| GET | `/fs/search?q=&ws=` | Full-text search over names, directory names and content (`ws` required) |
| GET | `/fs/fingerprint?path=&ws=` | Directory fingerprint used by the frontend to detect changes (`ws` required) |

> Requirement 20261113-001 D2: `/fs/tree`, `/fs/file`, `/fs/search`, `/fs/fingerprint` (and the other in-workspace read/write endpoints that share the same resolver) **no longer fall back to the most-recently-used workspace**. A request without `ws` is rejected with `400 bad_request` instead of silently reading a directory the user did not name. Only the "pick a workspace" browser `/fs/dirs` keeps a recommendation, because its job is precisely to help choose one.

#### Command Resources (CLI commands → REST, 10 groups, 40 endpoints)

**uploads (`/upload` command)**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/uploads` | Upload files `{sessionId, paths: string[]}` → 201 `{entries, contextNote, failed}` (partial success 201, all failed 400; contextNote is returned only, not injected — the client sends it with the next /messages round) |
| POST | `/uploads/raw?sessionId=` | Raw byte upload (body = file bytes, `X-File-Name` = encodeURIComponent file name) → 201 `{fileName, bytes, contextNote}`; both the WebUI 📎 picker and the composer's `Ctrl+V` paste (screenshots / files copied in Explorer) go through this endpoint |
| GET | `/uploads?sessionId=` | List uploaded files of a session |
| GET | `/uploads/view?path=&disp=file\|raw` | Preview an uploaded file (20261028-006): `disp=file` (default) returns `{name, bytes, truncated, content}` (same shape as `/fs/file`, truncated beyond 512KB, binaries rejected with 400); `disp=raw` returns raw bytes (images render directly, 100MB cap). `path` is relative to the uploads root, or an absolute path containing a `/.loop-agent/uploads/` segment (after normalization it must stay inside the uploads root; `resolveInWs` + realpath double check against traversal/escape — 403 out of root, 404 missing, 400 missing param; since 20261028-007 a leading `~` is expanded via homedir first). Used by conversation tool-card path chips to preview images handled by vision tools |
| GET | `/userdir/view?path=&disp=file\|raw` | Preview a file inside the app-owned data directory (20261028-007): root = `~/.loop-agent` (injectable via `ctx.userDir`). Validation chain identical to `/uploads/view` (`resolveInWs` + realpath double check — 403 out of root, 404 missing, 400 missing param, 400 binary under `disp=file`, 413 beyond 100MB); `disp=file` (default) same shape as `/fs/file`, `disp=raw` raw bytes. `path` is relative to the root (e.g. `memory/<wsId>/date.md`), an absolute path, or a `~` literal (expanded via homedir first). Used by conversation tool-card path chips to preview memories / runs logs / global skill SKILL.md files inside `~/.loop-agent` |
| DELETE | `/uploads?sessionId=` | Clear a session's upload directory (verb as confirmation) |

`contextNote` is the text block injected into the Agent context: `[文件上传] <on-disk name>` plus the upload path and size. Image files (png/jpg/jpeg/webp/gif/bmp) get one extra line, `类型: 图片 <mime>（可用 analyzeImage / ocrImage 查看）` — without it the main model sees `paste.png` and has no idea it is an image it can look at, and tends to `fileRead` raw binary instead.

**config (`/config` command)**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/config` | Full config (secrets masked) |
| GET | `/config/path` | Config file paths `{globalPath, workspacePath, workspaceExists}` |
| GET | `/config/:key` | Read one key `{key, value, scope}` (secrets masked) |
| PUT | `/config/:key` | Write one key `{value, scope?}` (global only; `api.*` returns restartRequired) |
| DELETE | `/config/:key?scope=` | Delete one key `{deleted}` |

**status (REPL `/status` snapshot)**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/status` | Lightweight snapshot `{version, model, session, tools, mcp, memory, uploads}` |

**tools (`/tools` command)**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/tools` | Tool snapshot `{tools: [{name, description, enabled, source}]}` (built-in + MCP, vision-gated) |
| GET | `/tools/:name` | Tool detail (with JSON Schema) |
| PATCH | `/tools/:name` | Enable/disable a built-in tool `{enabled, scope?}` (persisted + runtime sync) |
| POST | `/tools/reload` | Reload all tools `{reloaded}` |

**models (`/model` command)**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/models` | Profile registry `{profiles: [{alias, ..., isCurrent}]}` |
| GET | `/model` | Active model snapshot (apiKey masked) |
| PUT | `/model` | Switch active profile `{alias, scope?}` (ghost 409/404) |
| POST | `/models` | Register a profile `{alias, profile, scope?}` → 201 (duplicate alias 409) |
| DELETE | `/models/:alias?scope=` | Delete a profile `{deleted}` (409 while active; 404 across scopes with scope hint) |
| POST | `/models/:alias/test` | Connectivity test `{ok, latencyMs, error?}` |
| GET | `/models/bench` | Bench endpoint self-description (tiers / prompts / max aliases / history root) |
| POST | `/models/bench` | Start a bench run `{aliases, tier?, prompts?, rounds?, maxTokens?, bustCache?}` → 202 `{runId, plan}` (max 4 aliases, server-side serial) |
| GET | `/models/bench/:runId/stream` | SSE progress: `start` / `model_start` / `round_start` / `first_token` / `token` (throttled to 100ms) / `round_end` / `model_done` / `done` / `failed`; replays past events so reconnects are idempotent |
| POST | `/models/bench/:runId/stop` | Abort a bench run (idempotent) `{runId, stopped, status}` |
| GET | `/models/bench/history?alias=&limit=` | Bench history (without `alias`, only the latest run per model; stored in `~/.loop-agent/model-bench/history.json`, apiKey never persisted) |

**mcp (`/mcp` command)**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/mcp/servers` | Server list `{servers: [{name, transport, status, toolCount, state, lastError?, nextRetryAt?, scope}]}` (`scope` is always global; config is global-only after 20261112-008) |
| GET | `/mcp/tool-meta` | MCP tool display metadata `{tools: McpToolMeta[], summary}` (requirement 20261104-001: localized names, parameter labels, translation status; returns an empty list instead of 404 when no server is connected, never part of `toOpenAITools()`) |
| GET | `/mcp/servers/:name` | Server detail (with tool list) |
| POST | `/mcp/servers` | Register & connect `{name, transport, command?/url?, ...}` → 201 (duplicate name 409; connect failure 502 but config persisted) |
| DELETE | `/mcp/servers/:name?scope=` | Disconnect first, then delete config `{name, scope, deleted}` (`scope=workspace` returns 400; `deleted:false` when the key does not exist — no disconnect) |
| POST | `/mcp/reload` | Reconnect all `{reconnected, failed}` |
| POST | `/mcp/servers/:name/test` | Connection test `{ok, latencyMs, tools, error?}` |

**skills (`/skill` command)**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/skills` | Loaded skills `{skills: [{name, description, scope, path}]}` |
| GET | `/skills/:name` | Skill detail (with full body) |
| POST | `/skills` | Install from a source directory `{sourcePath, scope?, overwrite?}` → 201 (same name without overwrite 409) |
| POST | `/skills/upload` | Install from an uploaded skill zip `{rootName, zipBase64, scope?, overwrite?}` → 201 (max 20MB, strips the top-level directory) |
| DELETE | `/skills/:name?scope=` | Uninstall a skill `{deleted, scope}` |
| POST | `/skills/reload` | Reload skills `{loaded}` |

**memory (`/memory` command, 409 when disabled)**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/memory/status` | Layered status `{enabled, layers, counts, dreaming?}` (always 200 `{enabled:false,...}` when disabled; `dreaming` is the auto-promotion state, see below) |
| GET | `/memory/workspaces` | Aggregated workspace list "with sessions ∪ with memory" `{workspaces: [{id, name, path, hasMemory, hasSession}]}` (session side from session-index scans, memory side from `{memoryDir}/*/` directory scans; memory-only orphan workspaces listed too) |
| GET | `/memory/curated?ws=` | Full text of curated-layer files `{entries}` (`ws` optional: workspace id or absolute path; default = **startup workspace**, no longer drifting with the most-recently-used one as of req. 20261113-001; unknown workspace → 404) |
| GET | `/memory/episodic?limit=&ws=` | Episodic-layer log `{entries}` (`ws` optional, same semantics as curated; `limit` 1–90 days) |
| GET | `/memory/search?q=&limit=` | Cross-layer search `{results: [{content, score, layer}]}` (q required; current workspace) |
| GET | `/memory/gate` | Promotion gate thresholds + recent decisions |
| POST | `/memory/dream` | Trigger async curation → 202 `{accepted, reason?, skippedBecause?}` (`accepted:false` when a run is already in progress) |
| GET | `/memory/dream/schedule` | Current schedule `{enabled, cron, describe, misfireGraceMin, nextRunAt, nextRunTimes, intervalMode}` |
| PUT | `/memory/dream/schedule` | Update schedule `{enabled?, cron?, misfireGraceMin?}` → validated then **rescheduled hot (no restart)**; an invalid cron returns 400 and **neither persists nor changes the current schedule** |
| GET | `/memory/dream/preview?cron=` | Preview while typing: `{ok:true, describe, next:[…5 instants], timezoneOffsetMin}`; invalid → **200** `{ok:false, error, fieldIndex?}` (a preview is not a failed request, so the UI has a single branch) |
| GET | `/memory/dream/history?limit=&scope=&ws=` | Recent runs `{scope, runs:[{startedAt, finishedAt, durationMs, reason, ok, daysBack, promoted, skipped, errors, skippedBecause?, errorMessage?, catchup?, workspaceId?, workspaceName?, workspacePath?}]}`; `scope=all` aggregates all workspaces via file scan (no loaded runtime required), `scope=ws` (default) = the **startup workspace** (no longer drifting with the most-recently-used one as of req. 20261113-001); two new skip reasons `no-new-content` / `runtime-unavailable` |
| DELETE | `/memory/dream/history?scope=&ws=` | Clear run history `{deleted}` (follows the selected scope; with `all`, records in every workspace are cleared, files kept) |
| POST | `/memory/init` | Initialize layered directories (idempotent) |

**`dreaming` field of `/memory/status` (auto-promotion observability)**

```json
{
  "enabled": true,
  "layers": { "episodic": { "dir": "…" }, "curated": { "workspace": "…", "files": {} } },
  "counts": { "episodicDays": 7, "gatePending": 0, "gateApproved": 12 },
  "dreaming": {
    "enabled": true,
    "scheduleEnabled": true,
    "intervalHours": 24,
    "startupDelayMin": 5,
    "cron": "0 3 * * *",
    "cronValid": true,
    "describe": "每天 03:00",
    "timezoneOffsetMin": 480,
    "misfireGraceMin": 60,
    "intervalMode": "cron",
    "nextRunTimes": ["2026-10-27T19:00:00.000Z", "2026-10-28T19:00:00.000Z", "2026-10-29T19:00:00.000Z"],
    "running": false,
    "lastRunAt": "2026-10-26T00:12:33.000Z",
    "lastSummary": { "reason": "schedule", "promoted": 3, "skipped": 1, "errors": 0, "ok": true },
    "lastProcessedDay": "2026-10-25",
    "nextRunAt": "2026-10-27T19:00:00.000Z"
  }
}
```

> `dreaming` is only present when the scheduler is wired (`--serve` boot) and the workspace is loaded.
> With `memory.enabled=false` the whole response stays `{enabled:false, layers:{}, counts:{}}` (200, never an error).

Fields added by requirement `20261026-003` (legacy fields are kept for one release):

| Field | Meaning |
| --- | --- |
| `cron` / `cronValid` / `describe` | Current expression, validity, and a human-readable description (e.g. "每天 03:00", "每周一 09:00", "每周二、三、四 06:00") |
| `intervalMode` | `cron` (default) or `interval` (legacy fallback when `cron` is an empty string) |
| `timezoneOffsetMin` | Server local timezone offset in minutes (`480` for UTC+8); `nextRunAt(s)` are UTC ISO strings to be rendered in local time |
| `misfireGraceMin` | Misfire catch-up grace window in minutes |
| `nextRunTimes` | The next 3 trigger instants (UTC ISO) for the WebUI to render directly |
| `intervalHours` / `startupDelayMin` | **Deprecated** (meaningful only when `intervalMode=interval`); removed in the next major version |


**vision (`/vision` command, diagnostic semantics: failure does not fail the endpoint)**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/vision` | Probe-chain status `{available, provider, model, reason?}` |
| POST | `/vision/test` | Minimal image request to verify connectivity `{ok, latencyMs, error?}` |

**doctor (`/doctor` command, read-only checkup)**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/doctor` | Per-item checks `{ok, checks: [{name, ok, level, detail}]}` |

**dev (self-describing docs, requirement 20261104-002)**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dev/api-docs` | Full API documentation `{version, groups: [{key, title, desc, items}], stats: {total, documented, undocumented}}` (**runtime reflection over `createRoutes()`** gives the complete endpoint set, merged with metadata from `src/api/api-docs.ts`; `documented:false` means the endpoint has no Chinese description yet and is listed in `stats.undocumented`) |

`/dev/api-docs` shares the same auth policy as every other endpoint (loopback-only when no token; `Authorization: Bearer` required once `api.token` is set) and reads **no files from disk**: it works under the single-file SEA distribution where `docs/` does not exist. The WebUI "Developer Center" (`#/dev`) consumes this endpoint to render grouped lists, parameter tables and curl examples.

Errors are uniform `{error: {code, message}}`: 400 bad request / 401 unauthorized / 403 non-loopback / 404 not found / 405 method not allowed / 409 conflict (session busy / active model rejected / memory disabled) / 413 body over 2MB / 500 internal / 502 upstream connect failure (MCP).

Semantic conventions:

- **Verb as confirmation**: DELETE/PUT/PATCH replace the CLI's y/N prompts; skill overwrite requires explicit `overwrite: true`; deleting the active model returns 409 directly (stricter than a confirmation)
- **Unified scope**: configuration exists only globally (req 20261112-008), so write-config endpoints need no `scope` parameter; `?scope=workspace` always returns 400, and `global` is equivalent to omitting it
- **Diagnostic semantics**: `/vision/test`, `/models/:alias/test`, `/mcp/servers/:name/test` and `/doctor` return 200 even when the check fails (`ok: false` + details), never failing the endpoint

### SSE Streaming Events

`POST /sessions/:id/messages` returns `text/event-stream` by default, forwarding all 16 Agent event hooks frame by frame (`onXxx` → snake_case event names), followed by a synthetic terminal event from the API layer:

| Event | Payload | Description |
|-------|---------|-------------|
| `start` | `{input}` | Agent started |
| `iteration_start` | `{iteration, maxIterations}` | Each iteration begins |
| `llm_stream` | `{text}` | Streaming output fragment |
| `llm_end` | `{response, iteration}` | LLM round completed |
| `llm_stats` | `{stats}` | Per-round token stats |
| `llm_stats_summary` | `{summary}` | Session-level stats summary |
| `tool_start` / `tool_end` | `{tool, args}` / `{tool, result}` | Tool call start / end |
| `tool_progress` | `{tool, elapsedMs}` | Long-running tool heartbeat |
| `tool_call_delta` | `{tool, accumulatedBytes, elapsedMs}` | Streaming tool-argument deltas |
| `compaction_start` | `{info}` | L1 compaction starts (pre-compaction flush in progress) |
| `compaction` | `{info}` | L1 context compaction |
| `final` | `{answer}` | Final answer |
| `error` | `{name, message}` | Non-fatal error (may repeat; not terminal) |
| `warning` | `{level, message, context?}` | Warning (e.g. persistence degraded) |
| `end` | `{result}` | Agent finished |
| `done` | `{sessionId, durationMs, iterations, steps}` | Synthetic terminal (success; last frame) |
| `fatal` | `{message}` | Synthetic terminal (run failed, then the stream closes) |

### curl Examples

```bash
# Create a session (current workspace)
curl -X POST http://127.0.0.1:3000/sessions
# → {"id":"sess_8dcc67b6_20261016_103000","title":"...","messageCount":0,...}

# Create a session in a specific workspace (created there directly, no "current workspace" switch)
curl -X POST http://127.0.0.1:3000/sessions \
  -H "Content-Type: application/json" \
  -d '{"workspacePath": "D:\\other-project"}'

# Send a message (SSE streaming, -N disables buffering)
curl -N -X POST http://127.0.0.1:3000/sessions/sess_8dcc67b6_20261016_103000/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "Show me the project structure"}'

# Send a message (non-streaming JSON)
curl -X POST http://127.0.0.1:3000/sessions/sess_8dcc67b6_20261016_103000/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "hello", "stream": false}'
# → {"sessionId":"...","answer":"...","iterations":1,"steps":[...],"durationMs":123}

# Access after configuring a token
curl -H "Authorization: Bearer my-secret" http://127.0.0.1:3000/health

# Get / delete a session
curl http://127.0.0.1:3000/sessions/sess_8dcc67b6_20261016_103000
curl -X DELETE http://127.0.0.1:3000/sessions/sess_8dcc67b6_20261016_103000
```

### Behavior Notes

- **Multi-session isolation**: each session's history is injected into the shared agent independently (empty history uses `resetHistory`, non-empty uses explicit `messages`) — no cross-talk
- **Session persistence**: answers are written to the session pool (shared with the CLI); after a restart, keep chatting by posting to the existing session ID
- **Per-session mutex (workspace-scoped)**: a session processes one message at a time; concurrent requests get 409 (`busy`). The mutex only constrains the **same session in the same workspace** — a run in flight in workspace A does not block creating/deleting sessions or starting new runs in workspace B
- **Cross-workspace parallelism**: each workspace gets its own lazily-created `WorkspaceRuntime` from the `WorkspaceRegistry` (session store, config, skills, memory, agent pool; LRU cap 4); the process-level `process.chdir` has been removed, and tool relative paths resolve against the owning workspace root; a global concurrency semaphore (8) caps the total number of simultaneous runs
- **sessionId workspace namespace**: new ids look like `sess_<wsId8>_<timestamp>` (e.g. `sess_8dcc67b6_20261016_103000`), so the owning workspace is located from the id alone and endpoints like `GET /sessions/:id` no longer trigger a "workspace switch"; legacy `sess_<timestamp>` ids remain readable forever
- **Config changes** (token/port/host) require a server restart
- **No implicit default workspace** (requirement 20261113-001): in-workspace read/write endpoints reject a missing `ws` with 400 instead of silently using the most-recently-used workspace; `/fs/dirs` starts at `most-recently-used \|\| os.homedir()`. `POST /sessions` **must** carry an explicit `workspacePath` and `GET /sessions` **must** carry an explicit `ws` (missing or blank is a 400 — it never silently creates a session in any workspace and never falls back to the process startup workspace; see D6/D8); use `GET /workspaces` when you need the cross-workspace overview; `/memory/dream*` is all-workspace by nature and needs no `ws` to take effect
- **Run journal (Task-20261021-002-06)**: each run's lifecycle (running/done/failed/aborted) is journaled to `<userDir>/.loop-agent/sessions/<workspaceId>/runs/<sessionId>.json` (cleaned up together with session deletion); on startup, a scan rewrites leftover `running` records from the previous process to `interrupted`. The `GET /sessions/:id` response carries a `lastRun` field (journal disk state), and session entries in `GET /workspaces` carry a `lastRun: {status, finishedAt}` summary — the frontend uses these to show the "last run was interrupted (server restarted)" note and the sidebar ⚠ marker. Diagnostic logs also go to `~/.loop-agent/logs/runs-YYYY-MM-DD.jsonl` (start/finish/abort/failed/interrupted event stream)
