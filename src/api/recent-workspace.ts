// 最近使用工作空间（需求 20261027-004 D2/D3）
//
// 背景：serve 启动不再以 process.cwd() 为「缺省空间」，缺省空间语义改为「最近使用空间」：
// - 冷启动：扫 <userDir>/sessions/*/，recency = 目录树内最新 mtime（会话写入必改 mtime），
//   经 meta.json 的 workspacePath 映射回真实路径（canonical 化）。
// - 运行期：进程内 MRU 指针（模块级），touch 点收口两处（resolveWorkspaceRuntime 成功路径 /
//   handleMessage locateSession 成功路径），用户可感知的活动即刷新。
// - 兜底：无任何可用会话目录 / 映射缺失 / canonical 失败 → 回落启动期注入的 cwd 兜底
//   （setCwdFallback，由入口 index.ts 注入；A4 白名单收口，本模块零 process.cwd()）。
//   canonicalWorkspacePath 对不存在路径回退词法值不抛错，永不失败。
//
// 为什么不用会话 meta.json 的 updatedAt：需要 JSON.parse 全部目录（本机 ~180 空间），
// stat mtime 成本低一个量级；recency 粒度对「最近使用」语义足够。

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalWorkspacePath } from '../session/path-utils.js';
import { debug } from '../debug.js';
import { loopAgentHome } from '../user-home.js';

/** 最近使用空间指针（模块级：进程内唯一事实源；defaultRoot() 同步读） */
let mruRoot = '';
/** cwd 兜底（A4：本模块不直接依赖 process.cwd()，由 cli/start.ts 启动期注入一次） */
let cwdFallback = '';

/** 注入 cwd 兜底值（A4 白名单收口：仅 cli/start.ts 等白名单文件调用） */
export function setCwdFallback(root: string): void {
  cwdFallback = root;
}

/** 记录一次空间活动（本模块不做 canonical 化，调用方传 canonical root） */
export function markWorkspaceUsed(root: string): void {
  if (root) mruRoot = root;
}

/** 读缺省空间（进程启动后恒有值：指针为空时回落注入的 cwd 兜底；未注入为空串=未初始化） */
export function defaultRoot(): string {
  return mruRoot || cwdFallback;
}

/** 读当前指针（可空：供 server 闭包回落 deps.sessionStore.path，保持单测/嵌入旧行为） */
export function currentWorkspaceRoot(): string {
  return mruRoot;
}

/**
 * 冷启动推导「最近使用空间」。
 *
 * @param userDir 会话/记忆根目录（默认 ~/.loop-agent；单测注入临时目录）
 * @returns canonical 空间根（推导成功）或 canonical(cwd)（无任何可用映射时）；绝不抛错
 */
export async function resolveRecentRoot(userDir?: string): Promise<string> {
  const base = userDir ?? loopAgentHome();
  const sessionsDir = join(base, 'sessions');
  let dirs: string[];
  try {
    dirs = (await readdir(sessionsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => join(sessionsDir, d.name));
  } catch {
    return await canonicalWorkspacePath(cwdFallbackValue());
  }
  let best: { root: string; mtimeMs: number } | null = null;
  for (const dir of dirs) {
    const mtimeMs = await latestMtimeMs(dir);
    if (mtimeMs === null) continue;
    const root = await rootOfWsDir(dir);
    if (!root) continue; // 孤儿空间（meta 缺失/损坏/path 为空）：跳过
    if (!best || mtimeMs > best.mtimeMs) best = { root, mtimeMs };
  }
  if (best) {
    debug.log(`[recent] 冷启动缺省空间（最近使用）: ${best.root}`);
    return best.root;
  }
  return await canonicalWorkspacePath(cwdFallbackValue());
}

/** cwd 兜底读值（setCwdFallback 未注入时为空串——由调用方持有兜底语义） */
function cwdFallbackValue(): string {
  return cwdFallback;
}

/** 目录树内最新 mtime（目录自身 + 一层子项 + 二层子文件；全部失败 → null） */
async function latestMtimeMs(dir: string): Promise<number | null> {
  try {
    let max = (await stat(dir)).mtimeMs;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return max;
    }
    for (const e of entries) {
      const child = join(dir, e.name);
      try {
        max = Math.max(max, (await stat(child)).mtimeMs);
      } catch {
        continue; // 单个子项 stat 失败：跳过
      }
      if (!e.isDirectory()) continue;
      // 二层（会话文件常在 <wsId>/<sessionId>.json 一层，runs/meta 再深一层不追）
      let files: string[];
      try {
        files = await readdir(child);
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          max = Math.max(max, (await stat(join(child, f))).mtimeMs);
        } catch {
          // 单文件失败跳过
        }
      }
    }
    return max;
  } catch {
    return null;
  }
}

/**
 * ws 存储目录 → 真实空间根：读 meta.json 的 workspacePath（缺失/损坏 → null，跳过该目录）。
 * 注意：不能拿 <userDir>/sessions/<wsId> 目录本身当 root——它是存储目录，不是工作空间。
 */
async function rootOfWsDir(dir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(dir, 'meta.json'), 'utf-8');
    const meta = JSON.parse(raw) as { workspacePath?: string };
    if (!meta.workspacePath) return null;
    return await canonicalWorkspacePath(meta.workspacePath);
  } catch {
    return null;
  }
}
