// 配置 Schema 定义与类型
import type { MCPServerConfig } from '../tools/mcp/client.js';
import type { SessionConfig } from '../session/types.js';
import type { SkillConfig } from '../skill/types.js';
import type { MemoryConfig } from '../memory/types.js';
import { DEFAULT_MEMORY_CONFIG } from '../memory/types.js';
import { loopAgentHome } from '../user-home.js';
import { join } from 'node:path';

/** Agent 完整配置结构 */
export interface AgentConfig {
  model: ModelConfig;
  models: ModelsConfig;
  tools: ToolsConfig;
  agent: AgentBehaviorConfig;
  session: SessionConfig;
  skill: SkillConfig;
  memory: MemoryConfig;
  vision: VisionConfig;
  /** 本地 OCR（需求 20261112-002） */
  ocr: OcrConfig;
  api: ApiConfig;
  webui: WebuiConfig;
}

export interface ModelConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  /** 单模型高级参数（需求 20261111-001；未设置时按服务商默认） */
  advanced?: ModelAdvanced;
}

/**
 * 单模型高级参数（需求 20261111-001）
 *
 * 设计要点：
 * - 全部可选，未定义的键不下发（留空 = 用服务商默认值）
 * - 仅在该模型被调用时生效，切换模型互不影响
 * - maxTokens 只作为缺省值：调用方显式传入 maxTokens（压缩/测速等）时优先用显式值
 */
export interface ModelAdvanced {
  /** 单次输出上限（透传 max_tokens） */
  maxTokens?: number;
  /** 核采样（top_p，0~1） */
  topP?: number;
  /** top_k（部分兼容服务商支持） */
  topK?: number;
  /** 频率惩罚（frequency_penalty，-2~2） */
  frequencyPenalty?: number;
  /** 单模型请求超时（毫秒，下限 1000） */
  timeoutMs?: number;
  /** 自定义请求头（如 OpenAI-Organization、Azure api-version）；系统头不允许覆盖 */
  headers?: Record<string, string>;
}

/**
 * 单个已接入模型的登记信息（Task-20261011-002 多模型接入与切换）
 */
export interface ModelProfile {
  /** 模型名（如 deepseek-chat） */
  name: string;
  /** 服务地址（OpenAI 兼容协议） */
  baseUrl: string;
  /** API Key（展示时遮蔽，仅尾 4 位） */
  apiKey: string;
  /** 采样温度（可选；未设置时切换不覆盖 model.temperature 现值） */
  temperature?: number;
  /** 单模型高级参数（可选；切换时同步到 model.advanced 快照） */
  advanced?: ModelAdvanced;
}

/**
 * 多模型接入配置（Task-20261011-002）
 *
 * 设计要点：
 * - profiles 用 Record（别名 → 配置）而非数组：deepMerge 对对象递归合并，
 *   global 与 workspace 的登记簿可跨层叠加；数组会被整体替换互相覆盖
 * - model.* 是"当前生效"快照（运行时唯一读取点），models 是"登记簿 + 激活指针"，
 *   /model use 切换时同步写两者
 * - active 为空串 = 未纳入多模型管理（兼容存量单模型配置用户）
 */
export interface ModelsConfig {
  /** 当前激活的 profile 别名；空串 = 未纳入多模型管理 */
  active: string;
  /** 模型登记簿：别名 → 三元组 */
  profiles: Record<string, ModelProfile>;
}

export interface ToolsConfig {
  enabled: string[];
  disabled: string[];
  mcpServers: Record<string, MCPServerConfig>;
  /** MCP 工具展示名与参数标签的中文化（需求 20261104-001，D13） */
  mcpTranslate: McpTranslateConfig;
  /** 后台任务日志清理（需求 20261104-003） */
  backgroundLog: BackgroundLogConfig;
  /** 前台命令输出与默认超时（需求 20261104-006） */
  commandRun: CommandRunConfig;
  /** 工具输出超限治理：完整结果落临时文件 + 清理策略（需求 20261106-001） */
  outputGovernor: OutputGovernorConfig;
  /** 后台任务完成通知（需求 20261104-004） */
  backgroundNotify: BackgroundNotifyConfig;
}

