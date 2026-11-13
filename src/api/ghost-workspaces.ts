// 存量幽灵空间识别与告警（需求 20261113-002 D6）
//
// 背景：P0 断掉了「启动即落盘」，P1 断掉了「幽灵空壳自我强化」（不再被选为最近使用、
// 不进侧栏）。但磁盘上**已经存在**的幽灵目录（旧版启动预装产物，仅含 meta.json）
// 不会被自动消失——它们只是被忽略了。本模块负责把它们**识别出来并告警**，
// 让用户知道磁盘上还有这些残留、可以自行清理。
//
// 安全边界（重要）：本模块**只读**。
// - 不删除、不改名、不移动任何目录或文件；
// - 不提供 prune / 清理端点（用户已明确决定：不提供一键清理，存量由用户自行删除）；
// - 唯一写入的是诊断日志 <userDir>/ghost-workspaces.log（纯文本追加，与业务数据无关）。
// 将来若有人要在此模块加删除逻辑，必须重新走需求评审——这是刻意留的护栏。
//
// 判据偏保守：任何「除 meta.json / sessions.json 之外的东西」（包括 runs/ 目录、
// 其它散落文件）都视为真实活动痕迹，一律不判幽灵。宁可漏报，不可误报——
// 误报会诱导用户删掉真正在用的空间。

import { appendFile, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { debug } from '../debug.js';
import { loopAgentHome } from '../user-home.js';

/** 一条幽灵空间记录（只描述事实，不含任何处置动作） */
export interface GhostWorkspace {
  /** 存储目录名（workspaceId：canonical 路径的 SHA-256 前 16 位） */
  wsId: string;
  /** meta.json 里记录的工作空间绝对路径（判据要求必须存在） */
  workspacePath: string;
  /** 人类可读的判定理由（写进日志与启动告警） */
  reason: string;
}

/** 允许出现在幽灵目录里的文件名——它们本身不代表「有会话」 */
const ALLOWED_META_FILES = new Set(['meta.json', 'sessions.json']);

/** 诊断日志单文件上限（超过即重写，避免每次启动追加导致无限增长） */
const MAX_LOG_SIZE = 256 * 1024;

/** 诊断日志文件名（位于 userDir 下，与 sessions/ memory/ 平级） */
const LOG_FILENAME = 'ghost-workspaces.log';

/**
 * 扫描存量幽灵空间（**只读**）。
 *
 * 判定为幽灵需**同时**满足：
 * 1. 目录内只有 `meta.json`，或 `meta.json` + 解析为空数组的 `sessions.json`；
 * 2. 不含任何其它文件/子目录（`sess_*` 会话体、`runs/` 等一律视为真实活动）；
 * 3. `meta.json` 能解析且 `workspacePath` 非空——否则属「孤儿目录」（无归属信息，
 *    根本无法给出可读告警），本模块不做处理。
 *
 * @param userDir 会话根（默认 ~/.loop-agent；单测注入临时目录）
 * @returns 幽灵空间列表；目录不存在或读失败一律返回空数组，**绝不抛错**
 */
export async function scanGhostWorkspaces(userDir?: string): Promise<GhostWorkspace[]> {
  const base = userDir ?? loopAgentHome();
  const sessionsDir = join(base, 'sessions');
  let dirs: string[];
  try {
    dirs = (await readdir(sessionsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return []; // sessions 根目录不存在：全新环境，无幽灵可言
  }

  const ghosts: GhostWorkspace[] = [];
  for (const wsId of dirs) {
    const ghost = await inspectWsDir(join(sessionsDir, wsId), wsId);
    if (ghost) ghosts.push(ghost);
  }
  return ghosts;
}

/** 检查单个空间存储目录；是幽灵则返回记录，否则 null */
async function inspectWsDir(dir: string, wsId: string): Promise<GhostWorkspace | null> {
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })).map((e) => e.name);
  } catch {
    return null; // 读不到就不判（不猜）
  }

  // 判据②：出现任何非元数据项（含子目录 runs/）即视为有真实活动，直接排除
  for (const name of entries) {
    if (ALLOWED_META_FILES.has(name)) continue;
    return null;
  }

  // 判据③：meta.json 必须存在且带 workspacePath，否则是孤儿目录
  const workspacePath = await readWorkspacePath(join(dir, 'meta.json'));
  if (!workspacePath) return null;

  // 判据①：sessions.json 若存在，必须解析为「空数组」；非空索引说明有会话被记录过
  const hasIndex = entries.includes('sessions.json');
  if (hasIndex && (await hasNonEmptyIndex(join(dir, 'sessions.json')))) return null;

  return {
    wsId,
    workspacePath,
    reason: hasIndex
      ? '仅含 meta.json 与空 sessions.json，无任何会话文件'
      : '仅含 meta.json，无任何会话文件',
  };
}

/** 读 meta.json 的 workspacePath（缺失/损坏/空值为 null） */
async function readWorkspacePath(metaFile: string): Promise<string | null> {
  try {
    const raw = await readFile(metaFile, 'utf-8');
    const meta = JSON.parse(raw) as { workspacePath?: string };
    const p = (meta.workspacePath ?? '').trim();
    return p || null;
  } catch {
    return null;
  }
}

/** sessions.json 是否解析为「非空数组」（损坏/缺失 → false：不当成有会话的阻碍） */
async function hasNonEmptyIndex(indexFile: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(indexFile, 'utf-8')) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/**
 * 启动期告警：扫描 + 打印 + 追加诊断日志（**只读**，不做任何清理）。
 *
 * 日志写入失败一律静默——诊断信息绝不影响启动主流程（与 run-journal 同策略）。
 *
 * @param userDir 会话根（默认 ~/.loop-agent）
 * @param log 日志输出函数（默认 console.log；单测可注入收集器）
 * @returns 本次扫描到的幽灵空间列表（供调用方/单测断言）
 */
export async function reportGhostWorkspaces(
  userDir?: string,
  log: (msg: string) => void = (msg) => console.log(msg),
): Promise<GhostWorkspace[]> {
  const ghosts = await scanGhostWorkspaces(userDir);
  if (ghosts.length === 0) return ghosts;

  const base = userDir ?? loopAgentHome();
  log(
    `  ├─ 存量幽灵空间 ${ghosts.length} 个（旧版启动预装残留，仅告警不清理；` +
      `确认无用后可自行删除对应 sessions/ 目录）`,
  );
  for (const g of ghosts) {
    log(`  │    · ${g.wsId}  ${g.workspacePath}  (${g.reason})`);
  }
  log(`  │    明细: ${join(base, LOG_FILENAME)}`);

  await appendGhostLog(base, ghosts);
  return ghosts;
}

/** 追加一行 JSON 诊断日志；超限先重写（避免无限增长），失败静默 */
async function appendGhostLog(base: string, ghosts: GhostWorkspace[]): Promise<void> {
  try {
    const logFile = join(base, LOG_FILENAME);
    let mustReset = false;
    try {
      mustReset = (await stat(logFile)).size >= MAX_LOG_SIZE;
    } catch {
      // 文件还不存在：正常追加即可
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), count: ghosts.length, ghosts }) + '\n';
    if (mustReset) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(logFile, line, 'utf-8');
    } else {
      await appendFile(logFile, line, 'utf-8');
    }
  } catch (e) {
    debug.log(`[ghost] 诊断日志写入失败（忽略）: ${String(e)}`);
  }
}
