// 零依赖 PDF 文本提取器（需求 20261112-001 / 任务 02）
//
// 目标：把「文本层 PDF」提取为纯文本与页映射，不引入 pdfjs-dist/unpdf（SEA 单文件打包与体积约束）。
// 支持：对象扫描（不依赖 xref）、ObjStm、Flate/ASCIIHex/ASCII85、页树、Tj/TJ 文本算子、
//       ToUnicode CMap（含中文 CID）与常见简单字体编码。
// 边界：扫描件、加密 PDF、LZW/RunLength 流、复杂版面不处理，均给出明确降级提示。

import { readFile, stat } from 'node:fs/promises';
import { inflateRawSync, inflateSync } from 'node:zlib';
import {
  DocumentExtractError,
  type DocumentImage,
  type ExtractResult,
  type PageRange,
} from './types.js';
import { normalizeText } from './text.js';
import { pdftotextAvailable, runPdftotext } from './external.js';
import { rasterizePdfPages } from './pdf-raster.js';

/* ========================================================================
 * 配置
 * ======================================================================== */

const DEFAULT_MAX_PAGES = 500;
const DEFAULT_MAX_CHARS = 5_000_000;
const DEFAULT_TIME_BUDGET_MS = 15_000;
/** 单个流解压上限（压缩炸弹防护） */
const MAX_INFLATE_BYTES = 64 * 1024 * 1024;
/** 单页行数上限（防止单页内容异常膨胀） */
const MAX_PAGE_LINES = 20_000;

export interface PdfExtractOptions {
  /** 源文件大小上限 */
  maxBytes: number;
  maxPages?: number;
  maxChars?: number;
  timeBudgetMs?: number;
  signal?: AbortSignal;
  /**
   * 任务 04：是否对 PDF 无文本层页做光栅化（供 OCR 使用）。
   * false/省略时完全不 spawn 光栅化工具，保证「OCR 关闭 / 非 Windows」零额外开销。
   */
  pdfImageOcr?: boolean;
  /**
   * 任务 04（D3）：OCR 目标页范围。
   * false/省略 = 只光栅化「无文本层」页（ocr.doc.pdfScannedPagesOnly=true 的语义）；
   * true = 全部页都光栅化（pdfScannedPagesOnly=false）。
   */
  pdfOcrAllPages?: boolean;
  /** 自定义光栅化命令模板（ocr.pdfRasterizer） */
  pdfRasterizer?: string;
}

/**
 * 把指定页光栅化为 PNG，并组装成 DocumentImage（任务 04）。
 * 光栅化工具缺失或全部页失败时返回空 images，调用方保持原有降级提示。
 */
async function rasterizeForOcr(
  absPath: string,
  pageNumbers: number[],
  opts: PdfExtractOptions,
): Promise<{ images: DocumentImage[]; warnings: string[] }> {
  // 未开启文档图片 OCR（或 OCR 整体关闭）时不做任何 spawn，保证零额外开销
  if (!opts.pdfImageOcr) return { images: [], warnings: [] };
  const result = await rasterizePdfPages(absPath, pageNumbers, {
    customTemplate: opts.pdfRasterizer,
    signal: opts.signal,
  });
  return {
    images: result.pages.map((p, i) => ({
      name: `pdf-page-${p.page}`,
      data: p.data,
      index: i + 1,
      source: 'pdf-page' as const,
      page: p.page,
    })),
    warnings: result.warnings,
  };
}

/* ========================================================================
 * PDF 对象模型
 * ======================================================================== */

