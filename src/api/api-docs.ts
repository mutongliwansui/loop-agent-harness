// 开放 API 文档元数据（需求 20261104-002 · 方案 D1/D2/D3）
//
// 分层职责：
// - 端点全集 = `src/api/router.ts` 的 createRoutes()（运行时反射，唯一真源，新端点不可能漏）
// - 端点语义 = 本文件的 API_DOC_ENTRIES（中文说明 / 参数 / 请求体 / 响应 / curl 示例）
//
// 本模块是纯数据 + 纯函数，无 IO、不 import router.ts（避免 router → handlers/dev → api-docs 的循环依赖），
// 便于在 Node 下单测。元数据缺口的端点由 collectApiDocs 标 documented:false，
// 前端灰标「说明待补」、单测列出缺口清单 —— 文档漂移可观测，不静默（D3）。

/** 参数位置：path 段参数 / query 查询参数 / body 请求体字段 */
export type ApiDocParamIn = 'path' | 'query' | 'body';

/** 单个参数（或请求体字段）说明 */
export interface ApiDocParam {
  name: string;
  in: ApiDocParamIn;
  /** 类型描述（string / number / boolean / string[] / object …） */
  type: string;
  /** 是否必填（缺省 false） */
  required?: boolean;
  desc: string;
}

/** 单个端点的语义说明（键为 `METHOD /path`） */
export interface ApiDocEntry {
  /** 中文一句话说明（非空，P1 要求全量覆盖） */
  summary: string;
  params?: ApiDocParam[];
  /** 请求体结构说明（多行文本） */
  body?: string;
  /** 响应结构说明（多行文本） */
  response?: string;
  /** curl 示例：不含 base URL（前端用 location.origin 拼接，方案 D9） */
  example?: string;
  /** 是否 SSE 流式响应 */
  stream?: boolean;
  /** read=只读查询，write=有副作用（前端打标签） */
  scope?: 'read' | 'write';
}

/**
 * 端点语义表：键为 `METHOD /path`（path 与路由表逐字一致，含 `:param`）。
 *
 * 维护约定：
 * 1. 新增路由后必须在此补一条，否则 `tests/api-docs.test.ts` 会失败并列出缺口键；
 * 2. summary 必填且为中文一句话；params/body/response/example 可选（方案 D12：结构支持全字段、按需补齐）；
 * 3. example 里不写 base URL，只写 `curl ... /path`，前端按 location.origin 拼。
 */
