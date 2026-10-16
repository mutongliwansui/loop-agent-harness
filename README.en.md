# 🤖 ReAct Agent

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20.10+-339933?style=flat-square&logo=node.js)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)]()

**An intelligent agent built on the ReAct (Reasoning + Acting) framework**, connecting to large language models via the OpenAI protocol, invoking tools through **Function Calling**, and written in **TypeScript**.

> 🧠 **Core idea**: a **Thought → Action → Observation** reasoning loop — "think, act, observe" like a human, solving problems step by step until a final answer is reached.

[✨ Features](#-features)
[🚀 Quick Start](#-quick-start)
[📖 CLI Usage](#-cli-usage)
[💻 Programmatic Usage](#-programmatic-usage)
[🏗️ Architecture](#️-architecture)
[🔧 Built-in Tools](#-built-in-tools)
[🧩 Tool Extension](#-tool-extension)
[🎯 Skills](#-skills)
[⚙️ Configuration Management](#️-configuration-management)
[🎧 Event Listeners](#-event-listeners)
[💬 Multi-turn Conversation](#-multi-turn-conversation)
[💾 Session Persistence](#-session-persistence)
[🧠 Memory Management](#-memory-management)
[📊 LLM Token Stats](#-llm-token-stats)
[📝 Debug Logging](#-debug-logging)
[📁 Project Structure](#-project-structure)
[🛠️ Tech Stack](#️-tech-stack)
[🚀 SEA Single-file Deployment](#-sea-single-file-deployment)
[🔍 Troubleshooting](#-troubleshooting)

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
| � **File Upload** | `/upload` copies local files into a session-isolated upload directory and injects them into the Agent context: supports drag-and-drop (cross-terminal format normalization) and a native file picker with no arguments (Windows / macOS / Linux), ready for the Agent to read on the next turn |
| �️ **Built-in Tools** | Command execution, file read (supports line ranges, numbered by default), file write, text editing (editFile: literal/regex/line-range), content search (grep), skill activation |
| 👁️ **Vision Understanding** | Integrates multimodal vision models (OpenAI-protocol `image_url` format): four tools for image description / targeted Q&A / structured extraction / OCR; local images auto-converted to base64; LRU result caching and usage stats; `/vision` command for management and connectivity testing |
| 🌐 **MCP Support** | Connect external tool services via the Model Context Protocol (stdio / SSE / Streamable HTTP) |
| 🧩 **Skills** | SKILL.md spec + progressive loading; the `activate_skill` tool activates domain instructions on demand |
| 🧠 **Three-tier Memory** | L1 Working (token compaction) / L2 Episodic (daily journal) / L3 Curated (always injected) |
| 🔧 **Layered Config** | CLI > workspace > global > .env > defaults, with multiple layers of overrides and traceable sources |
| 🧭 **First-run Bootstrap** | On startup, the model config and global/workspace directories are checked automatically: if config is missing, an interactive wizard starts (baseUrl → masked apiKey input → model name → connectivity check → choose write scope) and directories are scaffolded with defaults; `--no-setup` skips it, while `/setup` re-runs it and `/doctor` performs a read-only check inside the REPL |
| 🎛️ **Runtime Config Management** | Built-in `/config`, `/mcp`, `/tools`, `/skill`, `/memory`, `/vision` commands with hot modification |
| 💾 **Session Persistence** | Conversation history stored with AES-256-GCM encryption; auto-saved across processes / manually restorable |
| 📝 **Debug Logging** | File logs of LLM requests/responses, tool calls and agent iterations, with automatic rotation |
| 🎯 **Event Hooks** | 15 lifecycle hooks, inspired by LangChain callbacks, for easy extension |
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
cp .env.example .env
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

# Max agent iterations (optional, defaults to 10)
MAX_ITERATIONS=10

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
```

---

## 📖 CLI Usage

```bash
npm start
```

Launching it enters an interactive REPL console:

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃            ReAct Agent Interactive Console               ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

Model: gpt-4o-mini (workspace)
BaseURL: https://api.openai.com/v1 (env)
Max iterations: 10
Built-in tools: [commandRun, fileRead, fileWrite, editFile, grep, activate_skill]
MCP tools: 3, Servers: atlasGraphMcp (atlasGraphMcp__toolName)
Skills: 2 (example-skill, py-pptx)
⚠ Debug mode enabled, logs output to: ~/.loop-agent/logs

Agent> Read the version from package.json
```

> If `agent.debug` is enabled, the startup banner additionally shows the debug log directory (see [📝 Debug Logging](#-debug-logging)).

> During execution, loading indicators (e.g. "Thinking… (round N)", "Generating args: fileWrite… (12.3KB / 8s)", "Running: grep…") are shown in time-consuming phases such as model generation (especially tool-call arguments) and tool execution, so waits give real-time feedback. Before printing logs / streamed Thought / the final answer, the indicator line is cleared first, so the two never mix. The indicator is only enabled in an interactive TTY; it is automatically disabled and produces zero output in pipes, redirects and CI environments.

### Built-in Commands

| Command | Description |
|---|---|
| `type a question` | The agent streams Thought / Action / Observation / Final |
| `/help` | Show global help; append `help` to any command (e.g. `/mcp help`) to see its subcommand usage |
| `/reset` `/clear` | Clear the multi-turn conversation history and start a new session |
| `/status` | Show the current session status (messages / tools / MCP tools / Skills) |
| `/tools` | Tool management (list / enable / disable / reload) |
| `/config` | Config management (get / set / delete / list / path) |
| `/mcp` | MCP management (list / add / remove / reload / test / view) |
| `/session` | Session management (list / load / save / new / current / delete / delete-all) |
| `/skill` | Skill management (list / reload / show / upload / remove) |
| `/memory` | Memory management (status / curated / episodic / search / dream / gate / init) |
| `/vision` | Vision model management (status / test) |
| `/model` | Multi-model management (list / use / add / remove / test) |
| `/upload` | File upload (copies into the session-isolated upload directory and injects into Agent context; list / clean) |
| `/setup` | Re-run the bootstrap config wizard (--global / --workspace to choose the write scope) |
| `/doctor` | Startup health check: verifies model config / config files / skills directories item by item (read-only) |
| `exit` / `quit` / `退出` | Exit the program (Ctrl+C also works) |

> **Subcommand help**: append `help` (or the shorthand `-h` / `--help`) to any command to see its subcommand usage, e.g. `/mcp help`, `/skill help`, `/config help` — no need to remember the global `/help`.
>
> **Tab completion**: press `Tab` to complete commands (`/con` → `/config`), subcommands (`/config ` → list / get / set / …) and dynamic arguments (session ids, tool names, skill names, MCP server names, model aliases, and **config keys** for `/config get|set|delete`, e.g. `model.name` / `vision.enabled`).

### Output Example

```
━━━ Iteration 1/10 ━━━

[Thought] I need to read the package.json file to get the version...

[Action] fileRead({"path":"package.json"})
[Observation]
  1: {
  2:   "name": "loop-agent-command",
  3:   "version": "0.1.0",
  4:   ...
  5: }

━━━ Final Answer ━━━
The project is named loop-agent-command with version 0.1.0.

━━━ Done (1 round, 1 step) ━━━
```

### CLI Command Details

#### `/config` — Config Management

Reads/writes configuration at two levels: workspace (default) and global.

```
/config list                    # Show the effective config (with a source tag per field)
/config get <key>               # Show one config item (e.g. model.name)
/config set <key> <value>       # Set a config item (written to the workspace by default)
/config set <key> <value> --global  # Write to the global config
/config delete <key>            # Delete a config item
/config path                    # Show the config file path
```

Values are auto-typed: `true`/`false` become booleans, numbers become Numbers, and `{...}` or `[...]` are parsed as JSON.

#### `/mcp` — MCP Management

```
/mcp list                       # List all MCP server configs and connection status
/mcp add <name>                 # Interactively add a new MCP server
/mcp remove <name>              # Remove the specified MCP server
/mcp reload                     # Reload all MCP config
/mcp test <name>                # Test the connection to the specified MCP server
/mcp view <name>                # Show the server info and its tool list
/mcp help                       # Show the subcommand usage of /mcp
```

> `/mcp view <name>` shows the server name, transport config, connection status and the list of tools it provides (tool name + description): for a connected server it reads the already-registered tools directly (zero overhead); for a disconnected one it connects temporarily to query and then disconnects automatically (same pattern as `/mcp test`), so no prior `/mcp reload` is needed.

#### `/tools` — Tool Management

```
/tools list                     # List all registered tools (built-in + MCP)
/tools enable <name>            # Enable a built-in tool
/tools disable <name>           # Disable a built-in tool
/tools reload                   # Reload all tools
```

#### `/session` — Session Management

```
/session list                   # List all sessions in the current workspace (ID / title / msg count / time)
/session current                # Show details of the current session
/session load <id>              # Load the specified session and restore its history
/session save                   # Manually save the current session
/session new                    # Create a new session (the old one is auto-saved)
/session delete <id>            # Delete the specified session
/session delete-all             # Delete all sessions in the current workspace (requires confirmation)
```

Example session list output:

```
Sessions in current workspace (2):
  sess_20260806_143022 [current] 2026/08/06 14:30:22 [5 msgs] Read the version from package.json
  sess_20260805_210011           2026/08/05 21:00:11 [3 msgs] Search for config in the src directory
```

Session data is stored with AES-256-GCM encryption under `~/.loop-agent/sessions/` (isolated by workspace). See [💾 Session Persistence](#-session-persistence).

#### `/skill` — Skill Management

```
/skill list                     # List all available Skills (global + workspace, with source tags)
/skill reload                   # Rescan the Skill directories
/skill show <name>              # Show the full SKILL.md content of the specified Skill
/skill upload <dirs...>         # Install local Skill directories (workspace by default; --global for global; asks before overwriting name conflicts)
/skill upload                   # No args: open the native directory picker (auto-detects available tools on Windows/macOS/Linux)
/skill remove <names...>        # Remove installed Skills (workspace first by default; --global/--workspace to restrict; per-item y/N confirmation)
```

Skills are auto-scanned from the global `~/.loop-agent/skills/` and the workspace `<cwd>/.loop-agent/skills/` directories; the workspace version takes precedence when names collide. See [🎯 Skills](#-skills).

`/skill upload` supports dragging directories into the terminal (quoted paths / `file://` URIs are normalized automatically) and batch installation of multiple directories. Each target is validated for a proper `SKILL.md` (name/description) before installation, a single failure does not block the rest, and Skills are rescanned automatically after installation.

`/skill remove` locates Skills by frontmatter `name` and deletes the entire Skill directory: when the same name exists in both scopes, the workspace one is removed by default (`--global` / `--workspace` restrict to a single scope), each deletion requires confirmation (default N), and a path guard rejects targets that are not direct children of the skills root (path-traversal protection). After removal, Skills are rescanned automatically and disappear from `/skill list` immediately. Batch removal is supported; a single failure does not block the rest.

#### `/memory` — Memory Management

```
/memory status                          # Show memory system status (L1/L2/L3 stats)
/memory curated list                    # List L3 core memory files (SOUL / USER / MEMORY)
/memory curated read <soul|user|memory> # Read the specified core memory file
/memory curated append <key> <content>  # Append a fact to a core memory file
/memory episodic list                   # List L2 episodic memory logs (by day)
/memory episodic read <YYYY-MM-DD>      # Read the episodic memory for a given date
/memory search <keyword>                # Search L2 episodic memory (returns relevant snippets)
/memory dream [days]                    # Manually trigger a Dreaming pass (promote L2 → L3)
/memory gate                            # Show Promotion Gate pending/eligible facts
/memory init                            # Initialize the L3 core memory files
```

See [🧠 Memory Management](#-memory-management).

#### `/vision` — Vision Model Management

```
/vision status                  # Show the vision model config (enabled state / triplet source tags / masked apiKey / cache stats / session cumulative stats)
/vision test                    # Run a connectivity test with a 1x1 PNG (verifies baseUrl / apiKey / model)
```

When the vision triplet (`vision.baseUrl` / `vision.apiKey` / `vision.model`) is empty, it automatically falls back to the main model's `model.*` values — zero duplicated config for multiple models of the same provider. To enable:

```
/config set vision.enabled true    # takes effect immediately: vision tools are auto-registered (auto-unregistered on false/delete), no /tools reload needed
/config set vision.model gpt-4o    # falls back to model.name when unset
```

Once enabled, four vision tools are registered: `describe_image` (whole-image description), `ask_image` (targeted Q&A), `extract_json` (structured extraction) and `ocr_image` (text recognition). See [🔧 Built-in Tools](#-built-in-tools).

#### `/model` — Multi-Model & Hot Switching

Register multiple OpenAI-protocol models into the registry (`models.profiles`, keyed by alias) and switch the effective model (the `model.*` snapshot) with a single alias command — takes effect on write, no restart needed:

```
/model list                  # List the registry and the effective snapshot (masked apiKey, drift hints)
/model use <alias>           # Switch to a registered model (syncs the active pointer and snapshot, effective immediately)
/model use <alias> --global  # Switch the global layer; conflicting workspace keys can be cleaned interactively
/model add <alias>           # Register a new model (interactive scope prompt, Enter defaults to workspace)
/model add <alias> --global  # Register into the global layer (explicit flag skips the scope prompt)
/model remove <alias>        # Remove a model from the registry (does not touch the effective snapshot)
/model test <alias>          # Run a connectivity test on a registered model (does not change the active state)
```

Design notes:

- **Registry + active pointer**: `models.profiles` is a pure registry, `models.active` points to the currently active alias; `/model use` writes both the active pointer and the `model.*` effective snapshot — the runtime only reads `model.*`, so the main model, the vision fallback triplet and the memory system (Dreaming / compaction) all follow the new model.
- **Layer merging**: the registry is deep-merged layer by layer (global → workspace; workspace leaves win for the same alias); models without a registered `temperature` do not override the current sampling temperature when switched to.
- **Drift detection**: `/model list` and the startup banner compare the active alias against the effective snapshot (name + baseUrl only; apiKey rotation is not drift) and suggest `/model use <alias>` to re-sync when they differ.
- **Wizard integration**: when the first-launch wizard writes a model and the registry is empty, the model is auto-registered as the `default` alias, so a later `/model use default` switches right back.

Config example (workspace `.loop-agent/.agent-config.json`):

```json
{
  "models": {
    "active": "deepseek",
    "profiles": {
      "deepseek": {
        "name": "deepseek-chat",
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKey": "sk-yyy"
      },
      "glm": {
        "name": "glm-4.7",
        "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
        "apiKey": "sk-zzz"
      }
    }
  }
}
```

#### `/upload` — File Upload (Session-Isolated Upload Directory)

Copies local files into the Agent's global upload directory (`~/.loop-agent/uploads/{sessionId}/`) and injects the uploaded paths into the current session context — the Agent automatically "knows" the files in subsequent turns and can process them directly with `fileRead` / `commandRun` / vision tools, no manual path recital needed:

```
/upload <paths...>        # Upload one or more files (drag into the terminal; quoted paths are parsed automatically)
/upload                   # No args: open the native file picker (multi-select; auto-detects available tools on Windows/macOS/Linux)
/upload list              # List files uploaded in the current session
/upload clean             # Clean the current session's upload directory (y/n confirm)
```

Design notes:

- **Session isolation**: directories are physically separated per session (`uploads/{sessionId}/`); `/session delete` / `delete-all` clean up the matching upload directory; sessions cannot see each other's files, and the workspace git tree stays untouched
- **Agent awareness**: each successful upload injects a `[File Upload]` context message (path + size), persisted with autoSave and restored via `/session load`; uploads never trigger an answer by themselves — uploading is a preparation step
- **Cross-platform normalization**: terminals drag-drop in different formats (Windows quoted paths / Linux GNOME `file://` URIs / Konsole escaped spaces), all unified into local paths; the no-arg picker probes `PowerShell + WinForms` / `osascript` / `zenity → kdialog → yad` per platform, and gracefully falls back to drag-and-drop / path arguments when none is available
- **Collision & limits**: filenames get a timestamp prefix to avoid overwrites; 100MB per-file cap; directories are not supported (prompt suggests compressing first)
- **Zero dependencies**: only `node:fs` / `node:child_process`, no new npm packages

#### `/setup` — Re-run the Bootstrap Wizard

Re-runs the first-launch config wizard inside the REPL with the same flow: baseUrl → apiKey (masked input) → model name → connectivity check → choose write scope. When it finishes, the config is reloaded and tool registration is refreshed immediately, so the following conversation takes effect without a restart:

```
/setup                     # without a scope flag, the wizard's default suggestion applies
/setup --global            # write to the global config ~/.loop-agent/config.json
/setup --workspace         # write to the workspace config .loop-agent/.agent-config.json
```

If the target file exists but is corrupted (invalid JSON), it is backed up as `.bak-<timestamp>` before writing.

#### `/doctor` — Startup Health Check

Read-only check of whether the current environment is ready for normal conversation, with a three-state report per item (✓ ok / ✗ blocker / ! warning). It never modifies any file:

```
/doctor
Startup health check report

  ✓ Main model apiKey
  ✓ Main model name
  ✗ Global config file: <reason> (auto-created on first config write)
  ! Global skills directory: <reason> → ~/.loop-agent/skills
  ……

  ✓ 0 blockers, main model config is ready for conversation
  This command is read-only and never modifies any file
```

There are 6 check items in total: main model apiKey, main model name, global config file, workspace config file, global skills directory and workspace skills directory; ✗ items come with a fix hint (e.g. "run /setup to reconfigure").

---

## 💻 Programmatic Usage

### Basic Single-turn Call

```typescript
import { agent } from './src/agent/react-agent.js';
import { registerBuiltinTools } from './src/tools/index.js';

// Register built-in tools (only needed once per process)
registerBuiltinTools();

// Single call
const result = await agent.run('Read the version from package.json', {
  verbose: true,       // Output Thought/Action/Observation logs
  resetHistory: true,  // Clear history and start a new session
});

console.log(result.answer);
console.log(`Iterations: ${result.iterations}, Steps: ${result.steps.length}`);
```

### Multi-turn Conversation

```typescript
// Turn 1: read package.json
const r1 = await agent.run('What is the project name in package.json?', {
  resetHistory: true,
  verbose: false,
});
console.log(r1.answer);

// Turn 2 — history context is reused automatically; no need to pass messages explicitly
const r2 = await agent.run('And what is its version?');
// The agent already knows package.json's content and can answer directly without calling tools again
console.log(r2.answer);
```

### Session Persistence

```typescript
import { agent } from './src/agent/react-agent.js';
import { SessionStore } from './src/session/index.js';
import { registerBuiltinTools } from './src/tools/index.js';

registerBuiltinTools();

// Initialize the session store (isolated by the current workspace path)
const sessionStore = new SessionStore(process.cwd());
await sessionStore.init();
agent.setSessionStore(sessionStore);

// If session.autoSave=true, a session is created/updated automatically after run()
const result = await agent.run('Read package.json', {
  resetHistory: true,
  verbose: true,
});
console.log(`Session ID: ${agent.currentSessionId}`);
```

### Custom Event Listeners

```typescript
import { agent } from './src/agent/react-agent.js';
import type { AgentEvents } from './src/types.js';

// Custom listener
const myListener: AgentEvents = {
  onToolStart: (tool, args) => {
    console.log(`[🔧 Tool start] ${tool}`, args);
  },
  onToolEnd: (tool, result) => {
    console.log(`[✅ Tool done] ${tool} → ${result.slice(0, 100)}...`);
  },
  onFinal: (answer) => {
    console.log(`[🎯 Final answer] ${answer}`);
  },
};

const result = await agent.run('Search for config in the src directory', {
  verbose: false,
  events: [myListener],
});
```

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                         CLI / API                            │
│                     (src/index.ts)                           │
├──────────────────────────────────────────────────────────────┤
│                      ReAct Agent                             │
│                    (react-agent.ts)                          │
│   ┌──────────────┐  ┌───────────────┐  ┌────────────────┐  │
│   │ System Prompt │  │  Event System │  │  ChatHistory   │  │
│   │  (prompt.ts)  │  │  (logger.ts)  │  │ (multi-turn)   │  │
│   └──────────────┘  └───────────────┘  └────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                     LLM Client                               │
│                   (llm/client.ts)                            │
│          chat() / chatStream() + auto-retry (backoff)       │
├──────────────────────────────────────────────────────────────┤
│                     Tool System                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Registry    │  │   Runner     │  │  MCP Adapter     │  │
│  │ (register/   │  │ (execute/    │  │ (external tool   │  │
│  │  query)      │  │  timeout)    │  │  adaptation)     │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                  Configuration System                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  ConfigLoader│  │  ConfigWriter│  │  MCPManager      │  │
│  │ (layered     │  │ (persistence)│  │ (lifecycle mgmt) │  │
│  │  loading)    │  │              │  │                  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                     Skill System                            │
│    scanner (scan) │ loader (load) │ activate_skill tool     │
├──────────────────────────────────────────────────────────────┤
│                     Memory System                           │
│    Working(L1) │ Episodic(L2) │ Curated(L3) │ Callback     │
├──────────────────────────────────────────────────────────────┤
│                   Session System                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ SessionStore │  │   Keychain   │  │  Crypto (AES-GCM)│  │
│  │ (read/write) │  │ (key mgmt)   │  │  (encrypt/decrypt)│ │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                   Built-in Tools                             │
│ commandRun │ fileRead │ fileWrite │ grep │ activateSkill    │
└──────────────────────────────────────────────────────────────┘
```

### ReAct Loop Flow

```
  ┌─────────────────────────────────────────────────────┐
  │  1. Build messages (system + user, or reuse history) │
  └────────────────────┬────────────────────────────────┘
                       │
                       ▼
  ┌─────────────────────────────────────────────────────┐
  │  2. Stream-call the LLM (chatStream)                 │
  │     Real-time Thought via events.onLLMStream         │
  └────────────────────┬────────────────────────────────┘
                       │
                       ▼
  ┌─────────────────────────────────────────────────────┐
  │  3. Get the full LLMResponse after the stream ends   │
  └────────────────────┬────────────────────────────────┘
                       │
                       ▼
          ┌────────────────────────────┐
          │  4. Check tool_calls       │
          │                            │
          │   ┌─── no tool_calls ──┐   │
          │   │ Return content as  │   │
          │   │   Final Answer     │   │
          │   └────────────────────┘   │
          │                            │
          │   ┌─── has tool_calls ─┐   │
          │   │ Run all tools      │   │
          │   │ concurrently;      │   │
          │   │ concatenate        │   │
          │   │ Observations back  │   │
          │   │ into messages      │   │
          │   └────────┬───────────┘   │
          └────────────┼───────────────┘
                       │
                       ▼
          ┌────────────────────────────┐
          │  5. Back to step 2, keep    │
          │     iterating               │
          └────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          │  6. Max iterations       │
          │  reached → throw error,  │
          │  exit gracefully         │
          └─────────────────────────┘
```

> After `run()` completes, if a session store is configured (`session.autoSave=true`), the current messages and steps are automatically encrypted and saved to disk.

### Layered Config Loading

```
Load priority (high → low):
  CLI args > workspace config (.loop-agent/.agent-config.json)
           > global config (~/.loop-agent/config.json)
           > environment variables (.env)
           > defaults (DEFAULT_CONFIG)
```

---

## 🔧 Built-in Tools

| Tool | Name | Description | Parameters |
|---|---|---|---|
| 🖥️ **Command Execution** | `commandRun` | Execute a shell command locally, returning stdout + stderr | `command` (required), `cwd` (optional), `timeout` (optional, defaults to 30000ms) |
| 📄 **File Read** | `fileRead` | Read file content; supports reading a line range; each line is prefixed with `line: ` by default | `path` (required), `startLine` (optional), `endLine` (optional), `encoding` (optional), `lineNumbers` (optional, defaults to `true`) |
| ✏️ **File Write** | `fileWrite` | **Whole-file write**: `overwrite` fully replaces the entire file with `content` (**the original content is permanently lost; partial/regional overwrite is NOT supported — use `editFile` for partial edits**); `append` appends to the end; parent directories are created automatically | `path` (required), `content` (required; the complete file content when overwriting), `mode` (optional, `overwrite` / `append`) |
| 🔁 **File Edit** | `editFile` | Three modes: ① literal replacement (must appear exactly once; multiple matches error out to avoid accidental edits); ② `regex=true` regex replacement (supports `$1`/`$&` capture references); ③ whole-line-range replacement when `startLine`/`endLine` are given | `path` (required), `newText` (required), `oldText` (required unless a line range is given), `startLine` (optional), `endLine` (optional), `replaceAll` (optional, defaults to `false`), `regex` (optional, defaults to `false`), `flags` (optional, e.g. `i`/`m`/`s`) |
| 🔍 **Content Search** | `grep` | Search content in a file or directory; supports regex, case-insensitivity and recursive search | `pattern` (required), `path` (required), `ignoreCase` (optional), `recursive` (optional), `maxResults` (optional, defaults to 50) |
| 🎯 **Skill Activation** | `activate_skill` | Activate a Skill, returning the full SKILL.md instructions **plus the skill's directory (skill dir / absolute SKILL.md path)**, making it easy to locate bundled scripts, reference docs, etc. | `name` (required) |
| 👁️ **Image Description** | `describe_image` | Produce an overall description of an image (subject, scene, visible text, colors, counts, etc.); use it first to get global context when unsure what to ask | `image` (required, local path or http(s) URL) |
| ❓ **Image Q&A** | `ask_image` | Answer a specific question about an image (UI text, error codes, button states, colors, counts, etc.); more precise and shorter output than `describe_image` | `image` (required), `question` (required) |
| 🧾 **Structured Extraction** | `extract_json` | Extract structured data from an image by a list of fields and return JSON (forms / tables / config screens, etc.); falls back to the raw text automatically when parsing fails | `image` (required), `fields` (required, array of field names) |
| 📝 **Text Recognition** | `ocr_image` | Recognize all text in an image (OCR), preserving the original reading order and line breaks | `image` (required) |

### Tool Usage Examples

```bash
# Command execution
commandRun({ "command": "dir", "cwd": "." })

# File read (full file, numbered by default)
fileRead({ "path": "package.json" })

# File read (a line range; line numbers are the real file line numbers)
fileRead({ "path": "src/agent/react-agent.ts", "startLine": 1, "endLine": 20 })

# File read (no line numbers; returns raw content, suitable for read-modify-write)
fileRead({ "path": "src/agent/react-agent.ts", "lineNumbers": false })

# File write (overwrite = whole-file replacement: content IS the complete file; original content is lost)
fileWrite({ "path": "output.txt", "content": "Hello World", "mode": "overwrite" })

# File write (append to the end, preserving existing content)
fileWrite({ "path": "output.txt", "content": "\nMore text", "mode": "append" })

# Partial edit of an existing file (do NOT use fileWrite overwrite — it loses content) → use editFile
editFile({ "path": "output.txt", "oldText": "Hello World", "newText": "Hello TRAE" })

# Text replacement (literal match; add replaceAll explicitly when there are multiple matches)
editFile({ "path": "src/config/schema.ts", "oldText": "gpt-4o-mini", "newText": "deepseek-chat" })

# Regex replacement (regex=true, supports flags and $1 capture references)
editFile({ "path": "src/version.ts", "oldText": "v\\d+\\.\\d+\\.\\d+", "newText": "v2.0.0", "regex": true })

# Whole-line-range replacement (replace lines 10-12 with newText; an empty newText deletes those lines)
editFile({ "path": "src/a.ts", "startLine": 10, "endLine": 12, "newText": "// TODO" })

# Line-range replacement + oldText check (optional; guards against line-number drift)
editFile({ "path": "src/a.ts", "startLine": 10, "endLine": 12, "oldText": "function legacy() {", "newText": "function modern() {" })

# Content search
grep({ "pattern": "config", "path": "src", "ignoreCase": true, "maxResults": 20 })

# Skill activation (progressive loading; returns the full SKILL.md content + skill dir / absolute SKILL.md path)
activate_skill({ "name": "example-skill" })

# Image description (local paths are auto-converted to base64 data URLs; requires vision.enabled = true)
describe_image({ "image": "screenshots/login.png" })

# Image Q&A (accepts a local path or an http(s) URL)
ask_image({ "image": "https://example.com/chart.png", "question": "Which month does the tallest bar in this chart correspond to?" })

# Structured extraction (returns a JSON string; falls back to the raw text when parsing fails)
extract_json({ "image": "invoice.png", "fields": ["title", "amount", "date"] })

# Text recognition (OCR; preserves the original reading order and line breaks)
ocr_image({ "image": "receipt.jpg" })
```

---

## 🧩 Tool Extension

### Adding a Custom Tool

```typescript
import type { Tool } from './src/types.js';
import { registry } from './src/tools/registry.js';

const myTool: Tool = {
  name: 'myTool',
  description: 'My custom tool',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input content' },
    },
    required: ['input'],
  },
  async execute(args) {
    const input = String(args.input);
    return `Processed result: ${input}`;
  },
};

// Register into the global registry
registry.register(myTool);
```

### Connecting External MCP Tools

MCP (Model Context Protocol) is a standardized tool-integration protocol supporting stdio, SSE (deprecated) and Streamable HTTP transports; Streamable HTTP is recommended for remote MCP servers.

#### Option 1: Config file (recommended)

Create `.mcp.json` or add one interactively via the CLI's `/mcp add` command:

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "fetch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"]
    },
    "remote": {
      "type": "streamableHttp",
      "url": "https://host/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

On startup, the project automatically loads the config and registers the tools of all MCP servers. Tool naming rule: `{serverName}__{toolName}` (e.g. `filesystem__read_file`).

#### Option 2: Interactive CLI add

After launching, type `mcp add my-server` and follow the prompts for transport type, command/URL, etc. It tests the connection automatically and then writes the config. The transport type can be `stdio` / `sse` / `http` (i.e. Streamable HTTP); choosing `http` also lets you enter one optional auth header (e.g. `Authorization: Bearer xxx`).

#### Option 3: Programmatic integration

```typescript
import { registry } from './src/tools/registry.js';

await registry.registerMCPServer('filesystem', {
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
});

// After registration, use registry.list() to see all tools
// Example MCP tool names: filesystem__read_file, filesystem__write_file
```

#### Option 4: Streamable HTTP transport (recommended for remote servers)

```typescript
await registry.registerMCPServer('my-server', {
  type: 'streamableHttp',
  url: 'https://host/mcp',
  // Optional: custom request headers (Bearer Token / API Key, etc.)
  headers: { Authorization: 'Bearer <token>' },
});
```

> - `type` also accepts the ecosystem aliases `http` / `streamable-http` (case-insensitive); all three are equivalent.
> - Streamable HTTP has replaced HTTP+SSE since the MCP spec 2025-03-26; the 2026-07-28 spec marks HTTP+SSE as Deprecated.

#### Option 5: SSE transport (deprecated, legacy compatibility only)

```typescript
await registry.registerMCPServer('my-server', {
  type: 'sse',
  url: 'http://localhost:3000/sse',
});
```

> **Note**: A failed connection to a single MCP server does not affect other servers or built-in tools (failure isolation).

---

## 🎯 Skills

A Skill is a set of **reusable instructions** for a specific domain task, using the `SKILL.md` standard format (YAML frontmatter + Markdown body). Based on user intent, the agent **progressively loads** a Skill's full instructions to handle complex domain tasks.

### Skill Directory Structure

```
~/.loop-agent/skills/           # Global Skills (available to all projects)
└── example-skill/
    └── SKILL.md

<workspace>/.loop-agent/skills/   # Workspace Skills (only for the current project; higher priority)
└── my-skill/
    ├── SKILL.md
    ├── scripts/                # Optional: executable scripts
    ├── references/             # Optional: reference docs
    └── assets/                 # Optional: templates/resources
```

### SKILL.md Format Spec

```markdown
---
name: example-skill
description: An example skill demonstrating how to create and use a Skill
---

# Example Skill

## When to use this skill
...

## How to ...
1. ...
```

| Field | Required | Description |
|---|---|---|
| `name` | ✅ | Unique Skill identifier, used for LLM matching and `activate_skill` calls |
| `description` | ✅ | A short description the LLM uses to decide when to use the Skill |

> **Priority**: When a Skill of the same name exists in both locations, the workspace version overrides the global one.

### Workflow

1. **On startup**: Automatically scan global + workspace Skills; inject metadata (name + description) into the System Prompt; **if there are no skills at all, the System Prompt explicitly states "no skills are currently available" to prevent the model from mistakenly searching the file system**
2. **At runtime**: The LLM decides a user intent matches a Skill → calls the `activate_skill` tool
3. **After loading**: The tool returns the full SKILL.md content **along with the skill's directory**; the agent continues reasoning from there. If the skill references internal scripts/docs, it can concatenate paths using that directory before reading
4. **Manual management**: View and refresh via the `/skill` command

### Programmatic Activation

```typescript
import { skillLoader } from './src/skill/index.js';

// Scan (global + workspace)
const skills = skillLoader.scan(process.cwd());

// Progressively load the full content
const content = skillLoader.load('example-skill');
console.log(content?.fullContent);
```

---

## ⚙️ Configuration Management

A multi-layer configuration system is supported. Priority, from high to low: **CLI args > workspace config > global config > environment variables > defaults**.

### Config Layers

| Layer | File Location | Description |
|---|---|---|
| CLI args | Passed at runtime | Highest priority; in-memory only |
| Workspace | `{project dir}/.loop-agent/.agent-config.json` | Project-level config (the whole `.loop-agent/` is kept out of version control) |
| Global | `~/.loop-agent/config.json` | User-level config, shared across projects |
| Environment | `.env` or `process.env` | Backward compatible, supports the existing env vars |
| Defaults | `DEFAULT_CONFIG` | Defaults built into the code |

### Config Structure

```json
{
  "model": {
    "name": "gpt-4o-mini",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-xxx",
    "temperature": 0,
    "maxIterations": 10
  },
  "models": {
    "active": "",
    "profiles": {
      "deepseek": {
        "name": "deepseek-chat",
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKey": "sk-yyy"
      }
    }
  },
  "tools": {
    "enabled": ["commandRun", "fileRead", "fileWrite", "editFile", "grep", "activate_skill"],
    "disabled": [],
    "mcpServers": {
      "filesystem": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
      }
    }
  },
  "agent": {
    "verbose": true,
    "debug": false,
    "systemPrompt": null,
    "showTokenStats": true
  },
  "session": {
    "autoSave": true,
    "autoRestore": true,
    "encryptionEnabled": true
  },
  "skill": {
    "enabled": true,
    "globalDir": "~/.loop-agent/skills",
    "workspaceDir": "skills",
    "autoLoad": true
  },
  "memory": {
    "enabled": true,
    "working": {
      "maxTokens": 102400,
      "compactionThreshold": 0.8,
      "keepRecentTurns": 3
    },
    "episodic": {
      "dir": "memory",
      "searchTopK": 3,
      "searchTimeoutMs": 500,
      "vectorSearch": {
        "enabled": false,
        "provider": "openai-compatible",
        "model": "",
        "dimension": 1024,
        "endpoint": "",
        "apiKey": "",
        "timeoutMs": 10000,
        "batchSize": 16
      }
    },
    "curated": {
      "files": ["SOUL.md", "USER.md", "MEMORY.md"]
    },
    "dreaming": {
      "enabled": true,
      "daysBack": 3,
      "onExit": true
    }
  },
  "vision": {
    "enabled": false,
    "baseUrl": "",
    "apiKey": "",
    "model": "",
    "temperature": 0,
    "maxTokens": 2048,
    "timeoutMs": 60000,
    "maxImageBytes": 10485760,
    "maxResultChars": 8000,
    "cacheEnabled": true,
    "cacheTtlMs": 600000
  }
}
```

| Section | Field | Description | Default |
|---|---|---|---|
| `model` | `name` / `baseUrl` / `apiKey` / `temperature` / `maxIterations` | LLM model config (the effective snapshot, the runtime's single read point) | `gpt-4o-mini`, etc. |
| `models` | `active` / `profiles` | Multi-model registry (Task-20261011-002): `profiles` maps aliases to model triplets (`name` / `baseUrl` / `apiKey`, optional `temperature`), `active` points to the current alias (empty string = not under multi-model management); `/model use <alias>` updates both `active` and the `model.*` snapshot | `active: ""`, `profiles: {}` |
| `tools` | `enabled` / `disabled` / `mcpServers` | Built-in tool toggles and MCP server config | all enabled |
| `agent` | `verbose` | Whether to output Thought/Action/Observation console logs | `true` |
| `agent` | `debug` | Whether to enable file debug logging (see 📝 Debug Logging) | `false` |
| `agent` | `systemPrompt` | Custom system prompt override | `null` |
| `agent` | `showTokenStats` | Whether to output per-round/summary token stats (Task-15) | `true` |
| `agent` | `loading` | Whether to show the waiting loading indicator (always disabled in non-TTY environments, Task-20260930-001) | `true` |
| `session` | `autoSave` | Auto-save the session to disk after `run()` | `true` |
| `session` | `autoRestore` | Auto-restore the most recent session on startup | `true` |
| `session` | `encryptionEnabled` | Whether session files are stored encrypted (AES-256-GCM) | `true` |
| `skill` | `enabled` / `globalDir` / `workspaceDir` / `autoLoad` | Skill toggles and scan directories | all enabled |
| `memory` | `enabled` / `working` / `episodic` / `curated` / `dreaming` / `vectorSearch` | Three-tier memory system config (incl. retrieval enhancement) | all enabled |
| `vision` | `enabled` / `baseUrl` / `apiKey` / `model` / `temperature` / `maxTokens` / `timeoutMs` / `maxImageBytes` / `maxResultChars` / `cacheEnabled` / `cacheTtlMs` | Vision model config (Task-20261010-001); an empty `baseUrl` / `apiKey` / `model` falls back to the main model's `model.*` triplet | `enabled: false`; other defaults in the config structure above |

### Environment Variables (Backward Compatible)

| Env Var | Required | Description | Default |
|---|---|---|---|
| `OPENAI_API_KEY` | ✅ | API Key | none |
| `OPENAI_BASE_URL` | ❌ | Model service address | `https://api.openai.com/v1` |
| `MODEL_NAME` | ❌ | Model name | `gpt-4o-mini` |
| `MAX_ITERATIONS` | ❌ | Max agent iterations | `10` |
| `VERBOSE` | ❌ | Whether to output Thought/Action/Observation logs (`true`/`false`) | `true` |
| `DEBUG` | ❌ | Whether to enable file debug logging (`true`/`false`, output to `~/.loop-agent/logs`) | `false` |

### Supported Base URL Examples

```env
# OpenAI
OPENAI_BASE_URL=https://api.openai.com/v1

# DeepSeek
OPENAI_BASE_URL=https://api.deepseek.com/v1

# Moonshot / Kimi
OPENAI_BASE_URL=https://api.moonshot.cn/v1

# Local deployment (vLLM / Ollama, etc.)
OPENAI_BASE_URL=http://localhost:8000/v1
```

### Runtime Config Management

Use the CLI's built-in `/config` command to modify config directly (written to `.loop-agent/.agent-config.json`):

```bash
# Show the complete effective config and its sources
/config list

# Change the model name (written to the workspace config)
/config set model.name deepseek-chat

# Change the max iterations
/config set model.maxIterations 20

# Enable debug logging
/config set agent.debug true

# Disable session auto-save
/config set session.autoSave false

# Write to the global config (shared across projects)
/config set model.name gpt-4 --global

# Delete a config item (reverts to the upper layer's default)
/config delete model.name

# Show the config file path
/config path
```

> Prefer the `/model` command for model registration and switching (see [Built-in Commands](#built-in-commands)): `/model use <alias>` syncs the active pointer and the effective snapshot, avoiding drift between the snapshot and the registry that a direct `/config set model.name` would cause.

---

## 🎧 Event Listeners

Inspired by LangChain callbacks, with support for **15 lifecycle hooks**. Any number of listeners can be stacked.

### Hook List

| Hook | Trigger Timing | Parameters |
|---|---|---|
| `onStart` | Agent begins execution | `input: string` |
| `onIterationStart` | Start of each iteration | `iteration: number, maxIterations: number` |
| `onLLMStream` | LLM streams a text chunk | `delta: string` |
| `onLLMEnd` | End of each LLM call | `response: LLMResponse, iteration: number` |
| `onToolStart` | A tool begins execution | `tool: string, args: Record<string, unknown>` |
| `onToolEnd` | A tool finishes execution | `tool: string, result: string` |
| `onToolProgress` | Tool execution progress heartbeat (Task-20260930-001; long-running tools report elapsed time every second) | `tool: string, elapsedMs: number` |
| `onToolCallDelta` | Streaming delta while generating tool arguments (tool_calls.arguments) (Task-20260930-001; covers the gap after Thought and before [Action]) | `tool: string, accumulatedBytes: number, elapsedMs: number` |
| `onCompaction` | L1 context hits the threshold and triggers compaction (Task-17) | `info: CompactionInfo` |
| `onFinal` | Agent produces the final answer | `answer: string` |
| `onError` | An error occurs | `error: Error` |
| `onWarning` | Non-fatal warning (level: warning/error) | `info: { level: 'warning' \| 'error'; message: string; context?: string }` |
| `onEnd` | Agent execution ends (success or failure) | `result: AgentResult \| null` |
| `onLLMStats` | End of each LLM call; outputs token stats (Task-15) | `stats: LLMStats` |
| `onLLMStatsSummary` | End of all iterations in the session; outputs summary stats (Task-15) | `summary: LLMStatsSummary` |

### Stacking Multiple Listeners

```typescript
import { agent } from './src/agent/react-agent.js';
import type { AgentEvents } from './src/types.js';

// Audit logger
const auditLogger: AgentEvents = {
  onToolStart: (tool, args) => {
    console.log(`[AUDIT] Tool call: ${tool}`);
  },
  onFinal: (answer) => {
    console.log(`[AUDIT] Final answer length: ${answer.length} chars`);
  },
};

// Metrics collector
const metricsCollector: AgentEvents = {
  onStart: () => { performance.mark('agent-start'); },
  onEnd: () => {
    performance.measure('agent-duration', 'agent-start');
    const duration = performance.getEntriesByName('agent-duration')[0].duration;
    console.log(`[METRICS] Duration: ${duration.toFixed(0)}ms`);
  },
};

const result = await agent.run('Help me search files', {
  events: [auditLogger, metricsCollector],
});
```

> **Note**: An error thrown by a single listener is caught and does not affect other listeners or the main loop.

---

## 💬 Multi-turn Conversation

The agent instance maintains `_chatHistory` internally, automatically persisting message history across `run()` calls.

### Behavior Rules

| Scenario | Behavior |
|---|---|
| First `run(input)` | Automatically creates a new session (system + user) |
| Consecutive `run(input)` | Automatically reuses the previous `_chatHistory`, appending a new user message |
| `run(input, { resetHistory: true })` | Clears history and starts a brand-new session |
| `run(input, { messages: [...] })` | Uses externally supplied message history (the system prompt is added) |
| `agent.resetSession()` | Manually clears the persisted history |
| `agent.getSessionMessages()` | Gets the current session's message history (read-only copy) |

### Multi-turn Example

```typescript
// Turn 1: read a file
const r1 = await agent.run('Read package.json', { resetHistory: true });
// Turn 2: follow up based on turn 1's result
const r2 = await agent.run('What is this project's version?');
// The agent already knows package.json's content and can answer directly
```

> **In-process** multi-turn is guaranteed by `_chatHistory`; for **cross-process** restore, use `SessionStore` persistence (see the next section).

---

## 💾 Session Persistence

The agent has built-in file-system-based session persistence: the conversation history (messages + steps) is encrypted on the local disk, and after restarting the CLI you can restore context with `/session load <id>` and continue.

### Storage Structure

```
~/.loop-agent/
├── .keyfile                      # 🔑 Master key file (auto-generated on first use, mode 0600)
├── config.json                   # Global config (optional)
├── logs/
│   └── debug-YYYY-MM-DD.log      # 📝 Debug logs (see the next section)
└── sessions/
    └── {workspaceId}/            # Isolated by workspace path (first 16 chars of the path's SHA-256)
        ├── meta.json             # Workspace metadata
        ├── sessions.json         # Session index (metadata only, no message content)
        └── sess_YYYYMMDD_HHMMSS.enc   # Encrypted session data file
```

### Encryption

- **Master key**: A 256-bit random key is auto-generated on first use and stored in `~/.loop-agent/.keyfile` (mode `0600`); no user password required
- **Data encryption**: Session messages are encrypted with **PBKDF2 (100,000 iterations) derivation** + **AES-256-GCM**, with an authentication tag ensuring integrity
- **Key verification**: The key file contains a verification token; the key's integrity is checked on read, and corruption raises an error
- **Plaintext index**: `sessions.json` stores only session metadata (ID, title, message count, time); all message content is encrypted

### Auto-save / Restore

- **Auto-save**: After `run()`, if `session.autoSave=true` and a SessionStore is set, a new session is created or the current one updated automatically
- **Auto-restore**: When `session.autoRestore=true`, the CLI loads the most recent session on startup, seamlessly continuing the last conversation
- **Manual control**: Use the `/session` subcommands at any time — list / load / save / new / delete

### Key Management (Keychain)

`src/session/keychain.ts` provides key lifecycle management:

| Method | Description |
|---|---|
| `keychain.ensureUnlocked()` | Ensure the key is loaded (auto-generates the key file on first use) |
| `keychain.exportKey()` | Export the master key (base64, for backup) |
| `keychain.importKey(base64)` | Import the master key from a backup (for migration/restore) |
| `keychain.reset()` | Delete the key file (⚠️ makes all encrypted sessions undecryptable) |

> ⚠️ **Important**: `.keyfile` is the sole credential for decrypting sessions. Losing this file makes all encrypted sessions unrecoverable. Back up regularly via `exportKey()`.

---

## 🧠 Memory Management

A three-tier memory architecture (Tier Model) in the OpenClaw style. Core ideas: **files are the source of truth, indexes only accelerate; write and read paths are separated; promotion is gated.** Memory management complements session persistence (Task-11): session persistence solves "restore the last conversation," while memory management solves "accumulate knowledge across sessions."

### Three-tier Architecture

| Tier | Storage Form | Lifecycle | Auto in context | Description |
|---|---|---|---|---|
| **L1 Working** | In-memory `_chatHistory` | Single session | ✅ Always | Compacts automatically past a threshold (default 8000 tokens / 80% threshold, keeping the last 3 turns) |
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

---

## 📊 LLM Token Stats

The agent has built-in LLM token stats (Task-15): after each LLM call it prints context/input/output tokens and cache hit rate; after the session ends it prints a session-level summary (total tokens, average cache hit rate, context peak).

```
[Iteration 2/5] Context 3214/8000 (40%) | Input 2588 | Output 412 | Cache 72.3% | 1.2s
[Stats Summary] 3 rounds | Total input 7842 | Total output 1230 | Total tokens 9072 | Avg cache hit 68.5% | Context peak 4500/8000 (56%)
```

- **Toggle**: Config `agent.showTokenStats` (defaults to `true`); once disabled, stats lines are no longer printed
- **Events**: Listen to `onLLMStats` (per round) and `onLLMStatsSummary` (session end) for structured data
- **Context warning**: When context tokens approach/exceed the L1 compaction threshold, the stats line is highlighted in yellow

---

## 📝 Debug Logging

The agent has a built-in file-based debug logging system (`src/debug.ts`) that records LLM requests/responses, tool calls and agent iterations to local files for troubleshooting.

### Enabling

```bash
# Option 1: environment variable
DEBUG=true npm start

# Option 2: runtime config
/config set agent.debug true
```

Once enabled, the CLI prints on startup:

```
⚠ Debug mode enabled, logs output to: C:\Users\xxx\.loop-agent\logs
```

### Log Location and Rotation

- **Location**: `~/.loop-agent/logs/debug-YYYY-MM-DD.log` (split by date)
- **Rotation**: max **10MB** per file; auto-rotates when exceeded, keeping up to **5** historical files
- **Redaction**: API keys in logs are automatically redacted (only the first and last 4 characters are shown)

### Log Content

| Type | Trigger | Recorded Content |
|---|---|---|
| `llmRequest` | Every LLM request | Model, message count, tool count, redacted parameters |
| `llmResponse` | LLM response returned | Content (truncated to 300 chars), tool calls, duration |
| `llmError` | LLM call error | Error message, duration |
| `toolCall` | Every tool call | Tool name, parameters, result (all truncated), duration |
| `iteration` | Every agent iteration | Thought / Action / Observation |
| `session` | Every `run()` start | Message count, tool count, session ID |

### Programmatic Read

```typescript
import { debug } from './src/debug.js';

// Current log file path
const logPath = debug.getLogPath();

// Read recent log content (defaults to at most 10000 chars)
const content = debug.readLog(10000);
```

---

## 📁 Project Structure

```
loop-agent-command/
├── src/
│   ├── index.ts                      # 🚪 CLI entry (interactive REPL + multi-command support)
│   ├── config.ts                     # ⚙️ Env-var config (deprecated; kept for legacy code — use config/index.ts)
│   ├── debug.ts                      # 📝 Debug logging (file output: LLM/tool/iteration logs)
│   ├── types.ts                      # 📐 Core type definitions (Tool, ChatMessage, AgentEvents, etc.)
│   ├── agent/
│   │   ├── react-agent.ts            # 🔄 ReAct main loop (streaming version + session auto-save)
│   │   ├── prompt.ts                 # 📝 System Prompt builder (incl. Skill metadata injection)
│   │   ├── logger.ts                 # 🎨 ConsoleLogger (colored log output, implements AgentEvents)
│   │   └── stats.ts                  # 📊 LLM stats aggregation (buildLLMStatsSummary)
│   ├── llm/
│   │   └── client.ts                 # 🤖 LLM client (chat + chatStream + auto-retry)
│   ├── config/                       # ⚙️ Layered configuration system
│   │   ├── index.ts                  # Unified exports
│   │   ├── schema.ts                 # Config type definitions + defaults (incl. skill / memory sections)
│   │   ├── loader.ts                 # Config loader (layered merge)
│   │   ├── writer.ts                 # Config writer (persistence)
│   │   ├── merge.ts                  # Deep merge utility
│   │   └── mcp-manager.ts            # MCP lifecycle manager
│   ├── skill/                        # 🎯 Skills
│   │   ├── index.ts                  # Unified exports
│   │   ├── types.ts                  # Skill type definitions (SkillMetadata / SkillContent)
│   │   ├── scanner.ts                # Directory scanning + SKILL.md YAML frontmatter parsing
│   │   └── loader.ts                 # SkillLoader (scan / progressive loading)
│   ├── memory/                       # 🧠 Three-tier memory management (Phases 1-5)
│   │   ├── index.ts                  # Unified exports
│   │   ├── types.ts                  # Memory type definitions + default config
│   │   ├── working.ts                # L1 WorkingMemory (token estimation + compaction)
│   │   ├── episodic.ts               # L2 EpisodicMemory (daily Markdown journal + retrieval)
│   │   ├── curated.ts                # L3 CuratedMemory (SOUL/USER/MEMORY read-write)
│   │   ├── context.ts                # ContextAssembler (L3 injection + L2 retrieval assembly)
│   │   ├── callback.ts               # ToolMemoryCallback (auto-write tool results to L2)
│   │   ├── gate.ts                   # PromotionGate (promotion gate: confirmation counts/thresholds)
│   │   ├── dreaming.ts               # DreamingPipeline (background L2 → L3 promotion)
│   │   ├── fts.ts                    # MemoryIndex (BM25 full-text search + tokenization)
│   │   ├── embedding.ts              # EmbeddingClient (vector embedding client)
│   │   ├── vector.ts                 # VectorMemory (vector store + cosine similarity)
│   │   └── hybrid.ts                 # Hybrid retrieval (FTS + vector RRF fusion)
│   ├── session/                      # 💾 Session persistence (encrypted storage)
│   │   ├── index.ts                  # Unified exports
│   │   ├── store.ts                  # SessionStore (session read/write/index/workspace isolation)
│   │   ├── keychain.ts               # Keychain (master key auto-generation/loading/backup)
│   │   ├── crypto.ts                 # Crypto primitives (PBKDF2 + AES-256-GCM)
│   │   └── types.ts                  # Session type definitions + default config
│   └── tools/
│       ├── index.ts                  # 🛠️ Tool system aggregate entry
│       ├── registry.ts               # 📋 Tool registry (register/query/convert to OpenAI format/MCP mgmt)
│       ├── runner.ts                 # ⚡ Tool runner (timeout control + exception capture)
│       ├── commandRun.ts             # 🖥️ Built-in tool: command execution
│       ├── fileRead.ts               # 📄 Built-in tool: file read
│       ├── fileWrite.ts              # ✏️ Built-in tool: file write
│       ├── editFile.ts               # 🔁 Built-in tool: text edit (literal/regex/line-range)
│       ├── grep.ts                   # 🔍 Built-in tool: content search
│       ├── activateSkill.ts          # 🎯 Built-in tool: Skill activation (progressive loading)
│       ├── vision/                   # 👁️ Vision tools (multimodal vision model integration)
│       │   ├── tools.ts              # Four vision tools (describe_image / ask_image / extract_json / ocr_image)
│       │   ├── image.ts              # Image resolution (local → base64 data URL / URL validation / size limits)
│       │   ├── cache.ts              # LRU result cache (local file fingerprints in the key; auto-invalidated on content change)
│       │   └── stats.ts              # Usage stats (success / failure / cache hits / elapsed / tokens)
│       └── mcp/                      # 🌐 MCP tool integration
│           ├── index.ts              # Entry
│           ├── client.ts             # MCP client (stdio / SSE transport)
│           └── adapter.ts            # MCP tool adapter (converts to the Tool interface)
├── examples/
│   └── run.ts                        # 📝 Programmatic usage example
├── tests/                            # 🧪 Tests (run serially to avoid API rate limits)
│   ├── integration/                  # Integration tests (7 cases)
│   │   ├── a-no-tool.test.ts         # Scenario requiring no tools
│   │   ├── b-single-tool.test.ts     # Single tool call
│   │   ├── c-multi-tool.test.ts      # Multiple tool calls
│   │   ├── d-tool-failure.test.ts    # Tool execution failure
│   │   ├── e-unknown-tool.test.ts    # Tool does not exist
│   │   ├── f-max-iterations.test.ts  # Reaching the max iterations
│   │   └── g-parallel-tools.test.ts  # Parallel tools in the same round
│   ├── memory-working.test.ts        # L1 working memory (token estimation + compaction)
│   ├── memory-callback.test.ts       # Tool callback auto-writes to L2
│   ├── memory-flush.test.ts          # L2 daily log flush
│   ├── memory-dreaming.test.ts       # Dreaming promotion pipeline
│   ├── memory-gate.test.ts           # Promotion Gate
│   ├── memory-phase4.test.ts         # Phase 4 hybrid retrieval
│   ├── memory-phase5.test.ts         # Phase 5 vector retrieval
│   ├── session-isolation.test.ts     # Session workspace isolation
│   ├── edit-file.test.ts             # editFile text-edit tool (literal/regex/line-range)
│   ├── file-read.test.ts             # fileRead line-number output
│   ├── activate-skill.test.ts        # activate_skill outputs the skill dir / SKILL.md path
│   ├── system-prompt.test.ts         # Skill block injection into the System Prompt
│   ├── llm-stats.test.ts             # LLM stats aggregation
│   ├── vision-cache.test.ts          # Vision result cache (LRU / TTL / file-fingerprint invalidation)
│   ├── vision-image.test.ts          # Image resolution (local → base64 / URL / size & format validation)
│   ├── vision-client.test.ts         # chatVision multimodal client (jsonMode / error-context rewrite / retry)
│   ├── vision-registry.test.ts       # Vision tool registration (vision.enabled gating / Tab-completion list)
│   ├── vision-tools.test.ts          # Vision tool pipeline (parsing / cache / fallback / truncation)
│   └── vision-command.test.ts        # /vision command (status / test)
├── docs/
│   ├── plan.md                       # 📋 Overall dev plan and milestones
│   ├── openclaw_memory_management.md # 🧠 Memory management design reference (OpenClaw style)
│   └── tasks/                        # 📂 Per-task docs (15 tasks, incl. memory Phases 1-5 and LLM stats)
├── .loop-agent/                      # 📋 Workspace config and Skills (.agent-config.json + skills/, all git-ignored)
│   ├── .agent-config.json            # ⚙️ Workspace config (optional, generated at runtime)
│   └── skills/                       # 🎯 Workspace Skills (example-skill, py-pptx, etc.)
├── memory/                           # 🧠 L2 episodic memory (generated at runtime, split by day)
├── SOUL.md                           # 🧠 L3: agent persona
├── USER.md                           # 🧠 L3: user profile
├── MEMORY.md                         # 🧠 L3: distilled facts
├── .env                              # 🔒 Environment variables (create by copying .env.example)
├── .env.example                      # 📄 Env-var template
├── .mcp.json                         # 🔌 MCP config (optional, copy from .mcp.json.example)
├── .mcp.json.example                 # 📄 MCP config template
├── package.json
├── tsconfig.json
├── vitest.config.ts                  # 🧪 Test config (serial execution)
└── README.md                         # 📖 Project documentation
```

---

## 🛠️ Tech Stack

| Item | Choice | Description |
|---|---|---|
| **Language** | TypeScript 5.x | strict mode, type-safe |
| **Runtime** | Node.js 18+ | native ESM modules |
| **LLM SDK** | `openai` v4.x | compatible with any OpenAI-protocol provider |
| **MCP SDK** | `@modelcontextprotocol/sdk` v1.x | external tool integration protocol |
| **Crypto** | Node.js `crypto` | PBKDF2 + AES-256-GCM session encryption |
| **Test Framework** | vitest | integration tests, serial execution |
| **Build Tool** | tsup | outputs ESM format |
| **Dev Tool** | tsx | run TypeScript directly during development |
| **Env Vars** | built-in .env parser | auto-loads `.env` into `process.env` on startup (dotenv-compatible behavior) |

---

## 🏗️ Development

```bash
# Dev mode (hot reload)
npm run dev

# Build
npm run build

# Type check
npm run typecheck

# Run tests
npm test

# Watch-mode tests
npm run test:watch
```

---

## 🚀 SEA Single-file Deployment

Package the agent into a **single executable** (Node SEA, Single Executable Applications). On-site deployment **requires no Node.js and no dependencies** — just run it directly.

### Build

```bash
# Build machine requires Node.js >= 20.10
npm run build:sea
```

The artifacts are output to `dist-sea/`:

| Platform | Artifact | Description |
|---|---|---|
| Windows | `dist-sea/loop-agent.exe` | Verified in practice (Node v24) |
| Linux | `dist-sea/loop-agent` | Must be built on Linux |
| macOS | `dist-sea/loop-agent` | Must be built on macOS |

> **No cross-compilation**: Node SEA requires building **on the target OS** (a Windows artifact only runs on Windows). Whichever OS the site uses, run `npm run build:sea` once on that OS.

### Run

```bash
# Windows
.\dist-sea\loop-agent.exe

# Linux / macOS (chmod +x first)
./dist-sea/loop-agent
```

The runtime experience is identical to `npm start`: enters the interactive REPL, with `/status`, `/config`, `/memory`, `/session` and other commands all available, and the memory system (L1/L2/L3) enabled.

### Build Principles

1. **Bundle**: `tsup` compiles TypeScript into a single CJS file, with all third-party dependencies inlined (`noExternal`)
2. **Generate blob**: `node --experimental-sea-config` generates a preparation blob from `sea-config.json`
3. **Inject**: copy the Node runtime as the artifact skeleton, and inject `NODE_SEA_BLOB` with `postject`

Corresponding orchestration script: [scripts/build-sea.mjs](scripts/build-sea.mjs) (`build:sea` in `package.json`).

### On-site Notes

| Item | Description |
|---|---|
| **MCP dependencies** | When using a stdio-type MCP server (e.g. `npx -y @modelcontextprotocol/...`), the target machine still needs Node/npx installed to spawn the subprocess; SSE type has no such requirement |
| **Global config and key migration** | On first run, `~/.loop-agent/` gets global config, `.keyfile` (session encryption master key), etc. When migrating machines, migrate these too, otherwise historical encrypted sessions can't be decrypted (back up with `keychain.exportKey()`) |
| **Working directory semantics** | The program treats the **current working directory** as the workspace root: L2 memory is written to `<cwd>/memory/`, and workspace config is read from `<cwd>/.loop-agent/`. Starting in a different directory yields a different "project context" |
| **No Node runtime needed** | The single-file artifact bundles the Node runtime; the target machine only needs the OS itself |

---

## 🔍 Troubleshooting

### Invalid or Expired API Key

```
Error: Invalid or expired API Key. Please check OPENAI_API_KEY in .env
```

**Fix**: Check whether `OPENAI_API_KEY` in `.env` is correct and matches the provider for `OPENAI_BASE_URL`. You can also change it at runtime via `/config set model.apiKey <key>`.

### Model Does Not Exist (404)

```
Error: Model does not exist (404). Please check MODEL_NAME in .env (current: xxx)
```

**Fix**: Confirm that `MODEL_NAME` is available on the target provider. Change it at runtime via `/config set model.name <new-model-name>`.

### Too Many Requests (429)

```
Error: Too many requests (429). Please retry later or reduce the call frequency
```

**Fix**: Reduce the call frequency. Integration tests run serially by default (`fileParallelism: false`) to avoid concurrent rate limiting.

### Tool Execution Timeout

```
Error: Tool execution timed out (30000ms)
```

**Fix**: The `commandRun` tool has a default 30s timeout, adjustable via the `timeout` parameter. For complex commands, split them into multiple steps.

### Windows Terminal Garbled Chinese

**Fix**: The CLI already runs `chcp 65001` on startup to switch to UTF-8. If garbling persists, manually run `chcp 65001` before starting.

### Reaching Max Iterations

```
Error: Reached max iterations 10; the agent could not produce a final answer
```

**Fix**: Increase `MAX_ITERATIONS` in `.env`, or change it at runtime via `/config set model.maxIterations 20`. You can also simplify the question so the agent finishes in fewer steps.

### Tool Not Registered

```
Error: Tool xxx is not registered
```

**Fix**: Call `registerBuiltinTools()` to register the built-in tools, or register a custom tool via `registry.register(tool)`. You can also reload via `/tools reload`.

### MCP Connection Failure

```
Error: MCP server xxx failed to connect
```

**Fix**: Check whether the MCP config is correct; run `/mcp test <name>` to test the connection. Remove with `/mcp remove <name>` and re-add with `/mcp add <name>`.

### Skill Not Found

```
Error: Skill "xxx" not found. Available Skills: ...
```

**Fix**: Confirm the Skill is placed in `~/.loop-agent/skills/` (global) or `<cwd>/.loop-agent/skills/` (workspace), and that `SKILL.md` contains a valid `name` and `description` frontmatter. View scan results via `/skill list`, and rescan via `/skill reload`.

### Memory System Not Enabled

```
⚠ Memory system not enabled. Please set memory.enabled=true in the config
```

**Fix**: Enable via `/config set memory.enabled true`, or edit `.loop-agent/.agent-config.json` directly. `/memory status` shows the current enabled state and per-tier stats.

### Session Cannot Be Loaded / Decryption Failure

```
Error: Key file is corrupted; verification failed
Error: Key not loaded; cannot read session
```

**Fix**:
- Check that `~/.loop-agent/.keyfile` exists and is not corrupted
- If accidentally deleted/corrupted, restore it by calling `keychain.importKey()` with the base64 exported earlier via `exportKey()`
- If it cannot be recovered, delete the corrupted session file (`/session delete <id>`) and start over

### Debug Logs Not Generated

**Fix**: Confirm debug mode is enabled via the `DEBUG=true` environment variable or `/config set agent.debug true`; logs output to `~/.loop-agent/logs/debug-YYYY-MM-DD.log`. Once enabled, the CLI startup banner shows the debug log directory hint.

### Config Source Tracing

When config doesn't take effect as expected, use `/config list` to see each field's actual source (cli / workspace / global / env / default) and quickly identify which layer overrode it.

---

## 📄 License

[MIT](LICENSE) © 2026

---

<div align="center">
  <sub>Built with ❤️ using TypeScript</sub>
</div>