type PdfValue =
  | { kind: 'dict'; map: Map<string, PdfValue> }
  | { kind: 'array'; items: PdfValue[] }
  | { kind: 'name'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'string'; bytes: Buffer }
  | { kind: 'ref'; num: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' };

interface PdfStream {
  kind: 'stream';
  dict: Map<string, PdfValue>;
  data: Buffer;
}

type PdfObject = PdfValue | PdfStream;

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isNumStart(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e;
}

/** 解析对象值；字符串按 latin1 处理，字符下标与字节下标一一对应 */
class PdfParser {
  pos: number;

  constructor(
    private readonly buf: Buffer,
    private readonly s: string,
    pos = 0,
  ) {
    this.pos = pos;
  }

  private code(i = this.pos): number {
    return this.s.charCodeAt(i);
  }

  skipWs(): void {
    while (this.pos < this.s.length) {
      const c = this.code();
      if (c === 0x25) {
        while (this.pos < this.s.length && this.code() !== 0x0a && this.code() !== 0x0d) {
          this.pos++;
        }
        continue;
      }
      if (WS.has(c)) this.pos++;
      else break;
    }
  }

  parseObject(): PdfObject {
    const value = this.parseValue();
    this.skipWs();
    if (value.kind === 'dict' && this.s.startsWith('stream', this.pos)) {
      const after = this.code(this.pos + 6);
      if (WS.has(after)) return this.parseStream(value.map);
    }
    return value;
  }

  parseValue(): PdfValue {
    this.skipWs();
    if (this.pos >= this.s.length) return { kind: 'null' };
    const c = this.s[this.pos];

    if (c === '<' && this.s[this.pos + 1] === '<') return this.parseDict();
    if (c === '<') return this.parseHexString();
    if (c === '(') return this.parseLiteralString();
    if (c === '[') return this.parseArray();
    if (c === '/') return this.parseName();

    if (this.s.startsWith('true', this.pos)) {
      this.pos += 4;
      return { kind: 'bool', value: true };
    }
    if (this.s.startsWith('false', this.pos)) {
      this.pos += 5;
      return { kind: 'bool', value: false };
    }
    if (this.s.startsWith('null', this.pos)) {
      this.pos += 4;
      return { kind: 'null' };
    }
    if (isNumStart(this.code())) return this.parseNumberOrRef();

    return this.parseKeyword();
  }

  private parseNumberOrRef(): PdfValue {
    const first = this.parseNumber();
    const save = this.pos;
    this.skipWs();
    if (this.code() >= 0x30 && this.code() <= 0x39) {
      this.parseNumber();
      this.skipWs();
      if (this.s[this.pos] === 'R') {
        this.pos++;
        return { kind: 'ref', num: first };
      }
    }
    this.pos = save;
    return { kind: 'number', value: first };
  }

  private parseNumber(): number {
    const start = this.pos;
    while (this.pos < this.s.length && isNumStart(this.code())) this.pos++;
    const raw = this.s.slice(start, this.pos);
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  private parseDict(): PdfValue {
    this.pos += 2;
    const map = new Map<string, PdfValue>();
    while (this.pos < this.s.length) {
      this.skipWs();
      if (this.s[this.pos] === '>' && this.s[this.pos + 1] === '>') {
        this.pos += 2;
        break;
      }
      const before = this.pos;
      const key = this.parseValue();
      if (key.kind !== 'name') {
        if (this.pos === before) this.pos++;
        continue;
      }
      const value = this.parseValue();
      map.set(key.value, value);
      if (this.pos === before) this.pos++;
    }
    return { kind: 'dict', map };
  }

  private parseArray(): PdfValue {
    this.pos += 1;
    const items: PdfValue[] = [];
    while (this.pos < this.s.length) {
      this.skipWs();
      if (this.s[this.pos] === ']') {
        this.pos += 1;
        break;
      }
      const before = this.pos;
      items.push(this.parseValue());
      if (this.pos === before) this.pos++;
    }
    return { kind: 'array', items };
  }

  private parseName(): PdfValue {
    this.pos += 1;
    const start = this.pos;
    while (this.pos < this.s.length) {
      const c = this.code();
      if (WS.has(c) || DELIM.has(c)) break;
      this.pos++;
    }
    const raw = this.s.slice(start, this.pos);
    const value = raw.replace(/#([0-9a-fA-F]{2})/g, (_m, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
    return { kind: 'name', value };
  }

  private parseHexString(): PdfValue {
    this.pos += 1;
    let hex = '';
    while (this.pos < this.s.length && this.s[this.pos] !== '>') {
      const ch = this.s[this.pos++];
      if (!/\s/.test(ch)) hex += ch;
    }
    if (this.s[this.pos] === '>') this.pos++;
    if (hex.length % 2) hex += '0';
    return { kind: 'string', bytes: Buffer.from(hex, 'hex') };
  }

  private parseLiteralString(): PdfValue {
    const { bytes, end } = readLiteralString(this.s, this.pos);
    this.pos = end;
    return { kind: 'string', bytes };
  }

  private parseKeyword(): PdfValue {
    const start = this.pos;
    while (this.pos < this.s.length) {
      const c = this.code();
      if (WS.has(c) || DELIM.has(c)) break;
      this.pos++;
    }
    if (this.pos === start) this.pos++;
    return { kind: 'null' };
  }

  private parseStream(dict: Map<string, PdfValue>): PdfStream {
    this.pos += 6; // stream
    if (this.s[this.pos] === '\r' && this.s[this.pos + 1] === '\n') this.pos += 2;
    else if (this.s[this.pos] === '\n' || this.s[this.pos] === '\r') this.pos += 1;

    const dataStart = this.pos;
    let dataEnd = -1;

    const len = dict.get('Length');
    if (len?.kind === 'number' && Number.isInteger(len.value) && len.value >= 0) {
      const candidate = dataStart + len.value;
      if (candidate <= this.buf.length && /^\s*endstream/.test(this.s.slice(candidate, candidate + 32))) {
        dataEnd = candidate;
      }
    }

    if (dataEnd < 0) {
      const idx = this.s.indexOf('endstream', dataStart);
      dataEnd = idx >= 0 ? idx : this.buf.length;
      while (dataEnd > dataStart && (this.buf[dataEnd - 1] === 0x0a || this.buf[dataEnd - 1] === 0x0d)) {
        dataEnd--;
      }
    }

    const endIdx = this.s.indexOf('endstream', dataEnd);
    this.pos = endIdx >= 0 ? endIdx + 9 : dataEnd;
    return { kind: 'stream', dict, data: this.buf.subarray(dataStart, dataEnd) };
  }
}

/** 读取 PDF 字面量字符串（支持嵌套括号与转义） */
function readLiteralString(s: string, start: number): { bytes: Buffer; end: number } {
  let i = start + 1;
  let depth = 1;
  const out: number[] = [];
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x5c) {
      i += 1;
      const e = s[i];
      if (e === 'n') {
        out.push(10);
        i += 1;
      } else if (e === 'r') {
        out.push(13);
        i += 1;
      } else if (e === 't') {
        out.push(9);
        i += 1;
      } else if (e === 'b') {
        out.push(8);
        i += 1;
      } else if (e === 'f') {
        out.push(12);
        i += 1;
      } else if (e === '(' || e === ')' || e === '\\') {
        out.push(e.charCodeAt(0));
        i += 1;
      } else if (e === '\r') {
        i += 1;
        if (s[i] === '\n') i += 1;
      } else if (e === '\n') {
        i += 1;
      } else if (e >= '0' && e <= '7') {
        let oct = '';
        for (let k = 0; k < 3 && s[i] >= '0' && s[i] <= '7'; k++) {
          oct += s[i];
          i += 1;
        }
        out.push(parseInt(oct, 8) & 0xff);
      } else if (e !== undefined) {
        out.push(e.charCodeAt(0));
        i += 1;
      }
      continue;
    }
    if (c === 0x28) {
      depth += 1;
      out.push(c);
      i += 1;
      continue;
    }
    if (c === 0x29) {
      depth -= 1;
      i += 1;
      if (depth === 0) break;
      out.push(c);
      continue;
    }
    out.push(c & 0xff);
    i += 1;
  }
  return { bytes: Buffer.from(out), end: i };
}

/* ========================================================================
 * 对象扫描与流解码
 * ======================================================================== */

function scanObjects(buf: Buffer, s: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const num = Number(m[1]);
    const parserPos = m.index + m[0].length;
    let obj: PdfObject;
    try {
      obj = new PdfParser(buf, s, parserPos).parseObject();
    } catch {
      re.lastIndex = parserPos;
      continue;
    }
    objects.set(num, obj);
    // 跳过流数据，避免在二进制内容里误匹配 "N 0 obj"
    const end = s.indexOf('endobj', parserPos);
    re.lastIndex = end >= 0 ? end + 6 : Math.max(parserPos, re.lastIndex);
  }
  return objects;
}

