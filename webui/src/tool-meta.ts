// 工具元信息映射层（Task-20261022-001）：英文工具名 → 中文名/图标/参数中文标签/摘要短语
//
// 设计约束（任务文档 §1.4）：
// - 纯函数/纯数据，禁止 DOM 依赖（root vitest 可直接单测）；
// - 未知工具 / MCP 工具（server__tool 命名）永不空白或报错：回退英文名 + 紧凑 JSON；
// - 仅展示层映射，后端工具定义与 SSE 协议零改动（D1）。
//
// 消费方：ChatView.vue（工具卡片 summary/参数表）、chat-stream.ts（live.brief）、LiveStatus.vue（运行态文案）。

/** 单个工具的展示元信息 */
export interface ToolMeta {
  /** 中文名 */
  zh: string;
  /** 图标 */
  icon: string;
  /** 参数英文名 → 中文标签（键序即参数表展示顺序） */
  params: Record<string, string>;
  /** 摘要短语生成器：从参数生成一句话概括（如 `src/a.ts（430-500 行）`） */
  brief: (args: Record<string, unknown>) => string;
}

/** 参数表行：key=英文参数名，zh=中文标签，text=展示值 */
export interface ParamRow {
  key: string;
  zh: string;
  text: string;
}

/** 摘要短语内字符串的最大长度（问题/字段列表等自由文本） */
const BRIEF_TEXT_MAX = 40;
/** 参数表单元格值的最大长度（D4 展示层兜底，超出再由结果区截断） */
const PARAM_VALUE_MAX = 200;
/** 未知工具回退摘要的默认截断（D2） */
export const COMPACT_JSON_MAX = 80;

/** 截断长文本，追加省略号说明 */
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 取路径末段（兼容 / 与 \，兼容 file:// 前缀） */
function baseName(p: string): string {
  const raw = p.startsWith('file://') ? p.slice(7) : p;
  const i = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  return i >= 0 ? raw.slice(i + 1) : raw;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

/** 安全解析 JSON 对象；非对象返回 undefined */
function tryParseArgs(argsJson: string): Record<string, unknown> | undefined {
  if (!argsJson) return undefined;
  try {
    const v: unknown = JSON.parse(argsJson);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    /* 历史脏数据/中断残片：走回退 */
  }
  return undefined;
}

/** 内置工具映射表（10 个全覆盖，顺序无意义） */
const TOOL_META: Record<string, ToolMeta> = {
  fileRead: {
    zh: '读取文件',
    icon: '📖',
    params: {
      path: '文件路径',
      startLine: '起始行',
      endLine: '结束行',
      offset: '起始行',
      limit: '读取行数',
      maxBytes: '字节上限',
      encoding: '编码',
      lineNumbers: '显示行号',
    },
    brief: (a) => {
      const p = str(a, 'path');
      if (!p) return '';
      const s = a.startLine;
      const e = a.endLine;
      const range = typeof s === 'number' && typeof e === 'number' ? `（${s}-${e} 行）` : '（全文）';
      return `${baseName(p)}${range}`;
    },
  },
  fileWrite: {
    zh: '写入文件',
    icon: '✏️',
    params: {
      path: '文件路径',
      content: '内容',
      mode: '写入模式',
    },
    brief: (a) => {
      const p = str(a, 'path');
      if (!p) return '';
      const c = str(a, 'content');
      const lines = c ? c.split('\n').length : 0;
      const verb = a.mode === 'append' ? '追加' : '写入';
      return lines > 0 ? `${baseName(p)}（${verb} ${lines} 行）` : baseName(p);
    },
  },
  editFile: {
    zh: '编辑文件',
    icon: '🔧',
    params: {
      path: '文件路径',
      oldText: '原文',
      newText: '新内容',
      regex: '正则模式',
      replaceAll: '全部替换',
      flags: '正则标志',
      startLine: '起始行',
      endLine: '结束行',
    },
    brief: (a) => {
      const p = str(a, 'path');
      if (!p) return '';
      const how = a.regex === true ? '正则替换' : '替换';
      const all = a.replaceAll === true ? '全部' : '';
      return `${baseName(p)}（${how}${all ? `·${all}` : ''}）`;
    },
  },
  grep: {
    zh: '搜索内容',
    icon: '🔍',
    params: {
      pattern: '检索内容',
      path: '路径',
      ignoreCase: '忽略大小写',
      recursive: '递归搜索',
      maxResults: '最大匹配数',
    },
    brief: (a) => {
      const p = str(a, 'path');
      const pat = str(a, 'pattern');
      if (!p && !pat) return '';
      return `在 ${p || '当前目录'} 中检索 ${clip(pat, BRIEF_TEXT_MAX)}`;
    },
  },
  commandRun: {
    zh: '执行命令',
    icon: '⚡',
    params: {
      command: '命令',
      cwd: '工作目录',
      timeout: '超时（毫秒）',
    },
    brief: (a) => clip(str(a, 'command'), BRIEF_TEXT_MAX * 2),
  },
  activateSkill: {
    zh: '激活技能',
    icon: '🧩',
    params: {
      name: '技能名称',
    },
    brief: (a) => str(a, 'name'),
  },
  describe_image: {
    zh: '描述图片',
    icon: '🖼️',
    params: {
      image: '图片',
    },
    brief: (a) => baseName(str(a, 'image')),
  },
  ask_image: {
    zh: '图片问答',
    icon: '❓',
    params: {
      image: '图片',
      question: '问题',
    },
    brief: (a) => {
      const img = baseName(str(a, 'image'));
      const q = clip(str(a, 'question'), BRIEF_TEXT_MAX);
      if (!img && !q) return '';
      return `${img}${q ? ` →「${q}」` : ''}`;
    },
  },
  extract_json: {
    zh: '提取字段',
    icon: '📋',
    params: {
      image: '图片',
      fields: '字段列表',
    },
    brief: (a) => {
      const img = baseName(str(a, 'image'));
      const f = a.fields;
      const names = Array.isArray(f) ? f.filter((x): x is string => typeof x === 'string').join('、') : '';
      if (!img && !names) return '';
      return `${img}${names ? ` → ${clip(names, BRIEF_TEXT_MAX * 2)}` : ''}`;
    },
  },
  ocr_image: {
    zh: '文字识别',
    icon: '🔤',
    params: {
      image: '图片',
    },
    brief: (a) => baseName(str(a, 'image')),
  },
};

/** 未知工具（含 MCP server__tool）的回退元信息 */
const FALLBACK_META: ToolMeta = {
  zh: '',
  icon: '⚙️',
  params: {},
  brief: () => '',
};

/** 查工具元信息；未知工具返回回退项（zh 为空 → 调用方显示英文原名） */
export function toolMeta(tool: string): ToolMeta {
  return TOOL_META[tool] ?? FALLBACK_META;
}

/** 工具显示名：已知→「图标 + 中文名」，未知→「⚙️ + 英文原名」 */
export function toolDisplay(tool: string): { icon: string; name: string; known: boolean } {
  const m = toolMeta(tool);
  return m.zh ? { icon: m.icon, name: m.zh, known: true } : { icon: '⚙️', name: tool, known: false };
}

/** 紧凑 JSON：可解析则压缩为单行，再按 max 截断；不可解析则原样 trim 后截断 */
export function compactJson(argsJson: string, max: number = COMPACT_JSON_MAX): string {
  const raw = argsJson.trim();
  if (!raw) return '';
  let text = raw;
  const obj = tryParseArgs(raw);
  if (obj) {
    try {
      text = JSON.stringify(obj);
    } catch {
      /* 保持原样 */
    }
  }
  return clip(text, max);
}

/** 格式化 JSON（展开详情的「原始 JSON」折叠块用）；无效 JSON 原样返回 */
export function prettyJson(argsJson: string): string {
  const raw = argsJson.trim();
  if (!raw) return '';
  const obj = tryParseArgs(raw);
  if (!obj) return raw;
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return raw;
  }
}

