// 附件文件类型图标（需求 20261113-006 D3）：按「族」归类，纯中性色 + 扩展名字标。
//
// 为什么不按类型上色：项目既有图标体系（TOOL_ICON_PATHS、nav-menu 等）统一是
// 单色线性 SVG（stroke:currentColor、1.6 线宽、圆头圆角），引入彩色会破坏一致性。
// 类型辨识交给「折角页形 + 族内语义线 + 扩展名字标」三重线索。
//
// 纯函数、无 DOM 依赖：便于单测，也便于待发送区与气泡内两处共用同一套判定。

/** 图标族：四族覆盖上传场景，PDF/PPT/压缩包为文档族内的子形 */
export type FileIconKey = 'img' | 'doc' | 'pdf' | 'xls' | 'ppt' | 'code' | 'md' | 'zip';

const IMG_EXTS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']);
const XLS_EXTS: ReadonlySet<string> = new Set(['xls', 'xlsx', 'csv', 'tsv']);
const PPT_EXTS: ReadonlySet<string> = new Set(['ppt', 'pptx']);
const ZIP_EXTS: ReadonlySet<string> = new Set(['zip', 'gz', 'tgz', 'rar', '7z', 'tar']);
const CODE_EXTS: ReadonlySet<string> = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'py', 'go', 'rs', 'java', 'kt',
  'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'swift', 'sh', 'ps1', 'bat',
  'json', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'css', 'scss', 'less', 'sql',
]);
const MD_EXTS: ReadonlySet<string> = new Set(['md', 'markdown', 'txt', 'log']);

/**
 * 取小写扩展名（不含点）。无扩展名或隐藏文件（如 `.gitignore`）返回空串——
 * 后者按「文档族」渲染，比强行猜成代码更稳妥。
 */
export function extOfName(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return '';
  return base.slice(i + 1).toLowerCase();
}

/** 扩展名展示用大写形式；无扩展名返回空串（调用方据此不渲染字标） */
export function extLabelOf(name: string): string {
  return extOfName(name).toUpperCase();
}

/** 判定图标族（未知扩展名统一落到 doc 族，不做第 9 种兜底图标） */
export function fileIconKey(name: string): FileIconKey {
  const ext = extOfName(name);
  if (IMG_EXTS.has(ext)) return 'img';
  if (ext === 'pdf') return 'pdf';
  if (XLS_EXTS.has(ext)) return 'xls';
  if (PPT_EXTS.has(ext)) return 'ppt';
  if (ZIP_EXTS.has(ext)) return 'zip';
  if (CODE_EXTS.has(ext)) return 'code';
  if (MD_EXTS.has(ext)) return 'md';
  return 'doc';
}

/** 是否为图片扩展名（决定气泡内是否取缩略图、待发送区是否用图片砖） */
export function isImageName(name: string): boolean {
  return IMG_EXTS.has(extOfName(name));
}

/**
 * 图片角标文案：让「这张是不是图」一眼可辨。
 * 统一用 IMG 之外也保留具体格式（PNG/JPG）——用户有时确实要确认贴的是哪种格式。
 */
export function imgTagOf(name: string): string {
  const ext = extOfName(name);
  if (ext === 'jpg' || ext === 'jpeg') return 'JPG';
  if (ext === 'png') return 'PNG';
  if (ext === 'gif') return 'GIF';
  if (ext === 'webp') return 'WEBP';
  if (ext === 'svg') return 'SVG';
  return 'IMG';
}

/* ===== 图标路径：16×16 视口，折角页形为族基底（与原型一致） ===== */

/** 折角页主体 + 折角三角（各文档族共用） */
const PAGE = 'M10.2 2.2H5.4a1.6 1.6 0 0 0-1.6 1.6v8.4a1.6 1.6 0 0 0 1.6 1.6h5.2a1.6 1.6 0 0 0 1.6-1.6V6.4z';
const FOLD = 'M10 2.4v4h4';

const ICON_PATHS: Record<FileIconKey, string> = {
  img: '<rect x="2.6" y="3.6" width="12.8" height="10.8" rx="2"/><circle cx="6.2" cy="7.2" r="1.2"/><path d="M3.4 12.6l3.6-3.2 2.6 2.3 2.1-1.8 3.5 3.1"/>',
  doc: `<path d="${PAGE}"/><path d="${FOLD}"/><path d="M6 9.2h5.2M6 12h4"/>`,
  pdf: `<path d="${PAGE}"/><path d="${FOLD}"/><path d="M6.2 12.4V9.4h1.1a.9.9 0 0 1 0 1.8H6.2M9.6 12.4V9.4h.9a1.5 1.5 0 0 1 0 3z"/>`,
  xls: `<path d="${PAGE}"/><path d="${FOLD}"/><path d="M5.6 9h6.2v4.4H5.6zM8.7 9v4.4M5.6 11.2h8.3"/>`,
  ppt: `<path d="${PAGE}"/><path d="${FOLD}"/><path d="M6.2 12.4V9.4h1.4a.9.9 0 0 1 0 1.8H6.2M9.5 9.4h1.3a.9.9 0 0 1 0 1.8H9.5v1.2"/>`,
  code: `<path d="${PAGE}"/><path d="${FOLD}"/><path d="M7.3 9.8L6 11.2l1.3 1.4M10.6 9.8l1.3 1.4-1.3 1.4"/>`,
  md: `<path d="${PAGE}"/><path d="${FOLD}"/><path d="M5.9 12.3V9.6l1.5 1.7 1.5-1.7v2.7M10.6 9.6v2.7h1.4"/>`,
  zip: `<path d="${PAGE}"/><path d="${FOLD}"/><path d="M7.6 2.6v1.6M7.6 4.8v1.6M7.6 7v1.6M6.9 9.4h1.4v2.2a.7.7 0 0 1-1.4 0z"/>`,
};

/** 单族图标路径（供测试与按需内联使用） */
export function iconPathOf(key: FileIconKey): string {
  return ICON_PATHS[key];
}

/**
 * 生成内联 SVG 字符串（项目图标规范：16 视口、stroke 1.6、currentColor、圆头圆角）。
 * 着色交给外层 CSS 的 color，图标本身不写 fill/stroke 颜色，便于两处复用同一枚图。
 */
export function fileIconSvg(name: string, size = 16): string {
  const key = fileIconKey(name);
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" ` +
    `stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">${ICON_PATHS[key]}</svg>`
  );
}
