// 开发者中心 · API 接口文档的前端纯函数与静态内容（需求 20261104-002 · 方案 D10）
//
// 本模块不 import 任何 .vue 与 DOM API（除 buildCurl 的 base 由调用方传入），是纯数据 + 纯函数，
// 便于在 Node 下直测。视图 DevView.vue 只负责渲染与交互。
//
// 数据类型与后端 src/api/api-docs.ts 的响应结构一一对应（此处独立声明，避免 webui 源码
// 反向依赖后端目录；两边的形状一致性由 tests/webui-api-docs.test.ts 的字段断言兜底）。

/** 参数位置：path 段 / query 查询 / body 请求体 */
export interface ApiDocParam {
  name: string;
  in: 'path' | 'query' | 'body';
  type: string;
  required?: boolean;
  desc: string;
}

/** 单个端点 */
export interface ApiDocItem {
  method: string;
  path: string;
  summary: string;
  /** false 表示后端元数据未登记说明，前端灰标「说明待补」 */
  documented: boolean;
  stream: boolean;
  scope: 'read' | 'write';
  params: ApiDocParam[];
  body?: string;
  response?: string;
  example?: string;
}

/** 一个分组 */
export interface ApiDocGroupOut {
  key: string;
  title: string;
  desc: string;
  items: ApiDocItem[];
}

/** GET /dev/api-docs 的响应 */
export interface ApiDocsPayload {
  version: string;
  groups: ApiDocGroupOut[];
  stats: {
    total: number;
    documented: number;
    undocumented: string[];
  };
}

/** 方法 → CSS 色调后缀（.mth-get / .mth-post …，颜色全部取既有令牌） */
export function methodTone(method: string): string {
  switch (method.toUpperCase()) {
    case 'GET':
      return 'get';
    case 'POST':
      return 'post';
    case 'PUT':
      return 'put';
    case 'PATCH':
      return 'patch';
    case 'DELETE':
      return 'del';
    default:
      return 'other';
  }
}

/** 方法筛选项（下拉/分段控件；all 为「全部」） */
export const METHOD_FILTERS: readonly string[] = ['all', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** 单条端点是否命中关键词：方法 / 路径 / 说明三路小写子串匹配（空关键词恒命中） */
export function matchDocItem(item: ApiDocItem, kw: string): boolean {
  const k = kw.trim().toLowerCase();
  if (!k) return true;
  if (item.method.toLowerCase().includes(k)) return true;
  if (item.path.toLowerCase().includes(k)) return true;
  return item.summary.toLowerCase().includes(k);
}

/** 过滤选项 */
export interface DocFilter {
  /** 关键词（方法 / 路径 / 说明三路匹配） */
  kw?: string;
  /** 方法（'all' 或具体方法名） */
  method?: string;
}

/**
 * 按关键词与方法过滤：只保留有命中项的分组，组内保持路由表原始顺序。
 *
 * 组内不重排（方案修订：路由注册顺序「静态段先于 :param」本身是语义信息，
 * 按 path 字母序重排会把 POST /models/bench 排到 POST /models/:alias/test 之前，与实际匹配优先级相反）。
 */
export function filterDocs(payload: ApiDocsPayload, filter: DocFilter = {}): ApiDocsPayload {
  const kw = filter.kw ?? '';
  const method = (filter.method ?? 'all').toUpperCase();
  const groups = payload.groups
    .map((g) => ({
      ...g,
      items: g.items.filter((it) => {
        if (method !== 'ALL' && it.method.toUpperCase() !== method) return false;
        return matchDocItem(it, kw);
      }),
    }))
    .filter((g) => g.items.length > 0);
  return { ...payload, groups };
}

/** 统计：总数 / 已登记说明数 / 各方法条数（用于统计条与标签页徽标） */
export function docCounts(payload: ApiDocsPayload): {
  total: number;
  documented: number;
  undocumented: number;
  byMethod: Record<string, number>;
} {
  const byMethod: Record<string, number> = {};
  let documented = 0;
  let total = 0;
  for (const g of payload.groups) {
    for (const it of g.items) {
      total++;
      if (it.documented) documented++;
      byMethod[it.method.toUpperCase()] = (byMethod[it.method.toUpperCase()] ?? 0) + 1;
    }
  }
  return { total, documented, undocumented: total - documented, byMethod };
}

/** 路径拆分片段（`:param` 段单独标出，供高亮） */
export interface PathSeg {
  text: string;
  param: boolean;
}

/** 把 '/sessions/:id/messages' 拆成 ['/sessions', '/:id'(param), '/messages'] */
export function splitPath(path: string): PathSeg[] {
  const out: PathSeg[] = [];
  const parts = path.split('/');
  parts.forEach((p, i) => {
    const text = i === 0 ? p : `/${p}`;
    if (text === '') return;
    out.push({ text, param: p.startsWith(':') });
  });
  return out;
}

/** 把 `:id` / `:name` 之类的路径参数换成 `<id>` 占位，便于直接复制到 curl 里替换 */
export function templatedPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '<$1>');
}

