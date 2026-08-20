// ReAct Agent 核心类型定义

// ===== 工具相关 =====

/**
 * 工具接口：每个工具需提供名称、描述、参数 JSON Schema 与执行函数
 */
export interface Tool {
  name: string;
  description: string;
  /** JSON Schema 描述参数结构 */
  parameters: Record<string, unknown>;
  /** 执行工具，返回字符串形式的 Observation */
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/**
 * OpenAI function calling 的 tools 参数格式
 */
export interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ===== 消息相关 =====

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON 字符串形式的参数 */
    arguments: string;
  };
}

/**
 * 聊天消息联合类型：
 * - system/user：仅 content
 * - assistant：纯文本回复 或 带 tool_calls 的回复
 * - tool：工具执行结果，附 tool_call_id
 */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * LLM 调用返回的 Token 使用情况（含缓存命中统计）
 *
 * 各字段含义：
 * - prompt_tokens: 总输入 token 数
 * - prompt_cache_hit_tokens: 命中前缀缓存的 token 数（DeepSeek V4 等模型支持）
 * - prompt_cache_miss_tokens: 未命中缓存、需重新计算的 token 数
 * - completion_tokens: 输出 token 数
 * - total_tokens: 总 token 数
 *
 * 缓存命中率 = prompt_cache_hit_tokens / prompt_tokens
 */
