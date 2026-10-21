// 工作空间路径规范化（Task-20261021-010-01 D2 / L2）
//
// 背景：`workspaceId(cwd) = sha256(原始串).slice(0,16)`，不做任何归一化——
// 于是 'D:\proj'、'D:\proj\'、'd:\PROJ' 会得到三个不同 id（三份会话目录）。
// 本模块把「同一物理目录的各种书写形式」收敛为同一字符串，作为 registry 的键与
// SessionStore / ConfigLoader 的根；**公式本身不动**（D2：存量目录零迁移）。
//
// 归一化顺序：'D:' 特例 → resolve 绝对化 → 去尾分隔符 → win32 取磁盘真实大小写（失败回退）
// 不做大小写折叠：折叠会改变 workspaceId，破坏存量会话可见性（验收 A5 的零迁移前提）。

import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const isWin = process.platform === 'win32';

/** 盘根书写形式：'D:' 或 'D:\'（Windows） */
const DRIVE_ROOT_RE = /^([A-Za-z]:)\\?$/;

/** 去尾分隔符，保留盘根 'D:\' 与 POSIX 根 '/' */
function stripTrailingSep(p: string): string {
  let s = p;
  while (s.length > 1 && s.endsWith(sep)) {
    // 盘根 'D:\' 若继续剥离会退化成 'D:'（相对路径语义），必须保留
    if (isWin && DRIVE_ROOT_RE.test(s)) break;
    s = s.slice(0, -1);
  }
  return s;
}

/**
 * 词法归一（同步、无 IO）：`'D:'` / `'D:\'` → `'D:\'`；其余 `resolve()` 绝对化并去尾分隔符。
 *
 * 用于「展示型」路径（如 `/fs/dirs` 的 path/parent 回显）——保持与改造前完全一致的取值，
 * 不取磁盘真实大小写。需要作为空间身份键时用 `canonicalWorkspacePath`。
 */
export function lexicalWorkspacePath(input: string): string {
  const raw = (input ?? '').trim();
  const drive = raw.match(DRIVE_ROOT_RE);
  if (drive) return `${drive[1].toUpperCase()}\\`;
  return stripTrailingSep(resolve(raw));
}

/**
 * 空间路径规范化（异步：win32 需 realpath 取磁盘真实大小写）。
 *
 * - `'D:'` / `'D:\'` → `'D:\'`（沿用原 sessions.ts `normalizeDirPath` 的盘符特例，L2）
 * - 其余：`resolve()` 绝对化（相对路径基于服务端 cwd，与原语义一致）后去尾分隔符
 * - win32：`realpath()` 取真实大小写；目录尚未创建等失败场景回退词法结果
 *
 * 注意：**不做大小写折叠**，也不改 `workspaceId()` 公式（D2）。
 */
export async function canonicalWorkspacePath(input: string): Promise<string> {
  const lexical = lexicalWorkspacePath(input);
  if (!isWin) return lexical;

  try {
    return stripTrailingSep(await realpath(lexical));
  } catch {
    // 目录可能尚未创建（新建会话选择新目录）：回退词法绝对路径
    return lexical;
  }
}

/**
 * 词法比较两路径是否同一工作空间（**不做 IO**）。
 *
 * win32：大小写与分隔符不敏感；POSIX：严格相等。
 * 用于"请求路径是否已是当前空间"这类快速判定；需要收敛到同一键时用 `canonicalWorkspacePath`。
 */
export function isSameWorkspace(a: string, b: string): boolean {
  if (a === b) return true;
  if (!isWin) return false;
  const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return norm(a) === norm(b);
}
