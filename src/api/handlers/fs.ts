// 工作空间文件浏览器 API（原型-20261018-001）
//
// GET /fs/tree   → 工作空间文件树（递归；node_modules/__pycache__ 恒排除；dot 条目默认隐藏）
// GET /fs/tree?path= → 单个目录的直接子项（懒加载，无深度上限；Web UI 逐层展开用）
// GET /fs/file   → 单文件文本预览（within 工作空间校验；二进制拒绝；超长截断）
// GET /fs/raw    → 文件原始字节（pdf/docx/xlsx 等二进制文档与图片预览用；大小上限）
// GET /fs/doc2md → 旧版 .doc 文本提取并转 markdown（word-extractor + 段落启发式；前端复用 md 渲染）
// GET /fs/search → 关键词搜索（文件名 + 目录名 + 内容，两阶段名称优先；跳过二进制与大文件；结果上限）
// GET /fs/fingerprint?path=&path= → 已展开目录的变更指纹（前端轮询比对，只重拉变化目录）
//
// 根解析：?ws=<绝对路径> 显式指定已注册工作空间（文件面板跟随活跃会话所属空间）；
// 缺省回落 ctx.deps.sessionStore.path（启动空间）。请求 path 为空间内相对路径
// （兼容绝对路径，但必须位于根内，越界 403）；响应 path 字段统一 '/' 分隔，
// 前端原样回传即可，无平台差异。
//
// 写操作与下载（优化建议 20261021-005）：
// - DELETE /fs/entry?path=&recursive=1  删除文件/目录（根、.git、.loop-agent 受保护）
// - POST   /fs/rename {from,to}          同目录改名或跨目录移动（目标已存在 409）
// - POST   /fs/mkdir {path}              新建目录（父目录必须存在）
// - POST   /fs/upload?path=<目标目录>    X-File-Name / X-Relative-Path / X-Conflict 原始字节上传
// - GET    /fs/download?path=            文件附件下载；目录手写 zip（无第三方依赖）
// 所有写操作在 resolveInWs 词法校验之外再做 realpath 校验，防符号链接逃逸。

import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { HandlerContext, Route } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, readRawBody, sendJson } from '../http-utils.js';
import { MAX_UPLOAD_BYTES } from '../../upload/manager.js';
// D15：toSlash / resolveInWs 抽到工具层共享模块，本文件只保留调用（规则唯一真源）
import { resolveInWs, toSlash } from '../../tools/workspace-fs.js';
import { canonicalWorkspacePath, isSameWorkspace } from '../../session/path-utils.js';
import WordExtractor from 'word-extractor'; // CJS 包，类型见 src/types/word-extractor.d.ts

/** 恒排除的重目录（体积大且对代码浏览无价值；不随 hidden 开关出现） */
const ALWAYS_SKIP = new Set(['node_modules', '__pycache__']);
/** 树最大递归深度与总条目上限（仅 /fs/tree 递归模式；防御超大空间拖垮响应） */
const MAX_DEPTH = 8;
const MAX_TREE_ENTRIES = 4000;
/** 懒加载单层目录的条目上限（/fs/tree?path=） */
const MAX_LEVEL_ENTRIES = 2000;
/** 文件预览读取上限（超出截断并在响应标记） */
const MAX_FILE_BYTES = 512 * 1024;
/** 搜索跳过的单文件大小上限（与二进制探测配合） */
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
/** 搜索结果条数上限 */
const MAX_SEARCH_RESULTS = 200;
/** 单次指纹查询的目录数上限（前端按已展开目录批量轮询） */
const MAX_FINGERPRINT_PATHS = 200;
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

/** 写操作受保护路径段（任意层级命中即拒绝；.git/.loop-agent 为版本库与配置目录） */
const PROTECTED_SEGMENTS = new Set(['.git', '.loop-agent']);
/** 目录 zip 打包上限：条目数 / 解压后总字节（防超大空间拖垮进程与响应） */
const MAX_ZIP_ENTRIES = 2000;
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
/** 上传同名冲突策略 */
type ConflictPolicy = 'rename' | 'overwrite' | 'skip';

