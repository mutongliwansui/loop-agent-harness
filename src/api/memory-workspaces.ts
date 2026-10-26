// 记忆页跨空间数据源（需求 20261026-004 / 方案 D2、D5、D6）
//
// 为什么独立成模块：聚合逻辑（sessions 索引 ∪ memory 目录、run-log 纯文件读写）
// 不依赖 registry/runtime，纯 fs + 纯函数，便于 Vitest 直接单测；
// handler 只做参数解析与错误码映射，保持薄。
// 同步 IO 的理由与 DreamRunLog 一致：单文件几十 KB、旁路展示数据，开销可忽略。

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { workspaceId } from '../session/store.js';
import { debug } from '../debug.js';

/** 历史文件名（与 DreamScheduler / memory-dream.ts 保持一致） */
export const RUNS_FILE = '.dreaming-runs.json';

/** wsId 形态约束：workspaceId 产出为 16 位十六进制；放宽到 8-64 位容纳测试/演进 */
const WS_ID_RE = /^[0-9a-f]{8,64}$/i;

/** 聚合后的工作空间条目（GET /memory/workspaces） */
export interface MemoryWorkspace {
  /** 工作空间 id（workspaceId 哈希前缀，即 memory/sessions 目录名） */
  id: string;
  name: string;
  path: string;
  hasMemory: boolean;
  hasSession: boolean;
}

