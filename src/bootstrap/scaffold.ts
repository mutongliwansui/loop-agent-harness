// 幂等补建：全局 skills 目录（需求 20261112-008：配置与 skill 一律全局，不再产出工作空间产物）
// 全部操作幂等：已存在的一律跳过，绝不覆盖已有内容
import { mkdir, writeFile, access, readFile, rename } from 'node:fs/promises';
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
 * 需求 20261112-008：工作空间配置已废弃，本函数恒不创建任何文件（保留导出以兼容调用方）。
 * 全局 config.json 缺失时同样不写空文件（留待向导写入，避免"存在但无 model"的半配置态）。
 */
export async function ensureConfigFiles(_paths: BootstrapPaths): Promise<string[]> {
  return [];
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

/** 一次性补建全部缺失目录（需求 20261112-008：只建全局 skills，不再建工作空间目录与配置骨架） */
export async function ensureScaffold(paths: BootstrapPaths): Promise<ScaffoldResult> {
  const dirs = await ensureDirs([paths.skillsGlobalDir]);
  const files = await ensureConfigFiles(paths);
  return { created: [...dirs, ...files] };
}
