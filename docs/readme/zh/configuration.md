# ⚙️ 配置管理

> [⬅ 返回 README](../../../README.md)

支持多层配置系统，优先级从高到低为：**CLI 参数 > 工作空间配置 > 全局配置 > 环境变量 > 默认值**。

### 配置层级

| 层级 | 文件位置 | 说明 |
|---|---|---|
| CLI 参数 | 运行时传入 | 最高优先级，仅内存中生效（`--serve` 的 `--port` / `--host` / `--token` / `--web-root` 启动参数即属此层） |
| 工作空间 (workspace) | `{项目目录}/.loop-agent/.agent-config.json` | 项目级配置（.loop-agent/ 整体不进入版本控制） |
| 全局 (global) | `~/.loop-agent/config.json` | 用户级配置，跨项目共享 |
| 环境变量 (env) | `.env` 或 `process.env` | 向后兼容，支持原有环境变量 |
| 默认值 (default) | `DEFAULT_CONFIG` | 代码内置的默认值 |

> **多工作空间（serve 模式）**：每个工作空间持有独立的 ConfigLoader / ConfigWriter 实例，路径在构造期固定，运行期不再重绑——A 空间的 `/config` 读写不会影响 B 空间。CLI 单空间模式即启动目录，行为不变。

### 配置结构

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
      "outputLimitKb": 64,
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

