// 视觉工具集（Task-20261010-001）：主模型通过 Function Call 决策，本地直接对接视觉大模型
//
// 角色划分：主模型只负责"想"（不接收像素），视觉模型只负责"看"，本地管道负责编排。
// 图片以字符串（路径/URL/data URI）出现在 user 消息中，由主模型填入工具参数。
import { configLoader } from '../../config/index.js';
import type { ModelConfig, VisionConfig } from '../../config/schema.js';
import type { Tool, VisionContentPart, VisionMessage } from '../../types.js';
import { llm } from '../../llm/client.js';
import { debug } from '../../debug.js';
import { resolveImage } from './image.js';
import { visionCache } from './cache.js';
import { visionStats } from './stats.js';

/**
 * 视觉工具名（注册与 Tab 补全复用）。
 * 需求 20261111-004：四工具合一为 analyzeImage —— 四者本就共用同一条 runVision 管道，
 * 差异只在 user 指令模板，拆成四个工具只是多花每轮 tools 参数。OCR 由 question 覆盖。
 */
export const VISION_TOOL_NAMES = ['analyzeImage'] as const;

type VisionKind = 'describe' | 'ask' | 'extract';

/** 各分支的 user 指令模板（system 固定为图像分析助手角色） */
const INSTRUCTIONS: Record<VisionKind, (args: VisionArgs) => string> = {
  describe: () => '请客观、详尽地描述这张图片的内容，包括主体、场景、可见文字、颜色、数量与布局。',
  ask: (a) => a.question,
  extract: (a) =>
    [
      '从图片中提取以下字段，找不到的字段值填 null。',
      '只输出一个 JSON 对象，不要任何解释或代码块围栏。',
      '字段：',
      ...a.fields.map((f) => `- ${f}`),
    ].join('\n'),
};


const VISION_SYSTEM_PROMPT = '你是一个专业的图像分析助手。只输出被要求的内容，不要输出多余解释。';

/** 管道的规范化参数（校验后） */
interface VisionArgs {
  image: string;
  question: string;
  fields: string[];
}

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`缺少必需参数: ${key}`);
  }
  return v.trim();
}

function reqStrArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string' || !x.trim())) {
    throw new Error(`参数 ${key} 必须是非空字符串数组`);
  }
  return (v as string[]).map((s) => s.trim());
}

/** 解析视觉三元组：空值回退主模型配置 */
export function resolveVisionTargets(vision: VisionConfig, model: ModelConfig): {
  baseUrl: string;
  apiKey: string;
  model: string;
} {
  return {
    baseUrl: vision.baseUrl || model.baseUrl,
    apiKey: vision.apiKey || model.apiKey,
    model: vision.model || model.name,
  };
}

/** 截断工具结果，防上下文膨胀 */
function truncateResult(text: string, maxChars: number): string {
  if (maxChars > 0 && text.length > maxChars) {
    return `${text.slice(0, maxChars)}\n…（已截断，原文共 ${text.length} 字符）`;
  }
  return text;
}

function safeParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** 从可能带围栏/前后缀文本的输出中提取 JSON 候选串 */
function extractJsonCandidate(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const inner = fenced[1].trim();
    if (safeParse(inner) !== undefined) return inner;
  }
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  let start = -1;
  let endCh = '';
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) {
    start = objStart;
    endCh = '}';
  } else if (arrStart >= 0) {
    start = arrStart;
    endCh = ']';
  }
  if (start < 0) return null;
  const end = text.lastIndexOf(endCh);
  if (end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * 原 extractJson 的解析容错降级 + 结果截断（缓存命中与实调共用，保证两路径输出一致）
 */
function postProcess(kind: VisionKind, content: string, maxResultChars: number): string {
  if (kind === 'extract') {
    const direct = safeParse(content);
    if (direct !== undefined) {
      return truncateResult(JSON.stringify(direct, null, 2), maxResultChars);
    }
    const candidate = extractJsonCandidate(content);
    const parsed = candidate !== null ? safeParse(candidate) : undefined;
    if (parsed !== undefined) {
      return truncateResult(JSON.stringify(parsed, null, 2), maxResultChars);
    }
    // 解析彻底失败：降级返回原始文本（不 throw，让主模型自行补救）
    return truncateResult(
      `注意：视觉模型输出不是合法 JSON，以下为原始文本：\n${content}`,
      maxResultChars,
    );
  }
  return truncateResult(content, maxResultChars);
}

/**
 * 由参数推断分支：fields → extract（结构化字段），question → ask（定点问答），
 * 两者都未给 → describe（整体描述）。OCR 走 ask，由 question 表达。
 */
function pickKind(rawArgs: Record<string, unknown>): VisionKind {
  if (rawArgs.fields !== undefined && rawArgs.fields !== null) return 'extract';
  const q = rawArgs.question;
  if (typeof q === 'string' && q.trim() !== '') return 'ask';
  return 'describe';
}

/**
 * 共享执行管道：
 * 1. 读配置（每次执行读取，运行时热改生效）
 * 2. resolveImage（三来源解析 + 分类错误）
 * 3. 缓存查询（P1：本地文件指纹参与 key，文件变更自动失效）
 * 4. 构造多模态消息调 llm.chatVision（用量统计 + 失败计数）
 * 5. 回填处理：extract 分支解析容错降级 + 结果截断
 */
async function runVision(rawArgs: Record<string, unknown>): Promise<string> {
  const { config: cfg } = configLoader.load();
  const vision = cfg.vision;
  if (!vision.enabled) {
    throw new Error('视觉功能未启用，请先 /config set vision.enabled true 并配置 vision.model');
  }

  const kind = pickKind(rawArgs);
  const args: VisionArgs = {
    image: reqStr(rawArgs, 'image'),
    question: kind === 'ask' ? reqStr(rawArgs, 'question') : '',
    fields: kind === 'extract' ? reqStrArray(rawArgs, 'fields') : [],
  };

  const img = await resolveImage(args.image, vision.maxImageBytes);
  const targets = resolveVisionTargets(vision, cfg.model);

  // 缓存 key：本地文件用 size-mtime 指纹（内容变自动失效），URL/data 用 uri 本身
  const cacheKey = visionCache.buildKey(
    targets.model,
    kind,
    kind === 'ask' ? [args.question] : kind === 'extract' ? [...args.fields] : [],
    img.fileFingerprint ?? img.uri,
  );
  if (vision.cacheEnabled) {
    const cached = visionCache.get(cacheKey);
    if (cached !== null) {
      debug.log(`[vision] 缓存命中 kind=${kind} key=${cacheKey.slice(0, 8)}…`);
      visionStats.recordCacheHit();
      return postProcess(kind, cached, vision.maxResultChars);
    }
  }

  const userParts: VisionContentPart[] = [
    { type: 'text', text: INSTRUCTIONS[kind](args) },
    { type: 'image_url', image_url: { url: img.uri } },
  ];
  const messages: VisionMessage[] = [
    { role: 'system', content: VISION_SYSTEM_PROMPT },
    { role: 'user', content: userParts },
  ];

  let content: string;
  try {
    const result = await llm.chatVision(messages, {
      ...targets,
      temperature: vision.temperature,
      maxTokens: vision.maxTokens,
      jsonMode: kind === 'extract',
    });
    visionStats.recordSuccess(result.usage, result.elapsedMs);
    content = result.content;
  } catch (err) {
    visionStats.recordError();
    throw err;
  }

  // 缓存原始输出（截断/解析后置，命中路径与实调路径处理一致）
  if (vision.cacheEnabled) {
    visionCache.set(cacheKey, content, vision.cacheTtlMs);
  }

  return postProcess(kind, content, vision.maxResultChars);
}

/** 视觉工具统一 60s 超时（runner 默认 30s 不够；注册时可被 vision.timeoutMs 配置覆盖） */
const VISION_TIMEOUT_MS = 60000;

/**
 * 视觉工具（需求 20261111-004 四合一）：按参数分流——
 * - 只给 image：整体描述（主体、场景、可见文字、颜色、数量）
 * - 给 question：定点问答（文字、报错码、按钮状态、颜色、数量）；提取全部文字也用它
 * - 给 fields：按字段输出 JSON（表单、表格、配置界面等精确取值）
 */
export const analyzeImage: Tool = {
  name: 'analyzeImage',
  description:
    '看一张图片。只给 image 时整体描述；给 question 时定点回答（提取全部文字也用它）；给 fields 时按字段返回 JSON。不确定看什么就先整体描述。',
  parameters: {
    type: 'object',
    properties: {
      image: { type: 'string', description: '图片路径、URL 或 dataURI' },
      question: { type: 'string', description: '要看什么；省略则整体描述' },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: '要提取的字段名，如 ["标题","金额"]',
      },
    },
    required: ['image'],
  },
  timeoutMs: VISION_TIMEOUT_MS,
  async execute(args) {
    return runVision(args);
  },
};

/** 视觉工具集（registerBuiltinTools 在 vision.enabled 时注册） */
export const visionTools: Tool[] = [analyzeImage];

