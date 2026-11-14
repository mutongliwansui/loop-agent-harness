# 📖 CLI 使用

> [⬅ 返回 README](../../../README.md)

```bash
npm start
```

启动后进入交互式 REPL 控制台：

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃            ReAct Agent 交互式控制台                      ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛

模型: gpt-4o-mini (workspace)
BaseURL: https://api.openai.com/v1 (env)
最大迭代: 100
内置工具: [commandRun, fileRead, fileWrite, editFile, grep, activate_skill]
MCP 工具: 3 个, Servers: atlasGraphMcp (atlasGraphMcp__toolName)
Skills: 2 个 (example-skill, py-pptx)
⚠ 调试模式已开启，日志输出到: ~/.loop-agent/logs

Agent> 帮我读取 package.json 的版本号
```

> 若配置中开启了 `agent.debug`，启动时会额外提示调试日志输出目录（见 [📝 调试日志](./debug-logging.md)）。

> 运行期间，在模型生成（尤其工具调用参数）与工具执行等耗时阶段会显示 loading 指示器（如「思考中…（第 N 轮）」「生成参数：fileWrite…（12.3KB / 8s）」「执行中：grep…」），让等待过程有实时反馈；日志/流式 Thought/最终答案打印前会先清除指示器行，二者不会混行。该指示器仅在交互式 TTY 下启用，管道、重定向与 CI 环境下自动关闭、零输出。

### 内置命令

| 命令 | 说明 |
|---|---|
| `输入问题` | Agent 流式输出 Thought / Action / Observation / Final |
| `/help` | 查看全局帮助信息；任意命令后加 `help`（如 `/mcp help`）查看其子命令用法 |
| `/reset` `/clear` | 清空多轮对话历史，开始新会话 |
| `/status` | 查看当前会话状态（消息数 / 工具数 / MCP 工具数 / Skills） |
| `/jobs` | 后台任务列表（命令 + 子任务，当前会话 + 无归属）；`/jobs show <id>` 查看摘要 |
| `/tools` | 工具管理（list / enable / disable / reload） |
| `/config` | 配置管理（get / set / delete / list / path） |
| `/mcp` | MCP 管理（list / add / remove / reload / test / view） |
| `/session` | 会话管理（list / load / save / new / current / delete / delete-all） |
| `/skill` | Skill 管理（list / reload / show / upload / remove） |
| `/memory` | 记忆管理（status / curated / episodic / search / dream / gate / init） |
| `/vision` | 视觉模型管理（status / test） |
| `/model` | 多模型管理（list / use / add / remove / test / bench） |
| `/upload` | 文件上传（复制到会话隔离上传目录并注入 Agent 上下文；list / clean） |
| `/setup` | 重跑初始化配置向导（配置一律写全局） |
| `/doctor` | 启动体检：逐项检测模型配置 / 配置文件 / skills 目录（只读） |
| `exit` / `quit` / `退出` | 退出程序（Ctrl+C 连按两次同样有效） |
| `Ctrl+C` | **回答中**：只中断本次回答（停止流式输出与工具执行，已生成内容保留到会话，可继续追问）；**测速等可中断命令执行中**：只中断该命令（如 `/model bench` 保留已完成样本）；**空闲时**：3 秒内连按两次才退出（防误触） |

> **Tab 自动补全**：在提示符下按 `Tab` 可逐级补全——
> - **命令**：输入 `/con` 再按 `Tab` 自动补全为 `/config`；
> - **子命令**：输入 `/config ` 再按 `Tab` 列出并补全子命令（`list/get/set/delete/path`）；
> - **动态参数**：`/session load ` 补真实会话 id、`/tools enable ` 补内置工具名、`/skill show / remove ` 补技能名、`/mcp test / view ` 补 server 名、`/model use / remove / test / bench ` 补已登记模型别名、`/config get / set / delete ` 补配置项名（如 `model.name`、`vision.enabled`）、`/upload ` 补 `list / clean` 子命令；
> - **单词命令**：`hel` → `help`、`ex` → `exit`。
>
> 多候选时按 `Tab` 会补全公共前缀并列出全部候选；普通提问（非 `/` 开头、含空格或中文）按 `Tab` 无任何副作用。
>
> **子命令帮助**：任意命令后加 `help`（或简写 `-h` / `--help`）即可查看该命令的子命令用法，如 `/mcp help`、`/skill help`、`/config help`——无需记忆全局 `/help`。

### 输出示例

```
━━━ 迭代 1/10 ━━━

