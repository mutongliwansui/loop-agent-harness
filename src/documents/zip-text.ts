// OOXML/ODF 压缩包与 XML 文本工具（需求 20261112-001 / 任务 03）
// 复用 skill/zip 的零依赖解析与安全上限（条目数/解压总量/ZIP64/加密）。

import { readFile } from 'node:fs/promises';
import { readZipEntries } from '../skill/zip.js';
import { DocumentExtractError } from './types.js';

/** 读取 zip 包为 path → Buffer（失败统一映射为 corrupt） */
export async function readOfficeZip(absPath: string): Promise<Map<string, Buffer>> {
  let buf: Buffer;
  try {
    buf = await readFile(absPath);
  } catch {
    throw new DocumentExtractError('corrupt', `文件不可读: ${absPath}`);
  }
  let entries;
  try {
    entries = readZipEntries(buf);
  } catch (e) {
    throw new DocumentExtractError(
      'corrupt',
      `文件不是合法的 OOXML/ODF 压缩包: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const map = new Map<string, Buffer>();
  for (const entry of entries) {
    if (!entry.isDir) map.set(entry.path, entry.data);
  }
  return map;
}

/** 取 zip 内文本条目（UTF-8），缺失返回 null */
export function entryText(zip: Map<string, Buffer>, name: string): string | null {
  const buf = zip.get(name);
  return buf ? buf.toString('utf-8') : null;
}

/** 解码 XML 实体（仅内置实体与数字实体，不展开自定义实体/DTD） */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)));
}

/** 去标签并解码实体（标签级文本抽取，不做 XML 解析） */
export function stripXmlTags(s: string): string {
  return decodeXmlEntities(s.replace(/<[^>]*>/g, ''));
}

/** 读取标签中的属性值（属性名精确匹配，值做实体解码） */
export function xmlAttr(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`\\s${escaped}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? decodeXmlEntities(m[1]) : null;
}
