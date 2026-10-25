// 终端可用的 shell 探测（Task-20261027-001 D3）
//
// 设计要点：
// - **不做硬编码假设**：实测本机不存在 `pwsh.exe`，若默认主选项写死 PowerShell 7 会导致首屏即失败
// - 探测结果按「用户偏好优先级」排序，只列出真实存在的可执行文件
// - platform / exists 可注入，便于三平台单测（不在 CI 上真跑 Windows）
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type ShellId = 'pwsh' | 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh';

export interface ShellInfo {
  id: ShellId;
  /** 展示名（前端下拉与页签用） */
  label: string;
  /** 可执行文件名/绝对路径 */
  file: string;
  args: string[];
}

/**
 * Windows 候选（按优先级）：
 * - pwsh.exe：PowerShell 7+，若安装则优先（UTF-8 默认、跨平台语法一致）
 * - powershell.exe：Windows PowerShell 5.1，Win10/11 必有
 * - cmd.exe：最后兜底
 */
const WINDOWS_CANDIDATES: readonly ShellInfo[] = [
  { id: 'pwsh', label: 'PowerShell 7', file: 'pwsh.exe', args: ['-NoLogo'] },
  { id: 'powershell', label: 'Windows PowerShell', file: 'powershell.exe', args: ['-NoLogo'] },
  { id: 'cmd', label: '命令提示符', file: 'cmd.exe', args: [] },
];

/** POSIX 候选：优先 $SHELL（尊重用户登录 shell），再按常见路径兜底 */
const POSIX_CANDIDATES: readonly ShellInfo[] = [
  { id: 'zsh', label: 'zsh', file: '/bin/zsh', args: ['-l'] },
  { id: 'bash', label: 'bash', file: '/bin/bash', args: ['-l'] },
  { id: 'sh', label: 'sh', file: '/bin/sh', args: [] },
];

/** 默认探测函数：文件存在性（Windows 侧名字不带路径，交给 PATH 解析） */
function defaultExists(file: string): boolean {
  // 带路径的绝对路径判断存在性；裸文件名（如 pwsh.exe）走 PATH 查找
  if (file.includes('/') || file.includes('\\')) return existsSync(file);
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  return dirs.some((d) => d && existsSync(join(d, file)));
}

/**
 * 探测本机可用 shell 列表。
 *
 * @param platform 目标平台（默认 process.platform，单测注入）
 * @param exists   存在性判定（默认查 PATH，单测注入）
 */
export function detectShells(
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = defaultExists,
  shellEnv: string | undefined = process.env.SHELL,
): ShellInfo[] {
  if (platform === 'win32') {
    return WINDOWS_CANDIDATES.filter((s) => exists(s.file));
  }
  const found = POSIX_CANDIDATES.filter((s) => exists(s.file));
  // $SHELL 指向的 shell 提前（用户登录 shell 优先）
  if (shellEnv) {
    const idx = found.findIndex((s) => shellEnv.endsWith(`/${s.id}`) || shellEnv === s.file);
    if (idx > 0) {
      const [hit] = found.splice(idx, 1);
      found.unshift(hit);
    }
  }
  return found;
}

/**
 * 按 id 取 shell；id 未命中时回落首个可用项。
 * 返回 null 表示一个 shell 都探测不到（终端整体不可用）。
 */
export function pickShell(list: readonly ShellInfo[], id?: string): ShellInfo | null {
  if (!list.length) return null;
  if (!id) return list[0];
  return list.find((s) => s.id === id) ?? list[0];
}
