// 幂等补建：两级 skills 目录、workspace .loop-agent/ 与骨架配置文件
// 全部操作幂等：已存在的一律跳过，绝不覆盖已有内容
import { mkdir, writeFile, access, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BootstrapPaths } from './doctor.js';

export interface ScaffoldResult {
  /** 本次实际新建的路径（供 ✓ 提示） */
  created: string[];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** mkdir -p，返回本次实际新建（原本不存在）的目录 */
export async function ensureDirs(dirs: string[]): Promise<string[]> {
  const created: string[] = [];
  for (const dir of dirs) {
    if (!(await pathExists(dir))) {
      await mkdir(dir, { recursive: true });
      created.push(dir);
    }
  }
  return created;
}

/**
 * 幂等补建配置文件（D3：默认值不落盘）：
 * - workspace .agent-config.json 缺失时写 {} 骨架（存在标记与编辑锚点）
 * - 全局 config.json 缺失时不写空文件（留待向导写入，避免"存在但无 model"的半配置态）
 * 返回本次实际创建的文件列表
 */
export async function ensureConfigFiles(paths: BootstrapPaths): Promise<string[]> {
  const created: string[] = [];
  if (!(await pathExists(paths.workspaceConfigPath))) {
    await mkdir(dirname(paths.workspaceConfigPath), { recursive: true });
    await writeFile(paths.workspaceConfigPath, '{}\n', 'utf-8');
    created.push(paths.workspaceConfigPath);
  }
  return created;
}

/**
 * 损坏配置备份（Task-20261011-001 3.8）：
 * 目标文件存在但不是合法 JSON 时，先重命名为 <path>.bak-<时间戳> 并返回备份路径；
 * 文件不存在或 JSON 合法时返回 null（不动作）。用于向导写盘前保护用户已有内容。
 */
export async function backupCorruptedFile(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return null; // 文件不存在，无需备份
  }
  try {
    JSON.parse(raw);
    return null; // JSON 合法，无需备份
  } catch {
    const backupPath = `${path}.bak-${Date.now()}`;
    await rename(path, backupPath);
    return backupPath;
  }
}

/** 一次性补建全部缺失目录与骨架文件 */
export async function ensureScaffold(paths: BootstrapPaths): Promise<ScaffoldResult> {
  const dirs = await ensureDirs([paths.skillsGlobalDir, paths.skillsWorkspaceDir]);
  const files = await ensureConfigFiles(paths);
  return { created: [...dirs, ...files] };
}
