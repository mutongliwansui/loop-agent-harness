# ⚙️ 配置管理

> [⬅ 返回 README](../../../README.md)

支持多层配置系统，优先级从高到低为：**CLI 参数 > 工作空间配置 > 全局配置 > 环境变量 > 默认值**。

### 配置层级

| 层级 | 文件位置 | 说明 |
|---|---|---|
| CLI 参数 | 运行时传入 | 最高优先级，仅内存中生效 |
| 工作空间 (workspace) | `{项目目录}/.loop-agent/.agent-config.json` | 项目级配置（.loop-agent/ 整体不进入版本控制） |
| 全局 (global) | `~/.loop-agent/config.json` | 用户级配置，跨项目共享 |
| 环境变量 (env) | `.env` 或 `process.env` | 向后兼容，支持原有环境变量 |
| 默认值 (default) | `DEFAULT_CONFIG` | 代码内置的默认值 |

### 配置结构

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

| 配置段 | 字段 | 说明 | 默认值 |
|---|---|---|---|
| `model` | `name` / `baseUrl` / `apiKey` / `temperature` / `maxIterations` | LLM 模型配置（当前生效快照，运行时唯一读取点） | `gpt-4o-mini` 等 |
| `models` | `active` / `profiles` | 多模型登记簿（Task-20261011-002）：`profiles` 以别名为键登记各模型三元组（`name` / `baseUrl` / `apiKey`，可选 `temperature`），`active` 指向当前激活别名（空串 = 未纳入多模型管理）；`/model use <别名>` 会同步更新 `active` 与 `model.*` 快照 | `active: ""`、`profiles: {}` |
| `tools` | `enabled` / `disabled` / `mcpServers` | 内置工具开关与 MCP server 配置 | 全部启用 |
| `agent` | `verbose` | 是否输出 Thought/Action/Observation 控制台日志 | `true` |
| `agent` | `debug` | 是否开启文件调试日志（见 📝 调试日志） | `false` |
| `agent` | `systemPrompt` | 自定义 system prompt 覆盖 | `null` |
| `agent` | `showTokenStats` | 是否输出每轮/会话汇总 token 统计（Task-15） | `true` |
| `agent` | `loading` | 是否显示等待 loading 指示器（非 TTY 环境始终禁用，Task-20260930-001） | `true` |
| `session` | `autoSave` | `run()` 结束后自动保存会话到磁盘 | `true` |
| `session` | `autoRestore` | 启动时自动恢复最近会话 | `true` |
| `session` | `encryptionEnabled` | 会话文件是否加密存储（AES-256-GCM） | `true` |
| `skill` | `enabled` / `globalDir` / `workspaceDir` / `autoLoad` | Skill 技能包开关与扫描目录 | 全部启用 |
| `memory` | `enabled` / `working` / `episodic` / `curated` / `dreaming` / `vectorSearch` | 三层记忆系统配置（含检索增强） | 全部启用 |
| `vision` | `enabled` / `baseUrl` / `apiKey` / `model` / `temperature` / `maxTokens` / `timeoutMs` / `maxImageBytes` / `maxResultChars` / `cacheEnabled` / `cacheTtlMs` | 视觉模型配置（Task-20261010-001）；`baseUrl` / `apiKey` / `model` 为空时回退主模型 `model.*` 三元组 | `enabled: false`，其余见上方配置结构 |

### 环境变量（向后兼容）

| 环境变量 | 必填 | 说明 | 默认值 |
|---|---|---|---|
| `OPENAI_API_KEY` | ✅ | API Key | 无 |
| `OPENAI_BASE_URL` | ❌ | 模型服务地址 | `https://api.openai.com/v1` |
| `MODEL_NAME` | ❌ | 模型名称 | `gpt-4o-mini` |
| `MAX_ITERATIONS` | ❌ | Agent 最大迭代次数 | `10` |
| `VERBOSE` | ❌ | 是否输出 Thought/Action/Observation 日志（`true`/`false`） | `true` |
| `DEBUG` | ❌ | 是否开启文件调试日志（`true`/`false`，输出到 `~/.loop-agent/logs`） | `false` |

### 支持的 Base URL 示例

```env
# OpenAI
OPENAI_BASE_URL=https://api.openai.com/v1

# DeepSeek
OPENAI_BASE_URL=https://api.deepseek.com/v1

# Moonshot / Kimi
OPENAI_BASE_URL=https://api.moonshot.cn/v1

# 本地部署（vLLM / Ollama 等）
OPENAI_BASE_URL=http://localhost:8000/v1
```

### 运行时配置管理

通过 CLI 内置的 `/config` 命令可直接修改配置（写入 `.loop-agent/.agent-config.json`）：

```bash
# 查看当前完整配置及来源
/config list

# 修改模型名称（写入工作空间配置）
/config set model.name deepseek-chat

# 修改最大迭代次数
/config set model.maxIterations 20

# 开启调试日志
/config set agent.debug true

# 关闭会话自动保存
/config set session.autoSave false

# 写入全局配置（跨项目共享）
/config set model.name gpt-4 --global

# 删除某配置项（恢复为上层默认值）
/config delete model.name

# 查看配置文件路径
/config path
```

> 模型接入与切换建议用 `/model` 命令（详见 [内置命令](cli-usage.md#内置命令)）：`/model use <别名>` 会同步激活指针与生效快照，避免直接 `/config set model.name` 造成快照与登记簿漂移。