/**
 * 前台命令执行配置（需求 20261104-006 D7）
 *
 * - outputLimitKb：返回内容总上限，头尾各占一半，中间省略（默认 64KB）
 *   默认值与上下文预算对齐：过大的单次输出会瞬间顶到 L1 压缩阈值，
 *   压缩后历史工具结果只剩摘要（界面看起来「输出被吞」）。
 * - timeoutMs：未传 timeout 参数时的默认超时（默认 30s，长任务请走 background）
 */
export interface CommandRunConfig {
  outputLimitKb: number;
  timeoutMs: number;
}

/**
 * 工具输出超限治理配置（需求 20261106-001）
 *
 * 职责分工：`commandRun.outputLimitKb` 管「进上下文多少」，
 * 这里管「完整结果落临时文件的触发条件与清理」。
 *
 * - preserveKb：落盘触发基数（KB）；也是 governOneShot 的一次性工具字节上限
 * - preserveLines：grep 等按行截断的默认保留行数
 * - triggerMultiplier：流式工具累计字节 > preserveKb × 本值 时创建临时文件
 *   （默认 2 ⇒ 128KB 以内的小输出完全不落盘，零磁盘开销）
 * - tmpTtlDays / tmpMaxTotalMb：~/.loop-agent/tmp 下临时文件的天数与总量上限
 */
export interface OutputGovernorConfig {
  preserveKb: number;
  preserveLines: number;
  triggerMultiplier: number;
  tmpTtlDays: number;
  tmpMaxTotalMb: number;
}

/**
 * 后台任务完成通知配置（需求 20261104-004 D7）
 *
 * - enabled：关闭后不产生通知、不写 notifiedAt
 * - tailLines / maxChars：注入日志尾部的行数与字符上限
 * - wakeIdle：会话空闲（无运行循环）时任务完成，是否像后台子任务一样
 *   唤醒一轮 run 主动消费通知（需求 20261108-002；默认 true，WebUI/服务模式生效）
 */
export interface BackgroundNotifyConfig {
  enabled: boolean;
  tailLines: number;
  maxChars: number;
  wakeIdle: boolean;
}

/**
 * 后台任务日志清理配置（需求 20261104-003）
 *
 * 说明：只清理 `~/.loop-agent/runs/` 下的历史 `.json`/`.log`，
 * 不截断正在写入的活日志（fd 偏移无法安全重置，见任务文档 D2）。
 */
export interface BackgroundLogConfig {
  /** 是否启用启动期 + 每次后台启动前的清理（默认 true） */
  enabled: boolean;
  /** 已结束任务（`.json`+`.log`）保留天数（默认 7） */
  retentionDays: number;
  /** runs 目录日志总量上限（MB，默认 100，超出按 mtime 从旧删起） */
  maxTotalMb: number;
}

/**
 * MCP 展示名翻译配置（需求 20261104-001）
 *
 * 说明：只影响 UI 展示（ToolCard/LiveStatus 的中文名与参数标签），
 * 绝不进入 `toOpenAITools()`，因此不会破坏模型前缀缓存（D9）。
 */
export interface McpTranslateConfig {
  /** 是否启用 LLM 翻译兜底（默认 true；关闭后仅用 title/中文描述提炼/名字美化） */
  enabled: boolean;
  /** auto=描述已是中文则本地提炼、不调 LLM；always=一律走 LLM（默认 auto） */
  mode: 'auto' | 'always';
  /** 单次翻译调用超时（毫秒，默认 20000） */
  timeoutMs: number;
  /** 单批最多工具数（默认 60，超出切批串行） */
  maxToolsPerBatch: number;
}

export interface AgentBehaviorConfig {
  verbose: boolean;
  debug: boolean;
  systemPrompt: string | null;
  /** Task-15：是否打印每轮 token/缓存/上下文统计（默认 true，独立于 verbose） */
  showTokenStats: boolean;
  /** 是否记录每次模型调用的输入参数与响应到独立日志文件（~/.loop-agent/logs/llm-*.log） */
  llmLogEnabled: boolean;
  /** Task-20260930-001：是否显示等待 loading 指示器（默认 true；非 TTY 环境始终禁用） */
  loading: boolean;
  /** 单次任务最大迭代次数（默认 100；环境变量 MAX_ITERATIONS 可覆盖） */
  maxIterations: number;
  /** 子 Agent 委托配置（需求 20261107-002 D5） */
  subAgent: SubAgentConfig;
}

/**
 * 子 Agent 委托配置（需求 20261107-002）
 */