/** 摘要短语：已知工具→brief(args)（空则回退紧凑 JSON）；未知工具/解析失败→紧凑 JSON（D2 回退） */
export function toolSummary(tool: string, argsJson: string): string {
  const meta = TOOL_META[tool];
  const args = tryParseArgs(argsJson);
  if (meta && args) {
    try {
      const s = meta.brief(args);
      if (s) return s;
    } catch {
      /* brief 内部异常不影响渲染，走回退 */
    }
  }
  return compactJson(argsJson);
}

/** 参数值格式化：字符串原样；object/array→紧凑 JSON；空值→—；统一截断 */
function formatParamValue(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'string') return clip(v, PARAM_VALUE_MAX);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return clip(JSON.stringify(v), PARAM_VALUE_MAX);
  } catch {
    return clip(String(v), PARAM_VALUE_MAX);
  }
}

/**
 * 参数表行（D3）：按 TOOL_META[tool].params 的键序输出已知参数；
 * args 中存在但未登记的参数追加在末尾（zh 回退英文键名）；args 无效 → 空数组（不抛错）。
 */
export function toolParamRows(tool: string, argsJson: string): ParamRow[] {
  const args = tryParseArgs(argsJson);
  if (!args) return [];
  const meta = TOOL_META[tool];
  const rows: ParamRow[] = [];
  if (meta) {
    for (const [key, zh] of Object.entries(meta.params)) {
      if (key in args) rows.push({ key, zh, text: formatParamValue(args[key]) });
    }
  }
  for (const [key, v] of Object.entries(args)) {
    if (meta && key in meta.params) continue;
    rows.push({ key, zh: key, text: formatParamValue(v) });
  }
  return rows;
}

/**
 * 失败启发式判定（D5，前端仅见结果文本）：
 * - 出现 `[exit=非0]`（commandRun 的退出码标记在结果尾部，任意位置匹配）→ 失败；`[exit=0]` → 明确成功；
 * - 结果以 Error/错误/异常/缺少必需参数 开头、含 Traceback、或含「工具执行超时」→ 失败。
 */
export function toolResultLooksFailed(result: string): boolean {
  const text = result.trimStart();
  if (!text) return false;
  const exit = text.match(/\[exit=([^\]]+)\]/);
  if (exit) return exit[1].trim() !== '0';
  // 错误词需后跟冒号/空白才判失败，避免「错误处理示例代码：…」这类正常内容误判
  if (/^(Error|ERR)[:：\s]/i.test(text)) return true;
  if (/^(错误|异常)[:：]/.test(text)) return true;
  if (text.startsWith('缺少必需参数')) return true;
  if (text.includes('Traceback')) return true;
  if (text.includes('工具执行超时')) return true;
  return false;
}

/** 结果区「展开全部结果」阈值：去 ANSI 后字符数超过该值才截断并显示展开按钮（D4 细化：短结果直接完整展示） */
export const RESULT_EXPAND_THRESHOLD = 400;

/** 剥离 ANSI 转义序列（OSC/CSI）：CLI 彩色输出（如 vitest）直接渲染会变成乱码方块 */
export function stripAnsi(s: string): string {
  return s
    // OSC：ESC ] ... BEL 或 ESC ] ... ESC \（终端标题等）
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI：ESC [ 参数字节 中间字节 终止字节（颜色/光标控制等）
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}
