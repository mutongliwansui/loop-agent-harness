// 工具元信息映射层（Task-20261022-001 建立；Task-20261024-001 重设计）
//
// 设计约束（任务文档 §1.4）：
// - 纯函数/纯数据，禁止 DOM 依赖（root vitest 可直接单测）；
// - 未知工具 / MCP 工具（server__tool 命名）永不空白或报错：回退英文名 + 紧凑 JSON；
// - 仅展示层映射，后端工具定义与 SSE 协议零改动（D1）；
// - 图标为 16×16 线性 SVG（与 chart-box.ts 的 kind-ico 同一体系），故 icon 字段是 key 而非 emoji（D2）。
//
// 消费方：components/ToolCard.vue（卡片头部/键值表/结果区/分组）、chat-stream.ts（live.brief）、LiveStatus.vue（运行态文案）。

/** 图标 key：与 TOOL_ICON_PATHS 一一对应 */
export type ToolIconKey =
  | 'book'
  | 'pencil'
  | 'wrench'
  | 'search'
  | 'terminal'
  | 'clock'
  | 'lines'
  | 'stop'
  | 'puzzle'
  | 'image'
  | 'help'
  | 'table'
  | 'text'
  | 'gear';

/** 单个工具的展示元信息 */
export interface ToolMeta {
  /** 中文名 */
  zh: string;
  /** 图标 key（D2：线性 SVG，不再是 emoji） */
  icon: ToolIconKey;
  /** 参数英文名 → 中文标签（键序即键值表展示顺序） */
  params: Record<string, string>;
  /** 摘要短语生成器：从参数生成一句话概括（如 `src/a.ts（430-500 行）`） */
  brief: (args: Record<string, unknown>) => string;
}

/** 参数表行：key=英文参数名，zh=中文标签，text=展示值 */
export interface ParamRow {
  key: string;
  zh: string;
  text: string;
  /** 路径型参数的原始完整值（20261028-006 D3/D4）：可点击 chip 用；非路径参数缺省 */
  path?: string;
  /** 路径分类：file=文件（预览）、dir=目录（面板定位）；仅 path 存在时有意义 */
  kind?: 'file' | 'dir';
}

/** 摘要短语内字符串的最大长度（问题/字段列表等自由文本） */
const BRIEF_TEXT_MAX = 40;
/** 参数表单元格值的最大长度（D4 展示层兜底，超出再由结果区截断） */
const PARAM_VALUE_MAX = 200;
/** 未知工具回退摘要的默认截断（D2） */
export const COMPACT_JSON_MAX = 80;
/** 失败原因（副标题直写）的最大长度 */
export const FAIL_REASON_MAX = 60;

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

/* ================= 图标（D2） ================= */

/**
 * 16×16 线性图标的 inner SVG。外层由 toolIconSvg() 统一给
 * viewBox / fill:none / stroke:currentColor / stroke-width:1.5 / 圆头圆角，
 * 与 chart-box.ts 的 kind-ico 完全同源（个别实心点用 fill:currentColor stroke:none）。
 */
