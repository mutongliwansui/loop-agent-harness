# ⚙️ Configuration Management

> [⬅ Back to README](../../../README.md)

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
    }
  },
  "agent": {
    "verbose": true,
    "debug": false,
    "systemPrompt": null,
    "showTokenStats": true,
    "maxIterations": 100
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
| `model` | `name` / `baseUrl` / `apiKey` / `temperature` | LLM model config (the effective snapshot, the runtime's single read point) | `gpt-4o-mini`, etc. |
| `models` | `active` / `profiles` | Multi-model registry (Task-20261011-002): `profiles` maps aliases to model triplets (`name` / `baseUrl` / `apiKey`, optional `temperature`), `active` points to the current alias (empty string = not under multi-model management); `/model use <alias>` updates both `active` and the `model.*` snapshot | `active: ""`, `profiles: {}` |
| `tools` | `enabled` / `disabled` / `mcpServers` | Built-in tool toggles and MCP server config | all enabled |
| `agent` | `verbose` | Whether to output Thought/Action/Observation console logs | `true` |
| `agent` | `debug` | Whether to enable file debug logging (see 📝 Debug Logging) | `false` |
| `agent` | `systemPrompt` | Custom system prompt override | `null` |
| `agent` | `showTokenStats` | Whether to output per-round/summary token stats (Task-15) | `true` |
| `agent` | `loading` | Whether to show the waiting loading indicator (always disabled in non-TTY environments, Task-20260930-001) | `true` |
| `agent` | `maxIterations` | Max iterations per task | `100` |
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
