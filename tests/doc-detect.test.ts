// 文档识别单测（需求 20261112-001 / 任务 01）：魔数 + 扩展名双校验

import { describe, it, expect } from 'vitest';
import { detectDocumentKind } from '../src/documents/detect.js';

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

describe('detectDocumentKind', () => {
  it('PDF 魔数识别为 pdf', () => {
    expect(detectDocumentKind('/tmp/a.pdf', Buffer.from('%PDF-1.7\n'))).toEqual({ kind: 'pdf' });
  });

  it('PDF 魔数但扩展名为 .docx：以魔数为准并给出告警', () => {
    const r = detectDocumentKind('/tmp/a.docx', Buffer.from('%PDF-1.4\n'));
    expect(r.kind).toBe('pdf');
    expect(r.warning).toContain('不符');
  });

  it('OLE 家族按扩展名区分 doc/xls/ppt', () => {
    expect(detectDocumentKind('/tmp/a.doc', OLE).kind).toBe('doc');
    expect(detectDocumentKind('/tmp/a.xls', OLE).kind).toBe('xls');
    expect(detectDocumentKind('/tmp/a.ppt', OLE).kind).toBe('ppt');
  });

  it('OLE 但扩展名未知：回落文本路径（由 NUL 判定拒绝）', () => {
    expect(detectDocumentKind('/tmp/a.bin', OLE).kind).toBe('text');
  });

  it('ZIP 家族按扩展名区分 docx/xlsx/pptx/odt', () => {
    expect(detectDocumentKind('/tmp/a.docx', ZIP).kind).toBe('docx');
    expect(detectDocumentKind('/tmp/a.xlsx', ZIP).kind).toBe('xlsx');
    expect(detectDocumentKind('/tmp/a.pptx', ZIP).kind).toBe('pptx');
    expect(detectDocumentKind('/tmp/a.odt', ZIP).kind).toBe('odt');
  });

  it('普通 zip 回落文本路径', () => {
    expect(detectDocumentKind('/tmp/a.zip', ZIP).kind).toBe('text');
  });

  it('RTF 魔数识别；扩展名冲突时给出告警', () => {
    expect(detectDocumentKind('/tmp/a.rtf', Buffer.from('{\\rtf1')).kind).toBe('rtf');
    const r = detectDocumentKind('/tmp/a.doc', Buffer.from('{\\rtf1'));
    expect(r.kind).toBe('rtf');
    expect(r.warning).toContain('不符');
  });

  it('普通文本 / 空文件识别为 text', () => {
    expect(detectDocumentKind('/tmp/a.txt', Buffer.from('hello'))).toEqual({ kind: 'text' });
    expect(detectDocumentKind('/tmp/a.txt', Buffer.alloc(0))).toEqual({ kind: 'text' });
  });
});