function expandObjectStreams(objects: Map<number, PdfObject>, warnings: string[]): void {
  for (const obj of [...objects.values()]) {
    if (obj.kind !== 'stream') continue;
    if (asName(obj.dict.get('Type')) !== 'ObjStm') continue;
    const data = decodeStream(obj, warnings);
    if (!data) continue;
    const count = asNumber(obj.dict.get('N'));
    const first = asNumber(obj.dict.get('First'));
    if (count == null || first == null || !Number.isInteger(count) || count <= 0) continue;
    const header = data.subarray(0, Math.min(first, data.length)).toString('latin1');
    const nums = header.trim().split(/\s+/).map(Number);
    const text = data.toString('latin1');
    for (let i = 0; i < count; i++) {
      const objNum = nums[i * 2];
      const offset = nums[i * 2 + 1];
      if (!Number.isInteger(objNum) || !Number.isInteger(offset)) continue;
      if (objects.has(objNum)) continue;
      try {
        objects.set(objNum, new PdfParser(data, text, first + offset).parseObject());
      } catch {
        // 单个对象解析失败不影响其他对象
      }
    }
  }
}

function getFilterNames(value: PdfValue | undefined): string[] {
  if (!value) return [];
  if (value.kind === 'name') return [value.value];
  if (value.kind === 'array') {
    return value.items.filter((v): v is { kind: 'name'; value: string } => v.kind === 'name').map((v) => v.value);
  }
  return [];
}

function decodeStream(stream: PdfStream, warnings: string[]): Buffer | null {
  let data = stream.data;
  for (const filter of getFilterNames(stream.dict.get('Filter'))) {
    try {
      if (filter === 'FlateDecode' || filter === 'Fl') {
        try {
          data = inflateSync(data, { maxOutputLength: MAX_INFLATE_BYTES });
        } catch {
          data = inflateRawSync(data, { maxOutputLength: MAX_INFLATE_BYTES });
        }
      } else if (filter === 'ASCIIHexDecode' || filter === 'AHx') {
        data = asciiHexDecode(data);
      } else if (filter === 'ASCII85Decode' || filter === 'A85') {
        data = ascii85Decode(data);
      } else {
        warnings.push(`不支持的 PDF 流过滤器 ${filter}，已跳过该流`);
        return null;
      }
    } catch {
      warnings.push(`PDF 流解码失败（${filter}），已跳过该流`);
      return null;
    }
  }
  return data;
}

function asciiHexDecode(data: Buffer): Buffer {
  let hex = data.toString('latin1').replace(/\s+/g, '');
  const end = hex.indexOf('>');
  if (end >= 0) hex = hex.slice(0, end);
  if (hex.length % 2) hex += '0';
  return Buffer.from(hex, 'hex');
}

