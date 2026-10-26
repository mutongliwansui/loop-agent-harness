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
| POST | `/sessions` | Create an empty session (body may carry `{title?, workspacePath?}`; with `workspacePath` the session is **created directly in that workspace** without switching the "current workspace") → 201 `{id, title, createdAt, workspace: {path, id, switched}}` (`switched` is kept for compatibility and is always `false`) |
| GET | `/sessions` | Sessions of the current workspace (most-recently-used pointer) `{sessions: [...]}` |
| GET | `/workspaces` | Cross-workspace aggregate `{workspaces: [{id, name, current, sessions}]}` (`current` is marked by the most-recently-used pointer; session entries carry `running` and a `lastRun` summary) |
| GET | `/sessions/:id` | Session detail `{meta, messages, run, lastRun, workspace}` (locates the owning workspace by id and reads from it — **pure read, no server-state change**; `messages` is the full history, system and compaction-summary messages carry `is_show=false` for the frontend to filter) |
| DELETE | `/sessions/:id` | Delete a session `{deleted: true}` (409 while in-flight in its owning workspace; runs in other workspaces are unaffected) |
| POST | `/sessions/:id/messages` | Send a message (SSE streaming by default; `"stream": false` for JSON; the owning workspace is located by id) |

#### Command Resources (CLI commands → REST, 10 groups, 40 endpoints)

**uploads (`/upload` command)**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/uploads` | Upload files `{sessionId, paths: string[]}` → 201 `{entries, contextNote, failed}` (partial success 201, all failed 400; contextNote is returned only, not injected — the client sends it with the next /messages round) |
| GET | `/uploads?sessionId=` | List uploaded files of a session |
| DELETE | `/uploads?sessionId=` | Clear a session's upload directory (verb as confirmation) |

**config (`/config` command)**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/config` | Full config (secrets masked) |
| GET | `/config/path` | Config file paths `{globalPath, workspacePath, workspaceExists}` |
| GET | `/config/:key` | Read one key `{key, value, scope}` (secrets masked) |
| PUT | `/config/:key` | Write one key `{value, scope?}` (workspace default; `api.*` returns restartRequired) |
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
| GET | `/mcp/servers` | Server list `{servers: [{name, transport, status, toolCount}]}` |
| GET | `/mcp/servers/:name` | Server detail (with tool list) |
| POST | `/mcp/servers` | Register & connect `{name, transport, command?/url?, ...}` → 201 (duplicate name 409; connect failure 502 but config persisted) |
| DELETE | `/mcp/servers/:name?scope=` | Disconnect first, then delete config `{deleted}` |
| POST | `/mcp/reload` | Reconnect all `{reconnected, failed}` |
| POST | `/mcp/servers/:name/test` | Connection test `{ok, latencyMs, tools, error?}` |

**skills (`/skill` command)**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/skills` | Loaded skills `{skills: [{name, description, scope, path}]}` |
| GET | `/skills/:name` | Skill detail (with full body) |
| POST | `/skills` | Install from a source directory `{sourcePath, scope?, overwrite?}` → 201 (same name without overwrite 409) |
| DELETE | `/skills/:name?scope=` | Uninstall a skill `{deleted, scope}` |
| POST | `/skills/reload` | Reload skills `{loaded}` |

**memory (`/memory` command, 409 when disabled)**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/memory/status` | Layered status `{enabled, layers, counts}` (always 200 `{enabled:false,...}` when disabled) |
| GET | `/memory/curated` | Full text of curated-layer files `{entries}` |
| GET | `/memory/episodic?limit=` | Episodic-layer log `{entries}` |
| GET | `/memory/search?q=&limit=` | Cross-layer search `{results: [{content, score, layer}]}` (q required) |
| GET | `/memory/gate` | Promotion gate thresholds + recent decisions |
| POST | `/memory/dream` | Trigger async curation → 202 `{accepted}` |
| POST | `/memory/init` | Initialize layered directories (idempotent) |

**vision (`/vision` command, diagnostic semantics: failure does not fail the endpoint)**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/vision` | Probe-chain status `{available, provider, model, reason?}` |
| POST | `/vision/test` | Minimal image request to verify connectivity `{ok, latencyMs, error?}` |

**doctor (`/doctor` command, read-only checkup)**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/doctor` | Per-item checks `{ok, checks: [{name, ok, level, detail}]}` |

Errors are uniform `{error: {code, message}}`: 400 bad request / 401 unauthorized / 403 non-loopback / 404 not found / 405 method not allowed / 409 conflict (session busy / active model rejected / memory disabled) / 413 body over 2MB / 500 internal / 502 upstream connect failure (MCP).

Semantic conventions:

- **Verb as confirmation**: DELETE/PUT/PATCH replace the CLI's y/N prompts; skill overwrite requires explicit `overwrite: true`; deleting the active model returns 409 directly (stricter than a confirmation)
- **Unified scope**: write-config endpoints accept `?scope=workspace|global` (workspace default), aligned with the CLI `--global` flag
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
- **Config changes** (token/port/host) require a server restart to take effect
- **Run journal (Task-20261021-002-06)**: each run's lifecycle (running/done/failed/aborted) is journaled to `<userDir>/.loop-agent/sessions/<workspaceId>/runs/<sessionId>.json` (cleaned up together with session deletion); on startup, a scan rewrites leftover `running` records from the previous process to `interrupted`. The `GET /sessions/:id` response carries a `lastRun` field (journal disk state), and session entries in `GET /workspaces` carry a `lastRun: {status, finishedAt}` summary — the frontend uses these to show the "last run was interrupted (server restarted)" note and the sidebar ⚠ marker. Diagnostic logs also go to `~/.loop-agent/logs/runs-YYYY-MM-DD.jsonl` (start/finish/abort/failed/interrupted event stream)