[Thought] 我需要读取 package.json 文件来获取版本号...

[Action] fileRead({"path":"package.json"})
[Observation]
  1: {
  2:   "name": "loop-agent-command",
  3:   "version": "0.1.0",
  4:   ...
  5: }

━━━ Final Answer ━━━
项目名称为 loop-agent-command，版本号为 0.1.0。

━━━ 完成（1 轮，1 步） ━━━
```

### CLI 命令详解

#### `/config` — 配置管理

配置只剩全局一份（需求 20261112-008 后工作空间级配置已移除）：

```
/config list                    # 查看当前生效配置（含每一字段的来源标记）
/config get <key>               # 查看某个配置项（如 model.name）
/config set <key> <value>       # 设置配置项（写全局；--global 可省略）
/config delete <key>            # 删除某配置项
/config path                    # 查看全局配置文件路径
```

`--workspace` 已移除，传入会明确报错中止；`--global` 保留但可省略。

配置值支持自动识别类型：`true`/`false` 为布尔值，数字自动转为 Number，`{...}` 或 `[...]` 自动解析为 JSON。

#### `/mcp` — MCP 管理

```
/mcp list                       # 列出所有 MCP Server 配置及连接状态
/mcp add <name>                 # 交互式添加新 MCP Server
/mcp remove <name>              # 移除指定 MCP Server
/mcp reload                     # 重新加载全部 MCP 配置
/mcp test <name>                # 测试连接指定 MCP Server
/mcp view <name>                # 查看指定 MCP Server 的服务信息与工具清单
/mcp help                       # 查看 /mcp 的子命令用法
```

> `/mcp view <name>` 展示服务名称、传输配置、连接状态与该服务下的工具清单（工具名 + 描述）：已连接的 Server 直接读取已注册工具（零开销），未连接的会临时连接查询后自动断开（与 `/mcp test` 同款模式），无需先 `/mcp reload`。

#### `/tools` — 工具管理

```
/tools list                     # 列出所有已注册工具（内置 + MCP）
/tools enable <name>            # 启用内置工具
/tools disable <name>           # 禁用内置工具
/tools reload                   # 重新加载所有工具
```

#### `/session` — 会话管理

```
/session list                   # 列出当前工作空间所有会话（ID / 标题 / 消息数 / 时间）
/session current                # 查看当前会话详情
/session load <id>              # 加载指定会话，恢复历史对话
/session save                   # 手动保存当前会话
/session new                    # 新建会话（旧会话自动保存）
/session delete <id>            # 删除指定会话
/session delete-all             # 删除当前工作空间的所有会话（需二次确认）
```

会话列表输出示例：

```
当前工作空间会话 (2 个):
  sess_20260806_143022 [当前] 2026/08/06 14:30:22 [5条] 帮我读取 package.json 的版本号
  sess_20260805_210011        2026/08/05 21:00:11 [3条] 搜索 src 目录中的 config
