// 文档格式识别（需求 20261112-001 D5）
//
// 只读文件头（≤8KB，由调用方传入，与现有二进制 NUL 嗅探共用缓冲区），不读盘。
// 规则：魔数决定真实格式；OLE/ZIP 家族再用扩展名区分具体种类；
// 未知二进制返回 text，交给原有 NUL 判定维持既有行为。

import { extname } from 'node:path';
import type { DetectResult, DocumentKind } from './types.js';

/** OLE 复合文档（doc/xls/ppt 共用） */
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
/** ZIP 本地文件头（docx/xlsx/pptx/odt 共用） */
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** 已登记的文档扩展名（用于扩展名与魔数冲突告警） */
const KNOWN_DOC_EXTS = new Set([
  'pdf',
  'doc',
  'docx',
  'rtf',
  'odt',
  'xlsx',
  'pptx',
  'xls',
  'ppt',
]);

/** 小写扩展名（无扩展名返回 ''） */
function extOf(absPath: string): string {
  return extname(absPath).replace(/^\./, '').toLowerCase();
}

/** 魔数与扩展名冲突时给出告警（仅对已登记扩展名生效，避免无扩展名文件产生噪音） */
function mismatchWarning(kind: DocumentKind, ext: string): Pick<DetectResult, 'warning'> {
  if (ext && KNOWN_DOC_EXTS.has(ext) && ext !== kind) {
    return { warning: `扩展名 .${ext} 与实际格式 ${kind} 不符，已按 ${kind} 解析` };
  }
  return {};
}

/**
 * 识别文档类型。
 * @param absPath 文件绝对路径（仅用于取扩展名）
 * @param head 文件头（调用方读取的前 N 字节）
 */
export function detectDocumentKind(absPath: string, head: Buffer): DetectResult {
  const ext = extOf(absPath);

  // PDF：%PDF-
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { kind: 'pdf', ...mismatchWarning('pdf', ext) };
  }

  // OLE 复合文档：扩展名区分 doc/xls/ppt；其他 OLE 无法判定，回落文本路径（会被 NUL 判定拒绝）
  if (head.length >= 8 && head.subarray(0, 8).equals(OLE_SIGNATURE)) {
    if (ext === 'doc') return { kind: 'doc' };
    if (ext === 'xls') return { kind: 'xls' };
    if (ext === 'ppt') return { kind: 'ppt' };
    return { kind: 'text' };
  }

  // ZIP 容器：扩展名区分 docx/xlsx/pptx/odt；其他 ZIP 回落文本路径
  if (head.length >= 4 && head.subarray(0, 4).equals(ZIP_SIGNATURE)) {
    if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx' || ext === 'odt') {
      return { kind: ext };
    }
    return { kind: 'text' };
  }

  // RTF：{\rtf
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === '{\\rtf') {
    return { kind: 'rtf', ...mismatchWarning('rtf', ext) };
  }

  return { kind: 'text' };
}
