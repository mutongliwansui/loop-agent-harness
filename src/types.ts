// ReAct Agent 核心类型定义
import type { Spinner } from './ui/spinner.js';
import type { ModelAdvanced } from './config/schema.js';

// ===== 工具相关 =====

/**
 * 工具执行上下文（Task-20261021-002-01）
 *
 * 作为 execute 的可选第二参传入，向后兼容：
 * 既有 `(args) => Promise<string>` 签名在 TS 结构类型下仍合法，无需改动。
 */
/**
 * 子 Agent 委托选项（需求 20261107-001）
 */
export interface SubAgentOptions {
  /** 补充给子 Agent 的背景信息 */
  context?: string;
  /** 指定模型（缺省继承主 Agent 的本次 run 模型） */
  model?: string;
  /** 最大迭代数（缺省继承主 Agent） */
  maxIterations?: number;
  /**
   * 归属的 delegate 工具调用 ID（需求 20261107-002 D2）：
   * 过程事件按此归属到对应工具卡片；并发多个 delegate 时不会串台。
   */
  callId?: string;
  /**
   * 后台执行（需求 20261107-002 D5）：立即返回 taskId，主 Agent 继续推理。
   * 受配置 `agent.subAgent.{background,maxConcurrent}` 约束。
   */
  background?: boolean;
}

/**
 * 子 Agent 执行结果（需求 20261107-001）
 */
export interface SubAgentResult {
  /** 子 Agent 的最终回答（作为主 Agent 的 observation 回写） */
  answer: string;
  /** 子 Agent 实际迭代轮数 */
  iterations: number;
  /** 后台任务 ID（background=true 时由执行器分配） */
  taskId?: string;
  /** 是否为后台提交（true 时 answer 为提交提示而非结论） */
  background?: boolean;
}

/**
 * 子 Agent 执行阶段（需求 20261107-002 D1/D2）
 */
export type SubAgentPhase =
  | 'start'
  | 'iteration'
  | 'think'
  | 'tool_start'
  | 'tool_end'
  | 'tool_progress'
  | 'final'
  | 'error'
  | 'aborted';

/**
 * 子 Agent 过程事件（需求 20261107-002）：由父 run 转发到 SSE，前端挂到 delegate 卡片。
 */
export interface SubAgentEventInfo {
  /** 归属：同步为 delegate 的 tool_call.id；后台为 taskId（sub_...） */
  callId: string;
  phase: SubAgentPhase;
  /** phase='iteration' 时为目标轮次（从 1 起）；think/tool_* 时为所属轮次 */
  iteration?: number;
  /** phase='think' 为思考文本摘要；'start' 为任务描述；'final' 为最终回答（均已截断） */
  text?: string;
  /** phase='tool_*' 时 */
  tool?: string;
  args?: Record<string, unknown>;
  result?: string;
  elapsedMs?: number;
  error?: string;
}

/** 子 Agent 单次工具步骤（过程区渲染 + 落盘恢复） */
export interface SubAgentToolStep {
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  elapsedMs?: number;
  ok?: boolean;
  /** 所属迭代轮次（从 1 起） */
  iteration?: number;
}

/** 子 Agent 执行轨迹（默认收起的过程区数据，需求 20261107-002 D3/D4） */
export interface SubAgentTrace {
  status: 'running' | 'done' | 'failed' | 'aborted';
  iterations: number;
  think: Array<{ iteration: number; text: string }>;
  tools: SubAgentToolStep[];
  final?: string;
  startedAt: number;
}

/** 后台子任务状态（落盘卡片 / 注册表共用） */
export type SubAgentTaskStatus = 'running' | 'done' | 'failed' | 'aborted' | 'interrupted';

/**
 * 后台子任务提交信息（需求 20261107-002 D8/D9）：
 * 由 Agent 层在后台任务登记后回调给 API 层，用于立即落盘「运行中」卡片。
 */
export interface SubAgentStartInfo {
  taskId: string;
  sessionId?: string;
  task: string;
  startedAt: number;
}

/**
 * 后台子任务完成信息（需求 20261107-002 D8）：
 * 由 Agent 层回调给 API 层，用于更新结果卡片 + 通知。
 */
export interface SubAgentCompleteInfo {
  taskId: string;
  sessionId?: string;
  task: string;
  status: 'done' | 'failed' | 'aborted';
  answer?: string;
  error?: string;
  iterations?: number;
  elapsedMs: number;
  trace?: SubAgentTrace;
}

