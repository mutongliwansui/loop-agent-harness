// 最近使用工作空间（需求 20261027-004 D2/D3）
//
// 背景：serve 启动不再以 process.cwd() 为「缺省空间」，缺省空间语义改为「最近使用空间」：
// - 冷启动：扫 <userDir>/sessions/*/，recency = 目录树内最新 mtime（会话写入必改 mtime），
//   经 meta.json 的 workspacePath 映射回真实路径（canonical 化）。
// - 运行期：进程内 MRU 指针（模块级），touch 点收口两处（resolveWorkspaceRuntime 成功路径 /
//   handleMessage locateSession 成功路径），用户可感知的活动即刷新。
// - 兜底：无任何可用会话目录 / 映射缺失 / canonical 失败 → 回落 os.homedir()。
//   canonicalWorkspacePath 对不存在路径回退词法值不抛错，永不失败。
//
// 需求 20261113-001 D9：原「cwd 兜底」机制整条退场（注入函数与「缺省空间」同步读取函数一并删除）。
// 它唯一用途是给那个已删函数提供兜底值，而它的消费者已按 D2/D3/D4/D5 全部清零；
// 兜底改用 homedir()——它是真实存在的绝对目录，语义上比「进程启动目录」更贴近「用户当前所在」。
//
// 为什么不用会话 meta.json 的 updatedAt：需要 JSON.parse 全部目录（本机 ~180 空间），
// stat mtime 成本低一个量级；recency 粒度对「最近使用」语义足够。

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { canonicalWorkspacePath } from '../session/path-utils.js';
import { debug } from '../debug.js';
import { loopAgentHome } from '../user-home.js';

/** 最近使用空间指针（模块级：进程内唯一事实源；currentWorkspaceRoot() 同步读） */
let mruRoot = '';

/** 记录一次空间活动（本模块不做 canonical 化，调用方传 canonical root） */
export function markWorkspaceUsed(root: string): void {
  if (root) mruRoot = root;
}

/** 读当前指针（可空：供 server 闭包回落 deps.sessionStore.path，保持单测/嵌入旧行为） */
export function currentWorkspaceRoot(): string {
  return mruRoot;
}

/** 会话索引/元数据文件名——它们存在不代表「该空间有真实会话」 */
const NON_SESSION_FILES = new Set(['meta.json', 'sessions.json']);

/** 会话体文件后缀（明文 / 加密）；与 SessionStore.sessionFileExt 同口径 */
const SESSION_FILE_EXTS = ['.json', '.enc'];

/**
 * 该空间存储目录是否含**真实会话**（需求 20261113-002 D4）。
 *
 * 判据落在「内容存在」而非「元数据存在」：仅含 meta.json 的幽灵目录（旧版启动预装产物）
 * 不得参与 recency 竞争，否则它每次启动被 touchWorkspaceMeta 刷新 mtime → 恒被选为最近使用
 * → 再落盘，形成永不自愈的自我强化闭环。
 *
 * 两条命中路径（任一为真即可）：
 * 1. 目录内存在 `sess_*` 会话体文件（排除 meta.json / sessions.json）；
 * 2. `sessions.json` 解析为非空数组（会话体被外部清理但索引仍在时仍认账）。
 *
 * 任何异常 → false（保守：宁可不选它为最近使用，也不选错）。
 */
async function hasRealSessions(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (NON_SESSION_FILES.has(e.name)) continue;
      if (SESSION_FILE_EXTS.some((ext) => e.name.endsWith(ext))) return true;
    }
    // 兜底：会话体文件缺失但索引非空（例如迁移中途）
    try {
      const raw = await readFile(join(dir, 'sessions.json'), 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) return true;
    } catch {
      // 索引缺失/损坏：不算有会话
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 冷启动推导「最近使用空间」。
 *
 * @param userDir 会话/记忆根目录（默认 ~/.loop-agent；单测注入临时目录）
 * @returns canonical 空间根（推导成功）或 canonical(homedir)（无任何可用映射时）；绝不抛错
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
    return await canonicalWorkspacePath(homedir());
  }
  let best: { root: string; mtimeMs: number } | null = null;
  for (const dir of dirs) {
    // 需求 20261113-002 D4：无真实会话的目录（幽灵空壳）不参与竞争——
    // 放在 mtime / canonical 计算之前，省掉两次无谓 IO
    if (!(await hasRealSessions(dir))) continue;
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
  return await canonicalWorkspacePath(homedir());
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