export const TOOL_ICON_PATHS: Record<ToolIconKey, string> = {
  book: '<path d="M3.2 2.8h6.4a2 2 0 0 1 2 2v8.4H5.2a2 2 0 0 1-2-2z"/><path d="M5.2 2.8v10.4"/>',
  pencil: '<path d="M11.1 2.6l2.3 2.3-7.2 7.2-3 .7.7-3z"/><path d="M9.6 4.1l2.3 2.3"/>',
  wrench:
    '<path d="M10.6 2.6a3.1 3.1 0 0 0-3.7 4L2.7 10.8a1.45 1.45 0 0 0 2.05 2.05l4.2-4.2a3.1 3.1 0 0 0 3.9-3.7l-1.9 1.9-1.7-.45-.45-1.7z"/>',
  search: '<circle cx="7" cy="7" r="3.7"/><path d="M9.8 9.8L13.4 13.4"/>',
  terminal:
    '<rect x="2.2" y="3.2" width="11.6" height="9.6" rx="2"/><path d="M5 6.6l1.9 1.9L5 10.4"/><path d="M8.9 10.4h2.4"/>',
  clock: '<circle cx="8" cy="8" r="5.4"/><path d="M8 4.9V8l2.2 1.4"/>',
  lines:
    '<path d="M5.4 4.4h8M5.4 8h8M5.4 11.6h5"/><circle cx="3" cy="4.4" r=".85" fill="currentColor" stroke="none"/><circle cx="3" cy="8" r=".85" fill="currentColor" stroke="none"/><circle cx="3" cy="11.6" r=".85" fill="currentColor" stroke="none"/>',
  stop: '<rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.4"/>',
  puzzle:
    '<path d="M5.1 2.7h2.1a1.4 1.4 0 1 1 1.7 0h2a.6.6 0 0 1 .6.6v2.1a1.4 1.4 0 1 0 0 1.7v2.1a.6.6 0 0 1-.6.6H8.9a1.4 1.4 0 1 0-1.7 0H5.1a.6.6 0 0 1-.6-.6V7.1a1.4 1.4 0 1 0 0-1.7V3.3a.6.6 0 0 1 .6-.6z"/>',
  image:
    '<rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.8"/><circle cx="5.8" cy="6.2" r="1.1"/><path d="M2.6 10.6l3.2-2.8 2.6 2.2 2-1.7 2.9 2.4"/>',
  help:
    '<circle cx="8" cy="8" r="5.4"/><path d="M6.3 6.1a1.75 1.75 0 1 1 2.5 1.6c-.5.26-.8.62-.8 1.15"/><circle cx="8" cy="11.3" r=".7" fill="currentColor" stroke="none"/>',
  table:
    '<rect x="2.4" y="3.2" width="11.2" height="9.6" rx="1.6"/><path d="M2.4 6.5h11.2M6.3 6.5v6.3"/>',
  text: '<path d="M3.4 3.6h9.2M8 3.6v8.8M6.2 12.4h3.6"/>',
  gear:
    '<circle cx="8" cy="8" r="2.1"/><path d="M8 1.9v1.7M8 12.4v1.7M1.9 8h1.7M12.4 8h1.7M3.7 3.7l1.2 1.2M11.1 11.1l1.2 1.2M12.3 3.7l-1.2 1.2M4.9 11.1l-1.2 1.2"/>',
};

