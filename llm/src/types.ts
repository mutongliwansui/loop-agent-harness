/**
 * 领域类型：大模型请求 / 响应 / 流式事件的**协议无关**形态。
 *
 * 为什么在 llm 包内自持而不从 `src/types.ts` 提取下沉：
 * - 不下沉进 core：core 是**领域无关的内核**，塞进大模型术语会让它变回
 *   「又一个业务包」，且 core 的 boundary 断言会失去意义。
 * - 不 import `src/types.ts`：违反零反向依赖，且那份 673 行文件里混着会话
 *   标记（`is_compact` / `is_show` / `msgId` / `attachments`）、后台通知边界
 *   常量等与 provider 契约无关的杂质，引用会把它们带进契约层。
 *
 * 代价：短期内与 `src/types.ts` 结构性重复，迁移时按对照表一次性对账。
 * 这是**刻意的**——契约层必须能独立演进，否则抽象形同虚设。
 *
 * 命名统一 camelCase：领域层若照搬上游 snake_case（`prompt_tokens`），
 * 抽象就被上游协议污染了，而这正是本包要解决的问题本身。上游映射由各
 * provider 实现自己完成。
 */

/** 内容分片：文本或多模态图片 */
export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

/** 消息四态：system / user / assistant / tool */
export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | LlmContentPart[] }
  | { role: 'assistant'; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

/** 工具定义：不暴露上游 `{type:'function', function:{…}}` 包装 */
export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema 对象；本期手写校验，不引三方库 */
  parameters: Record<string, unknown>;
}

/**
 * 工具调用。
 *
 * `arguments` 保持 JSON **字符串**而非已解析对象：与上游一致，避免
 * 「解析 → 再序列化」过程中的数字精度与键序丢失。
 */
export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * 用量。
 *
 * 缺失字段一律 `undefined`，**不填 0**：provider 不回报用量时记「未知」，
 * 若填 0 会让成本统计被系统性低估。
 */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 缓存命中 token；provider 不回报时为 `undefined`（≠ 0） */
  cacheHitTokens?: number;
  cacheMissTokens?: number;
}

/** 结束原因；开放字符串尾部保留服务商特有值 */
export type LlmFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | (string & {});

/** 一次请求：只含**本次调用**的变量，配置在实例创建时一次性给（见 define.ts） */
export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: LlmToolDef[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  responseFormat?: { type: 'text' } | { type: 'json'; schema?: Record<string, unknown> };
  stop?: string[];
  /** 透传元信息（如 sessionId），provider 可忽略；**不得含密钥** */
  metadata?: Record<string, string>;
}

/** 一次响应 */
export interface LlmResponse {
  content: string | null;
  toolCalls?: LlmToolCall[];
  finishReason: LlmFinishReason;
  /** 用量；provider 不回报时为 `undefined`，不构造全 0 对象 */
  usage?: LlmUsage;
  /** 实际使用的模型名（服务商可能把别名改写为具体版本） */
  model: string;
  /**
   * 受控逃生口：服务商专有字段。
   *
   * 这是**有意保留的泄漏**。消费方必须容忍其为 `undefined` 或形状随
   * provider 变化；**核心逻辑不得依赖**。需要稳定字段时应当提进契约。
   */
  raw?: unknown;
}

/** 流式事件：四个语义片段 + 收尾 */
export type LlmStreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call-start'; index: number; id: string; name: string }
  | { type: 'tool-call-delta'; index: number; argumentsDelta: string }
  | { type: 'usage'; usage: LlmUsage }
  | { type: 'done'; response: LlmResponse };
