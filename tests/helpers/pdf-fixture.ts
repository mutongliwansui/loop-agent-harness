// 测试辅助：生成最小可解析的 PDF（无第三方依赖）
// 覆盖：多页、简单字体、Type0 + ToUnicode（中文）、FlateDecode、加密标记。

import { deflateSync } from 'node:zlib';

export interface PdfPageInput {
  /** 内容流（ASCII；中文请用 <hex> 形式） */
  content: string;
  /** 用 FlateDecode 压缩内容流 */
  compress?: boolean;
}

export interface PdfOptions {
  /** 在 trailer 中加入 /Encrypt */
  encrypted?: boolean;
}

function obj(num: number, body: string): Buffer {
  return Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, 'latin1');
}

function streamObj(num: number, content: string, compress = false, extraDict = ''): Buffer {
  const raw = Buffer.from(content, 'latin1');
  const data = compress ? deflateSync(raw) : raw;
  const filter = compress ? ' /Filter /FlateDecode' : '';
  const head = Buffer.from(
    `${num} 0 obj\n<< /Length ${data.length}${filter}${extraDict} >>\nstream\n`,
    'latin1',
  );
  const tail = Buffer.from('\nendstream\nendobj\n', 'latin1');
  return Buffer.concat([head, data, tail]);
}

/**
 * 生成 PDF。对象编号约定：
 * 1 Catalog / 2 Pages / 3 简单字体 / 4 Type0 字体 / 5 ToUnicode
 * 页面 10+i / 内容 100+i / 加密占位 99
 */
export function makePdf(pages: PdfPageInput[], opts: PdfOptions = {}): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];

  parts.push(obj(1, '<< /Type /Catalog /Pages 2 0 R >>'));
  const kids = pages.map((_, i) => `${10 + i} 0 R`).join(' ');
  parts.push(obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`));
  parts.push(
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
  );
  parts.push(
    obj(
      4,
      '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H /ToUnicode 5 0 R >>',
    ),
  );

  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    '2 beginbfchar',
    '<4E2D> <4E2D>',
    '<6587> <6587>',
    'endbfchar',
    'endcmap',
    'end end',
  ].join('\n');
  parts.push(streamObj(5, cmap));

  for (let i = 0; i < pages.length; i++) {
    parts.push(
      obj(
        10 + i,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${100 + i} 0 R >>`,
      ),
    );
  }
  for (let i = 0; i < pages.length; i++) {
    parts.push(streamObj(100 + i, pages[i].content, pages[i].compress));
  }

  const trailerExtra = opts.encrypted ? ' /Encrypt 99 0 R' : '';
  if (opts.encrypted) parts.push(obj(99, '<< /Filter /Standard /V 1 /R 2 >>'));
  parts.push(Buffer.from(`trailer\n<< /Root 1 0 R${trailerExtra} >>\n%%EOF\n`, 'latin1'));

  return Buffer.concat(parts);
}

/** 生成把 Catalog/Pages/Page 放进 ObjStm 的 PDF（测试对象流解析） */
export function makePdfWithObjectStream(): Buffer {
  const catalog = '<< /Type /Catalog /Pages 2 0 R >>';
  const pagesDict = '<< /Type /Pages /Kids [10 0 R] /Count 1 >>';
  const page = [
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]',
    '/Resources << /Font << /F1 3 0 R >> >> /Contents 100 0 R >>',
  ].join(' ');
  const bodies = [
    { num: 1, body: catalog },
    { num: 2, body: pagesDict },
    { num: 10, body: page },
  ];

  let offset = 0;
  const headerParts: string[] = [];
  const bodyParts: string[] = [];
  for (const item of bodies) {
    headerParts.push(`${item.num} ${offset}`);
    bodyParts.push(item.body);
    offset += item.body.length + 1;
  }
  const header = `${headerParts.join(' ')} `;
  const objStmData = `${header}${bodyParts.join('\n')}\n`;

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  parts.push(
    streamObj(20, objStmData, false, ` /Type /ObjStm /N ${bodies.length} /First ${header.length}`),
  );
  parts.push(
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
  );
  parts.push(streamObj(100, 'BT /F1 12 Tf 72 720 Td (ObjStm works) Tj ET'));
  parts.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'));
  return Buffer.concat(parts);
}