export interface SubAgentConfig {
  /** 是否允许后台执行（delegate({background:true})）；关闭时委托一律同步阻塞 */
  background: boolean;
  /** 同一会话后台子任务并发上限（超限立即报错，不排队） */
  maxConcurrent: number;
}

/**
 * 视觉模型配置（Task-20261010-001）
 *
 * 设计要点：
 * - enabled 默认 false：关闭时不注册视觉工具，主模型 tools 列表与现状字节一致（保住前缀缓存）
 * - baseUrl/apiKey/model 为空时回退主模型 model.* 三元组（同一服务商多模型零重复配置）
 */
export interface VisionConfig {
  /** 是否启用视觉工具（关闭时不注册 analyzeImage） */
  enabled: boolean;
  /** 视觉服务 baseUrl，空则回退 model.baseUrl */
  baseUrl: string;
  /** 视觉服务 apiKey，空则回退 model.apiKey */
  apiKey: string;
  /** 视觉模型名，空则回退 model.name（主模型需具备视觉能力） */
  model: string;
  /** 采样温度（默认 0，输出稳定） */
  temperature: number;
  /** 单次输出上限（视觉描述可能较长） */
  maxTokens: number;
  /** 单次视觉调用超时毫秒（传入 Tool.timeoutMs） */
  timeoutMs: number;
  /** 图片大小上限（字节） */
  maxImageBytes: number;
  /** 工具结果最大字符数（超出截断，防上下文膨胀） */
  maxResultChars: number;
  /** 是否启用结果缓存（P1 生效） */
  cacheEnabled: boolean;
  /** 缓存 TTL 毫秒（P1 生效） */
  cacheTtlMs: number;
}

/**
 * 本地 OCR 配置（需求 20261112-002）
 *
 * 设计要点：
 * - `enabled` 默认 true，但**只有探测到可用引擎时**才注册 `ocrImage`（D7），
 *   非 Windows 平台不注册、不降级、不产出文档图片块（零影响）
 * - 引擎抽象为 `src/ocr/types.ts` 的 `OcrEngine`，`enginePriority` 决定 auto 探测顺序，
 *   补齐 macOS/Linux 实现时无需改动任何调用方（演进项）
 * - `fallbackFromVision` 控制 `analyzeImage` 视觉失败时是否降级到本地 OCR（D2）
 * - `doc.*` 是 `fileRead` 文档内图片 OCR 的三重预算（D3）
 */
export interface OcrConfig {
  /** 是否启用本地 OCR（关闭后不注册 ocrImage、不做视觉降级、文档不出图片块） */
  enabled: boolean;
  /** 引擎选择：'auto' 按 enginePriority 探测；也可显式指定 'winrt-ocr' / 'http' */
  engine: string;
  /** auto 时的探测顺序；默认 ['winrt-ocr']，配置了 http.endpoint 时自动追加 'http' */
  enginePriority: string[];
  /** 识别语言；'auto' 取引擎首选（Windows 上优先 zh-Hans-CN，其次任意 zh，再退首个可用） */
  lang: string;
  /** 单张图片 OCR 超时（毫秒） */
  timeoutMs: number;
  /** 单张图片大小上限（字节，与 vision.maxImageBytes 同口径） */
  maxImageBytes: number;
  /** 单张结果字符上限的**默认值**（工具入参可上浮至 maxCharsHardLimit，见 D7） */
  maxChars: number;
  /** 单张结果字符的硬上限（工具入参不得突破） */
  maxCharsHardLimit: number;
  /** 默认版面形态：text（y 聚类视觉行）/ table（markdown 表格）/ words（词坐标 TSV），见 D2 */
  layout: string;
  /** 是否启用进程内结果缓存（D5） */
  cacheEnabled: boolean;
  /** 缓存 TTL（毫秒） */
  cacheTtlMs: number;
  /** 缓存条目上限 */
  cacheMaxEntries: number;
  /** analyzeImage 视觉失败时是否降级到本地 OCR（D2；extract 分支不降级） */
  fallbackFromVision: boolean;
  /** fileRead 文档内图片 OCR（D3） */
  doc: OcrDocConfig;
  /** 可选 HTTP OCR 端点（P2；未配置则不参与探测） */
  http?: OcrHttpConfig;
  /** 自定义 PDF 光栅化命令模板（D8）；省略则按 内建渲染器 → pdftoppm → mutool → gs 顺序探测 */
  pdfRasterizer?: string;
  /**
   * PDF 渲染引擎策略（需求 20261112-004 / D6）：
   * - 'auto'（默认）：Windows 内建渲染器（Windows.Data.Pdf）优先，不可用时回落外部工具；
   * - 'winrt'：只用内建渲染器，不可用则直接报错（不回落，便于现场定位）；
   * - 'external'：只用外部工具（pdftoppm → mutool → gs），完全不 spawn powershell。
   */
  pdfRasterEngine?: PdfRasterEngine;
}