function ascii85Decode(data: Buffer): Buffer {
  const text = data.toString('latin1').replace(/\s+/g, '');
  const out: number[] = [];
  const chunk: number[] = [];
  const flush = (): void => {
    if (chunk.length === 0) return;
    let value = 0;
    for (let i = 0; i < 5; i++) value = value * 85 + (chunk[i] ?? 84);
    const bytes = [
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ];
    out.push(...bytes.slice(0, chunk.length - 1));
    chunk.length = 0;
  };
  for (const ch of text) {
    if (ch === '~') break;
    if (ch === 'z' && chunk.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 33 || code > 117) continue;
    chunk.push(code - 33);
    if (chunk.length === 5) flush();
  }
  flush();
  return Buffer.from(out);
}

/* ========================================================================
 * 值工具
 * ======================================================================== */

function resolve(value: PdfValue | undefined, objects: Map<number, PdfObject>, depth = 0): PdfObject | undefined {
  let cur: PdfObject | undefined = value;
  while (cur && cur.kind === 'ref' && depth < 32) {
    cur = objects.get(cur.num);
    depth += 1;
  }
  return cur;
}

function asDict(obj: PdfObject | undefined): Map<string, PdfValue> | null {
  if (!obj) return null;
  if (obj.kind === 'dict') return obj.map;
  if (obj.kind === 'stream') return obj.dict;
  return null;
}

function asName(value: PdfValue | undefined): string | null {
  return value?.kind === 'name' ? value.value : null;
}

function asNumber(value: PdfValue | undefined): number | null {
  return value?.kind === 'number' ? value.value : null;
}

function asArray(obj: PdfObject | undefined): PdfValue[] {
  return obj?.kind === 'array' ? obj.items : [];
}

/* ========================================================================
 * 页树
 * ======================================================================== */

function findCatalog(objects: Map<number, PdfObject>): Map<string, PdfValue> | null {
  for (const obj of objects.values()) {
    const dict = asDict(obj);
    if (dict && asName(dict.get('Type')) === 'Catalog') return dict;
  }
  return null;
}

function collectPages(
  catalog: Map<string, PdfValue>,
  objects: Map<number, PdfObject>,
  maxPages: number,
): { pages: Map<string, PdfValue>[]; truncated: boolean; declaredCount: number | null } {
  const pages: Map<string, PdfValue>[] = [];
  const visited = new Set<number>();
  let truncated = false;

  const rootValue = catalog.get('Pages');
  const rootDict = asDict(resolve(rootValue, objects));
  const declaredCount = asNumber(rootDict?.get('Count')) ?? null;

  const walk = (value: PdfValue | undefined, inherited?: PdfValue): void => {
    if (pages.length >= maxPages) {
      truncated = true;
      return;
    }
    const refNum = value?.kind === 'ref' ? value.num : null;
    if (refNum != null) {
      if (visited.has(refNum)) return;
      visited.add(refNum);
    }
    const dict = asDict(resolve(value, objects));
    if (!dict) return;

    const resources = dict.get('Resources') ?? inherited;
    const type = asName(dict.get('Type'));
    const kids = asArray(resolve(dict.get('Kids'), objects));

    if (type === 'Pages' || kids.length > 0) {
      for (const kid of kids) {
        if (pages.length >= maxPages) {
          truncated = true;
          break;
        }
        walk(kid, resources);
      }
      return;
    }

    if (type === 'Page' || dict.has('Contents') || dict.has('MediaBox')) {
      const copy = new Map(dict);
      if (resources) copy.set('Resources', resources);
      pages.push(copy);
    }
  };

  walk(rootValue);
  return { pages, truncated, declaredCount };
}

/* ========================================================================
 * 字体解码
 * ======================================================================== */

interface FontDecoder {
  codeLength: number;
  decode(code: number): string;
}

interface CMap {
  map: Map<number, string>;
  codeLength: number;
}

const CP1252: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘',
  0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function winAnsiChar(code: number): string {
  if (code < 0x20) return '';
  if (code >= 0x20 && code <= 0x7e) return String.fromCharCode(code);
  return CP1252[code] ?? String.fromCharCode(code);
}

function decodeUtf16Hex(hex: string): string {
  let h = hex;
  if (h.length % 2) h = `0${h}`;
  const buf = Buffer.from(h, 'hex');
  let out = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out += String.fromCharCode((buf[i] << 8) | buf[i + 1]);
  }
  return out;
}

function incrementUtf16(text: string, delta: number): string {
  if (!text) return text;
  return String.fromCharCode(text.charCodeAt(0) + delta) + text.slice(1);
}

function parseCMap(text: string): CMap {
  const map = new Map<number, string>();
  let codeLength = 0;

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const hexes = [...block[1].matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => m[1]);
    for (let i = 0; i + 1 < hexes.length; i += 2) {
      const src = hexes[i];
      if (!codeLength) codeLength = Math.ceil(src.length / 2);
      map.set(parseInt(src, 16), decodeUtf16Hex(hexes[i + 1]));
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block[1]))) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (!codeLength) codeLength = Math.ceil(m[1].length / 2);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 65535) continue;
      if (m[3]) {
        const base = decodeUtf16Hex(m[3]);
        for (let code = lo; code <= hi; code++) map.set(code, incrementUtf16(base, code - lo));
      } else {
        const dests = [...m[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => decodeUtf16Hex(x[1]));
        for (let code = lo; code <= hi && code - lo < dests.length; code++) {
          map.set(code, dests[code - lo]);
        }
      }
    }
  }

  return { map, codeLength };
}

