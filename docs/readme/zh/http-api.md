# 🌐 HTTP API 服务（--serve）

> [⬅ 返回 README](../../../README.md)

将 Agent 以 REST 服务常驻运行，供其他程序通过 HTTP 调用（零新增依赖，基于 `node:http`）。

### 启动

```bash
npm run serve
# 或
npx tsx src/index.ts --serve
```

```
HTTP API 服务已启动
  地址:    http://127.0.0.1:3000
  鉴权:    仅本机（未配置 api.token）
  端点:    46 个（会话 5 + 健康 1 + 命令资源化 40），详见下方端点表
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
| POST | `/sessions` | 创建空会话 → 201 `{id, title, createdAt, ...}` |
| GET | `/sessions` | 会话列表 `{sessions: [...]}` |
| GET | `/sessions/:id` | 会话详情 `{meta, messages}`（恢复视图，不含 system） |
| DELETE | `/sessions/:id` | 删除会话 `{deleted: true}`（in-flight 时 409） |
| POST | `/sessions/:id/messages` | 发消息（默认 SSE 流式，`"stream": false` 切非流式 JSON） |

#### 命令资源化（CLI 命令 → REST，10 组 40 端点）

**uploads（/upload 命令）**

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/uploads` | 上传文件 `{sessionId, paths: string[]}` → 201 `{entries, contextNote, failed}`（部分成功 201，全败 400；contextNote 仅返回不注入，由客户端随下轮 /messages 发送） |
| GET | `/uploads?sessionId=` | 列出会话上传文件 |
| DELETE | `/uploads?sessionId=` | 清空会话上传目录（动词即确认） |

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

**mcp（/mcp 命令）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/mcp/servers` | 服务器列表 `{servers: [{name, transport, status, toolCount}]}` |
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
| GET | `/memory/status` | 分层状态 `{enabled, layers, counts}`（未启用恒 200 `{enabled:false,...}`） |
| GET | `/memory/curated` | 整理层三层文件全文 `{entries}` |
| GET | `/memory/episodic?limit=` | 情景层日志 `{entries}` |
| GET | `/memory/search?q=&limit=` | 跨层检索 `{results: [{content, score, layer}]}`（q 必填） |
| GET | `/memory/gate` | 提升门阈值 + 近期判定 |
| POST | `/memory/dream` | 触发异步整理 → 202 `{accepted}` |
| POST | `/memory/init` | 初始化分层目录（幂等） |

**vision（/vision 命令，诊断语义：失败不失败端点）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/vision` | 探测链状态 `{available, provider, model, reason?}` |
| POST | `/vision/test` | 发最小图片请求验证连通 `{ok, latencyMs, error?}` |

**doctor（/doctor 命令，只读体检）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/doctor` | 逐项检查 `{ok, checks: [{name, ok, level, detail}]}` |

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
# 创建会话
curl -X POST http://127.0.0.1:3000/sessions
# → {"id":"sess_20261016_103000","title":"...","messageCount":0}

# 发消息（SSE 流式，-N 关闭缓冲）
curl -N -X POST http://127.0.0.1:3000/sessions/sess_20261016_103000/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "帮我看看项目结构"}'

# 发消息（非流式 JSON）
curl -X POST http://127.0.0.1:3000/sessions/sess_20261016_103000/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "你好", "stream": false}'
# → {"sessionId":"...","answer":"...","iterations":1,"steps":[...],"durationMs":123}

# 配置 token 后访问
curl -H "Authorization: Bearer my-secret" http://127.0.0.1:3000/health

# 查看会话 / 删除会话
curl http://127.0.0.1:3000/sessions/sess_20261016_103000
curl -X DELETE http://127.0.0.1:3000/sessions/sess_20261016_103000
```

### 行为要点

- **多会话隔离**：各会话历史独立注入共享 agent（空历史走 `resetHistory`，非空显式 `messages`），互不串话
- **会话持久化**：回答完成后写入会话池（与 CLI 共用存储），服务重启后直接对已有会话 ID 发消息即可续聊
- **会话级互斥**：同一会话同时只处理一条消息，并发请求返回 409；不同会话可并行
- **配置变更**（token/port/host）需重启服务生效
