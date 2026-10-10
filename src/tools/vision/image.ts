// 视觉工具图片解析：统一三种来源（http URL / data URI / 本地路径）
import { stat, readFile } from 'node:fs/promises';
import { extname } from 'node:path';

/** 图片来源类型 */
export type VisionImageSource = 'url' | 'data' | 'file';

/** 解析后的图片（uri 为发给视觉 API 的 image_url 值） */
export interface ResolvedImage {
  /** URL 原样透传；本地文件转为 data URI */
  uri: string;
  source: VisionImageSource;
  /** 原始字节数（URL 场景未知为 0；data URI 按解码后估算） */
  bytes: number;
  /** 本地文件缓存指纹（size-mtime），P1 缓存 key 使用；URL/data 场景为 undefined */
  fileFingerprint?: string;
}

/** 支持的图片扩展名 → MIME 映射 */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/** 支持的图片格式列表（用于错误提示） */
export const SUPPORTED_IMAGE_EXTS = Object.keys(MIME_BY_EXT)
  .map((e) => e.slice(1))
  .join('/');

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

export function isDataUri(s: string): boolean {
  return /^data:image\//i.test(s);
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

/**
 * 解析图片输入为视觉 API 可用的 uri
 *
 * 错误按类别抛出（由 ToolRunner 转为 tool 结果回填，主模型可据此调整）：
 * - 图片参数为空 / 文件不存在 / 路径不是文件 / 格式不支持 / 超大小上限
 */
export async function resolveImage(raw: string, maxBytes: number): Promise<ResolvedImage> {
  const input = (raw ?? '').trim();
  if (!input) {
    throw new Error('图片参数 image 不能为空，请提供本地路径或 http(s) URL');
  }

  // 1. http(s) URL：透传，由视觉服务端下载（本地不发起任意请求）
  if (isHttpUrl(input)) {
    return { uri: input, source: 'url', bytes: 0 };
  }

  // 2. data URI：直接透传，按 base64 长度估算解码后大小
  if (isDataUri(input)) {
    const commaIdx = input.indexOf(',');
    const b64 = commaIdx >= 0 ? input.slice(commaIdx + 1) : '';
    const bytes = Math.floor((b64.length * 3) / 4);
    if (maxBytes > 0 && bytes > maxBytes) {
      throw new Error(`图片超过大小限制: ${formatBytes(bytes)} > ${formatBytes(maxBytes)}`);
    }
    return { uri: input, source: 'data', bytes };
  }

  // 3. 本地文件路径
  let st;
  try {
    st = await stat(input);
  } catch {
    throw new Error(`图片文件不存在: ${input}`);
  }
  if (!st.isFile()) {
    throw new Error(`图片路径不是文件: ${input}`);
  }
  if (maxBytes > 0 && st.size > maxBytes) {
    throw new Error(`图片超过大小限制: ${formatBytes(st.size)} > ${formatBytes(maxBytes)}`);
  }
  const ext = extname(input).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(`不支持的图片格式: ${ext || '(无扩展名)'}（支持 ${SUPPORTED_IMAGE_EXTS}）`);
  }
  const buf = await readFile(input);
  return {
    uri: `data:${mime};base64,${buf.toString('base64')}`,
    source: 'file',
    bytes: st.size,
    fileFingerprint: `${st.size}-${st.mtimeMs}`,
  };
}