/** 完整 `<svg>` 串（尺寸由 CSS 控制）：供 `v-html` 渲染图标徽标 */
export function toolIconSvg(tool: string): string {
  const key = toolDisplay(tool).icon;
  return (
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"' +
    ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOOL_ICON_PATHS[key]}</svg>`
  );
}

/* ================= 内置工具映射表 ================= */

/**
 * 内置工具映射表（13 个全覆盖，顺序无意义）。
 * 键必须是工具的**真实 name**（与 `src/tools/**` 里的 `name` 字段逐字一致）：
 * 查找是精确匹配，拼错只会静默回退英文名（`activate_skill` 曾误写成驼峰 `activateSkill`）。
 * 新增内置工具时同步此处，`tests/webui-tool-meta.test.ts` 有全覆盖断言兜底。
 */
const TOOL_META: Record<string, ToolMeta> = {
  fileRead: {
    zh: '读取文件',
    icon: 'book',
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
    icon: 'pencil',
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
    icon: 'wrench',
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
    icon: 'search',
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
    icon: 'terminal',
    params: {
      command: '命令',
      cwd: '工作目录',
      timeout: '超时（毫秒）',
      background: '后台运行',
    },
    brief: (a) => {
      const cmd = clip(str(a, 'command'), BRIEF_TEXT_MAX * 2);
      // 后台模式在摘要中明示，与前台命令区分（Task-20261022-002）
      if (a.background === true) return `后台启动 ${cmd}`;
      return cmd;
    },
  },
  commandStatus: {
    zh: '查询后台任务',
    icon: 'clock',
    params: { taskId: '任务 ID' },
    brief: (a) => {
      const id = str(a, 'taskId');
      return id ? `查询 ${clip(id, BRIEF_TEXT_MAX)}` : '查询最近后台任务';
    },
  },
  commandLogs: {
    zh: '读取后台日志',
    icon: 'lines',
    params: { taskId: '任务 ID', sinceOffset: '起始偏移（字节）', tail: '只看尾部' },
    brief: (a) => {
      const id = clip(str(a, 'taskId'), BRIEF_TEXT_MAX);
      if (a.tail === true) return `查看 ${id} 最新输出`;
      if (typeof a.sinceOffset === 'number') return `续读 ${id}（自 ${a.sinceOffset} 字节起）`;
      return id ? `读取 ${id} 日志增量` : '';
    },
  },
  commandStop: {
    zh: '停止后台任务',
    icon: 'stop',
    params: { taskId: '任务 ID' },
    brief: (a) => {
      const id = str(a, 'taskId');
      return id ? `终止 ${clip(id, BRIEF_TEXT_MAX)}` : '';
    },
  },
  activate_skill: {
    zh: '激活技能',
    icon: 'puzzle',
    params: {
      name: '技能名称',
    },
    brief: (a) => str(a, 'name'),
  },
  describe_image: {
    zh: '描述图片',
    icon: 'image',
    params: {
      image: '图片',
    },
    brief: (a) => baseName(str(a, 'image')),
  },
  ask_image: {
    zh: '图片问答',
    icon: 'help',
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
    icon: 'table',
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
    icon: 'text',
    params: {
      image: '图片',
    },
    brief: (a) => baseName(str(a, 'image')),
  },
};

/** 未知工具（含 MCP server__tool）的回退元信息 */
const FALLBACK_META: ToolMeta = {
  zh: '',
  icon: 'gear',
  params: {},
  brief: () => '',
};

/** 查工具元信息；未知工具返回回退项（zh 为空 → 调用方显示英文原名） */
export function toolMeta(tool: string): ToolMeta {
  return TOOL_META[tool] ?? FALLBACK_META;
}

/** 工具显示名：已知→「icon key + 中文名」，未知→「gear + 英文原名」（D10） */
export function toolDisplay(tool: string): { icon: ToolIconKey; name: string; known: boolean } {
  const m = TOOL_META[tool];
  return m ? { icon: m.icon, name: m.zh, known: true } : { icon: 'gear', name: tool, known: false };
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

/** 格式化 JSON（`{ }` 浮层用）；无效 JSON 原样返回 */
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
      if (key in args) {
        const row: ParamRow = { key, zh, text: formatParamValue(args[key]) };
        annotatePathArg(row, tool, args); // 20261028-006：路径参数补原始值与分类
        rows.push(row);
      }
    }
  }
  for (const [key, v] of Object.entries(args)) {
    if (meta && key in meta.params) continue;
    rows.push({ key, zh: key, text: formatParamValue(v) });
  }
  return rows;
}

/* ================= 路径参数分类与可点 chip 判定（20261028-006 D3） ================= */

/**
 * 路径型参数映射：工具 → 参数名 → 文件/目录。
 * 与 TOOL_META.params 键序配合：参数表仍按 params 键序渲染，命中本表的值渲染为可点 chip。
 * grep 的 path 参数可传目录也可传文件，归为 dir（点击走面板定位更稳）。
 */
export const PATH_ARGS: Record<string, Record<string, 'file' | 'dir'>> = {
  fileRead: { path: 'file' },
  fileWrite: { path: 'file' },
  editFile: { path: 'file' },
  grep: { path: 'dir' },
  commandRun: { cwd: 'dir' },
  describe_image: { image: 'file' },
  ask_image: { image: 'file' },
  extract_json: { image: 'file' },
  ocr_image: { image: 'file' },
};

