// rtf 文本提取（需求 20261112-001 / 任务 03）
// 只做「控制字剥离 + 转义解码 + 段落还原」，不还原字体/颜色/表格等排版。

import { readFile } from 'node:fs/promises';
import { DocumentExtractError, type ExtractOptions, type ExtractResult } from './types.js';
import { normalizeText } from './text.js';

/** 跳过这些目标组（字体表、样式、图片、元信息等） */
const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object',
  'themedata', 'datastore', 'latentstyles', 'xmlnstbl',
  'listtable', 'listoverridetable', 'rsidtbl', 'generator',
  'filetbl', 'revtbl', 'pntext', 'header', 'footer',
]);

/** RTF 代码页 → TextDecoder 编码名 */
function decoderName(codepage: number): string {
  switch (codepage) {
    case 936:
      return 'gbk';
    case 950:
      return 'big5';
    case 1251:
      return 'windows-1251';
    case 65001:
      return 'utf-8';
    default:
      return 'windows-1252';
  }
}

function decodeBytes(bytes: number[], encoding: string): string {
  try {
    return new TextDecoder(encoding).decode(Buffer.from(bytes));
  } catch {
    return Buffer.from(bytes).toString('latin1');
  }
}

/** 解析 RTF 字符串（latin1 视角，字节与字符一一对应） */
function parseRtf(raw: string): string {
  let out = '';
  const skipStack: boolean[] = [false];
  let pendingHex: number[] = [];
  let encoding = decoderName(1252);
  let i = 0;

  const skipping = (): boolean => skipStack[skipStack.length - 1];
  const flushHex = (): void => {
    if (pendingHex.length === 0) return;
    if (!skipping()) out += decodeBytes(pendingHex, encoding);
    pendingHex = [];
  };

  while (i < raw.length) {
    const ch = raw[i];

    if (ch === '{') {
      skipStack.push(skipping());
      i += 1;
      continue;
    }
    if (ch === '}') {
      flushHex();
      if (skipStack.length > 1) skipStack.pop();
      i += 1;
      continue;
    }
    if (ch !== '\\') {
      flushHex();
      if (!skipping()) out += ch;
      i += 1;
      continue;
    }

    // 反斜杠控制序列
    i += 1;
    const next = raw[i];
    if (next === undefined) break;

    if (next === '\\' || next === '{' || next === '}') {
      flushHex();
      if (!skipping()) out += next;
      i += 1;
      continue;
    }
    if (next === "'") {
      const hex = raw.slice(i + 1, i + 3);
      const byte = parseInt(hex, 16);
      if (Number.isFinite(byte)) {
        pendingHex.push(byte);
        i += 3;
      } else {
        i += 1;
      }
      continue;
    }
    if (next === '*') {
      flushHex();
      skipStack[skipStack.length - 1] = true;
      i += 1;
      continue;
    }
    if (next === '~') {
      flushHex();
      if (!skipping()) out += ' ';
      i += 1;
      continue;
    }
    if (next === '-' || next === '_') {
      flushHex();
      if (!skipping()) out += '-';
      i += 1;
      continue;
    }
    if (next === '\r' || next === '\n') {
      flushHex();
      i += 1;
      continue;
    }

    // 控制字：字母 + 可选符号/数字 + 可选空格
    let j = i;
    while (j < raw.length && /[a-zA-Z]/.test(raw[j])) j += 1;
    const word = raw.slice(i, j);
    let numStart = j;
    if (raw[j] === '-') j += 1;
    while (j < raw.length && /[0-9]/.test(raw[j])) j += 1;
    const num = j > numStart ? Number(raw.slice(numStart, j)) : null;
    if (raw[j] === ' ') j += 1;
    i = j;

    if (!word) continue;
    flushHex();
    if (SKIP_DESTINATIONS.has(word)) {
      skipStack[skipStack.length - 1] = true;
      continue;
    }
    if (skipping()) continue;

    if (word === 'par' || word === 'line') out += '\n';
    else if (word === 'tab') out += '\t';
    else if (word === 'ansicpg' && num !== null) encoding = decoderName(num);
    else if (word === 'u' && num !== null) {
      out += String.fromCharCode(num < 0 ? num + 65536 : num);
      // 跳过替代字符（通常是 ? 或 \'hh）
      if (raw[i] === '?') i += 1;
      else if (raw[i] === '\\' && raw[i + 1] === "'") i += 4;
    } else if (word === 'emdash') out += '—';
    else if (word === 'endash') out += '–';
    else if (word === 'bullet') out += '•';
    else if (word === 'lquote') out += '‘';
    else if (word === 'rquote') out += '’';
    else if (word === 'ldblquote') out += '“';
    else if (word === 'rdblquote') out += '”';
  }

  flushHex();
  return out;
}

export async function extractRtf(
  absPath: string,
  _opts: ExtractOptions,
): Promise<ExtractResult> {
  let raw: string;
  try {
    raw = (await readFile(absPath)).toString('latin1');
  } catch {
    throw new DocumentExtractError('corrupt', `文件不可读: ${absPath}`);
  }

  const warnings: string[] = [];
  const text = normalizeText(parseRtf(raw));
  if (!text.trim()) {
    throw new DocumentExtractError('empty', `RTF 文档没有可提取的文本: ${absPath}`);
  }
  return { kind: 'rtf', text, warnings, truncated: false };
}