export interface ToolContext {
  /** run 级取消信号：来自 AgentOptions.signal，贯穿 LLM/工具/子进程三层 */
  signal?: AbortSignal;
  /**
   * 工作空间根目录：由 runner 注入（Task-20261021-010-02 起工具必须消费）。
   * 工具解析相对路径时以此为准，不再依赖 process.cwd()。
   */
  workspaceRoot?: string;
  /**
   * 当前会话 ID（需求 20261104-004 D5）：由 runner 注入，后台任务据此把完成通知
   * 投递回原会话；CLI 首轮未建会话时为空，其通知进入无归属桶。
   */
  sessionId?: string;
  /**
   * 子 Agent 委托执行器（需求 20261107-001 D1）：
   * 由 ReActAgent.run() 在本次 run 内构造并注入，持有 configLoader/共享记忆 kit/空间根/取消信号。
   * 未注入时（如工具被脱离 Agent 直接调用）`delegate` 工具据此降级报错，不抛异常。
   */
  runSubAgent?: (task: string, opts?: SubAgentOptions) => Promise<SubAgentResult>;
  /**
   * 当前工具调用 ID（需求 20261107-002 D2）：由 runner 注入，子 Agent 过程事件据此归属卡片。
   */
  callId?: string;
}

/**
 * 工具接口：每个工具需提供名称、描述、参数 JSON Schema 与执行函数
 */