function glyphNameToUnicode(name: string): string | null {
  const uni = /^uni([0-9a-fA-F]{4})$/.exec(name);
  if (uni) return String.fromCharCode(parseInt(uni[1], 16));
  const u = /^u([0-9a-fA-F]{4,6})$/.exec(name);
  if (u) return String.fromCodePoint(parseInt(u[1], 16));
  if (name.length === 1) return name;
  const common: Record<string, string> = {
    space: ' ', period: '.', comma: ',', hyphen: '-', colon: ':', semicolon: ';',
    parenleft: '(', parenright: ')', slash: '/', quoteleft: '‘', quoteright: '’',
    quotedblleft: '“', quotedblright: '”', endash: '–', emdash: '—', bullet: '•',
  };
  return common[name] ?? null;
}

function buildFontDecoder(
  dict: Map<string, PdfValue>,
  objects: Map<number, PdfObject>,
  warnings: string[],
): FontDecoder {
  const subtype = asName(dict.get('Subtype'));
  const type0 = subtype === 'Type0';

  let cmap: CMap | null = null;
  const toUnicode = resolve(dict.get('ToUnicode'), objects);
  if (toUnicode?.kind === 'stream') {
    const data = decodeStream(toUnicode, warnings);
    if (data) cmap = parseCMap(data.toString('latin1'));
  }

  const codeLength = cmap?.codeLength || (type0 ? 2 : 1);
  const map = cmap?.map ?? new Map<number, string>();

  // 简单字体的 Differences：只识别 uniXXXX / uXXXX 与常见字形名
  const encoding = asDict(resolve(dict.get('Encoding'), objects));
  const differences = encoding ? asArray(resolve(encoding.get('Differences'), objects)) : [];
  let code = 0;
  for (const item of differences) {
    if (item.kind === 'number') {
      code = item.value;
    } else if (item.kind === 'name') {
      const u = glyphNameToUnicode(item.value);
      if (u && !map.has(code)) map.set(code, u);
      code += 1;
    }
  }

  return {
    codeLength,
    decode(codeValue: number): string {
      const mapped = map.get(codeValue);
      if (mapped !== undefined) return mapped;
      if (codeLength === 1) return winAnsiChar(codeValue);
      return '\uFFFD';
    },
  };
}

function buildPageFonts(
  page: Map<string, PdfValue>,
  objects: Map<number, PdfObject>,
  warnings: string[],
  cache: WeakMap<object, FontDecoder>,
): Map<string, FontDecoder> {
  const fonts = new Map<string, FontDecoder>();
  const resources = asDict(resolve(page.get('Resources'), objects));
  const fontDict = asDict(resolve(resources?.get('Font'), objects));
  if (!fontDict) return fonts;

  for (const [name, value] of fontDict) {
    const fontObj = resolve(value, objects);
    const dict = asDict(fontObj);
    if (!dict || !fontObj) continue;
    const cacheKey = fontObj as object;
    let decoder = cache.get(cacheKey);
    if (!decoder) {
      decoder = buildFontDecoder(dict, objects, warnings);
      cache.set(cacheKey, decoder);
    }
    fonts.set(name, decoder);
  }
  return fonts;
}

/* ========================================================================
 * 内容流解析
 * ======================================================================== */

type ContentToken =
  | { t: 'num'; v: number }
  | { t: 'str'; v: Buffer }
  | { t: 'name'; v: string }
  | { t: 'op'; v: string }
  | { t: '[' }
  | { t: ']' };

class ContentLexer {
  pos = 0;

  constructor(private readonly s: string) {}