/** 读 sessions 索引中某空间的 meta（缺失/损坏返回 null） */
function readSessionMetaSync(sessionsDir: string, wsId: string): { name: string; path: string } | null {
  try {
    const meta = JSON.parse(readFileSync(join(sessionsDir, wsId, 'meta.json'), 'utf-8')) as {
      workspaceName?: string;
      workspacePath?: string;
    };
    return {
      name: meta.workspaceName || (meta.workspacePath ? basename(meta.workspacePath) : '') || wsId.slice(0, 8),
      path: meta.workspacePath ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * 扫描 sessions 索引与 memory 目录，聚合「有会话 ∪ 有记忆」的工作空间清单。
 *
 * - 空间名映射来自 sessions 索引 meta.json（明文）；memory 孤儿空间（有记忆无会话）
 *   查不到映射时，path 为空串、name 回落为 wsId 前 8 位。
 * - 任一目录缺失/不可读按空集处理（聚合端点不因单侧失败而 500）。
 */
export async function listMemoryWorkspaces(opts: {
  sessionsDir: string;
  memoryDir: string;
}): Promise<MemoryWorkspace[]> {
  const { sessionsDir, memoryDir } = opts;

  // 1. sessions 索引：wsId → {name,path}（meta.json 明文，损坏跳过）
  const metaById = new Map<string, { name: string; path: string }>();
  let sessionIds: string[] = [];
  try {
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    for (const d of entries) {
      if (!d.isDirectory()) continue;
      sessionIds.push(d.name);
      const meta = await readSessionMetaAsync(sessionsDir, d.name);
      if (meta) metaById.set(d.name, meta);
    }
  } catch {
    // sessions 目录不存在：按空集
  }

  // 2. memory 目录：有记忆内容的空间 id 集合
  const memoryIds = new Set<string>();
  try {
    for (const d of await readdir(memoryDir, { withFileTypes: true })) {
      if (d.isDirectory()) memoryIds.add(d.name);
    }
  } catch {
    // memory 目录不存在：按空集
  }

  // 3. 并集（sessions 空间在前、memory 孤儿追加在后，各自按 id 字典序稳定排序）
  const out = new Map<string, MemoryWorkspace>();
  for (const id of sessionIds.sort((a, b) => a.localeCompare(b))) {
    const meta = metaById.get(id);
    out.set(id, {
      id,
      name: meta?.name ?? id.slice(0, 8),
      path: meta?.path ?? '',
      hasMemory: memoryIds.has(id),
      hasSession: true,
    });
  }
  for (const id of [...memoryIds].sort()) {
    if (out.has(id)) continue;
    // 孤儿空间再查一次 sessions 索引（同根时通常能对上）
    const meta = readSessionMetaSync(sessionsDir, id);
    out.set(id, {
      id,
      name: meta?.name ?? id.slice(0, 8),
      path: meta?.path ?? '',
      hasMemory: true,
      hasSession: false,
    });
  }
  return [...out.values()];
}

/** 异步版 meta 读取（listMemoryWorkspaces 用） */
async function readSessionMetaAsync(
  sessionsDir: string,
  wsId: string,
): Promise<{ name: string; path: string } | null> {
  try {
    const meta = JSON.parse(await readFile(join(sessionsDir, wsId, 'meta.json'), 'utf-8')) as {
      workspaceName?: string;
      workspacePath?: string;
    };
    return {
      name: meta.workspaceName || (meta.workspacePath ? basename(meta.workspacePath) : '') || wsId.slice(0, 8),
      path: meta.workspacePath ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * 将 memory 根目录下的空间子目录解出为「路径 + 可显示名」。
 * 返回 null 表示该 id 不存在（或形态非法——兼防路径穿越）。
 *
 * 名称解析：同根 sessions 索引 meta.json → wsId 前 8 位。
 */
export function resolveMemorySpace(
  memoryDir: string,
  wsId: string,
  sessionsDir?: string,
): { dir: string; name: string; path: string } | null {
  if (!WS_ID_RE.test(wsId)) return null;
  const dir = join(memoryDir, wsId);
  if (!existsSync(dir)) return null;
  const meta = sessionsDir ? readSessionMetaSync(sessionsDir, wsId) : null;
  return { dir, name: meta?.name ?? wsId.slice(0, 8), path: meta?.path ?? '' };
}

/** 聚合后的单条触发记录（在 DreamRunRecord 上附空间维度） */
export interface AggregatedRun {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  /** 排序主键（parseRunsFile 已保证存在） */
  startedAt: string;
  /** 其余字段与 DreamRunRecord 同构（透传） */
  [k: string]: unknown;
}

/** 最低限度记录形状校验（与 dream-runs.ts parseRuns 同口径：startedAt 为字符串即收） */
interface RunLite {
  startedAt: string;
  [k: string]: unknown;
}

function parseRunsFile(raw: string): RunLite[] {
  try {
    const runs = (JSON.parse(raw) as { runs?: unknown } | null)?.runs;
    if (!Array.isArray(runs)) return [];
    return runs.filter((r): r is RunLite => Boolean(r) && typeof (r as RunLite).startedAt === 'string');
  } catch {
    return [];
  }
}

/**
 * 扫描各空间记忆目录下的 .dreaming-runs.json 聚合运行历史（全局新 → 旧排序）。
 *
 * 为什么纯文件扫描而非 registry 逐空间 historyFor（方案 D5）：
 * - 不依赖 runtime 装载状态——进程重启后从未访问过的空间记录也能看到；
 * - 与调度器写入端（DreamRunLog）同文件同结构，天然兼容。
 */
export function aggregateRunHistory(opts: {
  memoryDir: string;
  sessionsDir?: string;
  /** 只聚合该空间（传 id）；缺省聚合全部 */
  onlyWsId?: string;
}): AggregatedRun[] {
  const { memoryDir, sessionsDir, onlyWsId } = opts;
  if (onlyWsId && !WS_ID_RE.test(onlyWsId)) return [];

  // 收集目标空间 id（only 模式不扫全目录）
  let ids: string[] = [];
  if (onlyWsId) {
    if (existsSync(join(memoryDir, onlyWsId))) ids = [onlyWsId];
  } else {
    try {
      ids = readdirSync(memoryDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch (e) {
      debug.log(`[memory] 扫描记忆目录失败（按空集）: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  const out: AggregatedRun[] = [];
  for (const id of ids) {
    let runs: RunLite[] = [];
    try {
      runs = parseRunsFile(readFileSync(join(memoryDir, id, RUNS_FILE), 'utf-8'));
    } catch {
      continue; // 文件缺失/损坏：该空间按无记录
    }
    if (runs.length === 0) continue;
    const meta = sessionsDir ? readSessionMetaSync(sessionsDir, id) : null;
    for (const r of runs) {
      out.push({
        ...r,
        workspaceId: id,
        workspaceName: meta?.name ?? id.slice(0, 8),
        workspacePath: meta?.path ?? '',
      });
    }
  }
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return out;
}

/**
 * 清空（若干）空间的运行历史，返回删除总条数。
 * 文件保留、内容清空（与 DreamRunLog.clear 幂等语义一致），原子写 tmp → rename。
 * 目录名经 join+relative 包含性校验防路径穿越（id 来源为目录枚举，正常不会越界）。
 */
export function clearRunHistory(opts: { memoryDir: string; wsIds: string[] }): number {
  let deleted = 0;
  for (const id of opts.wsIds) {
    const dir = join(opts.memoryDir, id);
    const rel = relative(opts.memoryDir, dir);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue; // 越界目录名：跳过
    const file = join(dir, RUNS_FILE);
    try {
      if (!existsSync(file)) continue;
      const prev = parseRunsFile(readFileSync(file, 'utf-8'));
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, runs: [] }, null, 2), 'utf-8');
      renameSync(tmp, file);
      deleted += prev.length;
    } catch (e) {
      debug.log(`[memory] 清空运行历史失败（${id.slice(0, 8)}）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return deleted;
}

/** 计算工作空间 id（供 handler 把 ?ws= 绝对路径归一化为目录名） */
export function toWorkspaceId(absPath: string): string {
  return workspaceId(absPath);
}