export interface Tool {
  name: string;
  description: string;
  /** JSON Schema 描述参数结构 */
  parameters: Record<string, unknown>;
  /**
   * 执行工具，返回字符串形式的 Observation
   * 第二参 ctx 可选：需要感知取消/工作空间的工具（如 commandRun）可声明并消费
   */
  execute: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<string>;
  /** 工具自定义超时毫秒；未设置时使用 runner 默认 30000（视觉等慢工具可调大） */
  timeoutMs?: number;
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
 * 单轮（一次 run）token 统计（需求 20261106-006）：
 * 挂在每轮最终 assistant 消息上随会话落盘，供 WebUI 每条回答的 Token chip 展示；
 * 仅存盘/展示语义，调用 LLM 前由 normalizeMessages 与其他存盘标记一并剥离。
 */
export interface TurnUsage {
  /** 累计输入 token */
  promptTokens: number;
  /** 累计输出 token */
  completionTokens: number;
  /** 累计总 token */
  totalTokens: number;
  /** 命中缓存的输入 token 合计（0=无缓存数据） */
  cacheHitTokens: number;
  /** 平均缓存命中率（prompt_cache_hit ÷ prompt_tokens；厂商无缓存字段为 undefined） */
  avgCacheHitRate?: number;
}

/**
 * 会话持久化标记（仅存盘语义，调用 LLM 前由 LLMClient.normalizeMessages 统一剥离）
 */
export interface SessionMessageFlags {
  /** 是否已被压缩折叠进摘要；true=归档消息（不参与 LLM 上下文，仅保留用于界面展示），false=recent 消息 */
  is_compact?: boolean;
  /** 是否在对话界面展示（缺省视为 true；system 与压缩总结消息为 false） */
  is_show?: boolean;
  /** 界面展示内容；缺省或为空时取 content（content 可能含记忆/摘要注入前缀） */
  show_content?: string;
  /**
   * 消息种类；'summary' = 压缩总结消息。
   * 显式判据，避免用 is_show=false 隐式推断（is_show 只是展示标记）；
   * 旧数据缺省时由 isSummaryMessage 回退到「role=user 且 is_show=false」。
   */
  kind?: 'summary' | 'subagent_result';
  /** 本轮 token 统计（需求 20261106-006）：仅每轮最终 assistant 消息携带；不进入 LLM 请求 */
  usage?: TurnUsage;
  /** 子 Agent 执行轨迹（需求 20261107-002 D4）：挂到 delegate 的 tool 消息，刷新后可恢复过程区 */
  sub?: SubAgentTrace;
  /**
   * 消息稳定 ID（需求 20261107-007 S2）：写入时生成并随会话落盘，
   * 作为「同一条消息」的身份键，用于写入/恢复链路的幂等去重。
   * 不用内容哈希作键：内容相同的合法消息（如连发两次「继续」）必须各自保留。
   * 旧数据缺失时由 store 按确定性规则补生成（同文件多次读取得到同一 ID）。
   * 仅存盘语义，调用 LLM 前由 LLMClient.normalizeMessages 剥离。
   */
  msgId?: string;
}

/**
 * 聊天消息联合类型：
 * - system/user：仅 content；压缩注入的摘要占位与已落盘的总结消息统一用
 *   kind='summary' 标记（旧数据回退 is_show=false），LLM 可见、UI 不展示
 * - assistant：纯文本回复 或 带 tool_calls 的回复
 * - tool：工具执行结果，附 tool_call_id
 *
 * 每条消息附带 SessionMessageFlags（is_compact/is_show/show_content/kind），
 * 用于会话存储层的展示与压缩标记；这些字段不进入 LLM 请求。
 *  - is_compact=true：已被压缩折叠（归档），不进入 LLM 上下文
 *  - is_show=false：不展示给用户（system / 摘要总结消息）
 *  - kind='summary'：压缩总结消息（显式种类标记）
 */
export type ChatMessage =
  | ({ role: 'system'; content: string } & SessionMessageFlags)
  | ({ role: 'user'; content: string } & SessionMessageFlags)
  | ({ role: 'assistant'; content: string | null; tool_calls?: ToolCall[] } & SessionMessageFlags)
  | ({ role: 'tool'; tool_call_id: string; content: string } & SessionMessageFlags);

/** 后台任务完成通知的文本边界（需求 20261105-001 D9：仅展示，不进入 LLM 历史前缀） */
export const BACKGROUND_NOTICE_OPEN = '<background_task_notification>';
export const BACKGROUND_NOTICE_CLOSE = '</background_task_notification>';

/**
 * 判断一段消息文本是否为后台任务完成通知。
 * 容忍旧版本遗留的 L2 记忆注入前缀（旧实现把通知当普通 user 消息，可能被记忆前缀包裹）。
 */
export function isBackgroundNoticeContent(content: string | null | undefined): boolean {
  if (typeof content !== 'string') return false;
  const t = content.trim();
  return t.endsWith(BACKGROUND_NOTICE_CLOSE) && t.includes(BACKGROUND_NOTICE_OPEN);
}

/** 后台子任务结果卡片边界（需求 20261107-002 D8）：仅用于前端展示，不作为 LLM 历史前缀 */
export const SUBAGENT_RESULT_OPEN = '<subagent_result>';
export const SUBAGENT_RESULT_CLOSE = '</subagent_result>';

/** 判断一段消息文本是否为后台子任务结果卡片 */
export function isSubAgentResultContent(content: string | null | undefined): boolean {
  if (typeof content !== 'string') return false;
  const t = content.trim();
  return t.endsWith(SUBAGENT_RESULT_CLOSE) && t.includes(SUBAGENT_RESULT_OPEN);
}

/** 展示专用消息（后台任务通知 / 子任务结果卡片）：不进入 LLM 请求的历史前缀 */
export function isDisplayOnlyContent(content: string | null | undefined): boolean {
  return isBackgroundNoticeContent(content) || isSubAgentResultContent(content);
}

/**
 * LLM 调用返回的 Token 使用情况（含缓存命中统计）
 *
 * 各字段含义：
 * - prompt_tokens: 总输入 token 数
 * - prompt_cache_hit_tokens: 命中前缀缓存的 token 数（智谱/DeepSeek 风格字段）
 * - prompt_cache_miss_tokens: 未命中缓存、需重新计算的 token 数
 * - prompt_tokens_details.cached_tokens: OpenAI 风格缓存命中字段（部分兼容服务商使用）
 * - completion_tokens: 输出 token 数
 * - total_tokens: 总 token 数
 *
 * 缓存命中率 = prompt_cache_hit_tokens / prompt_tokens
 *
 * 归一化（优化建议 20261021-009）：client 统一经 normalizeUsage() 解析——
 * OpenAI 风格 cached_tokens 已换算为 prompt_cache_hit_tokens，且「字段缺失」保持
 * undefined（N/A）与「真 0 命中」区分；details 字段仅解析用，随原样保留。
 */
export interface LLMUsage {
  prompt_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  /** OpenAI 风格报文附带的 details（仅解析用；归一化后以 hit/miss 为准） */
  prompt_tokens_details?: { cached_tokens?: number };
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
  /** 有缓存数据轮次的输入 token 合计（缓存命中率分母；无任何缓存字段时为 0） */
  promptTokensWithCache?: number;
  avgCacheHitRate?: number;
  /**
   * 20261021-008 R5：首轮（第 1 次迭代）缓存命中率——含 system/工具 schema 冷启动 miss，
   * 天然偏低，仅作参考口径。
   */
  firstIterationHitRate?: number;
  /**
   * 20261021-008 R5：第 2 轮起命中率（token 加权）——前缀缓存稳定后的真实口径，
   * 是缓存优化效果的主指标；无缓存字段或第 2 轮起无数据时为 undefined。
   */
  subsequentIterationsHitRate?: number;
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
  /** Task-17：提取失败时的兜底策略（'skip'=跳过压缩保留全部历史；'archive'=降级存档后压缩；'aborted'=压缩期被用户取消，run 即将中止） */
  fallback?: 'skip' | 'archive' | 'aborted';
}

/** 压缩开始事件载荷（与 onCompaction 配对：start 发出后必有一个 compaction 结束事件） */
export interface CompactionStartInfo {
  /** 压缩阈值（maxTokens × compactionThreshold） */
  threshold: number;
  /** 触发时的上下文 token（真实 usage 或估算） */
  contextTokens: number;
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
  /**
   * 本次调用的完整真实消息轨迹：未经 L1 压缩裁剪（不含 system 与摘要占位）。
   * 压缩只裁剪内存视图 messages，本字段始终保留本轮全部真实消息，
   * 供 SessionStore 归档「本轮已被压缩、尚未落盘」的消息，避免持久化丢历史。
   */
  transcript?: ChatMessage[];
}

/** run 过程中的节流快照（崩溃保护用） */
export interface AgentSnapshot {
  /** 当前内存消息视图（含 system 与摘要占位；调用方只读，不要原地修改） */
  messages: ChatMessage[];
  /** 未经 L1 压缩的完整真实消息轨迹 */
  transcript: ChatMessage[];
  /** 已完成的迭代数（从 1 开始） */
  iterations: number;
}

/**
 * Agent 运行选项
 */
export interface AgentOptions {
  /** 最大迭代次数，默认读取 config.agent.maxIterations */
  maxIterations?: number;
  /** 采样温度，默认 0（确定性推理） */
  temperature?: number;
  /** 模型名，默认读取 config.modelName */
  model?: string;
  /**
   * 会话级模型覆盖的服务地址（task-20261025-002 D4/D5）：
   * 与 apiKey 成对使用，缺一则回落全局 config；不传时行为与改动前完全一致。
   */
  baseUrl?: string;
  /** 会话级模型覆盖的 API Key（与 baseUrl 成对；缺一则回落全局 config） */
  apiKey?: string;
  /**
   * 单模型高级参数（需求 20261111-001）：
   * 会话级覆盖时由 API 层传入对应 profile 的 advanced；缺省回落实效快照 model.advanced。
   */
  advanced?: ModelAdvanced;
  /** 是否打印 Thought/Action/Observation 日志，默认 true */
  verbose?: boolean;
  /** 事件监听器数组（参考 langchain callbacks 设计），每个钩子按顺序调用 */
  events?: AgentEvents[];
  /**
   * 本次 run 所属会话 ID（多会话并发的身份真源，task-20261106-002）。
   * 传入后 run 内所有 L2 记忆读写、工具 ctx、后台任务/通知归属均以此为准；
   * 缺省时回落实例的 _currentSessionId（CLI 兼容路径）。
   */
  sessionId?: string;
  /** 传入之前的消息历史（用于多轮对话），若同时指定 resetHistory=false，则会继续在此基础上追加 */
  messages?: ChatMessage[];
  /** true=清空历史重新开始（覆盖 messages 参数），默认 false */
  resetHistory?: boolean;
  /** 可选的 loading 指示器（由 CLI 层创建注入；程序化调用不传即无指示器） */
  spinner?: Spinner;
  /**
   * 节流快照回调：run 过程中每个工具迭代结束后按节流窗口（3 次迭代或 30s）调用，
   * 用于进程崩溃时保留已产生的消息。压缩前会强制调用一次。
   * 回调失败只记日志，不影响主流程。
   */
  onSnapshot?: (snapshot: AgentSnapshot) => void | Promise<void>;
  /**
   * run 级取消信号（Task-20261021-002-01）：
   * aborted 后 Agent 在检查点抛出 AgentAbortedError（携带 partial）。
   * 不传时全部路径行为与无取消一致（CLI 模式零改动）。
   */
  signal?: AbortSignal;
  /**
   * 排除的工具名（需求 20261107-001 D4）：本次 run 传给 LLM 的 tools 列表会剔除这些工具，
   * 执行阶段也会拦截（防止 LLM 幻觉调用）。用于子 Agent 排除 `delegate` 防无限递归；
   * 主 Agent run 一般不传，行为与改动前完全一致。
   */
  excludeTools?: string[];
  /**
   * 是否输出 LLM token 统计（需求 20261107-002 D12）：
   * 仅用于给子 Agent 关闭默认 ConsoleLogger 的统计行（子 Agent 过程走缩进日志/事件桥接）。
   * 缺省读取 config.agent.showTokenStats。
   */
  showTokenStats?: boolean;
  /**
   * 子 Agent 过程事件回调（需求 20261107-002 D1/D2）：
   * WebUI 由 API 层注入，转发为 SSE `subagent_event`；CLI 不注入（走缩进控制台日志）。
   */
  onSubAgentEvent?: (info: SubAgentEventInfo) => void | Promise<void>;
  /**
   * 后台子任务提交回调（需求 20261107-002 D8/D9）：
   * API 层据此立即落盘「运行中」卡片（刷新/重启后仍可见，中断时可标记）。
   */
  onSubAgentStart?: (info: SubAgentStartInfo) => void | Promise<void>;
  /**
   * 后台子任务完成回调（需求 20261107-002 D8）：
   * API 层据此更新结果卡片 + 推送通知；CLI 不注入时打印到终端。
   */
  onSubAgentComplete?: (info: SubAgentCompleteInfo) => void | Promise<void>;
}

// ===== 取消相关（Task-20261021-002-01） =====

/**
 * 中止时携带的部分结果：供 API 层（RunHub / handleMessage）落盘已生成内容
 */
export interface AgentPartialResult {
  /** 当前内存消息视图（含 system 与摘要占位） */
  messages: ChatMessage[];
  /** 未经 L1 压缩的完整真实消息轨迹 */
  transcript: ChatMessage[];
  /** 已完成的推理步骤 */
  steps: AgentStep[];
  /** 中止发生时的迭代轮数 */
  iterations: number;
}

/**
 * 用户中止载体（Task-20261021-002-01）
 *
 * 设计要点：
 * - `aborted === true` 标记位用于各层识别"这是取消"而非普通失败
 *   （ToolRunner 的归一化契约对此唯一放行，取消必须冒泡而非转为失败 Observation）；
 * - LLM/Tool 层无法构造完整 partial，会先抛空 partial 实例，
 *   由 agent 主循环（Task-20261021-002-02）换绑完整快照后再向外抛。
 */
export class AgentAbortedError extends Error {
  /** 标记位：识别"取消"而非普通失败（ToolRunner 冒泡例外的判据） */
  readonly aborted = true;
  constructor(readonly partial: AgentPartialResult) {
    super('run aborted by user');
    this.name = 'AgentAbortedError';
  }
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
  /** 工具执行进度心跳（Task-20260930-001 P2：长耗时工具运行期间周期性上报已用时） */
  onToolProgress?(tool: string, elapsedMs: number): void | Promise<void>;
  /**
   * 生成工具调用参数（tool_calls.arguments）的流式增量
   * Task-20260930-001：覆盖「Thought 文本结束 → [Action] 打印」之间的空窗（如 fileWrite 会逐 token 生成整个文件内容）
   * @param tool 工具名（首帧 name 未知时为占位名）
   * @param accumulatedBytes 该 tool_call 已累积的参数字节数
   * @param elapsedMs 自该轮参数生成开始以来的耗时
   */
  onToolCallDelta?(tool: string, accumulatedBytes: number, elapsedMs: number): void | Promise<void>;
  /** L1 上下文超阈值，压缩开始（pre-compaction flush 提取进行中，期间有一次额外 LLM 调用） */
  onCompactionStart?(info: CompactionStartInfo): void | Promise<void>;
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

// ===== 视觉模型相关 =====

/**
 * 视觉请求的多模态 content 片段（OpenAI 协议格式）
 *
 * 仅在 VisionClient（chatVision）内部构造请求时使用，
 * 不进入 ChatMessage 历史与会话持久化——主模型是纯文本模型，永不接收图像像素。
 */
export interface VisionContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

/** 视觉请求消息（content 支持多模态数组） */
export interface VisionMessage {
  role: 'system' | 'user';
  content: string | VisionContentPart[];
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
