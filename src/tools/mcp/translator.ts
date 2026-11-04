// MCP 展示名批量翻译（需求 20261104-001，D4/D5/D6/D7/D14）
// ------------------------------------------------------------------
// 设计要点：
// - 后台异步：调用方 `void translateServerMeta(...)`，本模块不阻塞注册与对话；
// - 按 server 批量单飞：同一 server 同时只允许一个翻译任务；
// - 内容指纹缓存：命中的工具零调用；服务端改描述自动失配重译；
// - 全程不抛错：任何异常都落进 `translateError`，由 UI 可观测（D14）。
import { llm as defaultLlm, type LLMClient } from '../../llm/client.js';
import { configLoader } from '../../config/loader.js';
import { debug } from '../../debug.js';
import { applyLocalNames, metaFingerprint, type McpToolMeta } from './meta.js';
import { loadMetaCache, saveMetaEntry } from './meta-store.js';

/** 单批估算输入字符上限（控成本，D5） */
const MAX_BATCH_CHARS = 12000;
/** 送去翻译时 description 截断长度 */
const DESC_CLIP = 240;
/** 送去翻译时单条参数描述截断长度 */
const PARAM_DESC_CLIP = 80;
/** 失败原因里保留的模型原文长度 */
const ERROR_CLIP = 200;

export interface TranslateOptions {
  /** LLM 客户端（默认全局单例，测试可注入） */
  llm?: LLMClient;
  /** 缓存文件路径（默认 ~/.loop-agent/mcp-meta.json） */
  cacheFile?: string;
  /** 单次调用超时（默认取 tools.mcpTranslate.timeoutMs，兜底 20000） */
  timeoutMs?: number;
  /** 单批工具数上限（默认取 tools.mcpTranslate.maxToolsPerBatch，兜底 60） */
  maxToolsPerBatch?: number;
  /** 翻译所用模型三元组（默认取当前激活模型） */
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface TranslateOutcome {
  /** 本次真正调用 LLM 后成功拿到中文名的工具数 */
  translated: number;
  /** 命中缓存直接复用的工具数 */
  cached: number;
  /** 失败工具数 */
  failed: number;
  /** 是否因为已有同 server 任务在跑而被跳过 */
  skipped: boolean;
  errors: string[];
}

/** 同 server 单飞锁 */
const inflight = new Set<string>();

/** 仅测试用：清空单飞锁 */
export function resetTranslateInflight(): void {
  inflight.clear();
}

/** 读取配置里的翻译设置（读取失败回落默认值，不影响主链路） */
function readTranslateConfig(): {
  enabled: boolean;
  mode: 'auto' | 'always';
  timeoutMs: number;
  maxToolsPerBatch: number;
} {
  const fallback = { enabled: true, mode: 'auto' as const, timeoutMs: 20000, maxToolsPerBatch: 60 };
  try {
    const cfg = configLoader.load().config.tools.mcpTranslate;
    if (!cfg) return fallback;
    return {
      enabled: cfg.enabled !== false,
      mode: cfg.mode === 'always' ? 'always' : 'auto',
      timeoutMs: Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : fallback.timeoutMs,
      maxToolsPerBatch:
        Number(cfg.maxToolsPerBatch) > 0 ? Number(cfg.maxToolsPerBatch) : fallback.maxToolsPerBatch,
    };
  } catch {
    return fallback;
  }
}

function clip(s: string, max: number): string {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 解析模型返回的 JSON（容错顺序见设计方案 §6.3）：
 * 1. 直接 JSON.parse
 * 2. 剥离 ``` 围栏后重试
 * 3. 截取首个 `{` 到末个 `}` 后重试
 * 全失败返回 null。
 */
export function parseTranslationJson(
  content: string,
): Record<string, { zh?: string; params?: Record<string, string> }> | null {
  const raw = String(content ?? '').trim();
  if (!raw) return null;
  const attempts: string[] = [raw];
  const fenced = raw.replace(/```(?:json)?/gi, '').trim();
  if (fenced !== raw) attempts.push(fenced);
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(raw.slice(first, last + 1));

