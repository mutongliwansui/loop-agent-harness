# 🤖 ReAct Agent

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20.10+-339933?style=flat-square&logo=node.js)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)]()

**An intelligent agent built on the ReAct (Reasoning + Acting) framework**, connecting to large language models via the OpenAI protocol, invoking tools through **Function Calling**, and written in **TypeScript**.

> 🧠 **Core idea**: a **Thought → Action → Observation** reasoning loop — "think, act, observe" like a human, solving problems step by step until a final answer is reached.

[中文](README.md) | [✨ Features](#-features) | [🚀 Quick Start](#-quick-start) | [📚 Documentation](#-documentation)

</div>

---

## ✨ Features

| Feature | Description |
|---|---|
| 🔄 **ReAct Loop** | Step-by-step reasoning via Thought → Action → Observation until a final answer is produced |
| 📡 **Streaming Output** | Real-time streaming of the LLM reasoning process, with concatenation of `content` and `tool_calls` chunks |
| ⏳ **Loading Indicator** | Shows "Thinking…" / "Running: <tool>…" loading indicators during time-consuming phases (model generation / tool execution); the line is cleared before printing so output never mixes. Automatically disabled for non-TTY (pipe / redirect / CI) |
| 📊 **Token Stats** | Prints context/input/output tokens and cache hit rate per round, plus a summary at session end (`showTokenStats` can disable it); the WebUI composer action bar mirrors a per-turn Token chip (accumulated per iteration while streaming, overwritten by the authoritative summary at run end, persisted with the session and restored after refresh) |
| 🔌 **OpenAI Protocol** | Compatible with any OpenAI-protocol provider (OpenAI, DeepSeek, Moonshot, local vLLM, etc.) |
| 🔀 **Multi-Model & Hot Switching** | Register multiple OpenAI-protocol models with `/model`, then switch with one command via `/model use <alias>` (takes effect on write, zero restarts), with connectivity testing, drift detection and global/workspace layering |
| 📈 **Model Benchmarks** | Connectivity ≠ performance: measure real speed from the backend over SSE — TTFT (first non-empty content chunk), TPOT / ITL p90, pure-decode TPS (main metric), end-to-end TPS, success rate; fixed prompt/max_tokens/temperature:0 for cross-model comparability, prefix cache busted by default with `prompt_cache_hit_tokens` recorded, token counts taken from `usage`, `p90` withheld below 3 samples, gateway-buffered responses flagged, up to 4 models compared serially, history in `~/.loop-agent/model-bench/history.json` (apiKey never stored); **also available from the CLI**: `/model bench [alias…]` shares the same engine and history file with the Web UI, redraws live readouts in place on a TTY, stops only the benchmark on Ctrl+C while keeping collected samples, and `--json` feeds CI |
| 📤 **File Upload** | `/upload` copies local files into a session-isolated upload directory and injects them into the Agent context: supports drag-and-drop (cross-terminal format normalization) and a native file picker with no arguments (Windows / macOS / Linux), ready for the Agent to read on the next turn |
| 🛠️ **Built-in Tools** | Command execution (foreground output keeps both head and tail, elides the middle with a byte count, unified timeout/exit-code semantics so `maxBuffer` no longer fails; `background:true` runs free of the 30s timeout), background task management (commandStatus for status, commandLogs for incremental log reading, commandStop to kill the process tree, with log rotation by retention days/total size), **background completion notices** (when a task finishes, its status/exit code/duration/log tail is injected into the next turn instead of polling; ANSI escapes stripped before injection; if the session is idle when a task finishes, the server wakes a run with a synthetic input to consume the notice proactively — CLI mode keeps passive injection; disable via `tools.backgroundNotify.wakeIdle`), file read (supports line ranges, numbered by default), file write, text editing (editFile: literal/regex/line-range), content search (grep: streaming line scan that keeps only the current line in memory so GB-scale logs are never read whole; files whose first 8000 bytes contain NUL are skipped as binary, same rule as `fileRead`; `crlfDelay` also strips trailing `\r` so end-of-line `$` anchors no longer mismatch on CRLF files; over-long minified lines are clipped to 500 chars around the hit with elided char counts annotated, so a single line cannot blow up the context; scanning stops early at a hard cap of 2000 matches, honestly declaring the persisted result incomplete, and the cap grows with `maxResults`; matches beyond `maxResults` are fully persisted to a temp file with a path and range-read hint), skill activation, sub-task delegation (delegate: hand a self-contained subtask to an independent sub-agent with its own context while sharing project memory; sub-agents cannot delegate further) |
| 👁️ **Vision Understanding** | Integrates multimodal vision models (OpenAI-protocol `image_url` format): four tools for image description / targeted Q&A / structured extraction / OCR; local images auto-converted to base64; LRU result caching and usage stats; `/vision` command for management and connectivity testing |
| 🌐 **MCP Support** | Connect external tool services via the Model Context Protocol (stdio / SSE / Streamable HTTP); tool display names and parameter labels are localized to Chinese automatically (display metadata → Chinese-description extraction → background async LLM translation, cached by content fingerprint; `enabled:false` disables it entirely with no LLM calls) |
| 🧩 **Skills** | SKILL.md spec + progressive loading; the `activate_skill` tool activates domain instructions on demand |
| 🧠 **Three-tier Memory** | L1 Working (compaction above the token threshold: flush extracts notes into L2, then a `kind=summary` placeholder replaces the old window; tail trimming is group-aware so `tool_calls`/`tool` pairs are never split, the current turn's user anchor is always pinned, and summary length is prompt-constrained to 500 characters) / L2 Episodic (daily journal) / L3 Curated (always injected); unified three-view session context: on-disk full history is the single source of truth, in-memory compaction and on-disk restore share one `buildCompactedView` generator — restore yields the most recent N model calls + summary; **hybrid retrieval**: BM25 full-text + vector semantics fused and ranked by RRF (active once `episodic.vectorSearch` is enabled; embedding failures degrade automatically to pure FTS / file keyword matching); **scheduled Dreaming promotion**: `schedule.cron` 5-field expressions (default `0 3 * * *`, server local timezone, "day-of-month" and "day-of-week" restrictions are unioned), hot-reloaded as soon as the file is written with no restart, invalid expressions rejected without disturbing the existing schedule, and the next trigger times previewed while typing |
| 🔧 **Layered Config** | CLI > workspace > global > .env > defaults, with multiple layers of overrides and traceable sources |
| 🧭 **First-run Bootstrap** | On startup, the model config and global/workspace directories are checked automatically: if config is missing, an interactive wizard starts (baseUrl → masked apiKey input → model name → connectivity check → choose write scope) and directories are scaffolded with defaults; `--no-setup` skips it, while `/setup` re-runs it and `/doctor` performs a read-only check inside the REPL |
| 🎛️ **Runtime Config Management** | Built-in basic commands `/help`, `/reset`, `/clear` and `/status`, plus management commands `/config`, `/model`, `/mcp`, `/tools`, `/skill`, `/memory`, `/vision`, `/upload`, `/session`, `/setup` and `/doctor` commands with hot modification and read-only health checks |
| 🖥️ **Web UI** | Open the browser and go: multi-session chat (SSE streaming / stop generation / in-chat upload) plus a config/models/tools/MCP/skills/memory/doctor/**developer center** console, hosted on the same port as `--serve`, reusing the REST endpoints entirely; the tools / skills / MCP servers pages all follow a "card stream + detail drawer" pattern (the skills page adds an install modal and a status matrix, the MCP page an add-server modal with removal-scope confirmation), with the tools page listing built-in tools only and MCP tools managed on the MCP servers page; tool calls render as cards (line icons + Chinese names + argument summaries, four states done/failed/running/aborted, failure reason written straight into the subtitle, one card per tool call, raw JSON tucked into a `{ }` popover); background tasks get their own card (status pill, duration, exit code, expandable log tail, stop with confirmation; polling while running, converging once finished) and background completion notices render as system notice cards (ANSI and `\r` overwrites stripped before injection, logs collapsed by default); **background sub-agents (delegate background) stay visible end to end** — a persistent "running N" indicator with a task list sits above the composer (fed by a 2s polling snapshot, no SSE needed: restored on session load or page refresh), the running trace is flushed incrementally every 8s and shows a live "elapsed Xs · N iterations", and the result card is written back into the timeline with a toast when the task finishes (only when you are viewing that session, so other sessions are not disturbed) — none of it is lost when the main run ends, SSE drops, or the page reloads; the composer is a single card (borderless auto-grow 44→200px, inline-icon tool row, attachment pills, persistent shortcut hint) with **per-session model selection** (switch the model for the current conversation right in the composer; stored in session metadata, restored when you reopen the session, and it never touches the global active model or other sessions); the composer action bar shows a **context-usage percentage ring** (hover for the manual compact entry, with compressible-history preview) and a **per-turn Token chip** (hover expands total input / total output / total tokens / average cache-hit rate, persisted with the session and restored after refresh); the **developer center** (`#/dev`) opens with the API reference as its first module — the endpoint set comes from runtime reflection over `createRoutes()` merged with in-code metadata, endpoints lacking a description are flagged "description pending" and blocked by a unit test, and the page offers grouped browsing / three-way search / method filtering / parameter tables and one-click curl copy, alongside an "Auth & conventions" module and an "SSE events" module; the **file preview area terminal** (full-screen xterm PTY, **on by default** and disabled with `webui.terminal=false`, in which case the WS handshake returns 403; each session keeps a 256KB ring buffer replayed on reconnect within a 60s grace period, closing a tab frees the concurrency slot immediately, and the `terminalDeny` list is enforced server-side with auditing) |
| 🧵 **Cross-Workspace Parallelism** | In HTTP serve mode each workspace owns its session store, config, skills, memory and agent pool, so multiple workspaces run in parallel without blocking each other; the process-level working-directory switch (`process.chdir`) has been removed |
| ⌨️ **Tab Autocompletion** | In the REPL, typing `/con` and pressing Tab completes to `/config`; both commands and subcommands are completable, and multiple candidates are listed automatically |
| ⏹️ **Two-state Ctrl+C** | While the model is answering, Ctrl+C interrupts only the current answer (the streaming request is really cancelled, tool process trees are killed, and the generated content stays in the session so you can keep asking) without exiting the process; when idle you must press it twice within 3 seconds to exit (mis-touch protection); during a y/N confirmation it acts as "cancel", and during Dreaming promotion it force-exits immediately |
| 💾 **Session Persistence** | Conversation history stored with AES-256-GCM encryption; auto-saved across processes / manually restorable; full transcript archiving + throttled snapshots + atomic write via temp-file rename, with a forced snapshot before compaction, so tool calls and window messages survive abnormal process exits |
| 📝 **Debug Logging** | File logs of LLM requests/responses, tool calls and agent iterations, with automatic rotation |
| 🎯 **Event Hooks** | 16 lifecycle hooks, inspired by LangChain callbacks, for easy extension; plus 4 run-level callbacks (`onSnapshot` throttled snapshots, `onSubAgentStart` / `onSubAgentEvent` / `onSubAgentComplete` for background sub-tasks) |
| 💬 **Multi-turn Conversation** | Message history persisted across `run()` calls; context is seamlessly continued |
| ⚡ **Parallel Tools per Round** | Supports multiple `tool_calls` returned in a single round, executed concurrently via `Promise.all` |
| 🛡️ **Failure Isolation** | A single tool failure doesn't affect other tools; a missing tool returns an error Observation so the agent keeps reasoning |
| 🔁 **Auto Retry** | Automatic retry (exponential backoff) for LLM calls on network errors and 429 rate limits |
| 🗣️ **Friendly Errors** | 401/403/404 and similar errors raise clear, actionable messages for fast diagnosis |

---

## 🚀 Quick Start

### 1. Install

```bash
# Clone the repository
git clone <repo-url> loop-agent-command
cd loop-agent-command

# Install dependencies
npm install
```

### 2. Configure

**Option A: Bootstrap wizard (recommended, zero manual config)** — skip this step and run `npm start` directly. On first launch, if no usable model config (apiKey / model name) is detected, a guided wizard starts automatically:

1. Asks for the model service URL (baseUrl), the API Key (input is masked with `*`) and the model name one by one;
2. Runs a connectivity check automatically; on failure you can retry / re-enter / save anyway (the summary is marked with ⚠ unverified);
3. Choose to write to the global config (`~/.loop-agent/config.json`) or the current workspace (`.loop-agent/.agent-config.json`); if the target file exists but is corrupted, it is backed up as `.bak-<timestamp>` before writing;
4. Skills and other directories are scaffolded with defaults, then you go straight into the chat.

Later you can re-run the wizard with `/setup` (`--global` / `--workspace` to choose the write scope) or run a read-only check with `/doctor` in the REPL.

**Option B: Manual .env config** — copy `.env.example` to `.env` and fill in your configuration:

```bash
# macOS / Linux
cp .env.example .env
```

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```bat
:: Windows CMD
copy .env.example .env
```

```env
# OpenAI API Key (required)
OPENAI_API_KEY=sk-xxx

# OpenAI-protocol Base URL (optional, defaults to https://api.openai.com/v1)
# Switch to DeepSeek: https://api.deepseek.com/v1
# Switch to Moonshot: https://api.moonshot.cn/v1
OPENAI_BASE_URL=https://api.openai.com/v1

# Model name (optional, defaults to gpt-4o-mini)
# Note: MODEL_NAME must belong to the same provider as OPENAI_BASE_URL above
#   OpenAI   -> gpt-4o-mini
#   DeepSeek -> deepseek-chat (also set Base URL to https://api.deepseek.com/v1)
#   Moonshot -> moonshot-v1-8k (also set Base URL to https://api.moonshot.cn/v1)
MODEL_NAME=gpt-4o-mini

# Max agent iterations (optional, defaults to 100)
MAX_ITERATIONS=100

# Debug logging (optional, off by default; when enabled, outputs to ~/.loop-agent/logs)
DEBUG=true
```

### 3. Run

```bash
# 🎮 CLI interactive mode (the bootstrap wizard starts automatically when config is missing on first launch)
npm start

# ⏭️ Skip bootstrap detection and the wizard
npm start -- --no-setup

# 🌐 Start the HTTP server + Web UI (hosted on the same port; open http://127.0.0.1:3000/)
npm run serve

# 🔁 Watch-mode development (auto-restart on source changes)
npm run dev

# 📝 Programmatic usage example
npx tsx examples/run.ts

# 🧪 Tests (unit layer: 161 test files / 2020 cases, run in parallel)
npm test

# 🧪 Integration tests (real PTY and other slow cases, run serially)
npm run test:integration

# 🧪 Full test suite (unit + integration, for pushes or CI)
npm run test:full

# 🔁 Watch mode tests (unit layer)
npm run test:watch

# 🎯 Run only tests related to changed files
npm run test:related

# ✅ Type check
npm run typecheck

# 📦 Build (output to dist/)
npm run build

# 🚀 Build a SEA single executable (output to dist-sea/, see the section below)
npm run build:sea

# 🖥️ Build the Web UI frontend (output webui/dist/; not committed — build once after cloning)
npm run build:webui
```

---

## 📚 Documentation

Each section's details have been split into [docs/readme/en/](docs/readme/en/) (Chinese version in [docs/readme/zh/](docs/readme/zh/)):

| Doc | Description |
|---|---|
| [📖 CLI Usage](docs/readme/en/cli-usage.md) | REPL interaction, the basic commands `/help` `/reset` `/clear` `/status`, and management commands: `/config` `/mcp` `/tools` `/session` `/skill` `/memory` `/vision` `/model` `/upload` `/setup` `/doctor` |
| [💻 Programmatic Usage](docs/readme/en/programmatic-usage.md) | `agent.run()` single/multi-turn examples, session persistence and custom event listeners |
| [🌐 HTTP API Service (--serve)](docs/readme/en/http-api.md) | Starting the HTTP service, auth configuration, REST endpoints and SSE event stream |
| [🖥️ Web UI](docs/readme/en/web-ui.md) | Browser interface: how to start it, token auth, an overview of the nine views (including the developer center) and frontend development |
| [🏗️ Architecture](docs/readme/en/architecture.md) | Layered architecture diagram, ReAct loop flow and layered config loading |
| [🔧 Built-in Tools](docs/readme/en/built-in-tools.md) | Parameter docs and call examples for the 14 built-in tools (10 core + 4 vision) |
| [🧩 Tool Extension](docs/readme/en/tool-extension.md) | Writing custom tools and connecting external MCP tools (five ways) |
| [🎯 Skills](docs/readme/en/skills.md) | SKILL.md spec, directory structure and progressive loading workflow |
| [⚙️ Configuration](docs/readme/en/configuration.md) | Config layers, full config structure, environment variables and the runtime `/config` command |
| [🎧 Event Listeners](docs/readme/en/event-listeners.md) | 16 lifecycle hooks, 4 run-level callbacks (throttled snapshots / sub-agent progress) and a multi-listener stacking example |
| [💬 Multi-turn Conversation](docs/readme/en/multi-turn-conversation.md) | Message history persistence rules across `run()` calls with examples |
| [💾 Session Persistence](docs/readme/en/session-persistence.md) | Encrypted storage structure, auto-save/restore and key management |
| [🧠 Memory Management](docs/readme/en/memory-management.md) | L1/L2/L3 memory tiers, Promotion Gate and Dreaming |
| [📊 LLM Token Stats](docs/readme/en/llm-token-stats.md) | Per-round and session-level token stats output |
| [📝 Debug Logging](docs/readme/en/debug-logging.md) | How to enable it, log location/rotation and what gets logged |
| [📁 Project Structure](docs/readme/en/project-structure.md) | Source tree and module responsibilities |
| [🛠️ Tech Stack](docs/readme/en/tech-stack.md) | Language / runtime / SDK / toolchain choices |
| [🏗️ Development](docs/readme/en/development.md) | Development, build, typecheck and test commands |
| [🚀 SEA Single-file Deployment](docs/readme/en/sea-deployment.md) | Building and running the single executable, and field notes |
| [🖥 Desktop App](docs/readme/en/desktop.md) | Windows installer and portable build: install, no-UAC rationale, first-run SmartScreen, uninstall and data location, packaging |
| [🔍 Troubleshooting](docs/readme/en/troubleshooting.md) | Common error messages and fixes |

---

## 📄 License

[MIT](LICENSE) © 2026

---

<div align="center">
  <sub>Built with ❤️ using TypeScript</sub>
</div>