```

会话数据以 AES-256-GCM 加密存储在 `~/.loop-agent/sessions/` 目录（按工作空间隔离），详见 [💾 会话持久化](./session-persistence.md)。

#### `/skill` — Skill 管理

```
/skill list                     # 列出所有可用 Skill（全局唯一目录）
/skill reload                   # 重新扫描 Skill 目录
/skill show <name>              # 显示指定 Skill 的 SKILL.md 完整内容
/skill upload <目录...>         # 安装本地 Skill 目录（一律装到全局；同名冲突询问覆盖）
/skill upload                   # 无参：弹出系统目录选择框（Windows/macOS/Linux 探测可用工具）
/skill remove <name...>         # 删除已安装 Skill（全局唯一目录；逐个 y/N 确认）
```

Skill 只从全局 `~/.loop-agent/skills/` 一个目录自动扫描（需求 20261112-008 后工作空间目录不再使用）。详见 [🎯 Skill 技能包](./skills.md)。

`/skill upload` 支持拖拽目录到终端（引号 / `file://` URI 自动归一）与多目录批量安装；安装前校验目标含合法 `SKILL.md`（name/description），单项失败不阻断其余，安装完成后自动重新扫描立即可用。

`/skill remove` 按 frontmatter `name` 定位并删除整个 Skill 目录（skill 目录已收敛为全局唯一，`--global` / `--workspace` 两个 flag 均已移除，传 `--workspace` 会明确报错）：删除前逐个确认（默认 N），内置路径护栏（目标必须是 skills 根的直接子目录，防路径穿越），删除后自动重新扫描，`/skill list` 立即不可见；支持批量删除，单项失败不阻断其余。

#### `/memory` — 记忆管理

```
/memory status                          # 查看记忆系统状态（L1/L2/L3 各层统计）
/memory curated list                    # 列出 L3 核心记忆文件（SOUL / USER / MEMORY）
/memory curated read <soul|user|memory> # 读取指定核心记忆文件内容
/memory curated append <key> <内容>      # 向核心记忆文件追加一条事实
/memory episodic list                   # 列出 L2 情景记忆日志（按天）
/memory episodic read <YYYY-MM-DD>      # 读取指定日期的情景记忆
/memory search <关键词>                  # 搜索 L2 情景记忆（返回相关片段）
/memory dream [天数]                    # 手动触发 Dreaming 巡检（晋升 L2 → L3）
/memory gate                            # 查看 Promotion Gate 待确认/待晋升事实
/memory init                            # 初始化 L3 核心记忆文件
```

详见 [🧠 记忆管理](./memory-management.md)。

#### `/vision` — 视觉模型管理

```
/vision status                  # 查看视觉模型配置（启用状态 / 三元组来源标记 / apiKey 掩码 / 缓存状态 / 会话累计统计）
/vision test                    # 用 1x1 PNG 做连通性测试（校验 baseUrl / apiKey / model 是否可用）
```

视觉三元组（`vision.baseUrl` / `vision.apiKey` / `vision.model`）为空时自动回退主模型 `model.*`，同一服务商多模型零重复配置。启用方式：

```
/config set vision.enabled true    # 立即生效：自动注册视觉工具（设为 false / delete 时自动注销），无需 /tools reload
/config set vision.model gpt-4o    # 不设置则回退主模型 model.name
```

启用后注册 `analyzeImage`（图片理解，20261111-004 起把描述 / 定向问答 / 结构化提取三合一为单工具）；文字识别工具 `ocrImage` 不依赖视觉模型，按 `ocr.enabled` + 本机引擎探测单独注册（详见 [🔧 内置工具](./built-in-tools.md)、[配置说明](./configuration.md)）。

#### `/model` — 多模型接入与切换

把多个 OpenAI 协议模型登记到登记簿（`models.profiles`，以别名为键），用别名一键切换当前生效模型（`model.*` 快照），写盘即生效、无需重启：

```
/model list                  # 列出登记簿与当前生效快照（含 apiKey 掩码与漂移检测提示）
/model use <别名>            # 切换到已登记模型（同步激活指针与生效快照，立即生效）
/model add <别名>            # 登记新模型（写全局）
/model remove <别名>         # 从登记簿移除（不影响当前生效快照）
/model test <别名>           # 对已登记模型做连通性测试（不改变激活状态）
```