/** 参数行附加信息（20261028-006）：路径参数补原始值与分类，供 ToolCard 渲染可点 chip */
function annotatePathArg(row: ParamRow, tool: string, args: Record<string, unknown>): void {
  const kind = PATH_ARGS[tool]?.[row.key];
  if (!kind) return;
  const raw = args[row.key];
  if (typeof raw !== 'string' || !raw.trim()) return; // 缺失/非字符串：纯文本，无 chip
  row.path = raw;
  row.kind = kind;
}

/**
 * uploads 图片路径嗅探（20261028-006 D6）：归一分隔符后含 `/.loop-agent/uploads/`。
 * 仅做前端分流提示，后端 `/uploads/view` 强校验兜底（越界一律 403）。
 */
export function isUploadsPath(raw: string): boolean {
  return raw.replaceAll('\\', '/').includes('/.loop-agent/uploads/');
}

/**
 * 自有数据目录嗅探（20261028-007 D1）：归一分隔符后含 `/.loop-agent/` 段（uploads 为其子集，
 * 分流时 uploads 优先）。覆盖记忆 / runs / skills / model-bench 等 `~/.loop-agent` 内路径；
 * 后端 `/userdir/view` 强校验兜底。
 */
export function isUserDirPath(raw: string): boolean {
  return raw.replaceAll('\\', '/').includes('/.loop-agent/');
}

/** Windows 盘符（含 UNC）判定 */
function looksAbsolute(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p) || p.startsWith('/');
}

/** 外部资源判定（20261028-006 D7）：http(s) 链接与 data URI 不做文件预览 */
function isExternalResource(p: string): boolean {
  return /^https?:\/\//i.test(p) || /^data:/i.test(p);
}

/**
 * 参数行是否渲染为可点 chip：
 * - 相对路径 → 视为 ws 内（工具语义即相对工作空间根），可点；
 * - 自有数据目录（/.loop-agent/ 段，uploads 为其子集）→ 可点（uploads 走 /uploads/view，
 *   其余走 /userdir/view，20261028-007 D1）；
 *   「~」开头的字面量：后端工具能解析（resolveToolPath 不展开 ~，视觉工具各自处理；
 *   view 端点按 homedir 展开），前端不做 ~ 展开，仅当含 /.loop-agent/ 段时放行，
 *   实际可达性由后端校验兜底；
 * - ws 内绝对路径 → 可点（/fs/* 兼容绝对路径，且 activeWsPath 可得时前端已做内判定）；
 * - 其余 ws 外绝对路径（~/.claude 等外部应用目录、系统路径）→ 不可点。
 * wsRoot 为可选的当前工作空间绝对路径（归一分隔符比较，大小写不敏感——Windows 盘符惯例）。
 */
export function isPathArgClickable(raw: string, wsRoot?: string): boolean {
  const p = raw.replaceAll('\\', '/');
  if (isExternalResource(p)) return false; // http(s)/data URI：无文件预览语义（D7）
  if (p.startsWith('~')) return isUploadsPath(p) || isUserDirPath(p);
  if (!looksAbsolute(p)) return true; // 相对路径：工具语义即 ws 内
  if (isUploadsPath(p)) return true;
  if (isUserDirPath(p)) return true; // 20261028-007：自有数据目录放行
  if (!wsRoot) return true; // 前端无 ws 根信息时不猜测，放行由后端校验兜底（误判最多 403 toast）
  const root = wsRoot.replaceAll('\\', '/').replace(/[\\/]+$/, '').toLowerCase();
  const abs = p.replace(/[\\/]+$/, '').toLowerCase();
  return abs === root || abs.startsWith(`${root}/`);
}