interface FsNode {
  name: string;
  /** 空间内相对路径，'/' 分隔 */
  path: string;
  type: 'dir' | 'file';
  size?: number;
  children?: FsNode[];
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

/** 懒加载：只列单层子项，不递归、无深度上限；条目过多时截断并标记 */
async function listChildren(
  dirAbs: string,
  dirRel: string,
  hidden: boolean,
): Promise<{ children: FsNode[]; truncated: boolean }> {
  let entries: Dirent[];
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return { children: [], truncated: false };
  }
  const filtered = entries
    .filter((x) => (hidden || !x.name.startsWith('.')) && !ALWAYS_SKIP.has(x.name))
    .sort(cmpEntries);
  const out: FsNode[] = [];
  for (const e of filtered) {
    if (out.length >= MAX_LEVEL_ENTRIES) break;
    const childRel = dirRel ? `${dirRel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push({ name: e.name, path: childRel, type: 'dir' });
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
  return { children: out, truncated: filtered.length > out.length };
}

/**
 * 解析文件面板根目录：?ws=<绝对路径> 指定必须为已注册工作空间（sessions 索引中存在），
 * 缺省回落启动空间。移除全局"当前空间"后，前端按活跃会话所属空间显式传 ws。
 */
async function resolveFsRoot(ctx: HandlerContext, query: URLSearchParams): Promise<string> {
  const ws = query.get('ws')?.trim();
  if (!ws) return ctx.defaultRoot();
  const target = await canonicalWorkspacePath(ws);
  const known = await ctx.deps.sessionStore.listAllWorkspaces();
  for (const w of known) {
    if (isSameWorkspace(await canonicalWorkspacePath(w.path), target)) return target;
  }
  throw new ApiHttpError('forbidden', `未知工作空间: ${ws}`);
}

/** GET /fs/tree?hidden=1：工作空间文件树（无 path 时整树递归；带 path 时只列该目录单层） */
async function handleTree(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const hidden = query.get('hidden') === '1';
  const root = await resolveFsRoot(ctx, query);

  if (query.has('path')) {
    const input = query.get('path')?.trim() ?? '';
    const dirAbs = resolveInWs(root, input);
    const st = await stat(dirAbs).catch(() => null);
    if (!st) throw new ApiHttpError('not_found', `目录不存在: ${input || '/'}`);
    if (!st.isDirectory()) throw new ApiHttpError('not_found', `不是目录: ${input}`);
    const dirRel = toSlash(relative(root, dirAbs));
    const { children, truncated } = await listChildren(dirAbs, dirRel, hidden);
    sendJson(res, 200, { root, name: basename(root), hidden, path: dirRel, truncated, children });
    return;
  }

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
  const root = await resolveFsRoot(ctx, query);
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
  const root = await resolveFsRoot(ctx, query);
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
  const root = await resolveFsRoot(ctx, query);
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

/**
 * 搜索命中项（20261028-004 引入 kind 字段）。
 * - kind='name'   文件名命中：line=0、text=''
 * - kind='dir'    目录名命中：line=0、text=''
 * - kind='content' 内容行命中：line 为 1-based 行号、text 为命中行
 * line=0 与真实行号不可能冲突，旧前端据此降级渲染不会错位。
 */
interface SearchHit {
  path: string;
  name: string;
  line: number;
  text: string;
  kind: 'content' | 'name' | 'dir';
}

/**
 * 阶段①：只 readdir 遍历，收集文件名与目录名命中（D1/D3）。
 * 不读文件内容，因此名称命中与文件大小/是否为二进制无关；命中上限即停。
 * 恒排除目录（node_modules 等）自身的名字也不参与匹配，且不下钻。
 */
async function scanNames(
  dirAbs: string,
  dirRel: string,
  hidden: boolean,
  needle: string,
  results: SearchHit[],
): Promise<void> {
  if (results.length >= MAX_SEARCH_RESULTS) return;
  let entries: Dirent[];
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  const filtered = entries.filter((x) => (hidden || !x.name.startsWith('.')) && !ALWAYS_SKIP.has(x.name));
  // 与内容阶段保持同一呈现序：先本层文件，再下钻目录
  for (const e of filtered.filter((x) => x.isFile()).sort(cmpEntries)) {
    if (results.length >= MAX_SEARCH_RESULTS) return;
    if (!e.name.toLowerCase().includes(needle)) continue;
    results.push({
      path: dirRel ? `${dirRel}/${e.name}` : e.name,
      name: e.name,
      line: 0,
      text: '',
      kind: 'name',
    });
  }
  for (const e of filtered.filter((x) => x.isDirectory()).sort(cmpEntries)) {
    if (results.length >= MAX_SEARCH_RESULTS) return;
    const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
    if (e.name.toLowerCase().includes(needle)) {
      // D5：目录命中只产出目录自身，其下文件由树承担浏览职责（仍继续下钻找更深的名字命中）
      results.push({ path: rel, name: e.name, line: 0, text: '', kind: 'dir' });
    }
    await scanNames(join(dirAbs, e.name), rel, hidden, needle, results);
  }
}

/** 阶段②：递归扫描目录做关键词行匹配；命中上限即停；二进制/大文件跳过 */
async function scanContents(
  dirAbs: string,
  dirRel: string,
  hidden: boolean,
  needle: string,
  results: SearchHit[],
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
        kind: 'content',
      });
    }
  }
  for (const e of filtered.filter((x) => x.isDirectory()).sort(cmpEntries)) {
    if (results.length >= MAX_SEARCH_RESULTS) return;
    await scanContents(join(dirAbs, e.name), dirRel ? `${dirRel}/${e.name}` : e.name, hidden, needle, results);
  }
}

/**
 * 搜索编排（D3）：名称阶段先跑并优先占位，内容阶段在剩余额度内继续。
 * 两阶段以「多跑一遍 readdir」换取「名称命中必有位置」——readdir 远比 readFile 便宜，
 * 若合成单次深度优先遍历，深层名称命中会被浅层内容命中挤出 200 条上限。
 * D4：已在名称阶段命中的文件，内容阶段仍照常扫描其内容（两处信息都保留）。
 */
async function searchWorkspace(root: string, hidden: boolean, q: string): Promise<SearchHit[]> {
  const results: SearchHit[] = [];
  const needle = q.toLowerCase();
  await scanNames(root, '', hidden, needle, results);
  await scanContents(root, '', hidden, needle, results);
  return results;
}

/** GET /fs/search?q=&hidden=1：工作空间搜索（文件名 / 目录名 / 内容；大小写不敏感；dot 条目默认跳过） */
async function handleSearch(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const q = query.get('q')?.trim() ?? '';
  if (!q) throw new ApiHttpError('bad_request', '缺少 q 参数');
  const hidden = query.get('hidden') === '1';
  const root = await resolveFsRoot(ctx, query);
  const results = await searchWorkspace(root, hidden, q);
  sendJson(res, 200, { query: q, truncated: results.length >= MAX_SEARCH_RESULTS, results });
}

/**
 * 计算单目录指纹：条目「类型 + 名称 + 大小 + mtime」的组合哈希。
 * 目录条目只取名称（其内部变更由该目录自身的指纹覆盖），文件条目带上 size/mtime，
 * 便于前端识别新增/删除/重命名/改写。目录不存在或不是目录 → null。恒排除项不参与。
 */
async function fingerprintDir(dirAbs: string): Promise<string | null> {
  let entries: Dirent[];
  try {
    const st = await stat(dirAbs);
    if (!st.isDirectory()) return null;
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return null;
  }
  const rows: string[] = [];
  for (const e of entries.filter((x) => !ALWAYS_SKIP.has(x.name)).sort(cmpEntries)) {
    if (rows.length >= MAX_LEVEL_ENTRIES) break;
    let meta = '';
    if (e.isFile()) {
      try {
        const st = await stat(join(dirAbs, e.name));
        meta = `${st.size}:${Math.floor(st.mtimeMs)}`;
      } catch {
        meta = '?'; // stat 失败：条目仍在，指纹保持稳定
      }
      rows.push(`f:${e.name}:${meta}`);
    } else if (e.isDirectory()) {
      rows.push(`d:${e.name}`);
    }
    // symlink 等非常规条目与 listChildren 保持一致：不参与
  }
  return createHash('sha1').update(rows.join('\n')).digest('hex');
}

/** GET /fs/fingerprint?path=&path=：批量返回已展开目录的指纹（前端轮询比对，只重拉变化目录） */
async function handleFingerprint(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const inputs = query.getAll('path');
  if (inputs.length === 0) throw new ApiHttpError('bad_request', '缺少 path 参数');
  if (inputs.length > MAX_FINGERPRINT_PATHS) {
    throw new ApiHttpError('bad_request', `path 数量超过 ${MAX_FINGERPRINT_PATHS} 上限`);
  }
  const root = await resolveFsRoot(ctx, query);
  const dirs = await Promise.all(
    inputs.map(async (raw) => {
      const input = raw.trim();
      const abs = resolveInWs(root, input); // 越界直接 403，不降级为 null
      return { path: toSlash(relative(root, abs)), sig: await fingerprintDir(abs) };
    }),
  );
  sendJson(res, 200, { root, dirs });
}

/* ================= 写操作与下载（优化建议 20261021-005） ================= */

/** 拒绝受保护路径段（大小写不敏感，Windows 下 .GIT 同样命中） */
function assertMutable(rel: string, input: string): void {
  for (const seg of rel.split('/')) {
    if (PROTECTED_SEGMENTS.has(seg.toLowerCase())) {
      throw new ApiHttpError('forbidden', `受保护路径不可修改: ${input || seg}`);
    }
  }
}

/** candidate 是否位于 realRoot 内（win32 大小写不敏感由 path.relative 保证） */
function insideRealRoot(realRoot: string, candidate: string): boolean {
  if (candidate === realRoot) return true;
  const rel = relative(realRoot, candidate);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 符号链接逃逸校验：沿路径向上找到最深的存在节点做 realpath，要求位于根的真实路径内。
 * followLeaf=false 用于删除/移动符号链接本身（链接指向外部也允许操作链接）；
 * true 用于读取/写入目标（链接指向外部必须拒绝）。
 * 20261028-006：/uploads/view 复用（导出），语义不变。
 */
export async function assertRealInside(root: string, abs: string, followLeaf: boolean): Promise<void> {
  const realRoot = await realpath(root).catch(() => root);
  let cur = followLeaf ? abs : dirname(abs);
  for (;;) {
    const rp = await realpath(cur).catch(() => null);
    if (rp) {
      if (!insideRealRoot(realRoot, rp)) {
        throw new ApiHttpError('forbidden', `符号链接指向工作空间外: ${toSlash(relative(root, abs))}`);
      }
      return;
    }
    const up = dirname(cur);
    if (up === cur) return; // 已到根仍不存在：交给后续存在性检查
    cur = up;
  }
}

/** lstat 封装：不存在返回 null（其余错误继续抛） */
async function lstatOrNull(abs: string) {
  try {
    return await lstat(abs);
  } catch {
    return null;
  }
}

/** 同名冲突自动改名：`name (1).ext`、`name (2).ext`… */
async function uniquePath(abs: string): Promise<string> {
  const dir = dirname(abs);
  const name = basename(abs);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i <= 9999; i++) {
    const candidate = join(dir, `${stem} (${i})${ext}`);
    if (!(await lstatOrNull(candidate))) return candidate;
  }
  throw new ApiHttpError('conflict', `同名文件过多: ${name}`);
}

/** DELETE /fs/entry?path=&recursive=1：删除文件/目录（目录必须显式 recursive） */
async function handleDeleteEntry(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const input = query.get('path')?.trim() ?? '';
  const root = await resolveFsRoot(ctx, query);
  const abs = resolveInWs(root, input);
  const rel = toSlash(relative(root, abs));
  if (!rel) throw new ApiHttpError('forbidden', '不允许删除工作空间根目录');
  assertMutable(rel, input);

  const st = await lstatOrNull(abs);
  if (!st) throw new ApiHttpError('not_found', `路径不存在: ${input}`);
  const isDir = st.isDirectory();
  if (isDir && query.get('recursive') !== '1') {
    throw new ApiHttpError('bad_request', '删除目录需显式传 recursive=1');
  }
  await assertRealInside(root, abs, false);

  try {
    if (isDir) await rm(abs, { recursive: true });
    else await unlink(abs); // 符号链接只删链接本身
  } catch (e) {
    throw new ApiHttpError('forbidden', `删除失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  ctx.log(`[api] 删除 ${rel}${isDir ? '（目录）' : ''}`);
  sendJson(res, 200, { path: rel, type: isDir ? 'dir' : 'file' });
}

/** POST /fs/rename {from,to}：同目录改名或跨目录移动；目标已存在 409 */
async function handleRename(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const body = await readJsonBody(req);
  const fromInput = typeof body.from === 'string' ? body.from.trim() : '';
  const toInput = typeof body.to === 'string' ? body.to.trim() : '';
  if (!fromInput || !toInput) throw new ApiHttpError('bad_request', 'from/to 必填');

  const root = await resolveFsRoot(ctx, query);
  const fromAbs = resolveInWs(root, fromInput);
  const toAbs = resolveInWs(root, toInput);
  const fromRel = toSlash(relative(root, fromAbs));
  const toRel = toSlash(relative(root, toAbs));
  if (!fromRel || !toRel) throw new ApiHttpError('forbidden', '不允许移动工作空间根目录');
  assertMutable(fromRel, fromInput);
  assertMutable(toRel, toInput);

  const st = await lstatOrNull(fromAbs);
  if (!st) throw new ApiHttpError('not_found', `源路径不存在: ${fromInput}`);
  if (await lstatOrNull(toAbs)) throw new ApiHttpError('conflict', `目标已存在: ${toInput}`);
  const parent = await stat(dirname(toAbs)).catch(() => null);
  if (!parent || !parent.isDirectory()) {
    throw new ApiHttpError('not_found', `目标父目录不存在: ${toInput}`);
  }
  await assertRealInside(root, fromAbs, false);
  await assertRealInside(root, toAbs, true);

  try {
    await rename(fromAbs, toAbs);
  } catch (e) {
    throw new ApiHttpError('bad_request', `重命名失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  ctx.log(`[api] 重命名 ${fromRel} → ${toRel}`);
  sendJson(res, 200, { from: fromRel, to: toRel, type: st.isDirectory() ? 'dir' : 'file' });
}

/** POST /fs/mkdir {path}：新建单层目录（父目录必须存在） */
async function handleMkdir(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const body = await readJsonBody(req);
  const input = typeof body.path === 'string' ? body.path.trim() : '';
  if (!input) throw new ApiHttpError('bad_request', 'path 必填');
  const root = await resolveFsRoot(ctx, query);
  const abs = resolveInWs(root, input);
  const rel = toSlash(relative(root, abs));
  if (!rel) throw new ApiHttpError('bad_request', '不允许以工作空间根目录作为新建目录');
  assertMutable(rel, input);

  const parent = await stat(dirname(abs)).catch(() => null);
  if (!parent || !parent.isDirectory()) {
    throw new ApiHttpError('not_found', `父目录不存在: ${input}`);
  }
  if (await lstatOrNull(abs)) throw new ApiHttpError('conflict', `路径已存在: ${input}`);
  await assertRealInside(root, abs, true);
  try {
    await mkdir(abs); // 非递归：父目录缺失已在上方 404
  } catch (e) {
    throw new ApiHttpError('bad_request', `新建目录失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  ctx.log(`[api] 新建目录 ${rel}`);
  sendJson(res, 201, { path: rel, type: 'dir' });
}

/** 目录上传的相对路径归一：拒绝绝对路径/盘符/`..`/受保护段 */
function normalizeUploadRelPath(raw: string, fallback: string): string {
  const cleaned = raw.replace(/\\/g, '/');
  if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned)) {
    throw new ApiHttpError('bad_request', 'X-Relative-Path 不能是绝对路径');
  }
  const segs = cleaned.split('/').filter((s) => s && s !== '.');
  if (segs.length === 0) return fallback;
  if (segs.some((s) => s === '..')) {
    throw new ApiHttpError('bad_request', 'X-Relative-Path 不能包含 ..');
  }
  if (segs.some((s) => PROTECTED_SEGMENTS.has(s.toLowerCase()))) {
    throw new ApiHttpError('forbidden', `受保护路径不可写入: ${raw}`);
  }
  return segs.join('/');
}

/** POST /fs/upload?path=<目标目录>：原始字节上传（X-File-Name / X-Relative-Path / X-Conflict） */
async function handleUploadFile(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const root = await resolveFsRoot(ctx, query);
  const dirInput = query.get('path')?.trim() ?? '';
  const dirAbs = resolveInWs(root, dirInput);
  const dirRel = toSlash(relative(root, dirAbs));
  assertMutable(dirRel, dirInput);
  const dst = await stat(dirAbs).catch(() => null);
  if (!dst || !dst.isDirectory()) throw new ApiHttpError('not_found', `目标目录不存在: ${dirInput || '/'}`);
  await assertRealInside(root, dirAbs, true);

  const encoded = req.headers['x-file-name'];
  if (typeof encoded !== 'string' || !encoded.trim()) {
    throw new ApiHttpError('bad_request', '缺少 X-File-Name 请求头（encodeURIComponent 后的文件名）');
  }
  let fileName: string;
  try {
    fileName = decodeURIComponent(encoded);
  } catch {
    throw new ApiHttpError('bad_request', 'X-File-Name 不是合法的 encodeURIComponent 编码');
  }
  fileName = fileName.split(/[\\/]/).pop() ?? ''; // 防路径穿越：仅保留末段纯文件名
  if (!fileName || fileName === '.' || fileName === '..') {
    throw new ApiHttpError('bad_request', '文件名非法');
  }
  if (Buffer.byteLength(fileName, 'utf8') > 200) {
    throw new ApiHttpError('bad_request', '文件名过长（>200 字节）');
  }

  const relHeader = req.headers['x-relative-path'];
  let relPath = fileName;
  if (typeof relHeader === 'string' && relHeader.trim()) {
    try {
      relPath = normalizeUploadRelPath(decodeURIComponent(relHeader), fileName);
    } catch (e) {
      if (e instanceof ApiHttpError) throw e;
      throw new ApiHttpError('bad_request', 'X-Relative-Path 不是合法的 encodeURIComponent 编码');
    }
  }
  const targetRel = dirRel ? `${dirRel}/${relPath}` : relPath;
  assertMutable(targetRel, targetRel);

  const rawPolicy = String(req.headers['x-conflict'] ?? 'rename').toLowerCase();
  if (rawPolicy !== 'rename' && rawPolicy !== 'overwrite' && rawPolicy !== 'skip') {
    throw new ApiHttpError('bad_request', `X-Conflict 仅支持 rename/overwrite/skip: ${rawPolicy}`);
  }
  const policy = rawPolicy as ConflictPolicy;

  let bytes: Buffer;
  try {
    bytes = await readRawBody(req, MAX_UPLOAD_BYTES);
  } catch (e) {
    if (e instanceof ApiHttpError && e.code === 'payload_too_large') {
      throw new ApiHttpError('payload_too_large', `超过单文件上限 ${MAX_UPLOAD_BYTES / 1048576} MB`);
    }
    throw e;
  }

  let finalAbs = resolveInWs(root, targetRel);
  let skipped = false;
  const existing = await lstatOrNull(finalAbs);
  if (existing) {
    if (existing.isDirectory()) throw new ApiHttpError('conflict', `目标位置已存在同名目录: ${targetRel}`);
    if (policy === 'skip') skipped = true;
    else if (policy === 'rename') finalAbs = await uniquePath(finalAbs);
    // overwrite：直接覆盖
  }

  if (!skipped) {
    await assertRealInside(root, finalAbs, true);
    await mkdir(dirname(finalAbs), { recursive: true }); // 目录上传的嵌套相对路径
    try {
      await writeFile(finalAbs, bytes);
    } catch (e) {
      throw new ApiHttpError('forbidden', `写入失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const savedRel = toSlash(relative(root, finalAbs));
  ctx.log(`[api] 上传 ${savedRel}（${bytes.length} 字节${skipped ? '，已跳过同名' : ''}）`);
  sendJson(res, skipped ? 200 : 201, { path: savedRel, bytes: bytes.length, skipped });
}

/* ---- zip 打包（store 不压缩；无第三方依赖） ---- */

/** CRC32 查表 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** mtime → DOS 时间/日期（ZIP 精度 2 秒；1980 年前收敛到 1980-01-01） */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface ZipEntry {
  /** zip 内路径（目录以 '/' 结尾） */
  name: string;
  abs: string;
  dir: boolean;
  size: number;
  mtime: Date;
}

/** 递归收集 zip 条目：跳过 ALWAYS_SKIP 与符号链接；条目/总字节超限 → 413 */
async function collectZipEntries(
  dirAbs: string,
  prefix: string,
  out: ZipEntry[],
  budget: { bytes: number },
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.filter((x) => !ALWAYS_SKIP.has(x.name)).sort(cmpEntries)) {
    if (e.isSymbolicLink()) continue; // 不跟随链接（防环 / 防逃逸）
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    let st;
    try {
      st = await lstat(join(dirAbs, e.name));
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (out.length >= MAX_ZIP_ENTRIES) {
        throw new ApiHttpError('payload_too_large', `目录条目超过 ${MAX_ZIP_ENTRIES} 上限`);
      }
      out.push({ name: `${rel}/`, abs: join(dirAbs, e.name), dir: true, size: 0, mtime: st.mtime });
      await collectZipEntries(join(dirAbs, e.name), rel, out, budget);
    } else if (st.isFile()) {
      if (out.length >= MAX_ZIP_ENTRIES) {
        throw new ApiHttpError('payload_too_large', `目录条目超过 ${MAX_ZIP_ENTRIES} 上限`);
      }
      budget.bytes += st.size;
      if (budget.bytes > MAX_ZIP_BYTES) {
        throw new ApiHttpError('payload_too_large', `目录总大小超过 ${MAX_ZIP_BYTES / 1048576} MB 上限`);
      }
      out.push({ name: rel, abs: join(dirAbs, e.name), dir: false, size: st.size, mtime: st.mtime });
    }
  }
}

/** 写响应块并尊重背压（客户端断开时 resolve，由后续 write 自行失败） */
function writeChunk(res: ServerResponse, chunk: Buffer): Promise<void> {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

/** 流式写出 zip：逐个条目写本地头 + 数据，最后写中央目录与 EOCD */
async function writeZip(
  res: ServerResponse,
  entries: ZipEntry[],
  ctx: HandlerContext,
): Promise<void> {
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const { time, date } = dosDateTime(e.mtime);
    let data = Buffer.alloc(0);
    if (!e.dir) {
      try {
        data = await readFile(e.abs);
      } catch (err) {
        // 已开始写响应：无法再改状态码，直接断开让客户端感知失败
        ctx.log(`[api] zip 读取失败 ${e.name}: ${err instanceof Error ? err.message : String(err)}`);
        res.destroy();
        return;
      }
    }
    const crc = e.dir ? 0 : crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // bit 11：UTF-8 文件名
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    await writeChunk(res, local);
    await writeChunk(res, nameBuf);
    if (data.length) await writeChunk(res, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(e.dir ? 0x10 : 0, 38); // 目录属性位
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  await writeChunk(res, cdBuf);
  res.end(eocd);
}

/** RFC5987 Content-Disposition：ASCII 回退 + UTF-8 文件名 */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** GET /fs/download?path=：文件附件下载；目录 zip 打包（保留相对层级） */
async function handleDownload(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const input = query.get('path')?.trim() ?? '';
  const root = await resolveFsRoot(ctx, query);
  const abs = resolveInWs(root, input);
  const rel = toSlash(relative(root, abs));
  assertMutable(rel, input);

  const st = await stat(abs).catch(() => null);
  if (!st) throw new ApiHttpError('not_found', `路径不存在: ${input || '/'}`);
  await assertRealInside(root, abs, true);

  if (!st.isDirectory()) {
    if (st.size > MAX_RAW_BYTES) {
      throw new ApiHttpError('payload_too_large', `文件超过 ${MAX_RAW_BYTES / 1048576} MB 上限: ${input}`);
    }
    const buf = await readFile(abs).catch(() => {
      throw new ApiHttpError('forbidden', `文件不可读: ${input}`);
    });
    res.writeHead(200, {
      'Content-Type': RAW_CONTENT_TYPES[extOf(abs)] ?? 'application/octet-stream',
      'Content-Length': buf.length,
      'Content-Disposition': contentDisposition(basename(abs)),
    });
    res.end(buf);
    return;
  }

  const entries: ZipEntry[] = [];
  const budget = { bytes: 0 };
  await collectZipEntries(abs, '', entries, budget);
  const name = `${rel ? basename(abs) : basename(root)}.zip`;
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDisposition(name),
  });
  ctx.log(`[api] 下载目录 ${rel || '/'} → ${name}（${entries.length} 条目，${budget.bytes} 字节）`);
  await writeZip(res, entries, ctx);
}

export function fsRoutes(): Route[] {
  return [
    { method: 'GET', path: '/fs/tree', handler: handleTree },
    { method: 'GET', path: '/fs/file', handler: handleFile },
    { method: 'GET', path: '/fs/raw', handler: handleRaw },
    { method: 'GET', path: '/fs/doc2md', handler: handleDoc2Md },
    { method: 'GET', path: '/fs/search', handler: handleSearch },
    { method: 'GET', path: '/fs/fingerprint', handler: handleFingerprint },
    // 写操作与下载（优化建议 20261021-005）
    { method: 'DELETE', path: '/fs/entry', handler: handleDeleteEntry },
    { method: 'POST', path: '/fs/rename', handler: handleRename },
    { method: 'POST', path: '/fs/mkdir', handler: handleMkdir },
    { method: 'POST', path: '/fs/upload', handler: handleUploadFile },
    { method: 'GET', path: '/fs/download', handler: handleDownload },
  ];
}
