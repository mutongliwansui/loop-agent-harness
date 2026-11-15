/**
 * 工具领域类型（本包自持，不依赖 `@loop-agent/llm`、不 import 主工程 `src/`）。
 *
 * ## 为什么不依赖 llm
 *
 * `tools` 与 `llm` 是**平级**的两个领域契约包：工具不该在概念上从属于大模型
 * （非 LLM 场景同样需要工具，如 ACP 编辑器的 tool 映射）。若 tools → llm，
 * 就会形成 `tools → llm → core` 的三层链，把本可正交的两条轴捆成一条。
 *
 * 但 `ToolDefView` 与 llm 的 `LlmToolDef` **字段一字等价**（name/description/
 * parameters），所以宿主侧适配是「一行 map」、不需要字段翻译。
 */

import type { ToolAnnotations, ToolDisplay } from './annotations.js';

/**
 * 工具参数 JSON Schema。
 *
 * 只支持手写子集（见 `schema.ts`）：type / properties / required / items /
 * enum / minimum / maximum / minLength / maxLength / pattern /
 * additionalProperties。超出子集的关键字被**跳过而非报错**。
 */
export type JsonSchema = Record<string, unknown>;

/** 工具规格：纯数据、不含行为（目录 list() 与诊断的返回单元） */
export interface ToolSpec {
  /** 唯一名；须匹配 `^[A-Za-z0-9_-]{1,64}$`，且不以 `__` 开头（见 `validateToolName`） */
  name: string;
  /** 给模型看的能力说明；空字符串在注册期拒绝（模型靠它决定何时调用） */
  description: string;
  /** 参数 JSON Schema；必须是 `{ type: 'object', ... }` */
  parameters: JsonSchema;
  /** 行为声明；未声明时按 MCP 悲观默认补全（见 `annotations.ts`） */
  annotations?: ToolAnnotations;
  /** 展示元信息；本期不接入 WebUI，仅占位 */
  display?: ToolDisplay;
  /** 单次执行默认超时；缺省 `DEFAULT_TOOL_TIMEOUT_MS`（30_000，对齐 runner.ts:65） */
  timeoutMs?: number;
}

/**
 * 执行期上下文：由宿主（runner / agent）**每次调用**注入。
 *
 * 插件对象**不得**持有本对象的任何字段——装配期（`apply(ctx)` 里的 core Context）
 * 与执行期（本接口）严格分离，否则并发会话会互相串状态。
 */
export interface ToolInvokeContext {
  /** 取消信号：贯穿 LLM / 工具 / 子进程三层 */
  signal?: AbortSignal;
  /** 工作空间根：相对路径解析基准 */
  workspaceRoot?: string;
  /** 当前会话 id（后台任务通知归属用） */
  sessionId?: string;
  /** 当前工具调用 id（子 Agent 过程事件归属用） */
  callId?: string;
  /** 只读元信息透传（如 traceId）；不含密钥 */
  metadata?: Record<string, string>;
}

/**
 * 执行结果。
 *
 * `text` 是唯一进入模型上下文的字段（ReAct 的 Observation 必须是文本）；
 * `isError` 让宿主不必再靠正则猜失败（现状 `toolResultLooksFailed` 的已知误判）；
 * `structured` 只服务宿主（UI / 统计 / 门禁），本期不消费。
 */
export interface ToolResult {
  /** 模型可见的观察文本 */
  text: string;
  /** 是否失败；缺省视为成功 */
  isError?: boolean;
  /** 结构化输出（本期预留，不消费） */
  structured?: Record<string, unknown>;
}

/**
 * 模型侧工具定义视图。
 *
 * 与 llm 的 `LlmToolDef` 结构等价，但类型声明在本包内（D2：类型自持）。
 */
export interface ToolDefView {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** 缺省超时：与 `src/tools/runner.ts:65` 的 30000 保持一致，避免迁移前后行为漂移 */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
