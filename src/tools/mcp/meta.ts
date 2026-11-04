// MCP 工具展示元信息（需求 20261104-001）
// ------------------------------------------------------------------
// 职责：从 MCP 原始 tool 定义里采集「只服务 UI」的展示素材，并解析中文展示名。
// 铁律：本文件产出的任何字段都**不得**进入 Tool 接口或 toOpenAITools()，
//       否则会改变发往模型的 tools 数组，破坏前缀缓存（D9）。
import { createHash } from 'node:crypto';

/** MCP 原始 tool 定义中本模块关心的字段（宽松类型，容忍 server 缺字段） */
export interface McpRawTool {
  name: string;
  /** MCP 规范 2025-06-18 起的顶层展示名 */
  title?: string;
  description?: string;
  /** MCP 规范 2025-03-26 起的 annotations.title（hint 字段） */
  annotations?: { title?: string } & Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
}

/** 展示名来源（MCP 页可观测用，D14） */
export type McpNameSource = 'title' | 'cjk' | 'translate' | 'none';

/** 翻译状态机（D14） */
export type McpTranslateState = 'idle' | 'pending' | 'done' | 'failed' | 'skipped';

/** MCP 工具展示元信息：只服务 UI，永不进入 toOpenAITools()（D9） */
export interface McpToolMeta {
  /** 完整工具名 server__tool（与 Registry 注册名一致） */
  fullName: string;
  server: string;
  tool: string;
  /** 规范展示名：title → annotations.title → ''（D2） */
  title: string;
  /** 服务端 description 原文（可能数百字符，由使用方自行截断） */
  description: string;
  /** inputSchema.properties[k].description 原文 */
  paramDesc: Record<string, string>;
  /** inputSchema.required（用于摘要挑选参数） */
  required: string[];
  /** 已解析的中文展示名；空串 = 未取到（D1） */
  zhName: string;
  /** 参数中文标签（缺项由前端用美化键名兜底） */
  zhParams: Record<string, string>;
  /** 展示名来源（D14） */
  nameSource: McpNameSource;
  /** 翻译状态（D14） */
  translate: McpTranslateState;
  /** 翻译失败原因（仅 translate==='failed' 时有值） */
  translateError?: string;
}

/** 中文展示名最大字数（超出截断，D12） */
export const ZH_NAME_MAX = 12;
/** 中文参数标签最大字数 */
export const ZH_PARAM_MAX = 8;

/** CJK 判定：命中任一中文区间即视为「描述已是中文」（D3） */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export function hasCjk(text: string): boolean {
  return typeof text === 'string' && CJK_RE.test(text);
}