export const API_DOC_ENTRIES: Record<string, ApiDocEntry> = {
  /* ================= 会话与系统 ================= */
  'GET /health': {
    summary: '健康探针：返回服务状态、版本号与当前激活模型名。',
    scope: 'read',
    response: '{ "status": "ok", "version": "0.1.0", "model": "deepseek-chat" }',
    example: 'curl /health',
  },
  'POST /sessions': {
    summary: '创建空会话；可指定标题，也可指定工作空间（直接建在目标空间，不切换「最近使用」指针）。',
    scope: 'write',
    params: [
      { name: 'title', in: 'body', type: 'string', desc: '会话标题，缺省由首条消息生成' },
      { name: 'workspacePath', in: 'body', type: 'string', desc: '目标工作空间绝对路径；缺省用最近使用空间' },
    ],
    body: '{ "title?": "string", "workspacePath?": "string" }',
    response: '201 { id, title, createdAt, workspace: { path, id, switched } }',
    example: 'curl -X POST /sessions -H "Content-Type: application/json" -d \'{"title":"调试"}\'',
  },
  'GET /sessions': {
    summary: '列出缺省空间（最近使用）的会话列表。',
    scope: 'read',
    response: '{ "sessions": [ { id, title, createdAt, messageCount, running, lastRun } ] }',
    example: 'curl /sessions',
  },
  'GET /fs/dirs': {
    summary: '浏览服务端目录（新建会话选择工作空间用），返回子目录清单。',
    scope: 'read',
    params: [{ name: 'path', in: 'query', type: 'string', desc: '要列出的目录绝对路径，缺省为最近使用空间' }],
    example: 'curl "/fs/dirs?path=D%3A%5Ctrae_workspace"',
  },
  'GET /workspaces': {
    summary: '跨工作空间聚合会话，标注最近使用空间与各会话运行状态。',
    scope: 'read',
    response: '{ "workspaces": [ { id, name, path, current, sessions: [ { id, title, running, lastRun } ] } ] }',
    example: 'curl /workspaces',
  },
  'POST /sessions/:id/messages': {
    summary: '给会话发消息并执行一轮 ReAct；默认 SSE 流式，stream=false 时返回一次性 JSON。',
    scope: 'write',
    stream: true,
    params: [
      { name: 'id', in: 'path', type: 'string', required: true, desc: '会话 id（形如 sess_<wsId8>_<时间戳>）' },
      { name: 'message', in: 'body', type: 'string', required: true, desc: '用户消息正文' },
      { name: 'stream', in: 'body', type: 'boolean', desc: '是否 SSE 流式，默认 true；false 返回 JSON' },
    ],
    body: '{ "message": "string", "stream?": true }',
    response: 'SSE：event: <type> + data: <JSON>；非流式：{ sessionId, answer, iterations, steps, durationMs }',
    example:
      'curl -N -X POST /sessions/<id>/messages -H "Content-Type: application/json" -d \'{"message":"你好"}\'',
  },
  'GET /sessions/:id/stream': {
    summary: '附着当前 run 的事件流续传（断线重连先回放缓冲区，再追新事件）。',
    scope: 'read',
    stream: true,
    params: [
      { name: 'id', in: 'path', type: 'string', required: true, desc: '会话 id' },
      { name: 'cursor', in: 'query', type: 'number', desc: '已收到的事件序号，从其后开始续传' },
    ],
    example: 'curl -N "/sessions/<id>/stream?cursor=0"',
  },
  'POST /sessions/:id/stop': {
    summary: '停止当前 run：无运行 204、已受理 202、会话不存在 404。',
    scope: 'write',
    params: [{ name: 'id', in: 'path', type: 'string', required: true, desc: '会话 id' }],
    example: 'curl -X POST /sessions/<id>/stop',
  },
  'GET /sessions/:id/context': {
    summary: '上下文用量（真实 llm_stats 优先，历史会话回退本地估算并标记 source=estimate）。',
    scope: 'read',
    params: [{ name: 'id', in: 'path', type: 'string', required: true, desc: '会话 id' }],
    response:
      '{ contextTokens, maxTokens, threshold, percent, keepRecentTurns, source: "stats" | "estimate", updatedAt? }',
    example: 'curl /sessions/<id>/context',
  },
  'GET /sessions/:id/subagents': {
    summary: '后台子任务列表（运行期内存状态：running/done/failed/aborted；结果卡片已落盘到会话）。',
    scope: 'read',
    params: [{ name: 'id', in: 'path', type: 'string', required: true, desc: '会话 id' }],
    response:
      '{ items: [{ taskId, task, status, startedAt, finishedAt?, elapsedMs?, iterations?, answer?, error?, trace? }] }',
    example: 'curl /sessions/<id>/subagents',
  },
  'POST /sessions/:id/compact': {
    summary: '空闲时强制 L1 压缩（运行中 409）；无可丢弃消息返回 ok=false reason=nothing_to_compact，不调 LLM。',
    scope: 'write',
    params: [{ name: 'id', in: 'path', type: 'string', required: true, desc: '会话 id' }],
    response:
      '{ ok, reason?, fallback?, beforeTokens?, afterTokens?, droppedCount?, keptMessages?, contextTokens?, maxTokens?, threshold? }',
    example: 'curl -X POST /sessions/<id>/compact',
  },
  'POST /sessions/:id/retry': {
    summary: '替换式重试：seq 指向助手回答，后端向前找该轮用户文本，截断其后全部消息后重新生成（SSE）。',
    scope: 'write',
    stream: true,
    params: [
      { name: 'id', in: 'path', type: 'string', required: true, desc: '会话 id' },
      { name: 'seq', in: 'body', type: 'number', required: true, desc: '目标助手回答在会话恢复视图中的下标' },
      { name: 'modelAlias', in: 'body', type: 'string', desc: '本轮模型别名（缺省跟随会话/全局）' },
    ],
    body: '{ "seq": 1, "modelAlias?": "deepseek-chat" }',
    response: 'SSE：event: <type> + data: <JSON>（与 POST /sessions/:id/messages 同格式）',
    example: 'curl -N -X POST /sessions/<id>/retry -H "Content-Type: application/json" -d \'{"seq":1}\'',
  },
  'PUT /sessions/:id/model': {
    summary: '设置会话级模型别名（只写会话元数据，不改变全局激活模型）。',
    scope: 'write',
    params: [
      { name: 'id', in: 'path', type: 'string', required: true, desc: '会话 id' },
      { name: 'alias', in: 'body', type: 'string', required: true, desc: '已登记模型别名；传空串表示跟随全局' },
    ],
    body: '{ "alias": "string" }',
    example: 'curl -X PUT /sessions/<id>/model -H "Content-Type: application/json" -d \'{"alias":"deepseek-chat"}\'',
  },
  'GET /sessions/:id': {
    summary: '会话详情：元信息、全量消息、当前 run 与上次运行状态。',
    scope: 'read',
    params: [{ name: 'id', in: 'path', type: 'string', required: true, desc: '会话 id' }],
    response: '{ meta, messages, run, lastRun, workspace }',
    example: 'curl /sessions/<id>',
  },
  'DELETE /sessions/:id': {
    summary: '删除会话（该会话正在运行返回 409）。',
    scope: 'write',
    params: [{ name: 'id', in: 'path', type: 'string', required: true, desc: '会话 id' }],
    response: '{ "deleted": true }',
    example: 'curl -X DELETE /sessions/<id>',
  },
  'GET /status': {
    summary: '轻量运行快照：版本、模型、会话、工具、MCP、记忆、上传概况。',
    scope: 'read',
    example: 'curl /status',
  },

  /* ================= 文件与上传 ================= */
  'GET /fs/tree': {
    summary: '工作空间目录树（单层懒加载，供文件面板展开）。',
    scope: 'read',
    params: [
      { name: 'path', in: 'query', type: 'string', desc: '相对工作空间根的目录路径，缺省为根' },
      { name: 'ws', in: 'query', type: 'string', desc: '工作空间绝对路径（须为已注册空间），缺省为最近使用空间' },
    ],
    example: 'curl "/fs/tree?path=src"',
  },
  'GET /fs/file': {
    summary: '读取工作空间文本文件（超过 512KB 截断，二进制拒绝）。',
    scope: 'read',
    params: [
      { name: 'path', in: 'query', type: 'string', required: true, desc: '相对工作空间根的文件路径' },
      { name: 'ws', in: 'query', type: 'string', desc: '工作空间绝对路径' },
    ],
    response: '{ name, bytes, truncated, content }',
    example: 'curl "/fs/file?path=README.md"',
  },
  'GET /fs/raw': {
    summary: '以原始字节返回文件（图片 / PDF 等前端直显用；Bearer 走请求头，不能用 <a href>）。',
    scope: 'read',
    params: [
      { name: 'path', in: 'query', type: 'string', required: true, desc: '相对工作空间根的文件路径' },
      { name: 'ws', in: 'query', type: 'string', desc: '工作空间绝对路径' },
    ],
    example: 'curl -H "Authorization: Bearer <token>" "/fs/raw?path=docs/a.png" -o a.png',
  },
  'GET /fs/doc2md': {
    summary: 'Office / PDF 文档转 Markdown 预览（docx、xlsx、pptx、pdf 等）。',
    scope: 'read',
    params: [
      { name: 'path', in: 'query', type: 'string', required: true, desc: '相对工作空间根的文档路径' },
      { name: 'ws', in: 'query', type: 'string', desc: '工作空间绝对路径' },
    ],
    example: 'curl "/fs/doc2md?path=docs/spec.docx"',
  },
  'GET /fs/search': {
    summary: '工作空间全文搜索：文件名、目录名、文件内容三路匹配（名称命中优先，上限 200 条）。',
    scope: 'read',
    params: [
      { name: 'q', in: 'query', type: 'string', required: true, desc: '关键词' },
      { name: 'ws', in: 'query', type: 'string', desc: '工作空间绝对路径' },
    ],
    response: '{ hits: [ { path, kind: "name" | "dir" | "content", line, text } ] }',
    example: 'curl "/fs/search?q=createRoutes"',
  },
  'GET /fs/fingerprint': {
    summary: '单目录指纹（条目类型 + 名称 + 大小 + mtime 的哈希），供前端识别目录是否变更。',
    scope: 'read',
    params: [
      { name: 'path', in: 'query', type: 'string', desc: '相对工作空间根的目录路径' },
      { name: 'ws', in: 'query', type: 'string', desc: '工作空间绝对路径' },
    ],
    example: 'curl "/fs/fingerprint?path=src"',
  },
  'DELETE /fs/entry': {
    summary: '删除文件或目录（目录必须 recursive=1；根目录与 .git / .loop-agent 拒绝）。',
    scope: 'write',
    params: [
      { name: 'path', in: 'query', type: 'string', required: true, desc: '相对工作空间根的路径' },
      { name: 'recursive', in: 'query', type: 'boolean', desc: '删除目录时必须为 1' },
      { name: 'ws', in: 'query', type: 'string', desc: '工作空间绝对路径' },
    ],
    example: 'curl -X DELETE "/fs/entry?path=temp/old.txt"',
  },
  'POST /fs/rename': {
    summary: '重命名或移动文件 / 目录（目标已存在返回 409）。',
    scope: 'write',
    params: [
      { name: 'from', in: 'body', type: 'string', required: true, desc: '源路径（相对工作空间根）' },
      { name: 'to', in: 'body', type: 'string', required: true, desc: '目标路径（相对工作空间根）' },
      { name: 'ws', in: 'query', type: 'string', desc: '工作空间绝对路径' },
    ],
    body: '{ "from": "a.txt", "to": "b.txt" }',
    example: 'curl -X POST "/fs/rename" -H "Content-Type: application/json" -d \'{"from":"a.txt","to":"b.txt"}\'',
  },
  'POST /fs/mkdir': {
    summary: '新建目录（父目录必须已存在）。',
    scope: 'write',
    params: [
      { name: 'path', in: 'body', type: 'string', required: true, desc: '要创建的目录路径（相对工作空间根）' },
      { name: 'ws', in: 'query', type: 'string', desc: '工作空间绝对路径' },
    ],
    body: '{ "path": "docs/new" }',
    example: 'curl -X POST /fs/mkdir -H "Content-Type: application/json" -d \'{"path":"docs/new"}\'',
  },
  'POST /fs/upload': {
    summary: '上传单个文件到工作空间目录（body 为原始字节，冲突策略默认 rename）。',
    scope: 'write',
    params: [
      { name: 'path', in: 'query', type: 'string', required: true, desc: '目标目录（相对工作空间根）' },
      { name: 'X-File-Name', in: 'query', type: 'string', required: true, desc: 'encodeURIComponent 后的文件名（请求头）' },
      { name: 'X-Relative-Path', in: 'query', type: 'string', desc: '目录上传时的层级路径（请求头）' },
      { name: 'X-Conflict', in: 'query', type: 'string', desc: 'rename | overwrite | skip，默认 rename' },
    ],
    example: 'curl -X POST "/fs/upload?path=docs" -H "X-File-Name: a.txt" --data-binary @a.txt',
  },
  'GET /fs/download': {
    summary: '下载文件或目录 zip（文件名经 Content-Disposition 返回）。',
    scope: 'read',
    params: [
      { name: 'path', in: 'query', type: 'string', required: true, desc: '相对工作空间根的路径（目录则打包 zip）' },
      { name: 'ws', in: 'query', type: 'string', desc: '工作空间绝对路径' },
    ],
    example: 'curl -OJ "/fs/download?path=src"',
  },
  'POST /uploads': {
    summary: '把服务端已存在的本机文件挂到会话 uploads 目录（paths 数组，部分成功仍 201）。',
    scope: 'write',
    params: [
      { name: 'sessionId', in: 'body', type: 'string', required: true, desc: '会话 id' },
      { name: 'paths', in: 'body', type: 'string[]', required: true, desc: '本机文件绝对路径列表' },
    ],
    body: '{ "sessionId": "string", "paths": ["D:\\\\a.png"] }',
    response: '201 { entries, contextNote, failed }（全失败 400）',
    example: 'curl -X POST /uploads -H "Content-Type: application/json" -d \'{"sessionId":"<id>","paths":["D:/a.png"]}\'',
  },
  'POST /uploads/raw': {
    summary: '原始字节直传到会话 uploads 目录（WebUI 附件与粘贴走此端点）。',
    scope: 'write',
    params: [
      { name: 'sessionId', in: 'query', type: 'string', required: true, desc: '会话 id' },
      { name: 'X-File-Name', in: 'query', type: 'string', required: true, desc: 'encodeURIComponent 后的文件名（请求头）' },
    ],
    response: '201 { fileName, bytes, contextNote }',
    example: 'curl -X POST "/uploads/raw?sessionId=<id>" -H "X-File-Name: a.png" --data-binary @a.png',
  },
  'GET /uploads': {
    summary: '列出某会话已上传的文件。',
    scope: 'read',
    params: [{ name: 'sessionId', in: 'query', type: 'string', required: true, desc: '会话 id' }],
    example: 'curl "/uploads?sessionId=<id>"',
  },
  'GET /uploads/view': {
    summary: '预览 uploads 文件：disp=file 返回文本内容，disp=raw 返回原始字节（越界 403）。',
    scope: 'read',
    params: [
      { name: 'path', in: 'query', type: 'string', required: true, desc: '相对 uploads 根的路径' },
      { name: 'disp', in: 'query', type: 'string', desc: 'file（默认，>512KB 截断）| raw（图片直显，上限 100MB）' },
    ],
    example: 'curl "/uploads/view?path=<sessionId>/a.png&disp=raw" -o a.png',
  },
  'DELETE /uploads': {
    summary: '清空某会话的上传目录（动词即确认）。',
    scope: 'write',
    params: [{ name: 'sessionId', in: 'query', type: 'string', required: true, desc: '会话 id' }],
    example: 'curl -X DELETE "/uploads?sessionId=<id>"',
  },
  'GET /userdir/view': {
    summary: '预览 ~/.loop-agent 自有数据目录内的文件（记忆 / 日志 / 全局技能等，受控只读）。',
    scope: 'read',
    params: [
      { name: 'path', in: 'query', type: 'string', required: true, desc: '相对 ~/.loop-agent 的路径，支持 ~ 字面量' },
      { name: 'disp', in: 'query', type: 'string', desc: 'file（默认）| raw' },
    ],
    example: 'curl "/userdir/view?path=memory/<wsId>/2026-11-04.md"',
  },

  /* ================= 配置 ================= */
  'GET /config': {
    summary: '全量配置（secret 字段遮蔽）。',
    scope: 'read',
    example: 'curl /config',
  },
  'GET /config/path': {
    summary: '配置文件路径与工作空间配置是否存在。',
    scope: 'read',
    response: '{ globalPath, workspacePath, workspaceExists }',
    example: 'curl /config/path',
  },
  'GET /config/:key': {
    summary: '读取单个配置键（支持点号路径，secret 遮蔽）。',
    scope: 'read',
    params: [{ name: 'key', in: 'path', type: 'string', required: true, desc: '配置键（点号路径，如 api.token）' }],
    response: '{ key, value, scope }',
    example: 'curl /config/api.port',
  },
  'PUT /config/:key': {
    summary: '写入单个配置键（默认写工作空间层；api.* 返回 restartRequired）。',
    scope: 'write',
    params: [
      { name: 'key', in: 'path', type: 'string', required: true, desc: '配置键（点号路径）' },
      { name: 'value', in: 'body', type: 'any', required: true, desc: '新值（类型须与该键 schema 一致）' },
      { name: 'scope', in: 'body', type: 'string', desc: 'workspace（默认）| global' },
    ],
    body: '{ "value": <any>, "scope?": "workspace" | "global" }',
    example: 'curl -X PUT /config/api.token -H "Content-Type: application/json" -d \'{"value":"s3cret"}\'',
  },
  'DELETE /config/:key': {
    summary: '删除单个配置键（回落到默认值或上层配置）。',
    scope: 'write',
    params: [
      { name: 'key', in: 'path', type: 'string', required: true, desc: '配置键（点号路径）' },
      { name: 'scope', in: 'query', type: 'string', desc: 'workspace（默认）| global' },
    ],
    response: '{ "deleted": true }',
    example: 'curl -X DELETE "/config/api.token?scope=workspace"',
  },

  /* ================= 工具 ================= */
  'GET /tools': {
    summary: '工具快照：内置工具（视觉四件套按 vision.enabled 门控）+ MCP 工具。',
    scope: 'read',
    response: '{ tools: [ { name, description, enabled, source: "builtin" | "mcp" } ] }',
    example: 'curl /tools',
  },
  'POST /tools/reload': {
    summary: '重载全部工具（内置重建 + MCP 工具重新注册）。',
    scope: 'write',
    response: '{ "reloaded": 12 }',
    example: 'curl -X POST /tools/reload',
  },
  'GET /tools/:name': {
    summary: '单个工具详情（内置工具含 JSON Schema 参数定义）。',
    scope: 'read',
    params: [{ name: 'name', in: 'path', type: 'string', required: true, desc: '工具名' }],
    example: 'curl /tools/fileRead',
  },
  'PATCH /tools/:name': {
    summary: '启用 / 禁用内置工具（落盘并同步运行时）。',
    scope: 'write',
    params: [
      { name: 'name', in: 'path', type: 'string', required: true, desc: '内置工具名' },
      { name: 'enabled', in: 'body', type: 'boolean', required: true, desc: 'true 启用 / false 禁用' },
      { name: 'scope', in: 'body', type: 'string', desc: 'workspace（默认）| global' },
    ],
    body: '{ "enabled": false, "scope?": "workspace" }',
    example: 'curl -X PATCH /tools/fileRead -H "Content-Type: application/json" -d \'{"enabled":false}\'',
  },

  /* ================= 模型与测速 ================= */
  'GET /models': {
    summary: '模型 profile 登记簿（含当前激活标记）。',
    scope: 'read',
    response: '{ profiles: [ { alias, model, baseUrl, isCurrent } ] }',
    example: 'curl /models',
  },
  'GET /model': {
    summary: '当前生效模型快照（apiKey 遮蔽）。',
    scope: 'read',
    example: 'curl /model',
  },
  'PUT /model': {
    summary: '切换激活模型到指定 alias。',
    scope: 'write',
    params: [
      { name: 'alias', in: 'body', type: 'string', required: true, desc: '目标模型别名' },
      { name: 'scope', in: 'body', type: 'string', desc: 'workspace（默认）| global' },
    ],
    body: '{ "alias": "string", "scope?": "workspace" }',
    example: 'curl -X PUT /model -H "Content-Type: application/json" -d \'{"alias":"deepseek-chat"}\'',
  },
  'POST /models': {
    summary: '登记一个模型 profile（同名返回 409）。',
    scope: 'write',
    params: [
      { name: 'alias', in: 'body', type: 'string', required: true, desc: '别名（唯一）' },
      { name: 'profile', in: 'body', type: 'object', required: true, desc: '模型配置（model / baseUrl / apiKey 等）' },
      { name: 'scope', in: 'body', type: 'string', desc: 'workspace（默认）| global' },
    ],
    body: '{ "alias": "string", "profile": { "model": "string", "baseUrl": "string", "apiKey": "string" } }',
    example: 'curl -X POST /models -H "Content-Type: application/json" -d \'{"alias":"ds","profile":{"model":"deepseek-chat"}}\'',
  },
  'PATCH /models/:alias': {
    summary: '编辑模型 profile（缺省字段不变；alias 不可改；生效模型同步 model.* 快照）。',
    scope: 'write',
    params: [
      { name: 'alias', in: 'path', type: 'string', required: true, desc: '模型别名（不可修改）' },
      { name: 'scope', in: 'body', type: 'string', desc: 'workspace（默认）| global' },
      { name: 'profile', in: 'body', type: 'object', required: true, desc: '字段增量；apiKey 空串 = 保持，temperature null = 删除该键' },
    ],
    body: '{ "scope?": "workspace", "profile": { "name?": "string", "baseUrl?": "string", "apiKey?": "string", "temperature?": "number | null" } }',
    example: 'curl -X PATCH /models/ds -H "Content-Type: application/json" -d \'{"profile":{"temperature":0.7}}\'',
  },
  'POST /models/:alias/test': {
    summary: '模型连通性测试（失败也返回 200，用 ok:false 表达）。',
    scope: 'read',
    params: [{ name: 'alias', in: 'path', type: 'string', required: true, desc: '模型别名' }],
    response: '{ ok, latencyMs, error? }',
    example: 'curl -X POST /models/ds/test',
  },
  'DELETE /models/:alias': {
    summary: '删除模型 profile（当前激活的模型返回 409）。',
    scope: 'write',
    params: [
      { name: 'alias', in: 'path', type: 'string', required: true, desc: '模型别名' },
      { name: 'scope', in: 'query', type: 'string', desc: 'workspace | global' },
    ],
    example: 'curl -X DELETE "/models/ds?scope=workspace"',
  },
  'POST /models/bench': {
    summary: '发起模型测速 run（最多 4 个模型，服务端串行执行）→ 202。',
    scope: 'write',
    params: [
      { name: 'aliases', in: 'body', type: 'string[]', required: true, desc: '参与对比的模型别名（≤4）' },
      { name: 'tier', in: 'body', type: 'string', desc: '测速档位（quick / standard / deep）' },
      { name: 'prompts', in: 'body', type: 'string[]', desc: '自定义提示词，缺省用档位内置集合' },
      { name: 'rounds', in: 'body', type: 'number', desc: '每模型轮次' },
      { name: 'maxTokens', in: 'body', type: 'number', desc: '单次输出上限' },
      { name: 'bustCache', in: 'body', type: 'boolean', desc: '是否打散缓存（每轮换随机前缀）' },
    ],
    body: '{ "aliases": ["a","b"], "tier?": "quick", "rounds?": 3, "bustCache?": true }',
    response: '202 { runId, plan }',
    example: 'curl -X POST /models/bench -H "Content-Type: application/json" -d \'{"aliases":["ds","gpt"]}\'',
  },
  'GET /models/bench/history': {
    summary: '测速历史（不带 alias 时每个模型只回最近一次；不存 apiKey）。',
    scope: 'read',
    params: [
      { name: 'alias', in: 'query', type: 'string', desc: '只看某个模型的历史' },
      { name: 'limit', in: 'query', type: 'number', desc: '返回条数上限' },
    ],
    example: 'curl "/models/bench/history?limit=10"',
  },
  'GET /models/bench/:runId/stream': {
    summary: '测速进度 SSE：start / model_start / round_start / first_token / token / round_end / model_done / done / failed，重连先回放。',
    scope: 'read',
    stream: true,
    params: [{ name: 'runId', in: 'path', type: 'string', required: true, desc: '测速 run id' }],
    example: 'curl -N /models/bench/<runId>/stream',
  },
  'POST /models/bench/:runId/stop': {
    summary: '中断测速 run（幂等）。',
    scope: 'write',
    params: [{ name: 'runId', in: 'path', type: 'string', required: true, desc: '测速 run id' }],
    response: '{ runId, stopped, status }',
    example: 'curl -X POST /models/bench/<runId>/stop',
  },
  'GET /models/bench': {
    summary: '测速端点自述：档位、内置提示词、最多对比模型数、历史目录。',
    scope: 'read',
    example: 'curl /models/bench',
  },

  /* ================= MCP 与技能 ================= */
  'GET /mcp/tool-meta': {
    summary: 'MCP 工具展示元信息（中文展示名、参数标签、翻译状态）；无连接时返回空表而非 404。',
    scope: 'read',
    response: '{ tools: [ { name, displayName, params, translated } ], summary }',
    example: 'curl /mcp/tool-meta',
  },
  'GET /mcp/servers': {
    summary: 'MCP 服务器列表（名称、传输方式、连接状态、工具数）。',
    scope: 'read',
    response: '{ servers: [ { name, transport, status, toolCount } ] }',
    example: 'curl /mcp/servers',
  },
  'POST /mcp/reload': {
    summary: '全量重连 MCP 服务器。',
    scope: 'write',
    response: '{ reconnected, failed }',
    example: 'curl -X POST /mcp/reload',
  },
  'GET /mcp/servers/:name': {
    summary: 'MCP 服务器详情（含该服务器提供的工具清单）。',
    scope: 'read',
    params: [{ name: 'name', in: 'path', type: 'string', required: true, desc: '服务器名' }],
    example: 'curl /mcp/servers/<name>',
  },
  'POST /mcp/servers': {
    summary: '登记并连接 MCP 服务器（同名 409；连接失败 502 但配置已落盘）。',
    scope: 'write',
    params: [
      { name: 'name', in: 'body', type: 'string', required: true, desc: '服务器名（唯一）' },
      { name: 'transport', in: 'body', type: 'string', required: true, desc: 'stdio | sse | http' },
      { name: 'command', in: 'body', type: 'string', desc: 'stdio 传输时的可执行命令' },
      { name: 'url', in: 'body', type: 'string', desc: 'sse / http 传输时的地址' },
    ],
    body: '{ "name": "string", "transport": "stdio", "command": "npx", "args": ["-y", "..."] }',
    example: 'curl -X POST /mcp/servers -H "Content-Type: application/json" -d \'{"name":"x","transport":"stdio","command":"npx"}\'',
  },
  'POST /mcp/servers/:name/test': {
    summary: 'MCP 服务器连接测试（失败也返回 200，用 ok:false 表达）。',
    scope: 'read',
    params: [{ name: 'name', in: 'path', type: 'string', required: true, desc: '服务器名' }],
    response: '{ ok, latencyMs, tools, error? }',
    example: 'curl -X POST /mcp/servers/<name>/test',
  },
  'DELETE /mcp/servers/:name': {
    summary: '先断开连接再删除 MCP 服务器配置。',
    scope: 'write',
    params: [
      { name: 'name', in: 'path', type: 'string', required: true, desc: '服务器名' },
      { name: 'scope', in: 'query', type: 'string', desc: 'workspace | global' },
    ],
    example: 'curl -X DELETE "/mcp/servers/<name>?scope=workspace"',
  },
  'GET /skills': {
    summary: '已加载技能列表（名称、描述、作用域、路径）。',
    scope: 'read',
    response: '{ skills: [ { name, description, scope, path } ] }',
    example: 'curl /skills',
  },
  'POST /skills/reload': {
    summary: '重载全部技能。',
    scope: 'write',
    response: '{ loaded }',
    example: 'curl -X POST /skills/reload',
  },
  'POST /skills/upload': {
    summary: '上传技能 zip 包安装（base64 传包，上限 20MB，自动剥离顶层目录）。',
    scope: 'write',
    params: [
      { name: 'rootName', in: 'body', type: 'string', required: true, desc: '安装目录名（通常取 zip 文件名去 .zip）' },
      { name: 'zipBase64', in: 'body', type: 'string', required: true, desc: '技能 zip 包的 base64' },
      { name: 'scope', in: 'body', type: 'string', desc: 'workspace（默认）| global' },
      { name: 'overwrite', in: 'body', type: 'boolean', desc: '同名已存在时是否覆盖' },
    ],
    body: '{ "rootName": "string", "zipBase64": "string", "scope?": "workspace", "overwrite?": false }',
    example: 'curl -X POST /skills/upload -H "Content-Type: application/json" -d \'{"rootName":"demo","zipBase64":"<b64>"}\'',
  },
  'GET /skills/:name': {
    summary: '技能详情（含 SKILL.md 正文）。',
    scope: 'read',
    params: [{ name: 'name', in: 'path', type: 'string', required: true, desc: '技能名（frontmatter name）' }],
    example: 'curl /skills/<name>',
  },
  'POST /skills': {
    summary: '从服务端源目录安装技能（同名未声明 overwrite 返回 409）。',
    scope: 'write',
    params: [
      { name: 'sourcePath', in: 'body', type: 'string', required: true, desc: '源技能目录绝对路径' },
      { name: 'scope', in: 'body', type: 'string', desc: 'workspace（默认）| global' },
      { name: 'overwrite', in: 'body', type: 'boolean', desc: '同名是否覆盖' },
    ],
    body: '{ "sourcePath": "string", "scope?": "workspace", "overwrite?": false }',
    example: 'curl -X POST /skills -H "Content-Type: application/json" -d \'{"sourcePath":"D:/skill-demo"}\'',
  },
  'DELETE /skills/:name': {
    summary: '卸载技能（按 frontmatter name 定位）。',
    scope: 'write',
    params: [
      { name: 'name', in: 'path', type: 'string', required: true, desc: '技能名' },
      { name: 'scope', in: 'query', type: 'string', desc: 'workspace | global' },
    ],
    response: '{ deleted, scope }',
    example: 'curl -X DELETE "/skills/demo?scope=workspace"',
  },

  /* ================= 记忆与 Dreaming ================= */
  'GET /memory/status': {
    summary: '记忆分层状态：层目录、条目计数与自动晋升（dreaming）状态；未启用时返回 enabled:false。',
    scope: 'read',
    response: '{ enabled, layers, counts, dreaming? }',
    example: 'curl /memory/status',
  },
  'GET /memory/workspaces': {
    summary: '列出「有会话 ∪ 有记忆」的空间（含仅有记忆的孤儿空间）。',
    scope: 'read',
    response: '{ workspaces: [ { id, name, path, hasMemory, hasSession } ] }',
    example: 'curl /memory/workspaces',
  },
  'GET /memory/curated': {
    summary: '整理层（L3）三层文件全文。',
    scope: 'read',
    params: [{ name: 'ws', in: 'query', type: 'string', desc: '空间 id 或绝对路径，缺省为最近使用空间' }],
    response: '{ entries }',
    example: 'curl /memory/curated',
  },
  'GET /memory/episodic': {
    summary: '情景层（L2）日志，按天返回。',
    scope: 'read',
    params: [
      { name: 'limit', in: 'query', type: 'number', desc: '回溯天数（1–90）' },
      { name: 'ws', in: 'query', type: 'string', desc: '空间 id 或绝对路径' },
    ],
    response: '{ entries }',
    example: 'curl "/memory/episodic?limit=7"',
  },
  'GET /memory/search': {
    summary: '跨层语义检索记忆条目。',
    scope: 'read',
    params: [
      { name: 'q', in: 'query', type: 'string', required: true, desc: '检索关键词' },
      { name: 'limit', in: 'query', type: 'number', desc: '返回条数上限' },
    ],
    response: '{ results: [ { content, score, layer } ] }',
    example: 'curl "/memory/search?q=部署"',
  },
  'GET /memory/gate': {
    summary: '记忆提升门阈值与近期判定结果。',
    scope: 'read',
    example: 'curl /memory/gate',
  },
  'POST /memory/dream': {
    summary: '触发一次异步记忆整理（已有晋升在跑时返回 accepted:false）。',
    scope: 'write',
    response: '202 { accepted, reason?, skippedBecause? }',
    example: 'curl -X POST /memory/dream',
  },
  'POST /memory/init': {
    summary: '初始化分层记忆目录（幂等）。',
    scope: 'write',
    example: 'curl -X POST /memory/init',
  },
  'PUT /memory/dream/schedule': {
    summary: '修改自动整理排期；校验通过即热重排（无需重启），非法 cron 返回 400 且不落盘。',
    scope: 'write',
    params: [
      { name: 'enabled', in: 'body', type: 'boolean', desc: '是否启用定时整理' },
      { name: 'cron', in: 'body', type: 'string', desc: '5 段 cron 表达式' },
      { name: 'misfireGraceMin', in: 'body', type: 'number', desc: '错过补跑宽限（分钟）' },
    ],
    body: '{ "enabled?": true, "cron?": "0 3 * * *", "misfireGraceMin?": 60 }',
    example: 'curl -X PUT /memory/dream/schedule -H "Content-Type: application/json" -d \'{"cron":"0 3 * * *"}\'',
  },
  'GET /memory/dream/preview': {
    summary: '预览 cron 表达式的可读描述与未来 5 次触发时刻（非法表达式也返回 200 + ok:false）。',
    scope: 'read',
    params: [{ name: 'cron', in: 'query', type: 'string', required: true, desc: '待预览的 cron 表达式' }],
    response: '{ ok: true, describe, next: [5 个 ISO 时刻], timezoneOffsetMin } 或 { ok: false, error, fieldIndex? }',
    example: 'curl "/memory/dream/preview?cron=0%203%20*%20*%20*"',
  },
  'GET /memory/dream/history': {
    summary: '最近自动整理触发记录（scope=all 聚合全部空间）。',
    scope: 'read',
    params: [
      { name: 'limit', in: 'query', type: 'number', desc: '返回条数上限' },
      { name: 'scope', in: 'query', type: 'string', desc: 'ws（默认，缺省空间）| all（全部空间）' },
      { name: 'ws', in: 'query', type: 'string', desc: 'scope=ws 时的目标空间' },
    ],
    response: '{ scope, runs: [ { startedAt, finishedAt, durationMs, reason, ok, promoted, skipped, errors } ] }',
    example: 'curl "/memory/dream/history?scope=all&limit=20"',
  },
  'DELETE /memory/dream/history': {
    summary: '清空自动整理触发记录（跟随筛选范围，文件保留）。',
    scope: 'write',
    params: [
      { name: 'scope', in: 'query', type: 'string', desc: 'ws（默认）| all' },
      { name: 'ws', in: 'query', type: 'string', desc: 'scope=ws 时的目标空间' },
    ],
    response: '{ deleted }',
    example: 'curl -X DELETE "/memory/dream/history?scope=all"',
  },

  /* ================= 诊断与能力探测 ================= */
  'GET /doctor': {
    summary: '逐项只读体检（失败项以 ok:false + detail 呈现，端点本身仍 200）。',
    scope: 'read',
    response: '{ ok, checks: [ { name, ok, level, detail } ] }',
    example: 'curl /doctor',
  },
  'GET /vision': {
    summary: '视觉模型探测链状态（是否可用、实际 provider 与 model）。',
    scope: 'read',
    response: '{ available, provider, model, reason? }',
    example: 'curl /vision',
  },
  'POST /vision/test': {
    summary: '发一张最小图片验证视觉链路连通（失败也返回 200，用 ok:false 表达）。',
    scope: 'read',
    response: '{ ok, latencyMs, error? }',
    example: 'curl -X POST /vision/test',
  },
  'GET /terminal/info': {
    summary: 'WebUI 终端能力探测：是否启用、PTY 模块是否可用、可用 shell 清单与限制。',
    scope: 'read',
    response: '{ enabled, ptyAvailable, ptyHint, shells, maxSessions, idleMs, cwd }',
    example: 'curl /terminal/info',
  },

  /* ================= 后台任务（需求 20261104-005） ================= */
  'GET /background/:taskId': {
    summary: '后台任务状态快照，供 WebUI 卡片轮询（运行中 2s、页面隐藏 15s）；优先读内存，未命中回落 runs 目录 .json。',
    scope: 'read',
    params: [{ name: 'taskId', in: 'path', type: 'string', required: true, desc: '后台任务 ID（bg_<hex8>_<秒级时间戳>）' }],
    response: '{ taskId, command, status, exitCode, startedAt, finishedAt, durationMs, logSize, cursor }',
    example: 'curl /background/bg_a1b2c3d4_1700000000',
  },
  'GET /background/:taskId/logs': {
    summary: '读取后台任务日志尾部：默认头 2KB，tail=1 时返回最后 20 行 / 2KB；日志已清理时 cleaned=true。',
    scope: 'read',
    params: [
      { name: 'taskId', in: 'path', type: 'string', required: true, desc: '后台任务 ID' },
      { name: 'tail', in: 'query', type: 'string', required: false, desc: '传 1 只取尾部（最后 20 行 / 2KB）' },
    ],
    response: '{ taskId, tail, size, truncated, cleaned }',
    example: 'curl "/background/bg_a1b2c3d4_1700000000/logs?tail=1"',
  },
  'POST /background/:taskId/stop': {
    summary: '停止后台任务（杀进程树），幂等：已结束返回 alreadyStopped=true；与 commandStop 同口径。',
    scope: 'write',
    params: [{ name: 'taskId', in: 'path', type: 'string', required: true, desc: '后台任务 ID' }],
    response: '{ taskId, stopped, alreadyStopped, status }',
    example: 'curl -X POST /background/bg_a1b2c3d4_1700000000/stop',
  },

  /* ================= 开发者 ================= */
  'GET /dev/api-docs': {
    summary: '本页数据源：反射路由表返回全部 API 端点结构，并叠加中文说明、分组与统计。',
    scope: 'read',
    response: '{ version, groups: [ { key, title, desc, items } ], stats: { total, documented, undocumented } }',
    example: 'curl /dev/api-docs',
  },
};