  for (const text of attempts) {
    try {
      const v = JSON.parse(text) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return v as Record<string, { zh?: string; params?: Record<string, string> }>;
      }
    } catch {
      /* 继续下一种容错 */
    }
  }
  return null;
}

/** 构造单批 prompt 的输入片段（D16：带上英文 title 作为参考，帮助翻译贴近原意） */
function buildInput(metas: McpToolMeta[]): string {
  return JSON.stringify(
    metas.map((m) => ({
      name: m.tool,
      ...(m.title ? { title: clip(m.title, DESC_CLIP) } : {}),
      description: clip(m.description, DESC_CLIP),
      params: Object.fromEntries(
        Object.entries(m.paramDesc).map(([k, v]) => [k, clip(v, PARAM_DESC_CLIP)]),
      ),
    })),
  );
}

const SYSTEM_PROMPT =
  '你是 MCP 工具的中文展示名翻译器。只输出 JSON，不要任何解释文字或代码围栏。' +
  '输出格式：{"<工具名>":{"zh":"<中文名>","params":{"<参数名>":"<中文标签>"}}}。' +
  'zh 为 4~10 字简洁中文展示名（动词短语或名词短语，不加引号书名号）；' +
  'params 只翻译输入中出现的参数名，2~6 字，不要编造；无法判断的项直接省略。';

