// 会话归属定位（Task-20261021-010-04 D17）：sessionId → 归属 WorkspaceRuntime
//
// 三级策略：
// 1. 新格式 id（sess_<wsId8>_<ts>）段解析 O(1)：registry 已装载直接命中；未装载按 wsId8
//    扫 <userDir>/sessions/<wsId>/meta.json 反查 root 后懒建 runtime
// 2. 老格式 id（sess_<ts>）：进程内映射缓存（id → canonicalRoot），命中即 getCanonical
// 3. 全扫回退：扫所有空间目录的 sessions.json / <id>.json(.enc)，命中后写缓存
//    仍找不到 → ApiHttpError('not_found')

import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { ApiHttpError } from './errors.js';
import { canonicalWorkspacePath } from '../session/path-utils.js';
import type { WorkspaceRegistry, WorkspaceRuntime } from './workspace-runtime.js';
import { loopAgentHome } from '../user-home.js';

/** 新格式 id 的空间段正则 */
const NS_PREFIX = /^sess_([0-9a-f]{8})_/;

/** 老格式 id → 归属空间 canonical root 的进程内映射缓存（root 路径稳定，不随 runtime 淘汰失效） */
const idRootCache = new Map<string, string>();

function resolveUserDir(registry: WorkspaceRegistry): string {
  return registry.userDir ?? loopAgentHome();
}

/** 解析 sessionId → 归属 runtime；找不到 → ApiHttpError('not_found') */
export async function locateSession(registry: WorkspaceRegistry, id: string): Promise<WorkspaceRuntime> {
  const seg = NS_PREFIX.exec(id)?.[1];
  if (seg) {
    // 1a. 已装载 runtime 中 O(1) 匹配 wsId8 前缀
    for (const rt of registry.list()) {
      if (rt.id.startsWith(seg)) return rt;
    }
    // 1b. 未装载：按 wsId8 反查磁盘 → 懒建
    const root = await rootByWsId8(registry, seg);
    if (root) return registry.getCanonical(root);
  }

  // 2. 映射缓存（老 id 命中即快速定位）
  const cached = idRootCache.get(id);
  if (cached) return registry.getCanonical(cached);

  // 3. 全扫回退
  const root = await rootByFullScan(registry, id);
  if (root) {
    idRootCache.set(id, root);
    return registry.getCanonical(root);
  }

  throw new ApiHttpError('not_found', `会话不存在: ${id}`);
}

/** 按 wsId8 扫 <userDir>/sessions/* 目录名前缀，读 meta.json 反查 canonical root */
async function rootByWsId8(registry: WorkspaceRegistry, wsId8: string): Promise<string | null> {
  const sessionsRoot = join(resolveUserDir(registry), 'sessions');
  let dirs: Dirent[];
  try {
    dirs = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory() || !d.name.startsWith(wsId8)) continue;
    const metaPath = join(sessionsRoot, d.name, 'meta.json');
    try {
      const raw = await readFile(metaPath, 'utf-8');
      const meta = JSON.parse(raw) as { workspacePath?: string };
      if (meta.workspacePath) return await canonicalWorkspacePath(meta.workspacePath);
    } catch {
      // meta.json 缺失或损坏：跳过
    }
  }
  return null;
}

/** 全扫所有空间的目录，按文件存在性反查归属 root */
async function rootByFullScan(registry: WorkspaceRegistry, id: string): Promise<string | null> {
  const sessionsRoot = join(resolveUserDir(registry), 'sessions');
  let dirs: Dirent[];
  try {
    dirs = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = join(sessionsRoot, d.name);
    // 优先检查文件直接命中（无需解析 sessions.json）
    for (const ext of ['.json', '.enc'] as const) {
      try {
        await stat(join(dir, `${id}${ext}`));
        const metaPath = join(dir, 'meta.json');
        const raw = await readFile(metaPath, 'utf-8');
        const meta = JSON.parse(raw) as { workspacePath?: string };
        if (meta.workspacePath) return await canonicalWorkspacePath(meta.workspacePath);
      } catch {
        // 文件不存在或 meta.json 异常：继续
      }
    }
    // 文件未命中但 sessions.json 里有索引（文件被外部清理、索引残留）
    try {
      const raw = await readFile(join(dir, 'sessions.json'), 'utf-8');
      const list = JSON.parse(raw) as { id: string }[];
      if (list.some((s) => s.id === id)) {
        const metaRaw = await readFile(join(dir, 'meta.json'), 'utf-8');
        const meta = JSON.parse(metaRaw) as { workspacePath?: string };
        if (meta.workspacePath) return await canonicalWorkspacePath(meta.workspacePath);
      }
    } catch {
      // sessions.json 异常：忽略
    }
  }
  return null;
}
