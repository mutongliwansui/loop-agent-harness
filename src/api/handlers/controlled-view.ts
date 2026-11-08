// 受控只读视图共用体（20261028-007 D5）：/uploads/view 与 /userdir/view 的公共实现。
// 校验链：resolveInWs 词法防穿越 → assertRealInside 符号链接防逃逸 → file/raw 双档读取。
// 常量与 Content-Type 表自 uploads.ts 上移（uploads.ts 保留 re-export 以免影响既有 import）。
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import type { ServerResponse } from 'node:http';
import { ApiHttpError } from '../errors.js';
import { resolveInWs, toSlash } from '../../tools/workspace-fs.js';
import { assertRealInside } from './fs.js';
import { sendJson } from '../http-utils.js';
import { loopAgentHome } from '../../user-home.js';

/** 文本预览读取上限（与 /fs/file 同构同限：512KB 截断） */
export const MAX_VIEW_TEXT_BYTES = 512 * 1024;
/** 原始字节输出上限（与 /fs/raw 同限） */
export const MAX_VIEW_RAW_BYTES = 100 * 1024 * 1024;
/** 二进制探测窗口：首段出现 NUL 即判定二进制（同 /fs/file 口径） */
export const VIEW_BINARY_SNIFF_BYTES = 8000;
/** 扩展名 → Content-Type（对齐 /fs/raw 的 RAW_CONTENT_TYPES；未识别一律 octet-stream） */
export const VIEW_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** ~ 开头输入按 home 展开（'~'/'~/'/'~\'；其余原样）。home 参数供单测注入；缺省走 loopAgentHome（测试经 LOOP_AGENT_HOME 重定向） */
export function expandHomeInput(input: string, home?: string): string {
  if (input === '~') return home ?? loopAgentHome();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return join(home ?? loopAgentHome(), input.slice(2));
  }
  return input;
}

/**
 * 受控只读视图（20261028-007 D5）：
 * - disp=file：文本预览（utf-8、>512KB 截断、含 NUL 判二进制拒绝），响应与 /fs/file 同构；
 * - disp=raw：原始字节（图片/文档），Content-Type 按扩展名，上限 100MB。
 * 入参 input 先经 expandHomeInput 展开（调用方或本函数均可，这里统一在函数内做），
 * 校验链：resolveInWs 词法防穿越 → assertRealInside 符号链接防逃逸 → 只读读取。
 */
export async function serveControlledView(
  root: string,
  input: string,
  disp: 'file' | 'raw',
  res: ServerResponse,
): Promise<void> {
  const abs = resolveInWs(root, expandHomeInput(input));
  await assertRealInside(root, abs, true);

  let size: number;
  try {
    const st = await stat(abs);
    if (st.isDirectory()) throw new ApiHttpError('bad_request', `是目录不是文件: ${input}`);
    size = st.size;
  } catch (e) {
    if (e instanceof ApiHttpError) throw e;
    throw new ApiHttpError('not_found', `文件不存在: ${input}`);
  }

  if (disp === 'raw') {
    if (size > MAX_VIEW_RAW_BYTES) {
      throw new ApiHttpError('payload_too_large', `文件超过 ${MAX_VIEW_RAW_BYTES / 1048576} MB 上限: ${input}`);
    }
    let buf: Buffer;
    try {
      buf = await readFile(abs);
    } catch {
      throw new ApiHttpError('forbidden', `文件不可读: ${input}`);
    }
    const ext = extname(abs).slice(1).toLowerCase();
    res.writeHead(200, {
      'Content-Type': VIEW_CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': buf.length,
    });
    res.end(buf);
    return;
  }

  // disp=file：文本预览（同 /fs/file：截断 + NUL 判二进制）
  const truncated = size > MAX_VIEW_TEXT_BYTES;
  const len = Math.min(size, MAX_VIEW_TEXT_BYTES);
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch {
    throw new ApiHttpError('forbidden', `文件不可读: ${input}`);
  }
  const head = buf.subarray(0, len);
  if (head.subarray(0, Math.min(len, VIEW_BINARY_SNIFF_BYTES)).includes(0)) {
    throw new ApiHttpError('bad_request', `二进制文件不支持预览: ${input}`);
  }
  sendJson(res, 200, {
    path: toSlash(relative(root, abs)),
    name: basename(abs),
    bytes: size,
    truncated,
    content: head.toString('utf-8'),
  });
}
