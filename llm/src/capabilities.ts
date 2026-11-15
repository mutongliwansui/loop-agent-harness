/**
 * 能力协商。
 *
 * 核心立场：**「兼容某协议」不等于可无损替换**。请求超出 provider 声明
 * 的能力时必须**显式拒绝**，不能悄悄忽略参数——静默忽略 `tools` 是最坏
 * 结果：模型收不到工具却照常返回文本，用户会以为是模型能力不行。
 *
 * 能力用**具名布尔字段**而非 `Record<string, boolean>`：后者失去类型提示
 * 与穷举检查，也无法靠 TS 发现「新增能力位忘记声明」。
 */

import type { LlmRequest } from './types.js';
import { LlmCapabilityError } from './errors.js';

/** 能力声明 */
export interface LlmCapabilities {
  /** 是否支持原生流式（否则走基类的 complete() 降级） */
  streaming: boolean;
  /** 是否支持工具调用 */
  toolCalling: boolean;
  /** 是否支持图片输入 */
  vision: boolean;
  /** 是否支持 JSON 输出模式 */
  jsonMode: boolean;
  /** 已知上下文上限（token）；未知不填，**不伪造** */
  maxContextTokens?: number;
  /** 是否回报用量 */
  usageReporting: boolean;
  /** 是否回报缓存命中数 */
  cacheReporting: boolean;
}

/**
 * 保守缺省：全部 `false`。
 *
 * 刻意不默认 `streaming: true`——基类虽有 `complete()` 降级可以「假装」
 * 支持流式，但那是**降级体验**而非真能力，把它算作能力会让调用方误判。
 */
export function defaultCapabilities(): LlmCapabilities {
  return {
    streaming: false,
    toolCalling: false,
    vision: false,
    jsonMode: false,
    usageReporting: false,
    cacheReporting: false,
  };
}

/** 一次能力违例 */
export interface CapabilityViolation {
  /** 违反的能力位 */
  capability: keyof LlmCapabilities;
  /** 人类可读的说明 */
  message: string;
}

/**
 * 检查请求是否超出能力声明，返回全部违例（不抛错）。
 *
 * 返回数组而非首个违例：一次性告诉调用方所有不满足项，避免「改一个
 * 报一个」的来回试错。
 */
export function checkRequestCapabilities(
  req: LlmRequest,
  caps: LlmCapabilities,
): CapabilityViolation[] {
  const violations: CapabilityViolation[] = [];

  if (req.tools && req.tools.length > 0 && !caps.toolCalling) {
    violations.push({
      capability: 'toolCalling',
      message: `该 provider 不支持工具调用，但请求带了 ${req.tools.length} 个 tools`,
    });
  }

  if (req.toolChoice !== undefined && req.toolChoice !== 'none' && !caps.toolCalling) {
    violations.push({
      capability: 'toolCalling',
      message: '该 provider 不支持工具调用，但请求指定了 toolChoice',
    });
  }

  if (caps.maxContextTokens !== undefined) {
    if (req.maxTokens !== undefined && req.maxTokens > caps.maxContextTokens) {
      violations.push({
        capability: 'maxContextTokens',
        message: `请求 maxTokens (${req.maxTokens}) 超过上下文上限 (${caps.maxContextTokens})`,
      });
    }
  }

  if (req.responseFormat?.type === 'json' && !caps.jsonMode) {
    violations.push({
      capability: 'jsonMode',
      message: '该 provider 不支持 JSON 输出模式，但请求指定了 responseFormat.type=json',
    });
  }

  if (!caps.vision && hasImagePart(req)) {
    violations.push({
      capability: 'vision',
      message: '该 provider 不支持图片输入，但消息中包含 image 分片',
    });
  }

  return violations;
}

/** 消息里是否含图片分片 */
function hasImagePart(req: LlmRequest): boolean {
  for (const msg of req.messages) {
    const content = msg.content;
    if (Array.isArray(content) && content.some((part) => part.type === 'image')) return true;
  }
  return false;
}

/**
 * 断言请求在能力范围内；有不满足项即抛 `LlmCapabilityError`。
 *
 * 由 `LlmRegistry` 在**调用 provider 之前**执行，因此**不会发出网络请求**。
 */
export function assertRequestCapabilities(
  providerId: string,
  req: LlmRequest,
  caps: LlmCapabilities,
): void {
  const violations = checkRequestCapabilities(req, caps);
  if (violations.length === 0) return;

  const first = violations[0]!;
  const message =
    violations.length === 1
      ? first.message
      : `${first.message}（另有 ${violations.length - 1} 项能力不满足）`;

  throw new LlmCapabilityError(providerId, first.capability, message, {
    cause: violations,
  });
}