/**
 * 生成 curl 示例：base 由调用方传 `location.origin`（方案 D9：用户可能经反代/局域网地址访问，
 * 后端配置里的 host:port 不一定等于实际访问地址）。
 *
 * 有 example 时把其中的路径 token 补上 base；无 example 时按方法+路径合成一条最小示例。
 */
export function buildCurl(item: ApiDocItem, base: string): string {
  const origin = base.replace(/\/+$/, '');
  if (item.example && item.example.trim()) {
    const tokens = item.example.trim().split(/\s+/).map((tk) => {
      // 形如 /path 或 "/path"（带引号的路径也要补 base）
      if (tk.startsWith('/')) return origin + tk;
      if (tk.startsWith('"/')) return `"${origin}${tk.slice(1)}`;
      return tk;
    });
    return tokens.join(' ');
  }
  const verb = item.method.toUpperCase() === 'GET' ? '' : ` -X ${item.method.toUpperCase()}`;
  return `curl${verb} ${origin}${templatedPath(item.path)}`;
}

/* ================= 模块（标签页）定义 ================= */

export type DevTabKey = 'api' | 'auth' | 'sse';

export interface DevTab {
  key: DevTabKey;
  label: string;
  hint: string;
}

/** 第一版三个模块：接口文档（首个）+ 鉴权约定 + SSE 事件（方案 D6） */
export const DEV_TABS: readonly DevTab[] = [
  { key: 'api', label: 'API 接口文档', hint: '全部端点、参数与示例' },
  { key: 'auth', label: '鉴权与通用约定', hint: 'token 三态与错误码' },
  { key: 'sse', label: 'SSE 事件', hint: '流式帧类型与接入' },
];

/** hash `?tab=` 还原：非法值回落到第一个模块 api */
export function resolveTab(v: string | null | undefined): DevTabKey {
  const hit = DEV_TABS.find((t) => t.key === v);
  return hit ? hit.key : 'api';
}

/* ================= 鉴权与通用约定（内容取自 src/api/server.ts 实际实现） ================= */

export interface AuthMode {
  key: string;
  /** 触发条件 */
  when: string;
  /** 服务端行为 */
  behavior: string;
  /** 失败时的响应 */
  failure: string;
}

/** token 三态：与 src/api/server.ts 的 isAuthorized / 启动校验逐条对应 */
export const AUTH_MODES: readonly AuthMode[] = [
  {
    key: 'token-empty',
    when: '未配置 api.token，且以回环地址访问',
    behavior: '放行（仅本机可用）',
    failure: '—',
  },
  {
    key: 'token-empty-remote',
    when: '未配置 api.token，但来自非回环地址',
    behavior: '拒绝',
    failure: '403 forbidden「仅允许本机访问（未配置 api.token）」',
  },
  {
    key: 'token-set',
    when: '已配置 api.token',
    behavior: '校验请求头 Authorization: Bearer <token>',
    failure: '401 unauthorized「缺少或错误的 Bearer Token」',
  },
  {
    key: 'bind-nonloopback',
    when: 'api.host 绑定非回环地址且未配置 api.token',
    behavior: '服务启动即被拒绝（防局域网裸奔）',
    failure: '进程退出并提示设置 api.token 或改回 127.0.0.1',
  },
];

export interface ErrorCode {
  code: number;
  key: string;
  desc: string;
}

