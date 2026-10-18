// 工作空间文件浏览器 API（原型-20261018-001）
//
// GET /fs/tree   → 工作空间文件树（递归；node_modules/__pycache__ 恒排除；dot 条目默认隐藏）
// GET /fs/file   → 单文件文本预览（within 工作空间校验；二进制拒绝；超长截断）
// GET /fs/raw    → 文件原始字节（pdf/docx/xlsx 等二进制文档与图片预览用；大小上限）
// GET /fs/doc2md → 旧版 .doc 文本提取并转 markdown（word-extractor + 段落启发式；前端复用 md 渲染）
// GET /fs/search → 关键词全文搜索（逐文件扫描，跳过二进制与大文件；结果上限）
//
// 锚定 ctx.deps.sessionStore.path 为当前工作空间根：请求 path 为空间内相对路径
// （兼容绝对路径，但必须位于根内，越界 403）；响应 path 字段统一 '/' 分隔，
// 前端原样回传即可，无平台差异。

import { open, readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { HandlerContext, Route } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { sendJson } from '../http-utils.js';
import WordExtractor from 'word-extractor'; // CJS 包，类型见 src/types/word-extractor.d.ts

/** 恒排除的重目录（体积大且对代码浏览无价值；不随 hidden 开关出现） */
const ALWAYS_SKIP = new Set(['node_modules', '__pycache__']);
/** 树最大递归深度与总条目上限（防御超大空间拖垮响应） */
const MAX_DEPTH = 8;
const MAX_TREE_ENTRIES = 4000;
/** 文件预览读取上限（超出截断并在响应标记） */
const MAX_FILE_BYTES = 512 * 1024;
/** 搜索跳过的单文件大小上限（与二进制探测配合） */
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
/** 搜索结果条数上限 */
const MAX_SEARCH_RESULTS = 200;
/** 二进制探测窗口：首段出现 NUL 即判定二进制 */
const BINARY_SNIFF_BYTES = 8000;
/** /fs/raw 原始输出上限（文档预览用；本地工具放宽到 100MB） */
const MAX_RAW_BYTES = 100 * 1024 * 1024;
/** 文档/图片类扩展名 → Content-Type（未识别一律 application/octet-stream） */
const RAW_CONTENT_TYPES: Record<string, string> = {
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

interface FsNode {
  name: string;
  /** 空间内相对路径，'/' 分隔 */
  path: string;
  type: 'dir' | 'file';
  size?: number;
  children?: FsNode[];
}

/** Windows 下 relative() 产 '\'，统一转 '/'（resolve 两种都接受） */
function toSlash(p: string): string {
  return sep === '\\' ? p.replace(/\\/g, '/') : p;
}

/** 解析空间内路径：相对基于根展开，绝对路径直接用；越出根 → 403 */
function resolveInWs(root: string, input: string): string {
  const raw = input.trim();
  if (!raw) return root;
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ApiHttpError('forbidden', `路径越出工作空间: ${input}`);
  }
  return abs;
}

/** 同层条目排序：目录在前，同类按名称（忽略大小写） */
function cmpEntries(a: Dirent, b: Dirent): number {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/** 递归构建文件树；IO 失败的子目录留空不中断整树；symlink 非目录/普通文件一律跳过（防环） */
async function listNodes(
  dirAbs: string,
  dirRel: string,
  depth: number,
  hidden: boolean,
  budget: { count: number },
): Promise<FsNode[]> {
  if (depth > MAX_DEPTH) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: FsNode[] = [];
  for (const e of entries.filter((x) => (hidden || !x.name.startsWith('.')) && !ALWAYS_SKIP.has(x.name)).sort(cmpEntries)) {
    if (budget.count >= MAX_TREE_ENTRIES) break;
    budget.count++;
    const childRel = dirRel ? `${dirRel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push({
        name: e.name,
        path: childRel,
        type: 'dir',
        children: await listNodes(join(dirAbs, e.name), childRel, depth + 1, hidden, budget),
      });
    } else if (e.isFile()) {
      let size: number | undefined;
      try {
        size = (await stat(join(dirAbs, e.name))).size;
      } catch {
        // stat 失败：size 缺省，节点保留
      }
      out.push({ name: e.name, path: childRel, type: 'file', size });
    }
  }
  return out;
}

/** GET /fs/tree?hidden=1：工作空间文件树（dot 条目默认隐藏） */
async function handleTree(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const hidden = query.get('hidden') === '1';
  const root = ctx.deps.sessionStore.path;
  const budget = { count: 0 };
  const children = await listNodes(root, '', 1, hidden, budget);
  sendJson(res, 200, {
    root,
    name: basename(root),
    hidden,
    truncated: budget.count >= MAX_TREE_ENTRIES,
    children,
  });
}

/** GET /fs/file?path=：文本文件预览（utf-8；>512KB 截断；含 NUL 判二进制拒绝） */
async function handleFile(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const input = query.get('path')?.trim() ?? '';
  if (!input) throw new ApiHttpError('bad_request', '缺少 path 参数');
  const root = ctx.deps.sessionStore.path;
  const abs = resolveInWs(root, input);

  let size: number;
  try {
    const st = await stat(abs);
    if (st.isDirectory()) throw new ApiHttpError('not_found', `是目录不是文件: ${input}`);
    size = st.size;
  } catch (e) {
    if (e instanceof ApiHttpError) throw e;
    throw new ApiHttpError('not_found', `文件不存在: ${input}`);
  }

  const truncated = size > MAX_FILE_BYTES;
  const len = Math.min(size, MAX_FILE_BYTES);
  const fh = await open(abs, 'r');
  let buf: Buffer;
  try {
    buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
  } catch {
    throw new ApiHttpError('forbidden', `文件不可读: ${input}`);
  } finally {
    await fh.close();
  }
  if (buf.subarray(0, Math.min(len, BINARY_SNIFF_BYTES)).includes(0)) {
    throw new ApiHttpError('bad_request', `二进制文件不支持预览: ${input}`);
  }

  sendJson(res, 200, {
    path: toSlash(relative(root, abs)),
    name: basename(abs),
    bytes: size,
    truncated,
    content: buf.toString('utf-8'),
  });
}

/** 小写扩展名（无扩展名返回 ''） */
function extOf(p: string): string {
  const i = p.lastIndexOf('.');
  return i >= 0 ? p.slice(i + 1).toLowerCase() : '';
}

/** 纯文本 → markdown：每行一个段落（word-extractor 以 \n 分段且不区分软换行，逐行成段保留原视觉层次） */
function textToMd(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n\n');
}

/** GET /fs/doc2md?path=：旧版 .doc 提取文本并转 markdown（word-extractor；响应结构与 /fs/file 同构，超限按字符截断） */
async function handleDoc2Md(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const input = query.get('path')?.trim() ?? '';
  if (!input) throw new ApiHttpError('bad_request', '缺少 path 参数');
  const root = ctx.deps.sessionStore.path;
  const abs = resolveInWs(root, input);

  let size: number;
  try {
    const st = await stat(abs);
    if (st.isDirectory()) throw new ApiHttpError('not_found', `是目录不是文件: ${input}`);
    size = st.size;
  } catch (e) {
    if (e instanceof ApiHttpError) throw e;
    throw new ApiHttpError('not_found', `文件不存在: ${input}`);
  }

  let raw: string;
  try {
    const doc = await new WordExtractor().extract(abs);
    raw = doc.getBody();
  } catch {
    throw new ApiHttpError('bad_request', `doc 解析失败（文件损坏或不是 Word 97-2003 文档）: ${input}`);
  }

  const body = textToMd(raw);
  const truncated = body.length > MAX_FILE_BYTES;
  sendJson(res, 200, {
    path: toSlash(relative(root, abs)),
    name: basename(abs),
    bytes: size,
    truncated,
    content: truncated ? body.slice(0, MAX_FILE_BYTES) : body,
  });
}

/** GET /fs/raw?path=：文件原始字节输出（二进制文档预览用；超上限拒绝） */
async function handleRaw(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const input = query.get('path')?.trim() ?? '';
  if (!input) throw new ApiHttpError('bad_request', '缺少 path 参数');
  const root = ctx.deps.sessionStore.path;
  const abs = resolveInWs(root, input);

  try {
    const st = await stat(abs);
    if (st.isDirectory()) throw new ApiHttpError('not_found', `是目录不是文件: ${input}`);
    if (st.size > MAX_RAW_BYTES) {
      throw new ApiHttpError('payload_too_large', `文件超过 ${MAX_RAW_BYTES / 1048576} MB 上限: ${input}`);
    }
  } catch (e) {
    if (e instanceof ApiHttpError) throw e;
    throw new ApiHttpError('not_found', `文件不存在: ${input}`);
  }

  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch {
    throw new ApiHttpError('forbidden', `文件不可读: ${input}`);
  }
  res.writeHead(200, {
    'Content-Type': RAW_CONTENT_TYPES[extOf(abs)] ?? 'application/octet-stream',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

/** 递归扫描目录做关键词行匹配；命中上限即停；二进制/大文件跳过 */
async function scanFor(
  dirAbs: string,
  dirRel: string,
  hidden: boolean,
  needle: string,
  results: { path: string; name: string; line: number; text: string }[],
): Promise<void> {
  if (results.length >= MAX_SEARCH_RESULTS) return;
  let entries: Dirent[];
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  const filtered = entries.filter((x) => (hidden || !x.name.startsWith('.')) && !ALWAYS_SKIP.has(x.name));
  // 先扫本层文件再下钻目录，结果按目录层级就近呈现
  for (const e of filtered.filter((x) => x.isFile()).sort(cmpEntries)) {
    if (results.length >= MAX_SEARCH_RESULTS) return;
    const abs = join(dirAbs, e.name);
    let st;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    if (st.size === 0 || st.size > MAX_SEARCH_FILE_BYTES) continue;
    let buf: Buffer;
    try {
      buf = await readFile(abs);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue; // 二进制跳过
    const childRel = dirRel ? `${dirRel}/${e.name}` : e.name;
    const lines = buf.toString('utf-8').split(/\r?\n/);
    for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i++) {
      const idx = lines[i].toLowerCase().indexOf(needle);
      if (idx < 0) continue;
      const text = lines[i].trim();
      results.push({
        path: childRel,
        name: e.name,
        line: i + 1,
        // 命中行裁到 240 字符，命中词附近优先
        text: text.length > 240 ? text.slice(Math.max(0, idx - 60), idx + 180) : text,
      });
    }
  }
  for (const e of filtered.filter((x) => x.isDirectory()).sort(cmpEntries)) {
    if (results.length >= MAX_SEARCH_RESULTS) return;
    await scanFor(join(dirAbs, e.name), dirRel ? `${dirRel}/${e.name}` : e.name, hidden, needle, results);
  }
}

/** GET /fs/search?q=&hidden=1：工作空间全文搜索（大小写不敏感；dot 条目默认跳过） */
async function handleSearch(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const q = query.get('q')?.trim() ?? '';
  if (!q) throw new ApiHttpError('bad_request', '缺少 q 参数');
  const hidden = query.get('hidden') === '1';
  const root = ctx.deps.sessionStore.path;
  const results: { path: string; name: string; line: number; text: string }[] = [];
  await scanFor(root, '', hidden, q.toLowerCase(), results);
  sendJson(res, 200, { query: q, truncated: results.length >= MAX_SEARCH_RESULTS, results });
}

export function fsRoutes(): Route[] {
  return [
    { method: 'GET', path: '/fs/tree', handler: handleTree },
    { method: 'GET', path: '/fs/file', handler: handleFile },
    { method: 'GET', path: '/fs/raw', handler: handleRaw },
    { method: 'GET', path: '/fs/doc2md', handler: handleDoc2Md },
    { method: 'GET', path: '/fs/search', handler: handleSearch },
  ];
}