/** 文档内图片 OCR 预算（D3） */
export interface OcrDocConfig {
  /** 是否对文档内图片做 OCR */
  enabled: boolean;
  /** 单文档最多 OCR 的图片数 */
  maxImages: number;
  /** 单张图片结果字符上限 */
  maxCharsPerImage: number;
  /** 文档图片 OCR 总时间预算（毫秒），超预算的剩余图片只给路径提示 */
  timeBudgetMs: number;
  /** PDF 仅对无文本层页做 OCR */
  pdfScannedPagesOnly: boolean;
  /**
   * 文档内图片是否视觉优先（需求 20261112-004 / D3）：默认 true，但还需 vision.enabled=true 才实际生效；
   * 置 false 可一键回到「只用本地 OCR」的旧行为（内网/隐私场景）。
   */
  preferVision: boolean;
}

/**
 * PDF 渲染引擎策略（`ocr.pdfRasterEngine`，需求 20261112-004 / D6）：
 * - `'auto'`（默认）：Windows 内建渲染器（`Windows.Data.Pdf`）优先，不可用时回落外部工具；
 * - `'winrt'`：只用内建渲染器，不可用即报错（不回落，便于现场定位）；
 * - `'external'`：只用外部工具（pdftoppm → mutool → gs），完全不 spawn powershell。
 */
export type PdfRasterEngine = 'auto' | 'winrt' | 'external';

/** 可选 HTTP OCR 端点配置 */
export interface OcrHttpConfig {
  /** 端点地址（POST，请求体 { image: base64, lang }） */
  endpoint: string;
  /** 鉴权 Token（Bearer；留空不带鉴权头，也不继承主模型 apiKey） */
  apiKey: string;
  /** 响应中承载文本的字段名（默认 'text'） */
  fieldName: string;
}

/**
 * HTTP API 服务配置（Task-20261016-001 自定义 REST API 服务）
 *
 * 设计要点：
 * - 仅在 `--serve` 启动模式下生效（REPL 模式完全忽略本段）
 * - host 绑定非回环地址且 token 为空时拒绝启动（防裸奔暴露局域网，D6）
 * - token 为空时仅接受本机请求；非空时所有请求强制 Bearer 校验
 */
export interface ApiConfig {
  /** 监听端口 */
  port: number;
  /** 监听地址；非回环地址必须配置 token */
  host: string;
  /** Bearer Token；为空时仅接受本机请求（展示时遮蔽，仅尾 4 位） */
  token: string;
  /** WebUI 静态资源根目录；空 = 自动探测内置 webui/dist（Task-20261017-001 D3） */
  webRoot: string;
}

/**
 * WebUI 专属配置（Task-20261027-001 文件预览区终端）
 *
 * 设计要点：
 * - 仅在 `--serve`（WebUI）模式下生效，REPL 模式完全忽略
 * - `terminal` **默认开启**：终端 = 当前用户权限下的任意命令执行，需要收紧时显式设为 false
 *   （2026-11-09 由默认 false 调整为 true；关闭后 WS 握手直接 403）
 * - `terminalDeny` 在**服务端**生效（前端确认框可被绕过，不算安全边界，D10）
 */
export interface WebuiConfig {
  /** 是否启用文件预览区终端（默认 true；置 false 可关闭，关闭后 WS 握手 403） */
  terminal: boolean;
  /** 终端拒绝执行的命令关键字（大小写不敏感子串匹配，命中即拒） */
  terminalDeny: string[];
  /** 单用户并发终端上限（默认 4） */
  terminalMax: number;
  /** 空闲回收毫秒（默认 30 分钟） */
  terminalIdleMs: number;
}

/** 配置来源标记 */
export type ConfigSource = 'cli' | 'workspace' | 'global' | 'env' | 'default';
/** 合并后的配置结果 */
export interface ResolvedConfig {
  config: AgentConfig;
  sources: Record<string, ConfigSource>;
}

