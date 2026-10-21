// LLM usage 归一化（优化建议 20261021-009）：
// 统一解析各服务商报文的缓存命中字段——智谱/DeepSeek 风格 `prompt_cache_hit_tokens`
// 与 OpenAI 风格 `prompt_tokens_details.cached_tokens`，并补齐 hit/miss 互相推导。
//
// 背景：client 此前只认 `prompt_cache_hit_tokens`，OpenAI 兼容服务商返回
// `prompt_tokens_details.cached_tokens`（无 prompt_cache_hit_tokens）时，
// 下游 `(usage.prompt_cache_hit_tokens ?? 0) / prompt_tokens` 会把「字段缺失」
// 误判为真 0 命中，且 cached_tokens>0 的真实命中被完全忽略——命中率被系统性低估。
//
// 归一化优先级：prompt_cache_hit_tokens → prompt_tokens_details.cached_tokens → cached_tokens。
// 归一化后 LLMUsage 仅以 hit/miss 为准；details 字段仅用于解析，随原样保留。

/** 待归一化的原始 usage 报文（SDK 类型 + 各服务商扩展字段；不含索引签名以兼容 SDK CompletionUsage） */
export interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: unknown;
  prompt_cache_miss_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  cached_tokens?: unknown;
}

/**
 * 归一化 LLM usage：
 * 1. 缓存命中按优先级取值，无任何缓存字段时 hit/miss 均为 undefined（N/A 语义，与真 0 区分）；
 * 2. hit/miss 互相推导补齐（只缺一边时按 prompt_tokens 补另一边）；
 * 3. 数值合法性 clamp 到 [0, prompt_tokens]，非有限数视为缺失；
 * 4. hit + miss 与 prompt_tokens 不一致时以 hit 为准并记 debug 告警。
 */
export function normalizeUsage(raw: RawUsage | undefined | null): LLMUsageLike {
  // 字段缺失统一用 undefined（而不是 0）——N/A 与真 0 语义分离的关键
  const promptTokens = asFiniteNumber(raw?.prompt_tokens) ?? 0;
  const completionTokens = asFiniteNumber(raw?.completion_tokens) ?? 0;
  const totalTokens = asFiniteNumber(raw?.total_tokens) ?? 0;

  const directHit = parseCount(raw?.prompt_cache_hit_tokens);
  const detailsHit = parseCount(raw?.prompt_tokens_details?.cached_tokens);
  const legacyHit = parseCount(raw?.cached_tokens);
  let hit = directHit ?? detailsHit ?? legacyHit;
  let miss = parseCount(raw?.prompt_cache_miss_tokens);

  // 任一字段存在（含显式 0）即视为该服务商提供缓存统计
  const hasHitField =
    directHit !== undefined ||
    detailsHit !== undefined ||
    legacyHit !== undefined;
  const hasMissField = miss !== undefined;
  const hasCacheFields = hasHitField || hasMissField;
  if (!hasCacheFields) {
    return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens };
    // eslint-disable-next-line no-unreachable
  }

  // 补齐推导（只缺一边时）：hit = prompt - miss / miss = prompt - hit
  if (hit === undefined && miss !== undefined) {
    hit = Math.max(0, promptTokens - miss);
  } else if (miss === undefined && hit !== undefined && promptTokens > 0) {
    miss = Math.max(0, promptTokens - hit);
  }

  // clamp 到 [0, prompt_tokens]（负数/越界报文防御）
  if (hit !== undefined) {
    const clamped = clampToPrompt(hit, promptTokens, 'hit');
    if (clamped !== hit) {
      debugWarn(`缓存命中 token 越界（${hit}），已 clamp 为 ${clamped}（prompt_tokens=${promptTokens}）`);
    }
    hit = clamped;
  }
  if (miss !== undefined) {
    const clamped = clampToPrompt(miss, promptTokens, 'miss');
    if (clamped !== miss) {
      debugWarn(`缓存未命中 token 越界（${miss}），已 clamp 为 ${clamped}（prompt_tokens=${promptTokens}）`);
    }
    miss = clamped;
  }

  // 一致性检查：hit + miss 与 prompt_tokens 不一致时以 hit 为准
  if (
    hit !== undefined &&
    miss !== undefined &&
    promptTokens > 0 &&
    hit + miss !== promptTokens
  ) {
    debugWarn(
      `缓存字段不一致：hit(${hit}) + miss(${miss}) = ${hit + miss} ≠ prompt_tokens(${promptTokens})，以 hit 为准`,
    );
    miss = Math.max(0, promptTokens - hit);
  }

  const usage: LLMUsageLike = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
  if (hit !== undefined) usage.prompt_cache_hit_tokens = hit;
  if (miss !== undefined) usage.prompt_cache_miss_tokens = miss;
  // details 原样保留（仅解析用，归一化后下游以 hit/miss 为准）
  if (raw?.prompt_tokens_details) usage.prompt_tokens_details = raw.prompt_tokens_details;
  return usage;
}

/** 归一化后的 usage（LLMUsage 兼容形状） */
export interface LLMUsageLike {
  prompt_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens: number;
  total_tokens: number;
}

/** 有效计数字段解析：非负有限数有效；显式 0 有效；负数/非有限数视为字段缺失 */
function parseCount(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  return undefined;
}

/** 有限数解析（基础 token 计数） */
function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** clamp 到 [0, prompt_tokens]（prompt_tokens<=0 时仅要求非负） */
function clampToPrompt(v: number, promptTokens: number, label: string): number {
  void label;
  let out = v;
  if (out < 0) out = 0;
  if (promptTokens > 0 && out > promptTokens) out = promptTokens;
  return out;
}

/** 轻量告警：仅 debug 模式输出（避免引入 cli/ui 依赖的循环引用） */
function debugWarn(msg: string): void {
  // 动态 import 避免顶层循环依赖；失败静默（归一化不因日志失败而中断）
  void import('../debug.js')
  .then(({ debug }) => debug.log(`[usage] ${msg}`))
  .catch(() => {});
}