/** 判定不可点原因（D7：纯文本 + title 注明），可点时返回空串 */
export function pathArgDisabledReason(raw: string, wsRoot?: string): string {
  const p = raw.replaceAll('\\', '/');
  if (/^https?:\/\//i.test(p)) return '外部链接不支持预览';
  if (/^data:/i.test(p)) return '内联数据不支持预览';
  if (p.startsWith('~')) {
    return isUploadsPath(p) || isUserDirPath(p) ? '' : '文件在工作空间之外';
  }
  if (!looksAbsolute(p)) return '';
  if (isUploadsPath(p)) return '';
  if (isUserDirPath(p)) return '';
  if (!wsRoot) return '';
  const root = wsRoot.replaceAll('\\', '/').replace(/[\\/]+$/, '').toLowerCase();
  const abs = p.replace(/[\\/]+$/, '').toLowerCase();
  if (abs === root || abs.startsWith(`${root}/`)) return '';
  return '文件在工作空间之外';
}

/* ================= 结果判定与结果区口径 ================= */

/**
 * 后端工具层错误前缀（权威信号，本次修复新增）：
 * ToolRunner 把工具抛出的异常统一归一化为 `工具执行失败: <msg>`（src/tools/runner.ts），
 * react-agent 在工具未注册 / 参数无效 / 缺少必需参数时也返回 `工具 <名> …` 形态。
 * 这些前缀只可能由后端生成、且锚定结果开头，正文撞车概率可忽略；
 * 漏判会导致最常见的失败（editFile 失配、ENOENT 等）显示成绿色「完成」卡（D1 失效）。
 */
const BACKEND_TOOL_ERROR =
  /^(?:工具执行失败[:：]|工具 [^\s]+ (?:未注册|参数无效[:：]|缺少必需参数[:：]))/;

/**
 * 失败启发式判定（D5，前端仅见结果文本）：
 * - 后端工具层错误前缀（`工具执行失败:` / `工具 X 缺少必需参数:` 等）→ 失败（开头锚定）；
 * - `[exit=N]` 行首标记：仅对 commandRun 生效（真实输出中该标记总是行首、后跟错误消息）；
 *   其他工具（如 fileRead 读到含该字面量的测试/文档正文）不套用，杜绝正文误判（20261022 用户反馈）；
 * - 结果以 Error/错误/异常/缺少必需参数 开头 → 失败；Traceback/「工具执行超时」仅开头锚定。
 * 已知边界：文件正文恰好以错误词开头仍会误判——本判定仅是 UI 徽章提示，结果文本始终完整展示。
 */
export function toolResultLooksFailed(result: string, tool?: string): boolean {
  const text = result.trimStart();
  if (!text) return false;
  if (BACKEND_TOOL_ERROR.test(text)) return true;
  if (!tool || tool === 'commandRun') {
    for (const line of text.split('\n')) {
      const m = line.trimStart().match(/^\[exit=([^\]]+)\]/);
      if (m) return m[1].trim() !== '0';
    }
  }
  // 错误词需后跟冒号/空白才判失败，避免「错误处理示例代码：…」这类正常内容误判
  if (/^(Error|ERR)[:：\s]/i.test(text)) return true;
  if (/^(错误|异常)[:：]/.test(text)) return true;
  if (text.startsWith('缺少必需参数')) return true;
  // 仅锚定结果开头：正文包含这些词不算失败（如 fileRead 读到含「工具执行超时」/Traceback 的文档内容）
  if (text.startsWith('Traceback')) return true;
  if (text.startsWith('工具执行超时')) return true;
  return false;
}

/**
 * 失败原因一句话（D1 卡片副标题直写，不展开即可读懂为什么失败）：
 * - commandRun 优先取 `[exit=N]` 标记行的剩余内容（真实输出形态：标记行首 + 后跟错误消息），
 *   标记独占一行时取其后的首个非空行；
 * - 再退化到「首个带错误特征的行」（Error/错误/异常/缺少必需参数/Traceback/工具执行超时）；
 * - 最后才用首个非空行（如 editFile 的「未找到文本（首个差异行 118）」）。
 * 无法提炼（结果为空 / 只有标记行）时返回 ''，由调用方兜底为「执行失败」。
 */