  next(): ContentToken | null {
    while (this.pos < this.s.length) {
      const c = this.s.charCodeAt(this.pos);
      if (WS.has(c)) {
        this.pos++;
        continue;
      }
      if (c === 0x25) {
        while (this.pos < this.s.length && this.s.charCodeAt(this.pos) !== 0x0a && this.s.charCodeAt(this.pos) !== 0x0d) {
          this.pos++;
        }
        continue;
      }
      break;
    }
    if (this.pos >= this.s.length) return null;

    const c = this.s[this.pos];
    if (c === '[') {
      this.pos++;
      return { t: '[' };
    }
    if (c === ']') {
      this.pos++;
      return { t: ']' };
    }
    if (c === '(') {
      const { bytes, end } = readLiteralString(this.s, this.pos);
      this.pos = end;
      return { t: 'str', v: bytes };
    }
    if (c === '<' && this.s[this.pos + 1] === '<') {
      // 内容流里的字典（极少见）：跳过
      const end = this.s.indexOf('>>', this.pos + 2);
      this.pos = end >= 0 ? end + 2 : this.s.length;
      return this.next();
    }
    if (c === '<') {
      this.pos++;
      let hex = '';
      while (this.pos < this.s.length && this.s[this.pos] !== '>') {
        const ch = this.s[this.pos++];
        if (!/\s/.test(ch)) hex += ch;
      }
      if (this.s[this.pos] === '>') this.pos++;
      if (hex.length % 2) hex += '0';
      return { t: 'str', v: Buffer.from(hex, 'hex') };
    }
    if (c === '/') {
      this.pos++;
      const start = this.pos;
      while (this.pos < this.s.length) {
        const cc = this.s.charCodeAt(this.pos);
        if (WS.has(cc) || DELIM.has(cc)) break;
        this.pos++;
      }
      return { t: 'name', v: this.s.slice(start, this.pos) };
    }
    if (isNumStart(this.s.charCodeAt(this.pos))) {
      const start = this.pos;
      while (this.pos < this.s.length && isNumStart(this.s.charCodeAt(this.pos))) this.pos++;
      return { t: 'num', v: Number(this.s.slice(start, this.pos)) || 0 };
    }

    const start = this.pos;
    while (this.pos < this.s.length) {
      const cc = this.s.charCodeAt(this.pos);
      if (WS.has(cc) || DELIM.has(cc)) break;
      this.pos++;
    }
    const word = this.s.slice(start, this.pos);
    if (word === 'BI') {
      skipInlineImage(this.s, this.pos);
      return { t: 'op', v: 'BI' };
    }
    return { t: 'op', v: word };
  }
}

function skipInlineImage(s: string, pos: number): number {
  const id = s.indexOf('ID', pos);
  if (id < 0) return s.length;
  let i = id + 2;
  while (i < s.length && WS.has(s.charCodeAt(i))) i++;
  const re = /[\s]EI[\s]/g;
  re.lastIndex = i;
  const m = re.exec(s);
  return m ? m.index + m[0].length : s.length;
}

interface TextState {
  out: string;
  font: FontDecoder | null;
  fontSize: number;
  lastX: number;
  lastY: number;
}

function decodeBytes(bytes: Buffer, dec: FontDecoder): string {
  let out = '';
  if (dec.codeLength === 1) {
    for (const b of bytes) out += dec.decode(b);
  } else {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      out += dec.decode((bytes[i] << 8) | bytes[i + 1]);
    }
    if (bytes.length % 2) out += dec.decode(bytes[bytes.length - 1]);
  }
  return out;
}

function parseContentStream(
  data: Buffer,
  fonts: Map<string, FontDecoder>,
  shouldStop: () => boolean,
): { text: string; stopped: boolean } {
  const lexer = new ContentLexer(data.toString('latin1'));
  const state: TextState = { out: '', font: null, fontSize: 12, lastX: 0, lastY: 0 };
  let operands: unknown[] = [];
  let arrays: unknown[][] = [];
  let tokenCount = 0;

  const newline = (): void => {
    if (state.out && !state.out.endsWith('\n')) state.out += '\n';
  };
  const space = (): void => {
    if (state.out && !/\s$/.test(state.out)) state.out += ' ';
  };
  const show = (bytes: Buffer): void => {
    if (!bytes.length) return;
    state.out += state.font ? decodeBytes(bytes, state.font) : bytes.toString('latin1');
  };

  for (;;) {
    if ((tokenCount++ & 0xfff) === 0 && shouldStop()) {
      return { text: state.out, stopped: true };
    }
    const token = lexer.next();
    if (!token) break;

    if (token.t === '[') {
      arrays.push([]);
      continue;
    }
    if (token.t === ']') {
      const arr = arrays.pop() ?? [];
      if (arrays.length > 0) arrays[arrays.length - 1].push(arr);
      else operands.push(arr);
      continue;
    }
    if (token.t !== 'op') {
      const value = token.t === 'str' ? token.v : token.v;
      if (arrays.length > 0) arrays[arrays.length - 1].push(value);
      else operands.push(value);
      continue;
    }

    switch (token.v) {
      case 'BT':
        newline();
        state.lastX = 0;
        state.lastY = 0;
        break;
      case 'ET':
        newline();
        break;
      case 'Tf': {
        const name = operands[0];
        const size = operands[1];
        if (typeof name === 'string') state.font = fonts.get(name) ?? null;
        if (typeof size === 'number' && Number.isFinite(size)) state.fontSize = size;
        break;
      }
      case 'Td':
      case 'TD': {
        const tx = typeof operands[0] === 'number' ? operands[0] : 0;
        const ty = typeof operands[1] === 'number' ? operands[1] : 0;
        if (ty !== 0) newline();
        else if (tx > state.fontSize * 0.5) space();
        state.lastX += tx;
        state.lastY += ty;
        break;
      }
      case 'Tm': {
        const e = typeof operands[4] === 'number' ? operands[4] : state.lastX;
        const f = typeof operands[5] === 'number' ? operands[5] : state.lastY;
        if (Math.abs(f - state.lastY) > 0.5) newline();
        else if (Math.abs(e - state.lastX) > state.fontSize * 0.5) space();
        state.lastX = e;
        state.lastY = f;
        break;
      }
      case 'T*':
        newline();
        break;
      case 'Tj': {
        const arg = operands[0];
        if (Buffer.isBuffer(arg)) show(arg);
        break;
      }
      case 'TJ': {
        const arr = operands.find((v) => Array.isArray(v)) as unknown[] | undefined;
        if (arr) {
          for (const item of arr) {
            if (Buffer.isBuffer(item)) show(item);
            else if (typeof item === 'number' && item <= -100) space();
          }
        }
        break;
      }
      case "'": {
        newline();
        const arg = operands[0];
        if (Buffer.isBuffer(arg)) show(arg);
        break;
      }
      case '"': {
        newline();
        const arg = operands[2];
        if (Buffer.isBuffer(arg)) show(arg);
        break;
      }
      default:
        break;
    }

    operands = [];
    if (arrays.length > 0) arrays = [];
  }

  newline();
  return { text: state.out, stopped: false };
}