/** 分组定义（数组顺序即页面展示顺序） */
export interface ApiDocGroup {
  key: string;
  title: string;
  desc: string;
  /** 归属前缀（按路径段精确匹配，最长者优先） */
  prefixes: string[];
}

export const API_DOC_GROUPS: readonly ApiDocGroup[] = [
  {
    key: 'core',
    title: '会话与系统',
    desc: '健康探针、会话生命周期、消息执行与跨空间聚合。',
    prefixes: ['/health', '/status', '/sessions', '/workspaces', '/fs/dirs'],
  },
  {
    key: 'files',
    title: '文件与上传',
    desc: '工作空间文件树 / 预览 / 搜索 / 读写，会话附件上传与 ~/.loop-agent 受控预览。',
    prefixes: ['/fs', '/uploads', '/userdir'],
  },
  {
    key: 'config',
    title: '配置',
    desc: '分层配置（global / workspace）的读取、写入与删除。',
    prefixes: ['/config'],
  },
  {
    key: 'tools',
    title: '工具',
    desc: '内置与 MCP 工具的查询、启停与重载，以及后台任务状态查询/停止。',
    prefixes: ['/tools', '/background'],
  },
  {
    key: 'models',
    title: '模型与测速',
    desc: '模型 profile 登记、激活切换、连通性测试与性能测速。',
    prefixes: ['/model', '/models'],
  },
  {
    key: 'extensions',
    title: 'MCP 与技能',
    desc: 'MCP 服务器生命周期与技能（Skill）安装、重载、卸载。',
    prefixes: ['/mcp', '/skills'],
  },
  {
    key: 'memory',
    title: '记忆与 Dreaming',
    desc: '三层记忆状态、跨层检索、自动整理排期与历史。',
    prefixes: ['/memory'],
  },
  {
    key: 'insight',
    title: '诊断与能力探测',
    desc: '只读体检、视觉链路探测与终端能力信息。',
    prefixes: ['/doctor', '/vision', '/terminal'],
  },
  {
    key: 'dev',
    title: '开发者',
    desc: '面向二次开发者的自描述端点（本页即由 /dev/api-docs 提供）。',
    prefixes: ['/dev'],
  },
];

