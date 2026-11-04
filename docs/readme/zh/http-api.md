# 🌐 HTTP API 服务（--serve）

> [⬅ 返回 README](../../../README.md)

将 Agent 以 REST 服务常驻运行，供其他程序通过 HTTP 调用（零新增依赖，基于 `node:http`）。

### 启动

```bash
npm run serve
# 或
npx tsx src/index.ts --serve

# 临时覆盖端口（优先级最高，不写入配置文件）
npm run serve -- --port 3001

# 也可用环境变量（Windows PowerShell：$env:LOOP_AGENT_PORT=3001; npm run serve）
LOOP_AGENT_PORT=3001 npm run serve
```

```
HTTP API 服务已启动
  地址:    http://127.0.0.1:3000
  鉴权:    仅本机（未配置 api.token）
  端点:    /health · /status · /sessions · /uploads · /config · /tools · /models · /mcp · /skills · /memory
  提示:    Ctrl+C 退出；配置变更需重启生效
```

### 配置与鉴权

`config.json` 新增 `api` 段：

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
/config set api.token my-secret   # 设置后需重启服务生效
```

鉴权三态：

- **token 为空** → 仅接受本机请求（`127.0.0.1` / `::1`），其余返回 403
- **token 非空** → 所有请求强制 `Authorization: Bearer <token>`，否则 401
- **host 绑定非回环地址**（如 `0.0.0.0`）且未配置 token → 拒绝启动（防止裸奔暴露局域网）

### 端点

#### 会话与系统

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康探针 `{status, version, model}` |
| POST | `/sessions` | 创建空会话（body 可带 `{title?, workspacePath?}`；带 `workspacePath` 时**直接建在目标空间**，不切换"当前空间"）→ 201 `{id, title, createdAt, workspace: {path, id, switched}}`（`switched` 字段保留、恒为 `false`） |
| GET | `/sessions` | 当前空间（最近使用指针）的会话列表 `{sessions: [...]}` |
| GET | `/workspaces` | 跨工作空间聚合 `{workspaces: [{id, name, current, sessions}]}`（`current` 由最近使用指针标注；会话项含 `running` 与 `lastRun` 概要） |
| GET | `/sessions/:id` | 会话详情 `{meta, messages, run, lastRun, workspace}`（按 id 定位归属空间读取，**纯读不改变服务端状态**；`messages` 为全量历史，system 与压缩总结消息带 `is_show=false` 由前端过滤） |
| DELETE | `/sessions/:id` | 删除会话 `{deleted: true}`（归属空间内 in-flight 时 409；其他空间的运行不影响） |
| POST | `/sessions/:id/messages` | 发消息（默认 SSE 流式，`"stream": false` 切非流式 JSON；按 id 定位归属空间执行） |

#### 命令资源化（CLI 命令 → REST，10 组 40 端点）

**uploads（/upload 命令）**

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/uploads` | 上传文件 `{sessionId, paths: string[]}` → 201 `{entries, contextNote, failed}`（部分成功 201，全败 400；contextNote 仅返回不注入，由客户端随下轮 /messages 发送） |
| POST | `/uploads/raw?sessionId=` | 原始字节直传（body=文件字节，`X-File-Name`=encodeURIComponent 文件名）→ 201 `{fileName, bytes, contextNote}`；WebUI 的 📎 与输入框 Ctrl+V 粘贴（截图 / 资源管理器复制的文件）都走这里 |
| GET | `/uploads?sessionId=` | 列出会话上传文件 |
| GET | `/uploads/view?path=&disp=file\|raw` | 预览 uploads 文件（20261028-006）：`disp=file`（默认）返回 `{name, bytes, truncated, content}`（与 `/fs/file` 同构，>512KB 截断、二进制 400）；`disp=raw` 原始字节（图片直显，上限 100MB）。`path` 为相对 uploads 根的路径或含 `/.loop-agent/uploads/` 段的绝对路径（归一后必须位于 uploads 根内，`resolveInWs` + realpath 双重校验防穿越/逃逸，越界 403、不存在 404、缺参 400；20261028-007 起 `~` 开头输入先按 homedir 展开）。用途：对话流工具卡片路径 chip 点击预览视觉工具处理的 uploads 图片 |
| GET | `/userdir/view?path=&disp=file\|raw` | 预览自有数据目录文件（20261028-007）：root = `~/.loop-agent`（`ctx.userDir` 可注入）。校验链与 `/uploads/view` 完全同构（`resolveInWs` + realpath 双重校验，越界 403、不存在 404、缺参 400、二进制 400、>100MB 413），`disp=file`（默认）与 `/fs/file` 同构、`disp=raw` 原始字节。`path` 为相对 root 的路径（如 `memory/<wsId>/日期.md`）、绝对路径或 `~` 字面量（先按 homedir 展开）。用途：对话流工具卡片路径 chip 点击预览记忆 / runs 日志 / 全局技能 SKILL.md 等 `~/.loop-agent` 内文件 |
| DELETE | `/uploads?sessionId=` | 清空会话上传目录（动词即确认） |

