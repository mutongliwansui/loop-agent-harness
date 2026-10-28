// 上传管理器（Task-20261012-001）
// 纯逻辑模块：参数跨平台归一 → 系统文件选择框（平台探测链）→ 复制到会话隔离上传目录
// 设计依据：docs/tasks/optimizations/task-20261012-001-文件上传（upload 会话隔离上传目录）.md
import { exec } from 'node:child_process';
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { MIME_BY_EXT } from '../tools/vision/image.js';

const execAsync = promisify(exec);

/** 单文件上传上限（内置常量，不入配置，D4） */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** 文件选择框超时（模态等待上限，防挂死） */
const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;

/** 全局上传根目录：~/.loop-agent/uploads */
export function defaultUploadsRoot(): string {
  return join(homedir(), '.loop-agent', 'uploads');
}

/** 单个上传文件记录 */
export interface UploadEntry {
  /** 源路径（原样回显，resolve 后） */
  originalPath: string;
  /** 上传后的绝对路径 */
  targetPath: string;
  /** 时间戳前缀后的文件名 */
  fileName: string;
  /** 字节数 */
  bytes: number;
  /** 上传时间（ISO） */
  uploadedAt: string;
}

/** 批量上传结果（单项失败不阻断其余） */
export interface UploadResult {
  succeeded: UploadEntry[];
  failed: { path: string; reason: string }[];
}

/** 文件选择框结果：paths 为空时 reason 说明原因（取消 or 环境不可用） */
export interface DialogPickResult {
  paths: string[];
  reason?: 'cancelled' | 'unavailable';
}

/**
 * file:// URI → 本地路径（跨平台手动归一，不依赖 fileURLToPath 的平台语义）：
 * - POSIX：file:///home/u/a%20b.png → /home/u/a b.png
 * - Windows：file:///D:/x/a%20b.png → D:/x/a b.png（正斜杠 Windows API 可直接使用）
 * - UNC：file://server/share/x → //server/share/x
 */
function fileUriToPath(uri: string): string {
  const u = new URL(uri);
  let p = decodeURIComponent(u.pathname);
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
  return p;
}

/**
 * 解析并归一上传参数为本地绝对路径候选数组（D5 跨平台）。
 * 兼容各终端拖拽格式：
 * - Windows Terminal：双引号段 `"D:\path\a b.png"`（多文件多段）
 * - GNOME Terminal 等：`file:///home/u/a%20b.png` URI（fileURLToPath 归一）
 * - Konsole：单引号段 `'D:\a b.png'` 与转义空格 `a\ b.png`
 * - 普通无引号路径
 */
export function parseUploadArgs(raw: string): string[] {
  const input = (raw ?? '').trim();
  if (!input) return [];
  const out: string[] = [];
  // 顺序：引号段优先（内部可含 file://），其次裸 file:// URI，最后裸 token（仅转义空白）
  const re = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|file:\/\/\S+|(?:\\[\s]|\S)+/g;
  for (const m of input.matchAll(re)) {
    const seg = m[0];
    let value: string;
    if (seg.length >= 2 && seg.startsWith('"') && seg.endsWith('"')) {
      value = seg.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
    } else if (seg.length >= 2 && seg.startsWith("'") && seg.endsWith("'")) {
      value = seg.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"');
    } else {
      // 裸 token：仅「反斜杠+空白」是转义；其余反斜杠保留（Windows 路径分隔符）
      value = seg.replace(/\\([\s])/g, '$1');
    }
    if (/^file:\/\//i.test(value)) {
      try {
        value = fileUriToPath(value);
      } catch {
        // 非法 URI 保留原文，交由上传校验报「文件不存在」
      }
    }
    if (value) out.push(value);
  }
  return out;
}

/**
 * 弹出系统文件选择框（D9 跨平台探测链，零 npm 依赖）：
 * - win32：powershell -NoProfile -STA + WinForms OpenFileDialog（Multiselect，UTF-8 输出）
 * - darwin：osascript choose file with multiple selections allowed
 * - Linux：zenity → kdialog → yad 依次 which 探测，命中即用
 * 取消 / 全部工具不可用 / 执行失败均不抛错，以 reason 区分。
 */