/** 部分配置（用于 CLI override、部分写入等） */
export type PartialAgentConfig = {
  model?: Partial<ModelConfig>;
  models?: Partial<ModelsConfig>;
  tools?: Partial<ToolsConfig>;
  agent?: Partial<AgentBehaviorConfig>;
  session?: Partial<SessionConfig>;
  skill?: Partial<SkillConfig>;
  memory?: Partial<MemoryConfig>;
  vision?: Partial<VisionConfig>;
  ocr?: Partial<OcrConfig>;
  api?: Partial<ApiConfig>;
  webui?: Partial<WebuiConfig>;
};

/**
 * 漂移检测（Task-20261011-002 D4）：激活 profile 与生效快照的结构字段不一致时返回提示。
 * 只比 name+baseUrl（apiKey 轮换属正常维护，不算漂移）；
 * 放在 schema 层供 /model 命令与 Banner 渲染共用（纯函数、无依赖）
 */
export function detectDrift(cfg: AgentConfig): string | null {
  const alias = cfg.models.active;
  if (!alias) return null;
  const p = cfg.models.profiles[alias];
  if (!p) return `激活项「${alias}」在登记簿中不存在（可能被手动删除）`;
  if (p.name !== cfg.model.name || p.baseUrl !== cfg.model.baseUrl) {
    return `当前生效快照（${cfg.model.name} @ ${cfg.model.baseUrl}）与激活 profile「${alias}」不一致，可执行 /model use ${alias} 重新同步`;
  }
  return null;
}

/** 默认配置值 */
export const DEFAULT_CONFIG: AgentConfig = {
  model: {
    name: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    temperature: 0,
  },
  models: {
    active: '',
    profiles: {},
  },
  tools: {
    enabled: [],
    disabled: [],
    mcpServers: {},
    mcpTranslate: {
      enabled: true,
      mode: 'auto',
      timeoutMs: 20000,
      maxToolsPerBatch: 60,
    },
    backgroundLog: {
      enabled: true,
      retentionDays: 7,
      maxTotalMb: 100,
    },
    commandRun: {
      outputLimitKb: 64,
      timeoutMs: 30000,
    },
    outputGovernor: {
      preserveKb: 64,
      preserveLines: 200,
      triggerMultiplier: 2,
      tmpTtlDays: 7,
      tmpMaxTotalMb: 200,
    },
    backgroundNotify: {
      enabled: true,
      tailLines: 20,
      maxChars: 2000,
      wakeIdle: true,
    },
  },
  agent: {
    verbose: true,
    debug: false,
    systemPrompt: null,
    showTokenStats: true,
    llmLogEnabled: true,
    loading: true,
    maxIterations: 100,
    subAgent: {
      background: true,
      maxConcurrent: 3,
    },
  },
  session: {
    autoSave: true,
    autoRestore: true,
    encryptionEnabled: true,
  },
  skill: {
    enabled: true,
    globalDir: join(loopAgentHome(), 'skills'),
    workspaceDir: '.loop-agent/skills',
    autoLoad: true,
  },
  memory: {
    ...DEFAULT_MEMORY_CONFIG,
  },
  vision: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0,
    maxTokens: 2048,
    timeoutMs: 60000,
    maxImageBytes: 10 * 1024 * 1024,
    maxResultChars: 8000,
    cacheEnabled: true,
    cacheTtlMs: 600000,
  },
  ocr: {
    enabled: true,
    engine: 'auto',
    enginePriority: ['winrt-ocr'],
    lang: 'auto',
    timeoutMs: 20000,
    maxImageBytes: 10 * 1024 * 1024,
    maxChars: 8000,
    maxCharsHardLimit: 200000,
    layout: 'text',
    cacheEnabled: true,
    cacheTtlMs: 600000,
    cacheMaxEntries: 64,
    fallbackFromVision: true,
    doc: {
      enabled: true,
      maxImages: 20,
      maxCharsPerImage: 4000,
      timeBudgetMs: 15000,
      pdfScannedPagesOnly: true,
      preferVision: true,
    },
    pdfRasterEngine: 'auto',
  },
  api: {
    port: 3000,
    host: '127.0.0.1',
    token: '',
    webRoot: '',
  },
  webui: {
    terminal: true,
    terminalDeny: [],
    terminalMax: 4,
    terminalIdleMs: 30 * 60 * 1000,
  },
};