`contextNote` 是注入 Agent 上下文的文本块：`[文件上传] <落盘名>` + 上传路径 + 大小；图片文件（png/jpg/jpeg/webp/gif/bmp）额外追加一行 `类型: 图片 <mime>（可用 ask_image / describe_image / extract_json / ocr_image 查看）`——否则主模型看到 `paste.png` 并不知道这是能看的图，容易用 `fileRead` 读出二进制垃圾。

**config（/config 命令）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/config` | 全量配置（secret 遮蔽） |
| GET | `/config/path` | 配置文件路径 `{globalPath, workspacePath, workspaceExists}` |
| GET | `/config/:key` | 单键读取 `{key, value, scope}`（secret 遮蔽） |
| PUT | `/config/:key` | 写单键 `{value, scope?}`（默认 workspace；api.* 返回 restartRequired） |
| DELETE | `/config/:key?scope=` | 删单键 `{deleted}` |

**status（REPL /status 快照）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/status` | 轻量快照 `{version, model, session, tools, mcp, memory, uploads}` |

**tools（/tools 命令）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/tools` | 工具快照 `{tools: [{name, description, enabled, source}]}`（内置 + MCP，vision 门控） |
| GET | `/tools/:name` | 工具详情（含 JSON Schema） |
| PATCH | `/tools/:name` | 启用/禁用内置工具 `{enabled, scope?}`（落盘 + 运行时同步） |
| POST | `/tools/reload` | 重载全部工具 `{reloaded}` |

**models（/model 命令）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/models` | profile 登记簿 `{profiles: [{alias, ..., isCurrent}]}` |
| GET | `/model` | 当前生效模型快照（apiKey 遮蔽） |
| PUT | `/model` | 切换激活 `{alias, scope?}`（ghost 409/404） |
| POST | `/models` | 登记 profile `{alias, profile, scope?}` → 201（同名 409） |
| DELETE | `/models/:alias?scope=` | 删除 profile `{deleted}`（当前激活 409；跨层 404 提示 scope） |
| POST | `/models/:alias/test` | 连通性测试 `{ok, latencyMs, error?}` |
| GET | `/models/bench` | 测速端点自述（档位 / 提示词 / 最多对比模型数 / 历史目录） |
| POST | `/models/bench` | 建测速 run `{aliases, tier?, prompts?, rounds?, maxTokens?, bustCache?}` → 202 `{runId, plan}`（`aliases` 最多 4 个，服务端串行） |
| GET | `/models/bench/:runId/stream` | SSE 进度：`start` / `model_start` / `round_start` / `first_token` / `token`（100ms 节流）/ `round_end` / `model_done` / `done` / `failed`；先回放已有事件，断线重连幂等 |
| POST | `/models/bench/:runId/stop` | 中断测速（幂等）`{runId, stopped, status}` |
| GET | `/models/bench/history?alias=&limit=` | 测速历史（不带 `alias` 每个模型只回最近一次；落 `~/.loop-agent/model-bench/history.json`，不存 apiKey） |