export async function pickFilesViaDialog(): Promise<DialogPickResult> {
  const platform = process.platform;
  if (platform === 'win32') {
    const ps =
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ` +
      `Add-Type -AssemblyName System.Windows.Forms; ` +
      `$d = New-Object System.Windows.Forms.OpenFileDialog; ` +
      `$d.Multiselect = $true; $d.Title = '选择要上传的文件'; ` +
      `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames }`;
    return runDialogCommand(`powershell -NoProfile -STA -Command "${ps}"`, 'line');
  }
  if (platform === 'darwin') {
    return runDialogCommand(
      `osascript -e 'POSIX path of (choose file with multiple selections allowed)'`,
      'line',
    );
  }
  // Linux 及其它 POSIX：按 zenity → kdialog → yad 探测
  if (await hasCommand('zenity')) {
    return runDialogCommand(
      `zenity --file-selection --multiple --separator='|' --title '选择要上传的文件'`,
      'pipe',
    );
  }
  if (await hasCommand('kdialog')) {
    return runDialogCommand(
      `kdialog --getopenfilename . --multiple --title '选择要上传的文件'`,
      'args',
    );
  }
  if (await hasCommand('yad')) {
    return runDialogCommand(`yad --file --multiple --separator='|' --title '选择要上传的文件'`, 'pipe');
  }
  return { paths: [], reason: 'unavailable' };
}

/** POSIX command -v 探测（Linux/macOS 弹框路径使用；Task-20261015-001 导出供 skill 目录选择框复用） */
export async function hasCommand(name: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`command -v ${name}`, { timeout: 5000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 执行弹框命令并归一输出。
 * - line：逐行一个路径（PowerShell FileNames / osascript POSIX path）
 * - pipe：'|' 分隔（zenity/yad --separator）
 * - args：整行按 shell 风格解析（kdialog 空格分隔带引号转义，复用 parseUploadArgs）
 * （Task-20261015-001 导出供 skill 目录选择框复用）
 */
export async function runDialogCommand(
  command: string,
  mode: 'line' | 'pipe' | 'args',
): Promise<DialogPickResult> {
  let stdout = '';
  let exitCode = 0;
  try {
    const r = await execAsync(command, {
      timeout: DIALOG_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = r.stdout ?? '';
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string };
    stdout = err.stdout ?? '';
    exitCode = typeof err.code === 'number' ? err.code : 1;
    // 非「用户取消」（zenity/yad 取消 = exit 1）一律视为环境不可用
    if (exitCode !== 1) return { paths: [], reason: 'unavailable' };
  }
  const text = stdout.trim();
  if (!text) return { paths: [], reason: 'cancelled' };
  let paths: string[];
  if (mode === 'args') {
    paths = parseUploadArgs(text);
  } else {
    const parts = mode === 'pipe' ? text.split('|') : text.split(/\r?\n/);
    paths = parts.map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return { paths };
}

/** 时间戳前缀：yyyymmdd-hhmmss */
function formatStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 字节数人性化 */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

/**
 * 批量复制文件到会话上传目录（D1/D3/D4）。
 * - sessionKey 为空 → 整体拒绝（无活动会话，无 default 回退）
 * - 目录 / 超限 / 不存在 → 该项 failed，其余继续
 * - 同秒同名 → 追加毫秒段；仍冲突 → 追加序号
 */
export async function copyToUploads(
  paths: string[],
  opts: { sessionKey: string; uploadsRoot?: string; now?: Date; maxBytes?: number },
): Promise<UploadResult> {
  const result: UploadResult = { succeeded: [], failed: [] };
  const root = opts.uploadsRoot ?? defaultUploadsRoot();
  const now = opts.now ?? new Date();
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  if (!opts.sessionKey) {
    for (const p of paths) result.failed.push({ path: p, reason: '当前无活动会话' });
    return result;
  }
  if (paths.length === 0) return result;

  const dir = join(root, opts.sessionKey);
  await mkdir(dir, { recursive: true });
  const existing = new Set(await readdir(dir));
  const stamp = formatStamp(now);

  for (const p of paths) {
    try {
      const abs = resolve(p);
      const st = await stat(abs);
      if (!st.isFile()) {
        result.failed.push({ path: p, reason: '仅支持文件（目录请压缩后上传）' });
        continue;
      }
      if (st.size > maxBytes) {
        result.failed.push({ path: p, reason: `超过单文件上限 ${formatBytes(maxBytes)}` });
        continue;
      }
      const base = basename(abs);
      let fileName = `${stamp}-${base}`;
      let seq = 0;
      while (existing.has(fileName)) {
        seq++;
        fileName = seq === 1
          ? `${stamp}-${now.getMilliseconds()}-${base}`
          : `${stamp}-${now.getMilliseconds()}-${seq}-${base}`;
      }
      existing.add(fileName);
      const target = join(dir, fileName);
      await copyFile(abs, target);
      result.succeeded.push({
        originalPath: abs,
        targetPath: target,
        fileName,
        bytes: st.size,
        uploadedAt: now.toISOString(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.failed.push({ path: p, reason: /ENOENT|ENOTDIR/i.test(msg) ? '文件不存在' : msg });
    }
  }
  return result;
}

/**
 * 写入单个原始字节文件到会话上传目录（WebUI 对话内上传，Task-20261017-001 §3.1b）。
 * 复用 copyToUploads 的落盘规则：时间戳前缀 / 同秒同名冲突链（毫秒段 → 序号）/ 大小上限。
 * 调用方需先归一 fileName 为纯文件名（本函数不再切路径段）；超限抛 Error。
 */
export async function writeUpload(
  fileName: string,
  bytes: Buffer,
  opts: { sessionKey: string; uploadsRoot?: string; now?: Date; maxBytes?: number },
): Promise<UploadEntry> {
  const root = opts.uploadsRoot ?? defaultUploadsRoot();
  const now = opts.now ?? new Date();
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  if (bytes.length > maxBytes) {
    throw new Error(`超过单文件上限 ${formatBytes(maxBytes)}`);
  }
  const dir = join(root, opts.sessionKey);
  await mkdir(dir, { recursive: true });
  const existing = new Set(await readdir(dir));
  const stamp = formatStamp(now);
  let name = `${stamp}-${fileName}`;
  let seq = 0;
  while (existing.has(name)) {
    seq++;
    name = seq === 1
      ? `${stamp}-${now.getMilliseconds()}-${fileName}`
      : `${stamp}-${now.getMilliseconds()}-${seq}-${fileName}`;
  }
  const target = join(dir, name);
  await writeFile(target, bytes);
  return {
    originalPath: '', // 原始字节上传无源路径（与 listUploads 的回显约定一致）
    targetPath: target,
    fileName: name,
    bytes: bytes.length,
    uploadedAt: now.toISOString(),
  };
}

/** 列出会话上传目录（目录不存在返回 []；uploadedAt 取 mtime） */
export async function listUploads(uploadsRoot: string, sessionKey: string): Promise<UploadEntry[]> {
  const dir = join(uploadsRoot, sessionKey);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const entries: UploadEntry[] = [];
  for (const fileName of names.sort()) {
    try {
      const st = await stat(join(dir, fileName));
      if (!st.isFile()) continue;
      entries.push({
        originalPath: '',
        targetPath: join(dir, fileName),
        fileName,
        bytes: st.size,
        uploadedAt: st.mtime.toISOString(),
      });
    } catch {
      // 并发删除等瞬时错误跳过
    }
  }
  return entries;
}

/** 清理单个会话上传目录，返回是否删除了内容（目录不存在/为空返回 false） */
export async function cleanUploads(uploadsRoot: string, sessionKey: string): Promise<boolean> {
  const dir = join(uploadsRoot, sessionKey);
  try {
    const names = await readdir(dir);
    if (names.length === 0) return false;
  } catch {
    return false;
  }
  await rm(dir, { recursive: true, force: true });
  return true;
}

/** 清理全部会话上传目录（/session delete-all 连带清理）：删除根目录并重建空目录 */
export async function cleanAllUploads(uploadsRoot: string): Promise<void> {
  await rm(uploadsRoot, { recursive: true, force: true });
  await mkdir(uploadsRoot, { recursive: true });
}

/** 生成注入 _chatHistory 的上下文消息（D2：Agent 感知上传文件）
 *  图片文件追加「类型」行（task-20261028-005 D11）：note 里只有文件名/路径/大小时，
 *  主模型看到 paste.png 并不知道这是能看的图，容易用 fileRead 读出二进制垃圾；
 *  显式标出 MIME 与可用视觉工具，才能把「贴图 → 问图」这条路走通。 */
export function buildContextNote(entry: UploadEntry): string {
  const lines = [
    `[文件上传] ${entry.fileName}`,
    `  上传路径: ${entry.targetPath}`,
    `  大小: ${formatBytes(entry.bytes)}`,
  ];
  const mime = MIME_BY_EXT[extname(entry.fileName).toLowerCase()];
  if (mime) {
    lines.push(`  类型: 图片 ${mime}（可用 ask_image / describe_image / extract_json / ocr_image 查看）`);
  }
  return lines.join('\n');
}
