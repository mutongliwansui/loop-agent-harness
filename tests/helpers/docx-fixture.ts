// 测试辅助：生成最小可解析的 docx（无第三方依赖）
// 仅包含文档层解析所需的最小 OOXML 结构，用于 doc 层与工具层单测。
// 需求 20261112-005 起默认支持 deflate 条目：该挂起 bug 只在「条目压缩后 ≥16384」时触发。

import { writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipInput {
  name: string;
  data: Buffer;
}

/**
 * 生成合法 zip（供 docx/xlsx/pptx/odt 夹具复用）。
 *
 * @param entries 条目列表
 * @param opts.deflate 为 true 时按 method=8（deflateRaw）压缩条目。
 *   默认 stored（method=0）只覆盖「无压缩」路径；需求 20261112-005 的挂起 bug
 *   只在 deflate 条目「压缩后 ≥16384」时触发，故回归用例必须显式开启 deflate。
 */
export function makeZip(entries: ZipInput[], opts: { deflate?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const method = opts.deflate ? 8 : 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf-8');
    const crc = crc32(entry.data);
    // stored：压缩前后一致；deflate：CRC 与解压尺寸仍按原文计算
    const payload = opts.deflate ? deflateRawSync(entry.data) : entry.data;
    const compSize = payload.length;
    const uncompSize = entry.data.length;
    const nameLen = name.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compSize, 18);
    local.writeUInt32LE(uncompSize, 22);
    local.writeUInt16LE(nameLen, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compSize, 20);
    central.writeUInt32LE(uncompSize, 24);
    central.writeUInt16LE(nameLen, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + nameLen + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** docx 正文部件的 XML 文本（导出以便测试核算 deflate 后长度） */
export function docxDocumentXml(paragraphs: string[]): string {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`)
    .join('');
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    `<w:body>${body}</w:body>`,
    '</w:document>',
  ].join('');
}

/** 生成最小 docx 字节（每个元素一个段落） */
export function makeDocx(paragraphs: string[], opts: { deflate?: boolean } = {}): Buffer {
  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml"',
    ' ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '</Types>',
  ].join('');

  return makeZip(
    [
      { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf-8') },
      { name: 'word/document.xml', data: Buffer.from(docxDocumentXml(paragraphs), 'utf-8') },
    ],
    opts,
  );
}

/** 写入一个 docx 文件并返回路径 */
export function writeDocx(
  dir: string,
  name: string,
  paragraphs: string[],
  opts: { deflate?: boolean } = {},
): string {
  const file = `${dir}/${name}`;
  writeFileSync(file, makeDocx(paragraphs, opts));
  return file;
}