**mcp（/mcp 命令）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/mcp/servers` | 服务器列表 `{servers: [{name, transport, status, toolCount}]}` |
| GET | `/mcp/tool-meta` | MCP 工具展示元信息 `{tools: McpToolMeta[], summary}`（需求 20261104-001：中文展示名、参数标签、翻译状态；无 server 连接时返回空表而非 404，不参与 `toOpenAITools()`） |
| GET | `/mcp/servers/:name` | 服务器详情（含工具清单） |
| POST | `/mcp/servers` | 登记并连接 `{name, transport, command?/url?, ...}` → 201（同名 409；连接失败 502 但配置已落盘） |
| DELETE | `/mcp/servers/:name?scope=` | 先断连再删配置 `{deleted}` |
| POST | `/mcp/reload` | 全量重连 `{reconnected, failed}` |
| POST | `/mcp/servers/:name/test` | 连接测试 `{ok, latencyMs, tools, error?}` |

**skills（/skill 命令）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/skills` | 已加载技能 `{skills: [{name, description, scope, path}]}` |
| GET | `/skills/:name` | 技能详情（含正文） |
| POST | `/skills` | 从源目录安装 `{sourcePath, scope?, overwrite?}` → 201（同名未 overwrite 409） |
| DELETE | `/skills/:name?scope=` | 卸载技能 `{deleted, scope}` |
| POST | `/skills/reload` | 重载技能 `{loaded}` |