| 配置段 | 字段 | 说明 | 默认值 |
|---|---|---|---|
| `model` | `name` / `baseUrl` / `apiKey` / `temperature` | LLM 模型配置（当前生效快照，运行时唯一读取点） | `gpt-4o-mini` 等 |
| `models` | `active` / `profiles` | 多模型登记簿（Task-20261011-002）：`profiles` 以别名为键登记各模型三元组（`name` / `baseUrl` / `apiKey`，可选 `temperature`），`active` 指向当前激活别名（空串 = 未纳入多模型管理）；`/model use <别名>` 会同步更新 `active` 与 `model.*` 快照 | `active: ""`、`profiles: {}` |
| `tools` | `enabled` / `disabled` / `mcpServers` | 内置工具开关与 MCP server 配置 | 全部启用 |
| `tools` | `mcpTranslate` | MCP 工具展示名中文化（需求 20261104-001）：`enabled` 总开关；`mode` 为 `auto`（描述已是中文则本地提炼，不调 LLM）或 `always`（一律走 LLM）；`timeoutMs` 单批超时；`maxToolsPerBatch` 单批工具数上限 | `{ enabled: true, mode: 'auto', timeoutMs: 20000, maxToolsPerBatch: 60 }` |
| `tools` | `backgroundLog` | 后台任务日志清理（需求 20261104-003）：`enabled` 总开关（启动期与每次后台启动前各清理一次）；`retentionDays` 已结束任务 `.json`+`.log` 保留天数；`maxTotalMb` `~/.loop-agent/runs/` 日志总量上限，超出按 mtime 从旧删起；运行中的活日志不截断 | `{ enabled: true, retentionDays: 7, maxTotalMb: 100 }` |
| `tools` | `commandRun` | 前台命令执行（需求 20261104-006）：`outputLimitKb` 返回内容总上限，头尾各占一半、中间省略并标注字节数（不再因 maxBuffer 失败），默认 64KB 与上下文预算对齐——过大单次输出会瞬间触发 L1 压缩、更早的工具结果只剩摘要；`timeoutMs` 未显式传 `timeout` 时的默认超时，长任务请用 `background:true` | `{ outputLimitKb: 64, timeoutMs: 30000 }` |
| `tools` | `backgroundNotify` | 后台任务完成通知（需求 20261104-004）：任务结束/被停止后，把完整提示与日志尾部注入原会话下一轮对话；`enabled` 总开关；`tailLines`/`maxChars` 日志尾部行数与字符上限；`wakeIdle` 空闲唤醒（需求 20261108-002，默认 `true`）：会话空闲期间后台命令任务完成时，API 服务以合成输入发起一轮唤醒 run 主动消费通知（镜像后台子 Agent 唤醒），唤醒输入不落盘为用户气泡；CLI 模式无运行循环，维持被动注入 | `{ enabled: true, tailLines: 20, maxChars: 2000, wakeIdle: true }` |
| `agent` | `verbose` | 是否输出 Thought/Action/Observation 控制台日志 | `true` |
| `agent` | `debug` | 是否开启文件调试日志（见 📝 调试日志） | `false` |
| `agent` | `systemPrompt` | 自定义 system prompt 覆盖 | `null` |
| `agent` | `showTokenStats` | 是否输出每轮/会话汇总 token 统计（Task-15） | `true` |
| `agent` | `loading` | 是否显示等待 loading 指示器（非 TTY 环境始终禁用，Task-20260930-001） | `true` |
| `agent` | `maxIterations` | 单次任务最大迭代次数 | `100` |
| `agent.subAgent` | `background` | 是否允许 `delegate({background:true})` 后台并行执行（关闭后委托一律同步阻塞） | `true` |
| `agent.subAgent` | `maxConcurrent` | 同一会话后台子任务并发上限，超限立即报错不排队 | `3` |
| `session` | `autoSave` | `run()` 结束后自动保存会话到磁盘 | `true` |
| `session` | `autoRestore` | 启动时自动恢复最近会话 | `true` |
| `session` | `encryptionEnabled` | 会话文件是否加密存储（AES-256-GCM） | `true` |
| `skill` | `enabled` / `globalDir` / `workspaceDir` / `autoLoad` | Skill 技能包开关与扫描目录 | 全部启用 |
| `memory` | `enabled` / `working` / `episodic` / `curated` / `dreaming` / `vectorSearch` | 三层记忆系统配置（含检索增强） | 全部启用 |
| `memory.dreaming` | `onExit` | 进程关停时是否自动晋升（语义已由「CLI 退出」扩为「任何宿主进程关停」：CLI 的 `quit`/`exit`/`Ctrl+C` 与 `--serve` 的 `Ctrl+C`/`SIGTERM`/`SIGBREAK` 共用） | `true` |
| `memory.dreaming` | `schedule.enabled` | `--serve`/WebUI 是否启用定时自动晋升（与 `onExit` 独立；CLI 不参与定时） | `true` |
| `memory.dreaming` | `schedule.cron` | 定时触发表达式（crontab 5 字段：分 时 日 月 周，**服务器本地时区**）。支持 `*` `,` `-` `/` 与 `@daily`/`@hourly`/`@weekly`/`@monthly`/`@yearly` 宏；「日」与「周」同时受限取并集（vixie 语义）；不支持 `L`/`W`/`#`/`?` 与 6 字段秒级。改后**热生效无需重启**（也可在 WebUI 记忆页直接改） | `"0 3 * * *"`（每天 03:00） |
| `memory.dreaming` | `schedule.misfireGraceMin` | 错过补跑宽限（分钟，`0`-`1440`）：迟于触发点但在此范围内 → 补跑一次并标 `catchup`；超出则只记一条「错过」不补跑 | `60` |
| `memory.dreaming` | `historyLimit` | 触发运行历史保留条数（环形裁剪，存 `{L2}/.dreaming-runs.json`）；`0` = 不留历史 | `20` |
| `memory.dreaming` | `schedule.intervalHours` | **已废弃**：仅在 `cron` 为空串时回落的固定间隔（小时） | `24` |
| `memory.dreaming` | `schedule.startupDelayMin` | **已废弃**：仅在 `cron` 为空串时回落的启动延迟（分钟） | `5` |
| `memory.dreaming` | `shutdownBudgetMs` | 关停兜底的总时间预算（毫秒）；超时打印警告后继续关停，不再等待 | `30000` |
| `memory.dreaming` | `maxDaysBack` | 读取窗口放大上限（天）：触发时按「距上次处理天数 + 1」放大 `daysBack`，修补停机多日的漏晋升 | `30` |
| `vision` | `enabled` / `baseUrl` / `apiKey` / `model` / `temperature` / `maxTokens` / `timeoutMs` / `maxImageBytes` / `maxResultChars` / `cacheEnabled` / `cacheTtlMs` | 视觉模型配置（Task-20261010-001）；`baseUrl` / `apiKey` / `model` 为空时回退主模型 `model.*` 三元组 | `enabled: false`，其余见上方配置结构 |
| `webui` | `terminal` | 是否启用 Web UI 文件预览区终端（终端 = 任意命令执行，**默认开启**；置 `false` 时 WS 握手 403） | `true` |
| `webui` | `terminalDeny` | 终端拒绝执行的命令关键字（**服务端**生效，命中即拒绝并审计；前端确认框不承担安全职责） | `[]` |
| `webui` | `terminalMax` | 单用户并发终端上限（超出返回 `too_many`；关闭页签会**立即**释放名额，页面刷新后最多 60s 释放） | `4` |
| `webui` | `terminalIdleMs` | 终端空闲回收毫秒数（WS 断开后保留 60s 供重连回放） | `1800000`（30 分钟） |

### 环境变量（向后兼容）

| 环境变量 | 必填 | 说明 | 默认值 |
|---|---|---|---|
| `OPENAI_API_KEY` | ✅ | API Key | 无 |
| `OPENAI_BASE_URL` | ❌ | 模型服务地址 | `https://api.openai.com/v1` |
| `MODEL_NAME` | ❌ | 模型名称 | `gpt-4o-mini` |
| `MAX_ITERATIONS` | ❌ | Agent 最大迭代次数 | `100` |
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
/config set agent.maxIterations 20

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