export function toolFailReason(result: string, tool?: string): string {
  const raw = stripAnsi(result ?? '').trim();
  if (!raw) return '';
  // 剥掉后端错误前缀，副标题只留真正的原因：
  // `工具执行失败: ENOENT…` → `ENOENT…`；`工具 editFile 缺少必需参数: path，请补充后重试` → `缺少必需参数: path，请补充后重试`
  const text = raw
    .replace(/^工具执行失败[:：]\s*/, '')
    .replace(/^工具 [^\s]+ (?=未注册|参数无效[:：]|缺少必需参数[:：])/, '');
  if (!text) return '';
  const lines = text.split('\n').map((l) => l.trim());
  if (!tool || tool === 'commandRun') {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\[exit=[^\]]+\]\s*(.*)$/);
      if (!m) continue;
      const rest = m[1].trim();
      if (rest) return clip(rest, FAIL_REASON_MAX);
      // 纯标记行（如 "[exit=1]" 独占一行）→ 取其后首个非空行
      for (let k = i + 1; k < lines.length; k++) {
        if (lines[k]) return clip(lines[k], FAIL_REASON_MAX);
      }
      return '';
    }
  }
  const errorish = /^(Error|ERR)[:：\s]|^(错误|异常)[:：]|^缺少必需参数|^Traceback|^工具执行超时/;
  const hit = lines.find((l) => l && errorish.test(l));
  if (hit) return clip(hit, FAIL_REASON_MAX);
  const first = lines.find((l) => l);
  return first ? clip(first, FAIL_REASON_MAX) : '';
}

/** 结果区默认可视行数（D6：190px ≈ 12 行） */
export const RESULT_PREVIEW_LINES = 12;
/** 结果区字符兜底：行数 ≤12 但单行超长（会被 190px 裁剪）时同样提供展开入口 */
export const RESULT_PREVIEW_CHARS = 1200;

/** 结果行数（先剥离 ANSI 转义，避免彩色输出被当成多行/乱码） */
export function resultLines(result: string): number {
  const text = stripAnsi(result ?? '');
  if (!text) return 0;
  return text.split('\n').length;
}

/**
 * 是否需要「展开全部 N 行」入口（D6）：超出 12 行，或字符数 >1200。
 * 取代旧口径（>600 字符 或 >8 行 + clamp + 渐变遮罩 + 260px 三重折叠）。
 */
export function resultNeedsExpand(result: string): boolean {
  const text = stripAnsi(result ?? '').trim();
  if (!text) return false;
  return text.split('\n').length > RESULT_PREVIEW_LINES || text.length > RESULT_PREVIEW_CHARS;
}

/** 字节数 → `B / KB / MB` */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 结果区头部附注：`60 行 · 1.8 KB`（空结果返回 ''） */
export function resultMetaText(result: string): string {
  const text = stripAnsi(result ?? '');
  if (!text) return '';
  const bytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length;
  return `${text.split('\n').length} 行 · ${formatBytes(bytes)}`;
}

/* ================= 连续同工具分组（D5） ================= */

/** 分组所需的最小工具段形状（不依赖 chat-stream 类型，避免循环依赖） */
export interface ToolSegLike {
  tool: string;
  args: string;
  result: string;
  done: boolean;
  elapsedMs?: number;
  aborted?: boolean;
}

/** 组内单次调用：seg 为原段引用，index 为该段在 segments 中的下标 */
export interface ToolSegItem<T> {
  seg: T;
  index: number;
}