/* ========================================================================
 * 页内容与主流程
 * ======================================================================== */

function collectPageContent(
  page: Map<string, PdfValue>,
  objects: Map<number, PdfObject>,
  warnings: string[],
): Buffer {
  const value = page.get('Contents');
  const resolved = resolve(value, objects);
  const parts: Buffer[] = [];

  const addStream = (obj: PdfObject | undefined): void => {
    if (!obj || obj.kind !== 'stream') return;
    const decoded = decodeStream(obj, warnings);
    if (decoded) parts.push(decoded);
  };

  if (resolved?.kind === 'array') {
    for (const item of resolved.items) addStream(resolve(item, objects));
  } else {
    addStream(resolved);
  }
  return Buffer.concat(parts, parts.reduce((sum, p) => sum + p.length, 0));
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * 提取 PDF 文本层。
 * 返回的 text 已规范化，pages 的行号与该 text 严格对应。
 */
async function extractPdfInternal(absPath: string, opts: PdfExtractOptions): Promise<ExtractResult> {
  let size: number;
  try {
    size = (await stat(absPath)).size;
  } catch {
    throw new DocumentExtractError('corrupt', `文件不存在或不可读: ${absPath}`);
  }
  if (size > opts.maxBytes) {
    throw new DocumentExtractError(
      'too_large',
      `文档过大（${formatBytes(size)}），解析上限为 ${formatBytes(opts.maxBytes)}`,
    );
  }

  const buf = await readFile(absPath);
  const text = buf.toString('latin1');

  // 加密检测：PDF 的 /Encrypt 只出现在 trailer/xref 附近
  const tail = text.slice(Math.max(0, text.length - 200_000));
  if (/\/Encrypt\s+(\d+\s+\d+\s+R|<<)/.test(tail)) {
    throw new DocumentExtractError('encrypted', 'PDF 已加密，无法提取文本；请提供解密后的副本');
  }

  const warnings: string[] = [];
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const deadline = Date.now() + (opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const shouldStop = (): boolean => Date.now() > deadline || opts.signal?.aborted === true;

  const objects = scanObjects(buf, text);
  if (objects.size === 0) {
    throw new DocumentExtractError('corrupt', 'PDF 结构无法解析（未找到任何对象）');
  }
  expandObjectStreams(objects, warnings);

  const catalog = findCatalog(objects);
  if (!catalog) {
    throw new DocumentExtractError('corrupt', 'PDF 未找到目录（Catalog），文件可能已损坏');
  }

  const { pages, truncated: pagesTruncated, declaredCount } = collectPages(catalog, objects, maxPages);
  if (pages.length === 0) {
    throw new DocumentExtractError('corrupt', 'PDF 未包含可读取的页面');
  }
  if (pagesTruncated) warnings.push(`PDF 页数超过 ${maxPages}，仅处理前 ${pages.length} 页`);

  const fontCache = new WeakMap<object, FontDecoder>();
  const lines: string[] = [];
  const ranges: PageRange[] = [];
  const pageTexts: string[] = [];
  let truncated = pagesTruncated;
  let chars = 0;
  let stoppedEarly = false;

  for (let i = 0; i < pages.length; i++) {
    if (shouldStop()) {
      stoppedEarly = true;
      truncated = true;
      break;
    }

    const page = pages[i];
    const fonts = buildPageFonts(page, objects, warnings, fontCache);
    const content = collectPageContent(page, objects, warnings);
    let pageText = '';

    if (content.length > 0) {
      const parsed = parseContentStream(content, fonts, shouldStop);
      pageText = normalizeText(parsed.text);
      if (parsed.stopped) {
        stoppedEarly = true;
        truncated = true;
      }
    }

    if (!pageText) pageText = '[本页未提取到文本]';
    pageTexts.push(pageText === '[本页未提取到文本]' ? '' : pageText);

    const startLine = lines.length + 1;
    lines.push(`=== 第 ${i + 1} 页 ===`);
    const pageLines = pageText.split('\n').slice(0, MAX_PAGE_LINES);
    lines.push(...pageLines);
    ranges.push({ page: i + 1, startLine, endLine: lines.length });

    chars += pageText.length;
    if (chars > maxChars) {
      truncated = true;
      warnings.push(`提取文本超过 ${maxChars} 字符上限，已截断`);
      break;
    }
    if (stoppedEarly) break;
  }

  if (stoppedEarly) {
    warnings.push('PDF 提取超出时间预算或已取消，已返回已完成页面');
  }

  const bodyText = pageTexts.join('');
  const nonWhitespace = bodyText.replace(/\s/g, '').length;
  const replacementChars = (bodyText.match(/\uFFFD/g) ?? []).length;
  if (nonWhitespace > 0 && replacementChars / nonWhitespace > 0.2) {
    warnings.push('字体编码未完全解析，文本可能乱码');
  }
  // 扫描件通常连一个可读字符都没有；阈值按页数放宽，避免短文档误判
  if (nonWhitespace < Math.max(5, pages.length * 5)) {
    // 任务 04：无文本层时尝试光栅化扫描页，图片交由工具层 OCR（D8）。
    // 光栅化工具缺失/失败时保持原有 scanned 错误，并附安装指引。
    const raster = await rasterizeForOcr(absPath, pages.map((_, i) => i + 1), opts);
    if (raster.images.length > 0) {
      return {
        kind: 'pdf',
        text: lines.join('\n'),
        pages: ranges,
        pageCount: declaredCount ?? pages.length,
        images: raster.images,
        warnings: [
          ...warnings,
          'PDF 没有可提取的文本层（扫描件），已渲染页面图片并交回 OCR',
          ...raster.warnings,
        ],
        truncated,
      };
    }
    throw new DocumentExtractError(
      'scanned',
      `该 PDF 没有可提取的文本层（可能是扫描件）；可用 analyzeImage 识别图片，或先转换为文本型 PDF。${raster.warnings[0] ?? ''}`,
    );
  }

  const pageCount = declaredCount ?? pages.length;

  // 任务 04：混合型 PDF（部分页无文本层）同样把空白页光栅化后交回 OCR
  const blankPages = pageTexts
    .map((t, i) => (t.trim() ? 0 : i + 1))
    .filter((p) => p > 0);
  const ocrTargets = opts.pdfOcrAllPages ? pages.map((_, i) => i + 1) : blankPages;
  let images;
  if (ocrTargets.length > 0) {
    const raster = await rasterizeForOcr(absPath, ocrTargets, opts);
    if (raster.images.length > 0) {
      images = raster.images;
      warnings.push(
        `PDF 有 ${ocrTargets.length} 页无文本层，已渲染页面图片并交回 OCR`,
        ...raster.warnings,
      );
    }
  }

  return {
    kind: 'pdf',
    text: lines.join('\n'),
    pages: ranges,
    pageCount,
    images,
    warnings,
    truncated,
  };
}

/** 外部 pdftotext 结果 → 统一 ExtractResult（按换页符 \f 分页） */
function buildFallbackResult(out: string, warnings: string[]): ExtractResult {
  const parts = out.split('\f');
  // pdftotext 常在末尾多一个换页符，去掉尾部空页
  while (parts.length > 1 && parts[parts.length - 1].trim() === '') parts.pop();
  const pageTexts = parts.length > 0 ? parts : [out];
  const lines: string[] = [];
  const ranges: PageRange[] = [];
  let hasText = false;

  for (let i = 0; i < pageTexts.length; i++) {
    const body = normalizeText(pageTexts[i]);
    if (body) hasText = true;
    const startLine = lines.length + 1;
    lines.push(`=== 第 ${i + 1} 页 ===`);
    if (body) lines.push(...body.split('\n'));
    ranges.push({ page: i + 1, startLine, endLine: lines.length });
  }

  if (!hasText) {
    throw new DocumentExtractError(
      'scanned',
      '该 PDF 没有可提取的文本层（可能是扫描件）；可用 analyzeImage 识别图片，或先转换为文本型 PDF',
    );
  }

  return {
    kind: 'pdf',
    text: lines.join('\n'),
    pages: ranges,
    pageCount: pageTexts.length,
    warnings,
    truncated: false,
  };
}

/**
 * PDF 提取入口：内置解析失败（扫描件/乱码）且系统存在 pdftotext 时兜底重试。
 * 外部工具不存在/失败时保持内置结果或原始错误，不掩盖真实原因。
 */
export async function extractPdf(
  absPath: string,
  opts: PdfExtractOptions,
): Promise<ExtractResult> {
  try {
    const result = await extractPdfInternal(absPath, opts);
    if (result.warnings.some((w) => w.includes('乱码')) && pdftotextAvailable()) {
      const alt = await runPdftotext(absPath, opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
      if (alt) {
        return buildFallbackResult(alt, [
          ...result.warnings,
          '由系统 pdftotext 提取（内置解析结果可能乱码）',
        ]);
      }
    }
    return result;
  } catch (e) {
    if (e instanceof DocumentExtractError && e.code === 'scanned' && pdftotextAvailable()) {
      const alt = await runPdftotext(absPath, opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
      if (alt) {
        return buildFallbackResult(alt, ['内置解析未找到文本层，已由系统 pdftotext 提取']);
      }
    }
    throw e;
  }
}
