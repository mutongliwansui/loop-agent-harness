// 测试辅助：生成最小 xlsx / pptx / odt（无第三方依赖，纯字符串拼装 + 复用 zip 构造器）

import { makeZip } from './docx-fixture.js';

export type XlsxCell = string | { inline: string } | { b: boolean };

export interface XlsxSheetInput {
  name: string;
  rows: XlsxCell[][];
}

function colName(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 生成最小 xlsx；useSharedStrings=true 时普通字符串走 sharedStrings，{inline} 始终内联 */
export function makeXlsx(
  sheets: XlsxSheetInput[],
  opts: { useSharedStrings?: boolean } = {},
): Buffer {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const indexOf = (value: string): number => {
    const existing = sharedIndex.get(value);
    if (existing !== undefined) return existing;
    const i = shared.length;
    shared.push(value);
    sharedIndex.set(value, i);
    return i;
  };

  const sheetXmls: string[] = [];
  for (let s = 0; s < sheets.length; s++) {
    const rowsXml: string[] = [];
    for (let r = 0; r < sheets[s].rows.length; r++) {
      const cells: string[] = [];
      const row = sheets[s].rows[r];
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        const ref = `${colName(c)}${r + 1}`;
        if (typeof cell === 'string' && opts.useSharedStrings) {
          cells.push(`<c r="${ref}" t="s"><v>${indexOf(cell)}</v></c>`);
        } else if (typeof cell === 'string') {
          cells.push(`<c r="${ref}" t="inlineStr"><is><t>${escapeXml(cell)}</t></is></c>`);
        } else if ('b' in cell) {
          cells.push(`<c r="${ref}" t="b"><v>${cell.b ? 1 : 0}</v></c>`);
        } else {
          cells.push(`<c r="${ref}" t="inlineStr"><is><t>${escapeXml(cell.inline)}</t></is></c>`);
        }
      }
      rowsXml.push(`<row r="${r + 1}">${cells.join('')}</row>`);
    }
    sheetXmls.push(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml.join('')}</sheetData></worksheet>`,
    );
  }

  const entries = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
        'utf-8',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
          .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join('')}</sheets></workbook>`,
        'utf-8',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
          .map(
            (_s, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('')}</Relationships>`,
        'utf-8',
      ),
    },
    {
      name: 'xl/sharedStrings.xml',
      data: Buffer.from(
        `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared
          .map((v) => `<si><t>${escapeXml(v)}</t></si>`)
          .join('')}</sst>`,
        'utf-8',
      ),
    },
    ...sheetXmls.map((xml, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: Buffer.from(xml, 'utf-8'),
    })),
  ];

  return makeZip(entries);
}

/** 生成最小 pptx；slides 每项为若干段落文本 */
export function makePptx(slides: string[][]): Buffer {
  const entries = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>',
        'utf-8',
      ),
    },
    ...slides.map((paragraphs, i) => ({
      name: `ppt/slides/slide${i + 1}.xml`,
      data: Buffer.from(
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${paragraphs
          .map((text) => `<a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p>`)
          .join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
        'utf-8',
      ),
    })),
  ];
  return makeZip(entries);
}

/** 生成最小 odt；content 为 office:text 内的原始 XML 片段 */
export function makeOdt(content: string): Buffer {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>${content}</office:text></office:body></office:document-content>`;
  return makeZip([
    { name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.text', 'utf-8') },
    { name: 'content.xml', data: Buffer.from(xml, 'utf-8') },
  ]);
}