**memory（/memory 命令，未启用时 409）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/memory/status` | 分层状态 `{enabled, layers, counts, dreaming?}`（未启用恒 200 `{enabled:false,...}`；`dreaming` 为自动晋升状态，见下） |
| GET | `/memory/workspaces` | 聚合「有会话 ∪ 有记忆」的空间清单 `{workspaces: [{id, name, path, hasMemory, hasSession}]}`（会话侧来自 sessions 索引扫描，记忆侧来自 `{memoryDir}/*/` 目录扫描；仅有记忆的孤儿空间也列出） |
| GET | `/memory/curated?ws=` | 整理层三层文件全文 `{entries}`（`ws` 可选：空间 id 或绝对路径；缺省=缺省空间（最近使用，需求 20261027-004）；未知空间 404） |
| GET | `/memory/episodic?limit=&ws=` | 情景层日志 `{entries}`（`ws` 可选，语义同 curated；`limit` 1–90 天） |
| GET | `/memory/search?q=&limit=` | 跨层检索 `{results: [{content, score, layer}]}`（q 必填；当前空间） |
| GET | `/memory/gate` | 提升门阈值 + 近期判定 |
| POST | `/memory/dream` | 触发异步整理 → 202 `{accepted, reason?, skippedBecause?}`（已有晋升在跑回 `accepted:false`） |
| GET | `/memory/dream/schedule` | 读取当前定时排期 `{enabled, cron, describe, misfireGraceMin, nextRunAt, nextRunTimes, intervalMode}` |
| PUT | `/memory/dream/schedule` | 改排期 `{enabled?, cron?, misfireGraceMin?}` → 校验通过即**热重排（无需重启）**；非法 cron → 400 且**不落盘、不改现有排期** |
| GET | `/memory/dream/preview?cron=` | 输入期预览：`{ok:true, describe, next:[…5 个时刻], timezoneOffsetMin}`；非法 → **200** `{ok:false, error, fieldIndex?}`（预览不属于错误请求，前端单分支处理） |
| GET | `/memory/dream/history?limit=&scope=&ws=` | 最近触发记录 `{scope, runs:[{startedAt, finishedAt, durationMs, reason, ok, daysBack, promoted, skipped, errors, skippedBecause?, errorMessage?, catchup?, workspaceId?, workspaceName?, workspacePath?}]}`；`scope=all` 文件扫描聚合全部空间（不要求已装载），`scope=ws`（缺省）= 缺省空间（最近使用）；另有 `no-new-content` / `runtime-unavailable` 两种跳过原因 |
| DELETE | `/memory/dream/history?scope=&ws=` | 清空触发记录 `{deleted}`（跟随筛选范围；`all` 时遍历清空各空间记录，文件保留） |
| POST | `/memory/init` | 初始化分层目录（幂等） |

**`/memory/status` 的 `dreaming` 字段（自动晋升可观测）**

```json
{
  "enabled": true,
  "layers": { "episodic": { "dir": "…" }, "curated": { "workspace": "…", "files": {} } },
  "counts": { "episodicDays": 7, "gatePending": 0, "gateApproved": 12 },
  "dreaming": {
    "enabled": true,
    "scheduleEnabled": true,
    "intervalHours": 24,
    "startupDelayMin": 5,
    "cron": "0 3 * * *",
    "cronValid": true,
    "describe": "每天 03:00",
    "timezoneOffsetMin": 480,
    "misfireGraceMin": 60,
    "intervalMode": "cron",
    "nextRunTimes": ["2026-10-27T19:00:00.000Z", "2026-10-28T19:00:00.000Z", "2026-10-29T19:00:00.000Z"],
    "running": false,
    "lastRunAt": "2026-10-26T00:12:33.000Z",
    "lastSummary": { "reason": "schedule", "promoted": 3, "skipped": 1, "errors": 0, "ok": true },
    "lastProcessedDay": "2026-10-25",
    "nextRunAt": "2026-10-27T19:00:00.000Z"
  }
}
```

> `dreaming` 仅在调度器已装配（`--serve` 启动）且该工作空间已装载时出现；`memory.enabled=false` 时整个响应仍为
> `{enabled:false, layers:{}, counts:{}}`（200，不报错）。

字段说明（需求 `20261026-003` 新增项，旧字段保留一版以兼容）：

| 字段 | 说明 |
| --- | --- |
| `cron` / `cronValid` / `describe` | 当前表达式、是否合法、人类可读描述（如「每天 03:00」「每周一 09:00」「每周二、三、四 06:00」） |
| `intervalMode` | `cron`（默认）或 `interval`（`cron` 为空串时的旧语义回落） |
| `timezoneOffsetMin` | 服务器本地时区偏移（分钟，东八区为 `480`）；`nextRunAt(s)` 均为 UTC ISO 串，按此换算本地时间 |
| `misfireGraceMin` | 错过补跑宽限（分钟） |
| `nextRunTimes` | 未来 3 次触发时刻（UTC ISO），供 WebUI 直接渲染 |
| `intervalHours` / `startupDelayMin` | **已废弃**（仅 `intervalMode=interval` 时有意义），下一大版本移除 |


**vision（/vision 命令，诊断语义：失败不失败端点）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/vision` | 探测链状态 `{available, provider, model, reason?}` |
| POST | `/vision/test` | 发最小图片请求验证连通 `{ok, latencyMs, error?}` |

**doctor（/doctor 命令，只读体检）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/doctor` | 逐项检查 `{ok, checks: [{name, ok, level, detail}]}` |

**dev（自描述文档，需求 20261104-002）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/dev/api-docs` | 接口文档全量 `{version, groups: [{key, title, desc, items}], stats: {total, documented, undocumented}}`（**运行时反射 `createRoutes()`** 得到端点全集，叠加 `src/api/api-docs.ts` 元数据；`documented:false` 表示该端点尚未登记中文说明，同时列进 `stats.undocumented`） |

`/dev/api-docs` 与其它端点同一套鉴权（无 token 时仅本机可访问；配置 `api.token` 后须带 `Authorization: Bearer`），且**不经任何磁盘文件**：SEA 单文件分发下也无需 `docs/` 目录。WebUI 的「开发者中心」（`#/dev`）即消费此端点渲染分组列表、参数表与 curl 示例。

错误统一为 `{error: {code, message}}`：400 参数错误 / 401 未鉴权 / 403 非本机 / 404 不存在 / 405 方法不支持 / 409 冲突（会话忙 / 激活模型拒删 / 记忆未启用）/ 413 请求体超 2MB / 500 内部错误 / 502 上游连接失败（MCP）。

语义约定：

- **动词即确认**：DELETE/PUT/PATCH 替代 CLI 的 y/N 确认；skill 同名覆盖用 `overwrite: true` 显式声明；删当前激活模型直接 409（比确认更严格）
- **scope 统一**：写配置类端点一律 `?scope=workspace|global`（默认 workspace），与 CLI `--global` flag 对齐
- **诊断语义**：`/vision/test`、`/models/:alias/test`、`/mcp/servers/:name/test`、`/doctor` 检测失败也返回 200（`ok: false` + 明细），不失败端点

### SSE 流式事件

`POST /sessions/:id/messages` 默认以 `text/event-stream` 返回，把 Agent 全部 16 个事件钩子逐帧透传（`onXxx` → snake_case 事件名），最后由 API 层合成终态：

| 事件 | 载荷 | 说明 |
|------|------|------|
| `start` | `{input}` | Agent 启动 |
| `iteration_start` | `{iteration, maxIterations}` | 每轮迭代开始 |
| `llm_stream` | `{text}` | 流式输出片段 |
| `llm_end` | `{response, iteration}` | 单轮 LLM 响应完成 |
| `llm_stats` | `{stats}` | 单轮 token 统计 |
| `llm_stats_summary` | `{summary}` | 会话统计汇总 |
| `tool_start` / `tool_end` | `{tool, args}` / `{tool, result}` | 工具调用开始/结束 |
| `tool_progress` | `{tool, elapsedMs}` | 长耗时工具心跳 |
| `tool_call_delta` | `{tool, accumulatedBytes, elapsedMs}` | 工具参数流式增量 |
| `compaction_start` | `{info}` | L1 上下文压缩开始（pre-compaction flush 进行中） |
| `compaction` | `{info}` | L1 上下文压缩 |
| `final` | `{answer}` | 最终答案 |
| `error` | `{name, message}` | 非致命错误（可多次出现，非终态） |
| `warning` | `{level, message, context?}` | 警告（如持久化失败降级） |
| `end` | `{result}` | Agent 结束 |
| `done` | `{sessionId, durationMs, iterations, steps}` | API 合成终态（正常结束，最后一件） |
| `fatal` | `{message}` | API 合成终态（运行异常，随后关流） |

### curl 示例

```bash
# 创建会话（当前空间）
curl -X POST http://127.0.0.1:3000/sessions
# → {"id":"sess_8dcc67b6_20261016_103000","title":"...","messageCount":0,...}

# 创建会话（指定工作空间，直接建在目标空间，不切换"当前空间"）
curl -X POST http://127.0.0.1:3000/sessions \
  -H "Content-Type: application/json" \
  -d '{"workspacePath": "D:\\other-project"}'

# 发消息（SSE 流式，-N 关闭缓冲）
curl -N -X POST http://127.0.0.1:3000/sessions/sess_8dcc67b6_20261016_103000/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "帮我看看项目结构"}'

# 发消息（非流式 JSON）
curl -X POST http://127.0.0.1:3000/sessions/sess_8dcc67b6_20261016_103000/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "你好", "stream": false}'
# → {"sessionId":"...","answer":"...","iterations":1,"steps":[...],"durationMs":123}

# 配置 token 后访问
curl -H "Authorization: Bearer my-secret" http://127.0.0.1:3000/health

# 查看会话 / 删除会话
curl http://127.0.0.1:3000/sessions/sess_8dcc67b6_20261016_103000
curl -X DELETE http://127.0.0.1:3000/sessions/sess_8dcc67b6_20261016_103000
```

### 行为要点

- **多会话隔离**：各会话历史独立注入共享 agent（空历史走 `resetHistory`，非空显式 `messages`），互不串话
- **会话持久化**：回答完成后写入会话池（与 CLI 共用存储），服务重启后直接对已有会话 ID 发消息即可续聊
- **会话级互斥（按空间隔离）**：同一会话同时只处理一条消息，并发请求返回 409（`busy`）；互斥仅约束**同空间同会话**——A 空间有运行中的 run，不影响 B 空间新建/删除会话、发起新 run
- **跨工作空间并行**：每个空间由 `WorkspaceRegistry` 懒建独立的 `WorkspaceRuntime`（会话存储、配置、技能、记忆、Agent 池，LRU 上限 4）；进程级 `process.chdir` 已移除，工具相对路径以会话所属空间根为基准；全局并发信号量（8）限制同时运行的 run 总数
- **sessionId 空间命名空间**：新 id 形如 `sess_<wsId8>_<时间戳>`（如 `sess_8dcc67b6_20261016_103000`），按 id 即可定位归属空间，`GET /sessions/:id` 等端点不再触发"切换空间"；老格式 `sess_<时间戳>` 永久兼容读取
- **配置变更**（token/port/host）需重启服务生效
- **run journal（Task-20261021-002-06）**：每次 run 的生命周期（running/done/failed/aborted）落到 `<用户目录>/.loop-agent/sessions/<空间ID>/runs/<会话ID>.json`（随会话删除联动清理）；服务重启时启动扫描把上个进程遗留的 `running` 记录改写为 `interrupted`。`GET /sessions/:id` 响应含 `lastRun` 字段（journal 磁盘态），`GET /workspaces` 的会话项含 `lastRun: {status, finishedAt}` 概要——前端据此展示「上次运行被中断（服务已重启）」注记与侧栏 ⚠ 标记。诊断日志另写 `~/.loop-agent/logs/runs-YYYY-MM-DD.jsonl`（start/finish/abort/failed/interrupted 事件流）