/** 统一错误体 { error: { code, message } } 的语义（取自 src/api/errors.ts 与各 handler） */
export const ERROR_CODES: readonly ErrorCode[] = [
  { code: 400, key: 'bad_request', desc: '参数缺失或非法（含 JSON 解析失败、二进制文件当文本读）' },
  { code: 401, key: 'unauthorized', desc: '缺少或错误的 Bearer Token（配置了 api.token 时）' },
  { code: 403, key: 'forbidden', desc: '非本机访问且未配置 token；或路径越界（uploads / userdir / fs 根外）' },
  { code: 404, key: 'not_found', desc: '端点或资源不存在' },
  { code: 405, key: 'method_not_allowed', desc: '路径存在但方法不支持（matchRoute 返回 method_not_allowed）' },
  { code: 409, key: 'conflict', desc: '冲突：同会话正在运行、删除当前激活模型、同名资源已存在、记忆未启用' },
  { code: 413, key: 'payload_too_large', desc: '请求体超过上限（JSON 2MB / 预览 100MB / 技能 zip 20MB）' },
  { code: 500, key: 'internal', desc: '服务端内部错误' },
  { code: 502, key: 'upstream_error', desc: '上游连接失败（MCP 服务器连接等）' },
];

/* ================= SSE 事件（内容取自 src/api/sse.ts 与实际 handler） ================= */

export interface SseEvent {
  name: string;
  payload: string;
  desc: string;
  /** frame=Agent 事件透传；synthesized=API 层合成终态 */
  kind: 'frame' | 'synthesized';
}

/** 与 src/api/sse.ts 的 createSseForwarder 16 个钩子 + API 层合成终态逐一对应 */
export const SSE_EVENTS: readonly SseEvent[] = [
  { name: 'start', payload: '{input}', desc: 'Agent 启动', kind: 'frame' },
  { name: 'iteration_start', payload: '{iteration, maxIterations}', desc: '每轮迭代开始', kind: 'frame' },
  { name: 'llm_stream', payload: '{text}', desc: '流式输出片段', kind: 'frame' },
  { name: 'llm_end', payload: '{response, iteration}', desc: '单轮 LLM 响应完成', kind: 'frame' },
  { name: 'llm_stats', payload: '{stats}', desc: '单轮 token 统计', kind: 'frame' },
  { name: 'llm_stats_summary', payload: '{summary}', desc: '会话统计汇总', kind: 'frame' },
  { name: 'tool_start', payload: '{tool, args}', desc: '工具调用开始', kind: 'frame' },
  { name: 'tool_end', payload: '{tool, result}', desc: '工具调用结束', kind: 'frame' },
  { name: 'tool_progress', payload: '{tool, elapsedMs}', desc: '长耗时工具心跳', kind: 'frame' },
  { name: 'tool_call_delta', payload: '{tool, accumulatedBytes, elapsedMs}', desc: '工具参数流式增量', kind: 'frame' },
  { name: 'compaction_start', payload: '{info}', desc: 'L1 上下文压缩开始', kind: 'frame' },
  { name: 'compaction', payload: '{info}', desc: 'L1 上下文压缩完成', kind: 'frame' },
  { name: 'final', payload: '{answer}', desc: '最终答案', kind: 'frame' },
  { name: 'error', payload: '{name, message}', desc: '非致命错误（可多次出现，非终态）', kind: 'frame' },
  { name: 'warning', payload: '{level, message, context?}', desc: '警告（如持久化降级）', kind: 'frame' },
  { name: 'end', payload: '{result}', desc: 'Agent 结束', kind: 'frame' },
  { name: 'done', payload: '{sessionId, durationMs, iterations, steps}', desc: 'API 合成终态（正常结束，最后一件）', kind: 'synthesized' },
  { name: 'fatal', payload: '{message}', desc: 'API 合成终态（运行异常，随后关流）', kind: 'synthesized' },
  { name: 'reset', payload: '{reason, oldestSeq}', desc: 'API 合成：续传缓冲区溢出，需从新 cursor 重放', kind: 'synthesized' },
];

/** 接入片段（fetch 流式解析，便于在浏览器里按需中断） */
export const SSE_SNIPPET = `const res = await fetch('/sessions/<id>/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer <token>' },
  body: JSON.stringify({ message: '你好' }),
});
const reader = res.body.getReader();
const dec = new TextDecoder();
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  for (const block of dec.decode(value).split('\\n\\n')) {
    const ev = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (ev && data) console.log(ev, JSON.parse(data));
  }
}`;