/** 未命中任何分组时的兜底分组 key（单测据此断言是否为 0） */
export const OTHER_GROUP = 'other';

/** 路径 → 分组 key：按路径段最长前缀匹配，未命中返回 OTHER_GROUP */
export function groupOfPath(path: string): string {
  const segs = path.split('/').filter((s) => s.length > 0);
  let best: { key: string; depth: number } | null = null;
  for (const g of API_DOC_GROUPS) {
    for (const p of g.prefixes) {
      const psegs = p.split('/').filter((s) => s.length > 0);
      if (psegs.length === 0 || psegs.length > segs.length) continue;
      // 逐段精确相等才算命中（避免 /model 误匹配 /models）
      let ok = true;
      for (let i = 0; i < psegs.length; i++) {
        if (psegs[i] !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (!best || psegs.length > best.depth) best = { key: g.key, depth: psegs.length };
    }
  }
  return best ? best.key : OTHER_GROUP;
}

/** 单个端点在响应中的形态（元数据 + 反射结果的合并产物） */
export interface ApiDocItem {
  method: string;
  path: string;
  summary: string;
  /** 是否有中文说明（false 时前端灰标「说明待补」） */
  documented: boolean;
  stream: boolean;
  scope: 'read' | 'write';
  params: ApiDocParam[];
  body?: string;
  response?: string;
  example?: string;
}

/** 一个分组在响应中的形态 */
export interface ApiDocGroupOut {
  key: string;
  title: string;
  desc: string;
  items: ApiDocItem[];
}

/** GET /dev/api-docs 的完整响应 */
export interface ApiDocsPayload {
  version: string;
  groups: ApiDocGroupOut[];
  stats: {
    total: number;
    documented: number;
    /** 缺中文说明的端点（`METHOD /path`），供前端计数与单测断言 */
    undocumented: string[];
  };
}

/** 路由表最小形状（避免 import router.ts 造成循环依赖） */
export interface RouteLike {
  method: string;
  path: string;
}

/**
 * 反射 + 合并：端点全集取自路由表，语义取自 API_DOC_ENTRIES。
 *
 * 保证：
 * - 路由表里有的端点必定出现（反射，不漏）；
 * - 元数据里多出来的键不会凭空造端点（以路由表为准，未命中的元数据忽略）；
 * - 未登记说明的端点 documented:false 并计入 stats.undocumented（可观测）。
 *
 * 展示顺序：沿用路由表注册顺序（静态段先于 `:param` 是真源语义，不重排）。
 */
export function collectApiDocs(routes: readonly RouteLike[], version = ''): ApiDocsPayload {
  const groups: ApiDocGroupOut[] = API_DOC_GROUPS.map((g) => ({
    key: g.key,
    title: g.title,
    desc: g.desc,
    items: [],
  }));
  const other: ApiDocGroupOut = { key: OTHER_GROUP, title: '其他', desc: '未归入任何分组的端点。', items: [] };
  const byKey = new Map<string, ApiDocGroupOut>(groups.map((g) => [g.key, g]));
  const undocumented: string[] = [];
  let documented = 0;

  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    const meta = API_DOC_ENTRIES[key];
    const hasSummary = typeof meta?.summary === 'string' && meta.summary.trim().length > 0;
    if (hasSummary) documented++;
    else undocumented.push(key);
    const item: ApiDocItem = {
      method: r.method,
      path: r.path,
      summary: hasSummary ? meta!.summary : '',
      documented: hasSummary,
      stream: meta?.stream === true,
      scope: meta?.scope ?? (r.method === 'GET' ? 'read' : 'write'),
      params: meta?.params ?? [],
      body: meta?.body,
      response: meta?.response,
      example: meta?.example,
    };
    const g = byKey.get(groupOfPath(r.path)) ?? other;
    g.items.push(item);
  }

  // 空的「其他」分组不输出（避免页面出现空组）
  const out = groups.filter((g) => g.items.length > 0);
  if (other.items.length > 0) out.push(other);

  return {
    version,
    groups: out,
    stats: { total: routes.length, documented, undocumented },
  };
}