设计要点：

- **登记簿 + 激活指针**：`models.profiles` 只做登记，`models.active` 指向当前激活别名；`/model use` 会同时写入激活指针与 `model.*` 生效快照——运行时只读 `model.*` 一处，主模型、视觉回退三元组、记忆系统（Dreaming / 压缩）全部跟随新模型。
- **单一全局层**：登记簿 `models.profiles` 只存在于全局配置，不再按「全局 → 工作空间」分层合并；`temperature` 未登记的模型切换时不覆盖现有采样温度。
- **漂移检测**：`/model list` 与启动 Banner 会比对激活别名与生效快照（只比 name + baseUrl，apiKey 轮换不算漂移），不一致时提示执行 `/model use <别名>` 重新同步。
- **向导联动**：首次启动向导写入模型时，若登记簿为空会自动登记为 `default` 别名，之后接入第二个模型即可随时 `/model use default` 回切。

配置示例（全局 `~/.loop-agent/config.json`）：

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

#### `/model bench` — 模型性能测速（与 WebUI 同一引擎）

`/model test` 只回答「通不通、往返多久」；`/model bench` 回答的是「**多快**」——它复用 WebUI 测速的同一套引擎（`src/llm/bench.ts` `runBench`）与同一份历史文件（`~/.loop-agent/model-bench/history.json`），因此 CLI 与 WebUI 的数字口径完全一致，两端的数据互相可见：

```
/model bench                          # 测当前激活模型（quick 档，秒级出结果）
/model bench deepseek glm             # 横向对比两个模型（最多 4 个，严格串行）
/model bench --all                    # 测全部已登记模型（取前 4 个，被忽略的会明确列出）
/model bench deepseek --tier standard # 标准档（2 档 × 3 轮，约 30–90s）
/model bench --json                   # 只输出 JSON，供 CI / 脚本消费
/model bench history                  # 历史（缺省每个模型最近一次）
/model bench history deepseek --limit 5   # 某模型最近 5 次的走势
```

可选参数（位置参数只放别名，其余一律 `--flag`）：

| 参数 | 说明 |
|---|---|
| `--tier quick\|standard` | 档位，默认 `quick`（1 档 1 轮）；`standard` 为 2 档 3 轮 |
| `--rounds 1-10` | 每档轮数（覆盖档位预设） |
| `--prompts short,medium,code` | 提示词档位（覆盖档位预设） |
| `--max-tokens 32-1024` | 输出上限，默认 256 |
| `--timeout 5-180` | 单轮超时秒数，默认 60 |
| `--no-bust-cache` | 不破坏前缀缓存（TTFT 含缓存收益，跨模型不可比） |
| `--json` | 只输出结构化结果，无动画、无颜色、无提示文案 |
| `--limit 1-20` | `history` 的条数上限 |

结果表列：`别名 | 型号 | TTFT | TPOT | 解码 TPS | 端到端 TPS | ITL p90 | 成功率 | 样本`；多模型并排，每列最优加 `*` 高亮（无颜色环境同样可辨），有历史时附「相比上次」变化。

设计要点：

