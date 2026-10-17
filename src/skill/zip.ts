// 技能 zip 包解析（零依赖，node:zlib inflateRawSync）。
// 仅供技能上传安装使用：解析 zip 中央目录 + 逐条目解压，返回安全归一化后的文件/目录条目。
// 安全防护：条目名归一化（\→/，拒绝绝对路径/盘符/.././NUL）、加密条目拒绝、
//          ZIP64 拒绝、条目数 ≤2000、解压后总量 ≤50MB（压缩炸弹防护）。

import { inflateRawSync } from 'node:zlib';

/** zip 条目：path 为归一化后的相对路径（/ 分隔），segs 为路径段，目录条目 data 为空 Buffer */
export interface ZipEntry {
  path: string;
  segs: string[];
  isDir: boolean;
  data: Buffer;
}

/** 条目数上限与解压后总量上限（压缩炸弹防护） */
const MAX_ENTRIES = 2000;
const MAX_TOTAL_UNCOMPRESSED = 50 * 1024 * 1024;

/** EOCD 定长 22 字节 + 注释最大 65535 字节 */
const EOCD_MIN = 22;
const EOCD_MAX_SCAN = EOCD_MIN + 0xffff;

function u16(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}
function u32(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}

/** 归一化并校验条目名：\→/ 归一化，拒绝绝对路径 / 盘符 / .. / . / NUL，返回路径段数组 */
function safeEntrySegs(rawName: string, entryPath: string): string[] {
  const name = rawName.replace(/\\/g, '/');
  if (name.includes('\0')) throw new Error(`条目路径含 NUL 字符: "${entryPath}"`);
  if (/^[a-zA-Z]:/.test(name)) throw new Error(`条目路径不允许盘符: "${entryPath}"`);
  if (name.startsWith('/')) throw new Error(`条目路径必须为相对路径: "${entryPath}"`);
  const segs = name.split('/').filter((s) => s !== '');
  if (segs.length === 0) throw new Error(`条目路径为空: "${entryPath}"`);
  if (segs.some((s) => s === '.' || s === '..')) {
    throw new Error(`条目路径不允许 . 或 ..: "${entryPath}"`);
  }
  return segs;
}

/** 从尾部回扫 EOCD（容忍注释），返回 { totalEntries, cdOffset } */
function findEocd(zip: Buffer): { totalEntries: number; cdOffset: number } {
  if (zip.length < EOCD_MIN) throw new Error('文件太小，不是合法 zip');
  const sig = 0x06054b50;
  const scanFrom = Math.max(0, zip.length - EOCD_MAX_SCAN);
  for (let i = zip.length - EOCD_MIN; i >= scanFrom; i--) {
    if (u32(zip, i) !== sig) continue;
    // 容忍注释长度与实际文件尾部不一致的非常规 zip：取找到的第一个（从后往前第一个即最后一个 EOCD）
    const totalEntries = u16(zip, i + 10);
    const cdOffset = u32(zip, i + 16);
    if (totalEntries === 0xffff || cdOffset === 0xffffffff) {
      throw new Error('不支持 ZIP64 格式 zip 包');
    }
    if (cdOffset > zip.length) throw new Error('zip 中央目录偏移越界，文件可能已损坏');
    return { totalEntries, cdOffset };
  }
  throw new Error('未找到 zip 结束记录（EOCD），不是合法 zip 文件');
}

/**
 * 解析 zip 包，返回全部文件/目录条目（按中央目录顺序）。
 * 任何非法结构、加密条目、不支持的压缩方法、超限均抛 Error（中文消息，调用方转 400）。
 */
export function readZipEntries(zip: Buffer): ZipEntry[] {
  const { totalEntries, cdOffset } = findEocd(zip);
  if (totalEntries === 0) throw new Error('zip 包内没有条目');
  if (totalEntries > MAX_ENTRIES) throw new Error(`zip 条目数过多（${totalEntries} > ${MAX_ENTRIES}）`);

  const entries: ZipEntry[] = [];
  let totalUncompressed = 0;
  let off = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (off + 46 > zip.length || u32(zip, off) !== 0x02014b50) {
      throw new Error('zip 中央目录损坏');
    }
    const flags = u16(zip, off + 8);
    const method = u16(zip, off + 10);
    const compSize = u32(zip, off + 20);
    const uncompSize = u32(zip, off + 24);
    const nameLen = u16(zip, off + 28);
    const extraLen = u16(zip, off + 30);
    const commentLen = u16(zip, off + 32);
    const localOffset = u32(zip, off + 42);

    if ((flags & 0x0001) !== 0) throw new Error('不支持加密的 zip 包');
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('不支持 ZIP64 格式 zip 包');
    }

    const rawName = zip.toString('utf8', off + 46, off + 46 + nameLen);
    const isDir = rawName.replace(/\\/g, '/').endsWith('/');
    const segs = safeEntrySegs(rawName, rawName);
    const path = segs.join('/');

    // 本地头：数据起始 = localOffset + 30 + 本地 nameLen + 本地 extraLen（尺寸用中央目录值，
    // 因为置位 data descriptor（flags bit3）时本地头尺寸字段为 0）
    if (localOffset + 30 > zip.length || u32(zip, localOffset) !== 0x04034b50) {
      throw new Error(`zip 本地文件头损坏: "${path}"`);
    }
    const lNameLen = u16(zip, localOffset + 26);
    const lExtraLen = u16(zip, localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > zip.length) throw new Error(`zip 条目数据越界: "${path}"`);

    let data: Buffer;
    if (isDir) {
      data = Buffer.alloc(0);
    } else if (method === 0) {
      data = zip.subarray(dataStart, dataEnd);
    } else if (method === 8) {
      try {
        data = inflateRawSync(zip.subarray(dataStart, dataEnd));
      } catch {
        throw new Error(`zip 条目解压失败: "${path}"`);
      }
    } else {
      throw new Error(`不支持的 zip 压缩方法 ${method}: "${path}"`);
    }

    if (!isDir) {
      totalUncompressed += data.length;
      if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
        throw new Error(`zip 解压后总大小超过 ${MAX_TOTAL_UNCOMPRESSED / 1024 / 1024}MB 上限`);
      }
    }

    entries.push({ path, segs, isDir, data });
    off += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}
