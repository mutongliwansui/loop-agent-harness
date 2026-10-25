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
| 📊 **Token Stats** | Prints context/input/output tokens and cache hit rate per round, plus a summary at session end (`showTokenStats` can disable it) |
| 🔌 **OpenAI Protocol** | Compatible with any OpenAI-protocol provider (OpenAI, DeepSeek, Moonshot, local vLLM, etc.) |
| 🔀 **Multi-Model & Hot Switching** | Register multiple OpenAI-protocol models with `/model`, then switch with one command via `/model use <alias>` (takes effect on write, zero restarts), with connectivity testing, drift detection and global/workspace layering |
| 📤 **File Upload** | `/upload` copies local files into a session-isolated upload directory and injects them into the Agent context: supports drag-and-drop (cross-terminal format normalization) and a native file picker with no arguments (Windows / macOS / Linux), ready for the Agent to read on the next turn |
| 🛠️ **Built-in Tools** | Command execution (foreground / `background:true`), background task management (commandStatus for status, commandLogs for incremental log reading, commandStop to kill the process tree), file read (supports line ranges, numbered by default), file write, text editing (editFile: literal/regex/line-range), content search (grep), skill activation |
| 👁️ **Vision Understanding** | Integrates multimodal vision models (OpenAI-protocol `image_url` format): four tools for image description / targeted Q&A / structured extraction / OCR; local images auto-converted to base64; LRU result caching and usage stats; `/vision` command for management and connectivity testing |
| 🌐 **MCP Support** | Connect external tool services via the Model Context Protocol (stdio / SSE / Streamable HTTP) |
| 🧩 **Skills** | SKILL.md spec + progressive loading; the `activate_skill` tool activates domain instructions on demand |
| 🧠 **Three-tier Memory** | L1 Working (compaction above the token threshold: flush extracts notes into L2, then a `kind=summary` placeholder replaces the old window; tail trimming is group-aware so `tool_calls`/`tool` pairs are never split, the current turn's user anchor is always pinned, and summary length is prompt-constrained to 500 characters) / L2 Episodic (daily journal) / L3 Curated (always injected); unified three-view session context: on-disk full history is the single source of truth, in-memory compaction and on-disk restore share one `buildCompactedView` generator — restore yields the recent N turns + summary |
| 🔧 **Layered Config** | CLI > workspace > global > .env > defaults, with multiple layers of overrides and traceable sources |
| 🧭 **First-run Bootstrap** | On startup, the model config and global/workspace directories are checked automatically: if config is missing, an interactive wizard starts (baseUrl → masked apiKey input → model name → connectivity check → choose write scope) and directories are scaffolded with defaults; `--no-setup` skips it, while `/setup` re-runs it and `/doctor` performs a read-only check inside the REPL |
| 🎛️ **Runtime Config Management** | Built-in `/config`, `/mcp`, `/tools`, `/skill`, `/memory`, `/vision` commands with hot modification |
| 🖥️ **Web UI** | Open the browser and go: multi-session chat (SSE streaming / stop generation / in-chat upload) plus a config/models/tools/MCP/skills/memory/doctor console, hosted on the same port as `--serve`, reusing the REST endpoints entirely; tool calls render as cards (line icons + Chinese names + argument summaries, four states done/failed/running/aborted, failure reason written straight into the subtitle, consecutive same-tool calls merged as `×N`, raw JSON tucked into a `{ }` popover); the composer is a single card (borderless auto-grow 44→200px, inline-icon tool row, attachment pills, persistent shortcut hint) with **per-session model selection** (switch the model for the current conversation right in the composer; stored in session metadata, restored when you reopen the session, and it never touches the global active model or other sessions) |
| 🧵 **Cross-Workspace Parallelism** | In HTTP serve mode each workspace owns its session store, config, skills, memory and agent pool, so multiple workspaces run in parallel without blocking each other; the process-level working-directory switch (`process.chdir`) has been removed |
| ⌨️ **Tab Autocompletion** | In the REPL, typing `/con` and pressing Tab completes to `/config`; both commands and subcommands are completable, and multiple candidates are listed automatically |
| 💾 **Session Persistence** | Conversation history stored with AES-256-GCM encryption; auto-saved across processes / manually restorable; full transcript archiving + throttled snapshots + atomic write via temp-file rename, with a forced snapshot before compaction, so tool calls and window messages survive abnormal process exits |
| 📝 **Debug Logging** | File logs of LLM requests/responses, tool calls and agent iterations, with automatic rotation |
| 🎯 **Event Hooks** | 16 lifecycle hooks, inspired by LangChain callbacks, for easy extension |
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

# 📝 Programmatic usage example
npx tsx examples/run.ts

# 🧪 Tests (7 integration cases + unit tests for memory/session/stats; run serially to avoid API rate limits)
npm test

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
| [📖 CLI Usage](docs/readme/en/cli-usage.md) | REPL interaction and built-in commands: `/config` `/mcp` `/tools` `/session` `/skill` `/memory` `/vision` `/model` `/upload` `/setup` `/doctor` |
| [💻 Programmatic Usage](docs/readme/en/programmatic-usage.md) | `agent.run()` single/multi-turn examples, session persistence and custom event listeners |
| [🌐 HTTP API Service (--serve)](docs/readme/en/http-api.md) | Starting the HTTP service, auth configuration, REST endpoints and SSE event stream |
| [🖥️ Web UI](docs/readme/en/web-ui.md) | Browser interface: how to start it, token auth, an overview of the eight views and frontend development |
| [🏗️ Architecture](docs/readme/en/architecture.md) | Layered architecture diagram, ReAct loop flow and layered config loading |
| [🔧 Built-in Tools](docs/readme/en/built-in-tools.md) | Parameter docs and call examples for the 10 built-in tools |
| [🧩 Tool Extension](docs/readme/en/tool-extension.md) | Writing custom tools and connecting external MCP tools (five ways) |
| [🎯 Skills](docs/readme/en/skills.md) | SKILL.md spec, directory structure and progressive loading workflow |
| [⚙️ Configuration](docs/readme/en/configuration.md) | Config layers, full config structure, environment variables and the runtime `/config` command |
| [🎧 Event Listeners](docs/readme/en/event-listeners.md) | 16 lifecycle hooks and multi-listener stacking example |
| [💬 Multi-turn Conversation](docs/readme/en/multi-turn-conversation.md) | Message history persistence rules across `run()` calls with examples |
| [💾 Session Persistence](docs/readme/en/session-persistence.md) | Encrypted storage structure, auto-save/restore and key management |
| [🧠 Memory Management](docs/readme/en/memory-management.md) | L1/L2/L3 memory tiers, Promotion Gate and Dreaming |
| [📊 LLM Token Stats](docs/readme/en/llm-token-stats.md) | Per-round and session-level token stats output |
| [📝 Debug Logging](docs/readme/en/debug-logging.md) | How to enable it, log location/rotation and what gets logged |
| [📁 Project Structure](docs/readme/en/project-structure.md) | Source tree and module responsibilities |
| [🛠️ Tech Stack](docs/readme/en/tech-stack.md) | Language / runtime / SDK / toolchain choices |
| [🏗️ Development](docs/readme/en/development.md) | Development, build, typecheck and test commands |
| [🚀 SEA Single-file Deployment](docs/readme/en/sea-deployment.md) | Building and running the single executable, and field notes |
| [🔍 Troubleshooting](docs/readme/en/troubleshooting.md) | Common error messages and fixes |

---

## 📄 License

[MIT](LICENSE) © 2026

---

<div align="center">
  <sub>Built with ❤️ using TypeScript</sub>
</div>
