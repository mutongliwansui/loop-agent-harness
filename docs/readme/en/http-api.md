# 🌐 HTTP API Server (--serve)

> [⬅ Back to README](../../../README.md)


Run the Agent as a long-lived REST service callable over HTTP (zero new dependencies, built on `node:http`).

### Starting

```bash
npm run serve
# or
npx tsx src/index.ts --serve
```

```
HTTP API server started
  Address:  http://127.0.0.1:3000
  Auth:     localhost only (api.token not configured)
  Endpoints: GET /health · POST /sessions · GET|DELETE /sessions/:id · POST /sessions/:id/messages
  Tips:     Ctrl+C to exit; config changes require a restart
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

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health probe `{status, version, model}` |
| POST | `/sessions` | Create an empty session → 201 `{id, title, createdAt, ...}` |
| GET | `/sessions` | List sessions `{sessions: [...]}` |
| GET | `/sessions/:id` | Session detail `{meta, messages}` (restore view, without system) |
| DELETE | `/sessions/:id` | Delete a session `{deleted: true}` (409 while in-flight) |
| POST | `/sessions/:id/messages` | Send a message (SSE streaming by default; `"stream": false` for JSON) |

Errors are uniform `{error: {code, message}}`: 400 bad request / 401 unauthorized / 403 non-loopback / 404 not found / 405 method not allowed / 409 busy / 413 body over 2MB / 500 internal.

### SSE Streaming Events

`POST /sessions/:id/messages` returns `text/event-stream` by default, forwarding all 15 Agent event hooks frame by frame (`onXxx` → snake_case event names), followed by a synthetic terminal event from the API layer:

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
| `compaction` | `{info}` | L1 context compaction |
| `final` | `{answer}` | Final answer |
| `error` | `{name, message}` | Non-fatal error (may repeat; not terminal) |
| `warning` | `{level, message, context?}` | Warning (e.g. persistence degraded) |
| `end` | `{result}` | Agent finished |
| `done` | `{sessionId, durationMs, iterations, steps}` | Synthetic terminal (success; last frame) |
| `fatal` | `{message}` | Synthetic terminal (run failed, then the stream closes) |

### curl Examples

```bash
# Create a session
curl -X POST http://127.0.0.1:3000/sessions
# → {"id":"sess_20261016_103000","title":"...","messageCount":0}

# Send a message (SSE streaming, -N disables buffering)
curl -N -X POST http://127.0.0.1:3000/sessions/sess_20261016_103000/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "Show me the project structure"}'

# Send a message (non-streaming JSON)
curl -X POST http://127.0.0.1:3000/sessions/sess_20261016_103000/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "hello", "stream": false}'
# → {"sessionId":"...","answer":"...","iterations":1,"steps":[...],"durationMs":123}

# Access after configuring a token
curl -H "Authorization: Bearer my-secret" http://127.0.0.1:3000/health

# Get / delete a session
curl http://127.0.0.1:3000/sessions/sess_20261016_103000
curl -X DELETE http://127.0.0.1:3000/sessions/sess_20261016_103000
```

### Behavior Notes

- **Multi-session isolation**: each session's history is injected into the shared agent independently (empty history uses `resetHistory`, non-empty uses explicit `messages`) — no cross-talk
- **Session persistence**: answers are written to the session pool (shared with the CLI); after a restart, keep chatting by posting to the existing session ID
- **Per-session mutex**: a session processes one message at a time; concurrent requests get 409; different sessions run in parallel
- **Config changes** (token/port/host) require a server restart to take effect
