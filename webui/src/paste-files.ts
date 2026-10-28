// 输入框粘贴附件的纯逻辑（task-20261028-005 D10）
//
// 为什么单独成文件：ChatView.vue 已近 1900 行，判据逻辑塞进去只能靠浏览器 E2E 验证；
// 这里的函数全部无 DOM 副作用（只读 DataTransfer / File 的字段），可被 vitest 直接覆盖，
// 与 tests/webui-autogrow.test.ts 等既有 webui 纯函数单测保持同一模式。
//
// 关键结论来自 2026-10-28 实测（Windows 11 + Chrome，CDP 有头真实按键）：
//   图片（截图位图）与文件（资源管理器 Ctrl+C）都落在 paste.clipboardData.files，
//   区别只有 name/type；纯文本 files 为空。故本模块只有一条收集路径（D1）。

/** 单次粘贴最多接受的附件数（D9：与「人一次截图的合理批量」量级匹配） */
export const PASTE_MAX_FILES = 6;

/**
 * 视觉工具可读的图片扩展名（D6）。
 * 必须与 src/tools/vision/image.ts 的 MIME_BY_EXT 保持一致——服务端按扩展名判定，
 * 前端若放宽（如放进 svg）会出现「前端说能看、后端报不支持」的错位。
 * tests/webui-paste-files.test.ts 有一条用例守着这份镜像关系。
 */
export const VISION_IMAGE_EXTS: readonly string[] = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

/** 可出缩略图的扩展名：比视觉白名单宽（浏览器能渲染即可，用户自己判据），D6 */
const THUMB_EXTS: ReadonlySet<string> = new Set([...VISION_IMAGE_EXTS, 'svg', 'avif']);

/**
 * 浏览器/系统贴图时的默认文件名（D4，小写比较）。
 * 命中这些名字才重命名——普通文件被改成 paste-xxx 会让用户认不出自己贴的是哪个。
 */
export const DEFAULT_PASTE_NAMES: readonly string[] = [
  '',
  'image.png',
  'image.jpg',
  'image.jpeg',
  'image.webp',
  'image.gif',
  'image.bmp',
];

/** MIME → 扩展名（仅在原标题无扩展名时用于反推，D4） */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

/** 视觉可读性配置（由调用方从 GET /vision + GET /config/vision.maxImageBytes 组装，D8） */
export interface VisionGate {
  available: boolean;
  /** 服务端 reason 原文（available=false 时给出），拼进警告文案 */
  unavailableReason?: string;
  maxImageBytes: number;
}

/** 一个待上传的粘贴文件：原始 File + 上传用文件名 + 是否按图片处理 */
export interface PastedFile {
  file: File;
  /** 上传时使用的文件名（默认名已按 D4 重命名） */
  name: string;
  /** 是否出缩略图（D6 的第一个判据：浏览器能渲染） */
  isImage: boolean;
}

/** 取小写扩展名（无扩展名/唯一点文件返回 ''） */
function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

/** 是否是浏览器贴图时的默认名（D4） */
export function isDefaultPasteName(name: string): boolean {
  return DEFAULT_PASTE_NAMES.includes((name ?? '').trim().toLowerCase());
}

/**
 * 生成 paste[-seq].<ext>（D4，实施中按 E2E 实测调整：不再带前端时间戳）。
 *
 * 为什么不带时间戳：服务端 writeUpload（src/upload/manager.ts）会给每个上传名再加
 * `YYYYMMDD-HHmmss-` 前缀，前端若也带时间戳就成双时间戳
 * （实测 `20261028-163901-paste-20261028-163901.png`）：同一秒传的多张截图前缀完全一致，
 * 被 chip 的 190px 省略号截断后彼此不可区分——正好与 D4 的意图相反。
 * 落盘名 `20261028-163901-paste.png` / `20261028-163901-paste-2.png` 已含时间且可区分。
 */
export function renamePastedFile(name: string, mime: string, seq = 1): string {
  const ext = extOf(name) || EXT_BY_MIME[(mime ?? '').toLowerCase()] || 'png';
  const tail = seq > 1 ? `-${seq}` : '';
  return `paste${tail}.${ext}`;
}

/**
 * 是否按图片处理（决定出不出缩略图，D6）：
 * - MIME 明确是 image/* → 是；
 * - MIME 缺失或仅是 application/octet-stream（资源管理器个别场景拿不到类型）→ 按扩展名兜底；
 * - MIME 明确是非图片（如 text/plain）→ 否，即使扩展名像图片也尊重 MIME。
 */
function looksLikeImage(name: string, mime: string): boolean {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return true;
  const generic = m === '' || m === 'application/octet-stream';
  return generic && THUMB_EXTS.has(extOf(name));
}

/**
 * 从剪贴板取文件并按 D4 重命名（D1/D2）。
 * 返回空数组表示「这次粘贴没有文件」——调用方必须放行默认粘贴行为，不得 preventDefault。
 */
export function collectPasteFiles(dt: DataTransfer | null): PastedFile[] {
  if (!dt || !dt.files || dt.files.length === 0) return [];
  const out: PastedFile[] = [];
  let defaultSeq = 0; // 同一批里第 N 张截图（多张连贴时靠 seq 区分，D4）
  for (let i = 0; i < dt.files.length; i++) {
    const f = dt.files[i];
    if (!f) continue;
    const baseName = f.name ?? '';
    const mime = f.type ?? '';
    let name = baseName;
    if (isDefaultPasteName(baseName)) {
      defaultSeq += 1;
      name = renamePastedFile(baseName, mime, defaultSeq);
    }
    out.push({ file: f, name, isImage: looksLikeImage(name, mime) });
  }
  return out;
}

/** 截断到单次上限（D9），返回保留项与丢弃数量供调用方 toast */
export function capPasteFiles(
  list: readonly PastedFile[],
  max: number = PASTE_MAX_FILES,
): { accepted: PastedFile[]; dropped: number } {
  if (max <= 0) return { accepted: [], dropped: list.length };
  if (list.length <= max) return { accepted: list.slice(), dropped: 0 };
  return { accepted: list.slice(0, max), dropped: list.length - max };
}

function fmtMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/**
 * 视觉可读性警告文案；无问题返回 null（D8）。
 *
 * 判定顺序（先因后果，文案只说第一条命中的原因）：
 *   1. 不是图片 → null（文本类文件 Agent 用 fileRead 就能读，不该警告）
 *   2. 视觉链路 available=false → 不可用（带服务端 reason）
 *   3. 字节数超 maxImageBytes → 超上限
 *   4. 扩展名不在视觉白名单 → 格式不支持（典型：svg 有缩略图但视觉读不了）
 */
export function visionSkipReason(
  name: string,
  mime: string,
  bytes: number,
  gate: VisionGate,
): string | null {
  const m = (mime ?? '').toLowerCase();
  const ext = extOf(name);
  const imageByMime = m.startsWith('image/');
  const imageByExt = VISION_IMAGE_EXTS.includes(ext);
  if (!imageByMime && !imageByExt) return null; // 非图片，不提示

  if (!gate.available) {
    return gate.unavailableReason
      ? `视觉链路不可用（${gate.unavailableReason}），Agent 无法查看此图`
      : '视觉链路不可用，Agent 无法查看此图';
  }
  if (bytes > gate.maxImageBytes) {
    return `超过视觉上限 ${fmtMb(gate.maxImageBytes)}，Agent 无法查看此图`;
  }
  if (!imageByExt) {
    return `格式 .${ext || '未知'} 不在视觉支持范围（${VISION_IMAGE_EXTS.join('/')}），Agent 无法查看此图`;
  }
  return null;
}