- **单一测量口径**：所有测量参数（`temperature:0`、`max_tokens`、破坏前缀缓存、分位统计）都走引擎既有默认，CLI 侧不另算一套——否则与 WebUI 的数字不可比，测速就失去意义。
- **前置整体校验**：别名拼错或 profile 缺 `apiKey` 在开跑**前**拦截并列出可用别名，不会「跑一半才发现第 3 个模型拼错」。
- **实时读数**：TTY 下固定 3 行原地刷新（当前轮次 / 已出 token 与实时 TPS / TTFT 与成功失败计数）；管道、重定向、CI 等非 TTY 场景降级为逐轮一行，无 `\r`、无转义序列、无颜色。
- **Ctrl+C 只停测速**：已完成样本照常汇总并落盘，表头标注「已中断 n/m」，随后回到 `Agent>`——进程不退出，可立刻重跑。
- **失败样本不丢弃**：401 / 404 / 429 / 超时 / 网络错误按既有 `classifyBenchError` 分类，计入成功率分母；表格同时给出失败分类计数与主因说明。
- **历史落盘**：写入与 WebUI 共享的 `history.json`（每模型保留 20 次、只存 host 不存 apiKey、临时文件 + rename 原子写），写入失败只告警不阻断结果。
- **quick 档脚注**：quick 档首轮 TTFT 含 DNS + TCP + TLS 建连开销；要严格可比请用 `--tier standard`（多轮取 p50）。
- **快照回落**：未设置 `models.active` 时回落生效快照，别名显示为 `(当前快照)` 且不写历史（它不在登记簿里，写进去会污染趋势）。

#### `/upload` — 文件上传（会话隔离上传目录）

把本地文件复制到 Agent 的全局上传目录（`~/.loop-agent/uploads/{会话ID}/`），并把上传路径注入当前会话上下文——Agent 在后续对话中自动"知道"文件，可直接用 `fileRead` / `commandRun` / 视觉工具处理，无需口头转述路径：

```
/upload <路径...>         # 上传一个或多个文件（可拖拽到终端，自动解析带引号路径）
/upload                   # 无参：弹出系统文件选择框（多选；Windows/macOS/Linux 探测可用工具）
/upload list              # 列出当前会话已上传文件
/upload clean             # 清理当前会话的上传目录（y/n 确认）
```

设计要点：

- **会话隔离**：物理目录按会话分隔（`uploads/{sessionId}/`），`/session delete` / `delete-all` 连带清理；跨会话互不可见，且不污染工作空间 git 工作区
- **Agent 感知**：上传成功后注入 `[文件上传]` 上下文消息（路径 + 大小），随 autoSave 持久化、`/session load` 恢复后依然有效；不自动触发回答，上传是准备动作
- **跨平台归一**：终端拖拽格式各异（Windows 引号路径 / Linux GNOME `file://` URI / Konsole 转义空格），统一解析为本地路径；无参弹框按平台探测 `PowerShell + WinForms` / `osascript` / `zenity → kdialog → yad`，全部不可用时优雅降级为拖拽/路径参数
- **防覆盖与上限**：文件名加时间戳前缀防重名；单文件上限 100MB；目录不支持直接上传（提示压缩后上传）
- **零依赖**：仅 `node:fs` / `node:child_process`，无 npm 新增依赖

#### `/setup` — 重跑初始化向导

在 REPL 内重新运行首次启动的配置向导，流程一致：baseUrl → apiKey（遮蔽输入）→ 模型名 → 连通性校验。配置一律写入全局 `~/.loop-agent/config.json`（写入层已收敛为全局，`--global` / `--workspace` 均已移除，传 `--workspace` 会明确报错）。完成后立即重新加载配置并刷新工具注册，后续对话即时生效，无需重启：

```
/setup                     # 重跑向导，配置写全局
```

写入前若目标文件存在但内容损坏（非法 JSON），会自动备份为 `.bak-<时间戳>`。

#### `/doctor` — 启动体检

只读检查当前环境是否具备正常对话条件，逐项输出三态报告（✓ 正常 / ✗ 阻断 / ! 警告），不修改任何文件：

```
/doctor
启动体检报告

  ✓ 主模型 apiKey
  ✓ 主模型名称
  ✗ 全局配置文件：<原因>（首次写入配置时自动创建）
  ! 全局 skills 目录：<原因> → ~/.loop-agent/skills
  ……

  ✓ 阻断项 0 个，主模型配置齐备，可正常对话
  本命令只读，不修改任何文件
```

共 4 个检测项：主模型 apiKey、主模型名称、全局配置文件、全局 skills 目录；✗ 项附带修复提示（如「运行 /setup 重新配置」）。
