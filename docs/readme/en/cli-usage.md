# 📖 CLI Usage

> [⬅ Back to README](../../../README.md)


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

> If `agent.debug` is enabled, the startup banner additionally shows the debug log directory (see [📝 Debug Logging](debug-logging.md)).

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

Session data is stored with AES-256-GCM encryption under `~/.loop-agent/sessions/` (isolated by workspace). See [💾 Session Persistence](session-persistence.md).

#### `/skill` — Skill Management

```
/skill list                     # List all available Skills (global + workspace, with source tags)
/skill reload                   # Rescan the Skill directories
/skill show <name>              # Show the full SKILL.md content of the specified Skill
/skill upload <dirs...>         # Install local Skill directories (workspace by default; --global for global; asks before overwriting name conflicts)
/skill upload                   # No args: open the native directory picker (auto-detects available tools on Windows/macOS/Linux)
/skill remove <names...>        # Remove installed Skills (workspace first by default; --global/--workspace to restrict; per-item y/N confirmation)
```

Skills are auto-scanned from the global `~/.loop-agent/skills/` and the workspace `<cwd>/.loop-agent/skills/` directories; the workspace version takes precedence when names collide. See [🎯 Skills](skills.md).

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

See [🧠 Memory Management](memory-management.md).

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

Once enabled, four vision tools are registered: `describe_image` (whole-image description), `ask_image` (targeted Q&A), `extract_json` (structured extraction) and `ocr_image` (text recognition). See [🔧 Built-in Tools](built-in-tools.md).

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
