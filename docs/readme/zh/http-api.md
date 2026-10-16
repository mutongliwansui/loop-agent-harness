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
  端点:    GET /health · POST /sessions · GET|DELETE /sessions/:id · POST /sessions/:id/messages
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

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康探针 `{status, version, model}` |
| POST | `/sessions` | 创建空会话 → 201 `{id, title, createdAt, ...}` |
| GET | `/sessions` | 会话列表 `{sessions: [...]}` |
| GET | `/sessions/:id` | 会话详情 `{meta, messages}`（恢复视图，不含 system） |
| DELETE | `/sessions/:id` | 删除会话 `{deleted: true}`（in-flight 时 409） |
| POST | `/sessions/:id/messages` | 发消息（默认 SSE 流式，`"stream": false` 切非流式 JSON） |

错误统一为 `{error: {code, message}}`：400 参数错误 / 401 未鉴权 / 403 非本机 / 404 不存在 / 405 方法不支持 / 409 会话忙 / 413 请求体超 2MB / 500 内部错误。

### SSE 流式事件

`POST /sessions/:id/messages` 默认以 `text/event-stream` 返回，把 Agent 全部 15 个事件钩子逐帧透传（`onXxx` → snake_case 事件名），最后由 API 层合成终态：

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