/** 卡片视图模型：单卡与组卡共用同一形状（模板无需判别联合收窄） */
export interface ToolCardVM<T> {
  kind: 'single' | 'group';
  /** 工具名（组内恒同名） */
  tool: string;
  /** 组内各次调用（single 时长度恒为 1） */
  items: ToolSegItem<T>[];
  /** 首段下标（渲染 key 与展开状态 key） */
  index: number;
  /** 任一失败（已完成且判定失败，中断态不算失败） */
  failed: boolean;
  /** 任一仍在执行（未完成且未中断） */
  running: boolean;
  /** 全部已中断且无完成 */
  aborted: boolean;
  /** 总耗时：全部组员都有 elapsedMs 时求和，否则 undefined */
  totalMs?: number;
}

/** 顺序渲染项：非工具段原样输出，工具段输出卡片视图模型 */
export type RenderItem<T> = { kind: 'seg'; seg: T; index: number } | { kind: 'tool'; card: ToolCardVM<T> };

/** 合并阈值（D5：连续 ≥3 次同一工具） */
export const TOOL_GROUP_MIN = 3;

/** 把段当作工具段读取（调用前已确认 type === 'tool'） */
function asTool<T>(seg: T): ToolSegLike {
  return seg as unknown as ToolSegLike;
}

/** 单卡/组卡的派生状态统一计算，避免模板里堆条件 */
function buildCard<T extends { type: string }>(
  kind: 'single' | 'group',
  tool: string,
  items: ToolSegItem<T>[],
): ToolCardVM<T> {
  const likes = items.map((it) => asTool(it.seg));
  const failed = likes.some((s) => s.done && !s.aborted && toolResultLooksFailed(s.result, s.tool));
  const running = likes.some((s) => !s.done && !s.aborted);
  const aborted = likes.length > 0 && likes.every((s) => s.aborted === true && !s.done);
  let totalMs: number | undefined;
  if (likes.every((s) => typeof s.elapsedMs === 'number')) {
    totalMs = likes.reduce((sum, s) => sum + (s.elapsedMs ?? 0), 0);
  }
  return { kind, tool, items, index: items[0]?.index ?? 0, failed, running, aborted, totalMs };
}

/**
 * 连续同工具分组（D5）：返回顺序渲染项。
 * - 连续 ≥minCount 次**同一工具**且中间没有文本段/其他工具 → 合并为一张组卡；
 * - 组内含失败 → **不合并**，逐个拆成单卡（失败必须一眼可见）；
 * - 阈值以下同样拆单卡。纯函数、无缓存：SSE 更新后重算即得最新形态。
 */
export function groupToolSegs<T extends { type: string }>(
  segs: readonly T[],
  minCount: number = TOOL_GROUP_MIN,
): RenderItem<T>[] {
  const out: RenderItem<T>[] = [];
  let i = 0;
  while (i < segs.length) {
    const seg = segs[i];
    if (seg.type !== 'tool') {
      out.push({ kind: 'seg', seg, index: i });
      i++;
      continue;
    }
    const tool = asTool(seg).tool;
    let j = i + 1;
    while (j < segs.length && segs[j].type === 'tool' && asTool(segs[j]).tool === tool) j++;
    const items: ToolSegItem<T>[] = [];
    for (let k = i; k < j; k++) items.push({ seg: segs[k], index: k });
    const groupFailed = items.some((it) => {
      const s = asTool(it.seg);
      return s.done && !s.aborted && toolResultLooksFailed(s.result, s.tool);
    });
    if (items.length >= minCount && !groupFailed) {
      out.push({ kind: 'tool', card: buildCard('group', tool, items) });
    } else {
      for (const it of items) out.push({ kind: 'tool', card: buildCard('single', asTool(it.seg).tool, [it]) });
    }
    i = j;
  }
  return out;
}

/** 剥离 ANSI 转义序列（OSC/CSI）：CLI 彩色输出（如 vitest）直接渲染会变成乱码方块 */
export function stripAnsi(s: string): string {
  return s
    // OSC：ESC ] ... BEL 或 ESC ] ... ESC \（终端标题等）
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI：ESC [ 参数字节 中间字节 终止字节（颜色/光标控制等）
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}