/** 把一批待翻译项按字符预算切分（单批工具数 + 估算字符双上限） */
function splitBatches(metas: McpToolMeta[], maxTools: number): McpToolMeta[][] {
  const batches: McpToolMeta[][] = [];
  let cur: McpToolMeta[] = [];
  let chars = 0;
  for (const m of metas) {
    const size = buildInput([m]).length;
    if (cur.length >= maxTools || (cur.length > 0 && chars + size > MAX_BATCH_CHARS)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(m);
    chars += size;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

/** 把翻译结果写回元信息（就地） */
function applyTranslation(
  m: McpToolMeta,
  item: { zh?: string; params?: Record<string, string> } | undefined,
): boolean {
  if (!item) return false;
  const zh = typeof item.zh === 'string' ? item.zh.trim() : '';
  const params: Record<string, string> = {};
  if (item.params && typeof item.params === 'object') {
    for (const [k, v] of Object.entries(item.params)) {
      if (typeof v === 'string' && v.trim()) params[k] = v.trim();
    }
  }
  if (!zh && Object.keys(params).length === 0) return false;
  if (zh) {
    m.zhName = zh;
    m.nameSource = 'translate';
  }
  // 已由本地中文描述提炼出的标签优先保留（避免无谓改写）
  for (const [k, v] of Object.entries(params)) {
    if (!m.zhParams[k]) m.zhParams[k] = v;
  }
  m.translate = 'done';
  delete m.translateError;
  return true;
}

/**
 * 批量翻译一个 server 的缺失展示名（D5）。
 *
 * - 只处理 `translate === 'pending'` 的项；
 * - 先查内容指纹缓存，命中即复用（D7）；
 * - 同一 server 已有任务在跑时直接返回 `skipped: true`（D4 单飞）；
 * - 不抛错：异常进 `errors`，对应项标 `translate: 'failed'`。
 */
export async function translateServerMeta(
  metas: McpToolMeta[],
  opts: TranslateOptions = {},
): Promise<TranslateOutcome> {
  const outcome: TranslateOutcome = { translated: 0, cached: 0, failed: 0, skipped: false, errors: [] };
  const pending = (Array.isArray(metas) ? metas : []).filter((m) => m.translate === 'pending');
  if (pending.length === 0) return outcome;

  const key = pending[0].server;
  if (inflight.has(key)) {
    outcome.skipped = true;
    return outcome;
  }
  inflight.add(key);

  const cfg = readTranslateConfig();
  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs;
  const maxTools = opts.maxToolsPerBatch ?? cfg.maxToolsPerBatch;
  const client = opts.llm ?? defaultLlm;

  try {
    // 1) 缓存命中
    const cache = await loadMetaCache(opts.cacheFile);
    const todo: McpToolMeta[] = [];
    for (const m of pending) {
      const hit = cache.translations[metaFingerprint(m)];
      if (hit && (hit.zhName || Object.keys(hit.zhParams).length > 0)) {
        if (hit.zhName) {
          m.zhName = hit.zhName;
          m.nameSource = 'translate';
        }
        for (const [k, v] of Object.entries(hit.zhParams)) {
          if (!m.zhParams[k]) m.zhParams[k] = v;
        }
        m.translate = 'done';
        delete m.translateError;
        outcome.cached++;
      } else {
        todo.push(m);
      }
    }
    if (todo.length === 0) return outcome;

    // 2) 分批调用
    const modelName = opts.model ?? configLoader.load().config.model.name;
    const baseUrl = opts.baseUrl ?? configLoader.load().config.model.baseUrl;
    const apiKey = opts.apiKey ?? configLoader.load().config.model.apiKey;

    for (const batch of splitBatches(todo, maxTools)) {
      let content = '';
      try {
        const res = await client.chat(
          [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildInput(batch) },
          ],
          undefined,
          {
            temperature: 0,
            model: modelName,
            baseUrl,
            apiKey,
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        content = res.content ?? '';
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        for (const m of batch) {
          m.translate = 'failed';
          m.translateError = clip(msg, ERROR_CLIP);
          outcome.failed++;
        }
        outcome.errors.push(`${key}: ${msg}`);
        continue;
      }

      const parsed = parseTranslationJson(content);
      if (!parsed) {
        const msg = `翻译结果不是合法 JSON：${clip(content, ERROR_CLIP)}`;
        for (const m of batch) {
          m.translate = 'failed';
          m.translateError = msg;
          outcome.failed++;
        }
        outcome.errors.push(`${key}: ${msg}`);
        continue;
      }

      for (const m of batch) {
        const item = parsed[m.tool];
        if (applyTranslation(m, item)) {
          outcome.translated++;
          try {
            await saveMetaEntry(
              metaFingerprint(m),
              {
                server: m.server,
                tool: m.tool,
                zhName: m.zhName,
                zhParams: m.zhParams,
                model: modelName,
                at: new Date().toISOString(),
              },
              opts.cacheFile,
            );
          } catch {
            /* 缓存非关键路径，失败不影响本次展示 */
          }
        } else {
          // 部分成功：缺项工具回落美化名，不整批判失败（D5）
          m.translate = 'failed';
          m.translateError = '翻译结果缺少该工具';
          outcome.failed++;
        }
      }
    }
    return outcome;
  } finally {
    inflight.delete(key);
    debug.log(
      `[mcp-meta] ${key} 翻译结束：新译 ${outcome.translated} / 缓存 ${outcome.cached} / 失败 ${outcome.failed}`,
    );
  }
}

/**
 * 连接后调用的统一入口：先本地判定（title / 中文描述），再按需后台翻译。
 *
 * 调用方 `void` 即可，不阻塞注册与对话（D4）。
 */
export async function prepareServerMeta(
  metas: McpToolMeta[],
  opts: TranslateOptions & { mode?: 'auto' | 'always'; enabled?: boolean } = {},
): Promise<TranslateOutcome> {
  const cfg = readTranslateConfig();
  const mode = opts.mode ?? cfg.mode;
  const enabled = opts.enabled ?? cfg.enabled;
  let need = 0;
  for (const m of metas) {
    if (applyLocalNames(m, mode)) need++;
  }
  if (!enabled) {
    for (const m of metas) {
      if (m.translate === 'pending') m.translate = 'skipped';
    }
    return {
      translated: 0,
      cached: 0,
      failed: 0,
      skipped: true,
      errors: need > 0 ? ['tools.mcpTranslate.enabled=false，跳过 LLM 翻译'] : [],
    };
  }
  if (need === 0) return { translated: 0, cached: 0, failed: 0, skipped: true, errors: [] };
  return translateServerMeta(metas, opts);
}
