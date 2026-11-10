# ⚙️ Configuration Management

> [⬅ Back to README](../../../README.md)

A multi-layer configuration system is supported. Priority, from high to low: **CLI args > workspace config > global config > environment variables > defaults**.

### Config Layers

| Layer | File Location | Description |
|---|---|---|
| CLI args | Passed at runtime | Highest priority; in-memory only (the `--serve` startup flags `--port` / `--host` / `--token` / `--web-root` belong to this layer) |
| Workspace | `{project dir}/.loop-agent/.agent-config.json` | Project-level config (the whole `.loop-agent/` is kept out of version control) |
| Global | `~/.loop-agent/config.json` | User-level config, shared across projects |
| Environment | `.env` or `process.env` | Backward compatible, supports the existing env vars |
| Defaults | `DEFAULT_CONFIG` | Defaults built into the code |

> **Multiple workspaces (serve mode)**: each workspace holds its own ConfigLoader / ConfigWriter instance whose paths are fixed at construction time and never rebound at runtime — a `/config` read/write in workspace A never affects workspace B. The CLI single-workspace mode uses the launch directory; behavior is unchanged.

### Config Structure

```json
{
  "model": {
    "name": "gpt-4o-mini",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-xxx",
    "temperature": 0
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
    },
    "mcpTranslate": {
      "enabled": true,
      "mode": "auto",
      "timeoutMs": 20000,
      "maxToolsPerBatch": 60
    },
    "backgroundLog": {
      "enabled": true,
      "retentionDays": 7,
      "maxTotalMb": 100
    },
    "commandRun": {
      "outputLimitKb": 256,
      "timeoutMs": 30000
    },
    "backgroundNotify": {
      "enabled": true,
      "tailLines": 20,
      "maxChars": 2000,
      "wakeIdle": true
    }
  },
  "agent": {
    "verbose": true,
    "debug": false,
    "systemPrompt": null,
    "showTokenStats": true,
    "maxIterations": 100,
    "subAgent": {
      "background": true,
      "maxConcurrent": 3
    }
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
      "keepRecentTurns": 10
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
      "onExit": true,
      "schedule": {
        "enabled": true,
        "cron": "0 3 * * *",
        "misfireGraceMin": 60
      },
      "historyLimit": 20,
      "shutdownBudgetMs": 30000,
      "maxDaysBack": 30
    }
  },
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
| `model` | `name` / `baseUrl` / `apiKey` / `temperature` | LLM model config (the effective snapshot, the runtime's single read point) | `gpt-4o-mini`, etc. |
| `models` | `active` / `profiles` | Multi-model registry (Task-20261011-002): `profiles` maps aliases to model triplets (`name` / `baseUrl` / `apiKey`, optional `temperature`), `active` points to the current alias (empty string = not under multi-model management); `/model use <alias>` updates both `active` and the `model.*` snapshot | `active: ""`, `profiles: {}` |
| `tools` | `enabled` / `disabled` / `mcpServers` | Built-in tool toggles and MCP server config | all enabled |
| `tools` | `mcpTranslate` | MCP tool display-name localization (requirement 20261104-001): `enabled` master switch; `mode` = `auto` (distill locally when the description is already Chinese, no LLM call) or `always` (always use the LLM); `timeoutMs` per-batch timeout; `maxToolsPerBatch` tools per batch | `{ enabled: true, mode: 'auto', timeoutMs: 20000, maxToolsPerBatch: 60 }` |
| `tools` | `backgroundLog` | Background task log cleanup (requirement 20261104-003): `enabled` master switch (runs at startup and before each background launch); `retentionDays` retention for finished tasks' `.json`+`.log`; `maxTotalMb` total size cap for `~/.loop-agent/runs/`, oldest by mtime evicted first; live logs of running tasks are never truncated | `{ enabled: true, retentionDays: 7, maxTotalMb: 100 }` |
| `tools` | `commandRun` | Foreground command execution (requirement 20261104-006): `outputLimitKb` total output cap returned to the model, split head/tail with the middle omitted and byte count annotated (no more maxBuffer failures); `timeoutMs` default timeout when `timeout` is not passed explicitly — use `background:true` for long tasks | `{ outputLimitKb: 256, timeoutMs: 30000 }` |
| `tools` | `backgroundNotify` | Background task completion notice (requirement 20261104-004): after a task exits or is stopped, inject its summary and log tail into the originating session's next turn; `enabled` master switch; `tailLines`/`maxChars` bound the log tail; `wakeIdle` idle wake-up (requirement 20261108-002, default `true`): when a background command task finishes while the session is idle, the API service starts a wake-up run with a synthetic input to consume the notice proactively (mirroring the sub-agent wake-up); the wake-up input is not persisted as a user bubble; CLI mode has no run loop and keeps passive injection | `{ enabled: true, tailLines: 20, maxChars: 2000, wakeIdle: true }` |
| `agent` | `verbose` | Whether to output Thought/Action/Observation console logs | `true` |
| `agent` | `debug` | Whether to enable file debug logging (see 📝 Debug Logging) | `false` |
| `agent` | `systemPrompt` | Custom system prompt override | `null` |
| `agent` | `showTokenStats` | Whether to output per-round/summary token stats (Task-15) | `true` |
| `agent` | `loading` | Whether to show the waiting loading indicator (always disabled in non-TTY environments, Task-20260930-001) | `true` |
| `agent` | `maxIterations` | Max iterations per task | `100` |
| `agent.subAgent` | `background` | Allow `delegate({background:true})` parallel background runs (when off, delegation always blocks) | `true` |
| `agent.subAgent` | `maxConcurrent` | Max concurrent background sub-agents per session; exceeding it fails fast | `3` |
| `session` | `autoSave` | Auto-save the session to disk after `run()` | `true` |
| `session` | `autoRestore` | Auto-restore the most recent session on startup | `true` |
| `session` | `encryptionEnabled` | Whether session files are stored encrypted (AES-256-GCM) | `true` |
| `skill` | `enabled` / `globalDir` / `workspaceDir` / `autoLoad` | Skill toggles and scan directories | all enabled |
| `memory` | `enabled` / `working` / `episodic` / `curated` / `dreaming` / `vectorSearch` | Three-tier memory system config (incl. retrieval enhancement) | all enabled |
| `memory.dreaming` | `onExit` | Auto-promote on process shutdown (semantics widened from "CLI exit" to "any host process shutdown": CLI `quit`/`exit`/`Ctrl+C` and `--serve` `Ctrl+C`/`SIGTERM`/`SIGBREAK` share it) | `true` |
| `memory.dreaming` | `schedule.enabled` | Enable periodic auto-promotion in `--serve`/WebUI (independent of `onExit`; the CLI never schedules) | `true` |
| `memory.dreaming` | `schedule.cron` | Schedule expression (5-field crontab: minute hour day-of-month month day-of-week, **server local timezone**). Supports `*` `,` `-` `/` plus the `@daily`/`@hourly`/`@weekly`/`@monthly`/`@yearly` macros; day-of-month and day-of-week are OR-ed when both are restricted (vixie semantics); `L`/`W`/`#`/`?` and the 6-field seconds form are not supported. **Hot reload, no restart needed** (also editable from the WebUI memory page) | `"0 3 * * *"` (daily 03:00) |
| `memory.dreaming` | `schedule.misfireGraceMin` | Misfire catch-up grace in minutes (`0`-`1440`): later than the trigger point but within this window → run once, flagged `catchup`; beyond it → only a "missed" entry, no run | `60` |
| `memory.dreaming` | `historyLimit` | Number of runs kept in the ring buffer (`{L2}/.dreaming-runs.json`); `0` = keep no history | `20` |
| `memory.dreaming` | `schedule.intervalHours` | **Deprecated**: legacy fixed interval (hours), used only when `cron` is an empty string | `24` |
| `memory.dreaming` | `schedule.startupDelayMin` | **Deprecated**: legacy startup delay (minutes), used only when `cron` is an empty string | `5` |
| `memory.dreaming` | `shutdownBudgetMs` | Total time budget for the shutdown fallback in ms; after it expires a warning is printed and shutdown continues without waiting | `30000` |
| `memory.dreaming` | `maxDaysBack` | Upper bound (days) for window widening: on each trigger the window grows to "days since last processed day + 1" `daysBack`, so downtime no longer drops days | `30` |
| `vision` | `enabled` / `baseUrl` / `apiKey` / `model` / `temperature` / `maxTokens` / `timeoutMs` / `maxImageBytes` / `maxResultChars` / `cacheEnabled` / `cacheTtlMs` | Vision model config (Task-20261010-001); an empty `baseUrl` / `apiKey` / `model` falls back to the main model's `model.*` triplet | `enabled: false`; other defaults in the config structure above |
| `webui` | `terminal` | Enable the terminal in the Web UI file preview area (a terminal means arbitrary command execution, so it must be enabled explicitly; while off the WS handshake returns 403) | `false` |
| `webui` | `terminalDeny` | Command keywords the terminal refuses to run (**enforced server-side**, denied and audited; the front-end confirmation is not a security boundary) | `[]` |
| `webui` | `terminalMax` | Max concurrent terminals per user (exceeding it returns `too_many`; closing a tab frees the slot **immediately**, while a page reload takes up to 60s) | `4` |
| `webui` | `terminalIdleMs` | Terminal idle reclaim in milliseconds (the PTY is kept 60s after a WS disconnect for replay on reconnect) | `1800000` (30 min) |

### Environment Variables (Backward Compatible)

| Env Var | Required | Description | Default |
|---|---|---|---|
| `OPENAI_API_KEY` | ✅ | API Key | none |
| `OPENAI_BASE_URL` | ❌ | Model service address | `https://api.openai.com/v1` |
| `MODEL_NAME` | ❌ | Model name | `gpt-4o-mini` |
| `MAX_ITERATIONS` | ❌ | Max agent iterations | `100` |
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
/config set agent.maxIterations 20

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

> Prefer the `/model` command for model registration and switching (see [Built-in Commands](cli-usage.md#built-in-commands)): `/model use <alias>` syncs the active pointer and the effective snapshot, avoiding drift between the snapshot and the registry that a direct `/config set model.name` would cause.