export interface LLMUsage {
  prompt_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * LLM 调用返回的统一结构
 */
export interface LLMResponse {
  content: string | null;
  tool_calls?: ToolCall[];
  finish_reason: 'stop' | 'tool_calls' | 'length' | string;
  /** Token 使用情况（含缓存命中统计） */
  usage?: LLMUsage;
}

/**
 * 单轮 LLM 调用统计（Task-15：每轮迭代后打印）
 *
 * 字段说明：
 * - contextTokens: 本轮上下文 token 数（优先 usage.prompt_tokens，缺失时 fallback 估算）
 * - contextMaxTokens / contextThreshold: L1 压缩上限与压缩阈值（用于展示占用比例与警示）
 * - cacheHitRate: 缓存命中率 0-1（= prompt_cache_hit_tokens / prompt_tokens，无法计算时为 undefined）
 */
export interface LLMStats {
  iteration: number;
  maxIterations: number;
  contextTokens: number;
  contextMaxTokens: number;
  contextThreshold: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens?: number;
  cacheHitRate?: number;
  elapsedMs: number;
}

/** 会话累积统计汇总（Task-15：会话结束打印） */
export interface LLMStatsSummary {
  iterations: number;
  totalPrompt: number;
  totalCompletion: number;
  totalTokens: number;
  totalCacheHit: number;
  avgCacheHitRate?: number;
  peakContextTokens: number;
  peakContextMaxTokens: number;
}

/** L1 压缩事件信息（触发压缩时回调） */
export interface CompactionInfo {
  /** 压缩阈值（maxTokens × compactionThreshold） */
  threshold: number;
  /** 触发时的上下文 token（真实 usage 或估算） */
  contextTokens: number;
  /** pre-compaction flush 提取写入 L2 的字符数 */
  flushedChars: number;
  /** 压缩后保留的消息数 */
  keptMessages: number;
  /** Task-17：提取是否失败（false=正常压缩；true=提取失败走了兜底路径） */
  failed?: boolean;
  /** Task-17：提取失败时的兜底策略（'skip'=跳过压缩保留全部历史；'archive'=降级存档后压缩） */
  fallback?: 'skip' | 'archive';
}

// ===== Agent 相关 =====

/**
 * 单步推理记录：对应 ReAct 的 Thought / Action / Observation
 */
export interface AgentStep {
  /** 模型的推理内容（Thought） */
  thought?: string;
  /** 工具调用（Action） */
  action?: {
    tool: string;
    args: Record<string, unknown>;
  };
  /** 工具返回结果（Observation） */
  observation?: string;
}

/**
 * Agent 运行结果
 */
export interface AgentResult {
  /** 最终答案 */
  answer: string;
  /** 推理步骤记录 */
  steps: AgentStep[];
  /** 实际迭代轮数 */
  iterations: number;
  /** 本次调用结束后的完整 messages 历史（含 system/assistant/tool），可用于下一轮续接 */
  messages: ChatMessage[];
}

/**
 * Agent 运行选项
 */
export interface AgentOptions {
  /** 最大迭代次数，默认读取 config.maxIterations */
  maxIterations?: number;
  /** 采样温度，默认 0（确定性推理） */
  temperature?: number;
  /** 模型名，默认读取 config.modelName */
  model?: string;
  /** 是否打印 Thought/Action/Observation 日志，默认 true */
  verbose?: boolean;
  /** 事件监听器数组（参考 langchain callbacks 设计），每个钩子按顺序调用 */
  events?: AgentEvents[];
  /** 传入之前的消息历史（用于多轮对话），若同时指定 resetHistory=false，则会继续在此基础上追加 */
  messages?: ChatMessage[];
  /** true=清空历史重新开始（覆盖 messages 参数），默认 false */
  resetHistory?: boolean;
}

/**
 * Agent 事件监听器接口（参考 langchain callbacks）
 *
 * 所有钩子均为可选，未实现时跳过
 * 多个 listener 顺序执行，单个 listener 抛错会被捕获不中断主循环
 */
export interface AgentEvents {
  /** Agent 启动 */
  onStart?(input: string): void | Promise<void>;
  /** 每轮迭代开始 */
  onIterationStart?(iteration: number, maxIterations: number): void | Promise<void>;
  /** LLM 流式输出 Thought 片段（实时） */
  onLLMStream?(delta: string): void | Promise<void>;
  /** LLM 单轮调用结束，拿到完整响应 */
  onLLMEnd?(response: LLMResponse, iteration: number): void | Promise<void>;
  /** LLM 单轮统计（Task-15：每轮迭代完成后调用） */
  onLLMStats?(stats: LLMStats): void | Promise<void>;
  /** 会话统计汇总（Task-15：整个 ReAct 会话结束后调用） */
  onLLMStatsSummary?(summary: LLMStatsSummary): void | Promise<void>;
  /** 工具调用开始（同轮多工具时每个触发一次） */
  onToolStart?(tool: string, args: Record<string, unknown>): void | Promise<void>;
  /** 工具调用结束，拿到 Observation */
  onToolEnd?(tool: string, result: string): void | Promise<void>;
  /** L1 上下文超阈值，触发压缩 */
  onCompaction?(info: CompactionInfo): void | Promise<void>;
  /** Agent 给出最终答案 */
  onFinal?(answer: string): void | Promise<void>;
  /** Agent 出错（达到 maxIterations 或其他异常） */
  onError?(error: Error): void | Promise<void>;
  /** Agent 警告（非致命问题，如会话保存失败） */
  onWarning?(info: { level: 'warning' | 'error'; message: string; context?: string }): void | Promise<void>;
  /** Agent 结束（无论成功或失败） */
  onEnd?(result: AgentResult | null): void | Promise<void>;
}

// ===== 流式相关 =====

/**
 * 流式输出的单个 chunk
 *
 * 设计说明：
 * - delta：文本片段（Thought/最终答案的逐 token 产出）
 * - toolCallStart：开始一个新的 tool_call（首次出现某个 index）
 * - toolCallDelta：tool_call 的 arguments 增量片段
 * - done：流结束，携带完整的 LLMResponse（含累积后的 content / tool_calls / finish_reason）
 */
export type StreamChunk =
  | { type: 'delta'; content: string }
  | { type: 'toolCallStart'; index: number; toolCallId: string; name: string }
  | { type: 'toolCallDelta'; index: number; argumentsDelta: string }
  | { type: 'done'; response: LLMResponse };