/** 清洗描述：去 Markdown 围栏/强调标记，压平空白 */
function cleanText(s: string): string {
  return String(s ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 按中文/英文标点切句（保留顺序） */
function splitClauses(s: string): string[] {
  return s
    .split(/[。！？!?\n]/)
    .flatMap((sent) => sent.split(/[，、；;：:,]/))
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/** 硬截断：不切断 ASCII 单词（截断点落在英文词内部时回退到词首） */
function cutSafe(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const isWordChar = (c: string | undefined): boolean => !!c && /[A-Za-z0-9]/.test(c);
  if (isWordChar(s[end - 1]) && isWordChar(s[end])) {
    while (end > 0 && isWordChar(s[end - 1])) end--;
  }
  const out = s.slice(0, end || max).replace(/[\s，、；;：:,。.!?！？-]+$/, '');
  return out;
}

/** 纯状语分句：「在指定的图实例下」「对于某场景时」——对展示名无信息量，直接剔除 */
const ADVERBIAL_RE = /^(在|对|对于|向|从|由|通过|基于)\S{0,28}(下|时|中|后|前|情况下|基础上|场景下)$/;

/** 常见工具动词（用于「动词 + 宾语」压缩，按出现位置取最早的一个） */
const VERBS = [
  '查询', '获取', '列出', '添加', '创建', '删除', '更新', '修改', '执行', '计算',
  '导出', '导入', '设置', '启动', '停止', '搜索', '查找', '转换', '展开', '清空',
  '重置', '读取', '写入', '保存', '加载', '校验', '遍历', '统计', '解析', '生成',
];

/** 通用尾缀词：超长时先剥离，避免把「语言/列表」这类词切成半个字 */
const TAIL_SUFFIXES = ['语言', '信息', '列表', '数据', '情况', '内容', '结果', '详情', '说明'];

/** 尾部虚词：截断点落在这里会让展示名读不成短语 */
const TAIL_PARTICLE_RE = /(之间|下的|的|与|和|及|或|进行|用于|对于|通过|根据|从|向)+$/;

/** 泛化宾语：单独作为展示名无区分度，需拼上「的」前的对象名词 */
const GENERIC_OBJECTS = ['详细信息', '信息', '详情', '列表', '数据', '内容', '结果', '情况'];

/** 限定词前的修饰语（剥掉后剩下的才是对象本身） */
const QUALIFIER_PREFIX_RE = /^(指定|所有|该|每个|各个|全部|当前|目标|相关|对应|某)+/;

/** 限定词取不到时用的分隔符集合（「的」前的短语里，对象名词通常在最后一个分隔符之后） */
const QUALIFIER_SEP_RE = /[下里中的和与及上内]/;

/**
 * 从「的」前的限定短语里取对象名词：`获取指定图实例下指定关系` → `关系`。
 * 取不到（或取到的片段含动词）返回空串，由调用方走保守回退。
 */
function pickQualifier(before: string, verb: string): string {
  const cjkOnly = before
    .replace(/[A-Za-z0-9_.\-:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cjkOnly) return '';
  const segs = cjkOnly
    .split(QUALIFIER_SEP_RE)
    .map((s) => s.trim().replace(QUALIFIER_PREFIX_RE, '').trim())
    .filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i] ?? '';
    if (seg.length < 2 || seg.length > 4) continue;
    if (seg === verb || VERBS.some((v) => seg.includes(v))) continue;
    return seg;
  }
  return '';
}

/** 剥掉括号里的补充说明（`kExpand` 这类描述括号内很长，属操作提示而非名称） */
function stripParens(s: string): string {
  return s
    .replace(/（[^）]*）/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 去掉尾部虚词；清洗后过短（<4 字）说明删多了，回退原串 */
function trimTailParticle(s: string): string {
  const out = s.replace(TAIL_PARTICLE_RE, '').trim();
  return out.length >= 4 ? out : s;
}

/**
 * 「动词 + 宾语」压缩：`查询两个节点之间的最短路径` → `查询最短路径`。
 *
 * 只在宾语是**纯中文**（2~8 字）时成立——英文宾语（`获取…的label`）压出来
 * 会丢限定语，那种情况交给「的」前截断更保守。
 *
 * 泛化宾语（`详细信息`）单用毫无区分度，此时拼上「的」前的对象名词：
 * 三个 `get*Info` 分别得到「获取图实例详细信息 / 获取关系详细信息 / 获取节点详细信息」。
 */
function squeezeVerbObject(core: string): string {
  const di = core.lastIndexOf('的');
  if (di <= 0) return '';
  const obj = core.slice(di + 1).trim();
  if (obj.length < 2 || obj.length > 8) return '';
  if (!hasCjk(obj) || /[A-Za-z]/.test(obj)) return '';
  let verb = '';
  let verbAt = Number.MAX_SAFE_INTEGER;
  for (const v of VERBS) {
    const at = core.indexOf(v);
    if (at >= 0 && at < verbAt) {
      verb = v;
      verbAt = at;
    }
  }
  if (!verb) return '';
  const direct = `${verb}${obj}`;
  if (!GENERIC_OBJECTS.includes(obj) && direct.length >= 3 && direct.length <= ZH_NAME_MAX) {
    return direct;
  }
  const qualifier = pickQualifier(core.slice(0, di), verb);
  if (!qualifier) return '';
  const out = `${verb}${qualifier}${obj}`;
  return out.length <= ZH_NAME_MAX ? out : '';
}

/**
 * 从中文描述本地提炼短展示名（D3：描述已是中文时不调 LLM）。
 *
 * 策略（按序尝试，任一成功即返回）：
 * 1. 剥括号补充说明 → 切句 → **剔除纯状语分句**（「在指定的图实例下」）；
 * 2. 主句取**首个**有信息量的分句（工具的主动作），长度达标直接用；
 * 3. 超长：动词+宾语压缩 → 「的」前截断 → 剥通用尾缀 → 安全截断并清洗尾部虚词。
 */
export function distillZhName(desc: string): string {
  const text = stripParens(cleanText(desc));
  if (!text) return '';
  const clauses = splitClauses(text);
  if (clauses.length === 0) return '';
  const meaningful = clauses.filter((c) => !ADVERBIAL_RE.test(c));
  const pool = meaningful.length > 0 ? meaningful : clauses;
  const core = pool.find((c) => c.length >= 4) ?? pool[0] ?? '';
  if (!core) return '';
  if (core.length <= ZH_NAME_MAX) return core;
  const squeezed = squeezeVerbObject(core);
  if (squeezed) return squeezed;
  const di = core.lastIndexOf('的');
  if (di > 0) {
    const prefix = core.slice(0, di).trim();
    if (prefix.length >= 4 && prefix.length <= ZH_NAME_MAX) return prefix;
  }
  for (const suffix of TAIL_SUFFIXES) {
    if (core.endsWith(suffix)) {
      const stripped = core.slice(0, -suffix.length).trim();
      if (stripped.length >= 4 && stripped.length <= ZH_NAME_MAX) return stripped;
    }
  }
  return trimTailParticle(cutSafe(core, ZH_NAME_MAX));
}

/**
 * 从中文参数描述提炼标签（D3）：参数描述通常很短，取首分句并限长。
 */
export function distillParamLabel(desc: string, max: number = ZH_PARAM_MAX): string {
  const text = cleanText(desc);
  if (!text) return '';
  const clauses = splitClauses(text);
  const first = clauses[0] ?? text;
  return cutSafe(first, max);
}

/** 从原始 MCP tool 采集元信息（纯函数，零 LLM，D4） */
export function collectMcpMeta(serverName: string, tools: McpRawTool[]): McpToolMeta[] {
  const list = Array.isArray(tools) ? tools : [];
  return list.map((t) => {
    const toolName = String(t?.name ?? '');
    const topTitle = typeof t?.title === 'string' ? t.title.trim() : '';
    const annTitle =
      typeof t?.annotations?.title === 'string' ? String(t.annotations.title).trim() : '';
    const schema = t?.inputSchema;
    const props =
      schema && typeof schema === 'object' && !Array.isArray(schema)
        ? (schema as { properties?: unknown }).properties
        : undefined;
    const paramDesc: Record<string, string> = {};
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
        const d = v && typeof v === 'object' ? (v as { description?: unknown }).description : '';
        if (typeof d === 'string' && d.trim()) paramDesc[k] = d.trim();
      }
    }
    const rawRequired =
      schema && typeof schema === 'object' && !Array.isArray(schema)
        ? (schema as { required?: unknown }).required
        : undefined;
    const required = Array.isArray(rawRequired)
      ? rawRequired.filter((x): x is string => typeof x === 'string')
      : [];

    return {
      fullName: `${serverName}__${toolName}`,
      server: serverName,
      tool: toolName,
      title: topTitle || annTitle,
      description: typeof t?.description === 'string' ? t.description : '',
      paramDesc,
      required,
      zhName: '',
      zhParams: {},
      nameSource: 'none' as McpNameSource,
      translate: 'idle' as McpTranslateState,
    };
  });
}

/**
 * 就地填充「不需要 LLM 就能得到」的中文展示名与参数标签（D1/D2/D3/D16）。
 *
 * - `title` 已是中文 → 直接采用，`nameSource='title'`、`translate='skipped'`
 * - `mode='auto'` 且描述已是中文 → 本地提炼，`nameSource='cjk'`、`translate='skipped'`
 * - 其余（含**英文 title**）→ `translate='pending'`，由 translator 产出中文名；
 *   翻译失败时前端回落 `title` 原文（D16：目标语言优先于协议字段字面优先级）
 *
 * @param mode auto=中文描述跳过 LLM；always=一律走 LLM
 * @returns true 表示该项需要后续 LLM 翻译
 */
export function applyLocalNames(m: McpToolMeta, mode: 'auto' | 'always' = 'auto'): boolean {
  if (m.title && hasCjk(m.title)) {
    m.zhName = m.title;
    m.nameSource = 'title';
    m.translate = 'skipped';
    // title 存在时参数标签仍可用中文描述提炼（无成本）
    for (const [k, d] of Object.entries(m.paramDesc)) {
      if (hasCjk(d)) m.zhParams[k] = distillParamLabel(d);
    }
    return false;
  }

  if (mode === 'auto' && hasCjk(m.description)) {
    const name = distillZhName(m.description);
    if (name) {
      m.zhName = name;
      m.nameSource = 'cjk';
    }
    for (const [k, d] of Object.entries(m.paramDesc)) {
      if (hasCjk(d)) m.zhParams[k] = distillParamLabel(d);
    }
    m.translate = 'skipped';
    return false;
  }

  m.translate = 'pending';
  return true;
}

/** 稳定序列化：对象键排序，保证指纹可复现 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * 内容指纹（D7）：sha256(server\0tool\0title\0description\0JSON(paramDesc)) 取前 32 位。
 * 服务端改描述/改 title 即自动失配 → 触发重译。
 */
export function metaFingerprint(m: McpToolMeta): string {
  const payload = [
    m.server,
    m.tool,
    m.title,
    m.description,
    stableStringify(m.paramDesc),
  ].join('\u0000');
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 32);
}
