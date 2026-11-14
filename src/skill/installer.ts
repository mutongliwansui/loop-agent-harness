// Skill 安装器（Task-20261015-001，需求 20261015-001）
// 纯逻辑模块：目录校验 → 复制到作用域 skills 目录 → 系统目录选择框（平台探测链）
// 设计依据：docs/tasks/2026-10-15/task-20261015-001-skill上传（skill-upload）.md
// Task-20261015-002：追加 removeSkills（按 frontmatter name 定位删除，护栏防路径穿越）
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseSkillMd } from './scanner.js';
import type { SkillMetadata, SkillScope } from './types.js';
import type { DialogPickResult } from '../upload/manager.js';
import { hasCommand, runDialogCommand } from '../upload/manager.js';

/** 单个安装成功记录 */
export interface SkillInstallEntry {
  /** 源目录（resolve 后） */
  sourcePath: string;
  /** 安装目标目录（skills 根/<basename>） */
  targetDir: string;
  /** skill 名（frontmatter name） */
  name: string;
  /** skill 描述（frontmatter description） */
  description: string;
}

/** 批量安装结果（单项失败不阻断其余，D 与 /upload 一致） */
export interface SkillInstallResult {
  installed: SkillInstallEntry[];
  failed: { path: string; reason: string }[];
}

export type ValidateResult =
  | { ok: true; name: string; description: string }
  | { ok: false; reason: string };

/**
 * 校验 skill 目录（D4：与 scanner 扫描条件完全对齐，避免「装完扫不出」）：
 * 是目录 → 含 SKILL.md → frontmatter 可解析出合法 name/description
 */
export function validateSkillDir(dir: string): ValidateResult {
  if (!existsSync(dir)) return { ok: false, reason: '目录不存在' };
  if (!statSync(dir).isDirectory()) {
    return { ok: false, reason: '仅支持目录（skill 是含 SKILL.md 的目录）' };
  }
  const skillMd = join(dir, 'SKILL.md');
  if (!existsSync(skillMd)) return { ok: false, reason: '缺少 SKILL.md' };
  const parsed = parseSkillMd(skillMd);
  if (!parsed) return { ok: false, reason: 'SKILL.md frontmatter 缺少合法 name/description' };
  return { ok: true, name: parsed.name, description: parsed.description };
}

/**
 * 批量安装 skill 目录到目标作用域根（D5/D7/D8）。
 * - 目标目录名 = 源目录 basename（D7，不改名）
 * - 已存在同名目录 → confirmOverwrite 询问（D5）；确认则先删再整体复制
 * - 安全护栏：源与目标相同、目标位于源内部（递归复制）均拒绝
 */
export async function installSkillDirs(
  paths: string[],
  opts: {
    targetRoot: string;
    confirmOverwrite: (name: string, targetDir: string) => Promise<boolean>;
  },
): Promise<SkillInstallResult> {
  const result: SkillInstallResult = { installed: [], failed: [] };
  if (paths.length === 0) return result;
  await mkdir(opts.targetRoot, { recursive: true });

  for (const p of paths) {
    try {
      const abs = resolve(p);
      const v = validateSkillDir(abs);
      if (!v.ok) {
        result.failed.push({ path: p, reason: v.reason });
        continue;
      }
      const targetDir = join(opts.targetRoot, basename(abs));
      const targetAbs = resolve(targetDir);
      if (abs === targetAbs) {
        result.failed.push({ path: p, reason: '源目录已在目标位置，无需安装' });
        continue;
      }
      if (targetAbs.startsWith(abs + sep)) {
        result.failed.push({ path: p, reason: '目标位于源目录内部，拒绝安装' });
        continue;
      }
      if (existsSync(targetAbs)) {
        const yes = await opts.confirmOverwrite(v.name, targetAbs);
        if (!yes) {
          result.failed.push({ path: p, reason: '已存在同名目录，已跳过' });
          continue;
        }
        await rm(targetAbs, { recursive: true, force: true });
      }
      await cp(abs, targetAbs, { recursive: true });
      result.installed.push({
        sourcePath: abs,
        targetDir: targetAbs,
        name: v.name,
        description: v.description,
      });
    } catch (e) {
      result.failed.push({ path: p, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

/**
 * 弹出系统目录选择框（D3 跨平台探测链，零 npm 依赖，单选）：
 * - win32：powershell -NoProfile -STA + WinForms FolderBrowserDialog（UTF-8 输出）
 * - darwin：osascript choose folder
 * - Linux：zenity --directory → kdialog --getexistingdirectory → yad --file --directory 探测
 * 取消 / 全部工具不可用 / 执行失败均不抛错，以 reason 区分（与 pickFilesViaDialog 同契约）。
 */
export async function pickDirectoryViaDialog(): Promise<DialogPickResult> {
  const platform = process.platform;
  if (platform === 'win32') {
    const ps =
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ` +
      `Add-Type -AssemblyName System.Windows.Forms; ` +
      `$d = New-Object System.Windows.Forms.FolderBrowserDialog; ` +
      `$d.Description = '选择 Skill 目录（含 SKILL.md）'; ` +
      `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }`;
    return runDialogCommand(`powershell -NoProfile -STA -Command "${ps}"`, 'line');
  }
  if (platform === 'darwin') {
    return runDialogCommand(
      `osascript -e 'POSIX path of (choose folder with prompt "选择 Skill 目录（含 SKILL.md）")'`,
      'line',
    );
  }
  // Linux 及其它 POSIX：按 zenity → kdialog → yad 探测
  if (await hasCommand('zenity')) {
    return runDialogCommand(
      `zenity --file-selection --directory --title '选择 Skill 目录（含 SKILL.md）'`,
      'pipe',
    );
  }
  if (await hasCommand('kdialog')) {
    return runDialogCommand(`kdialog --getexistingdirectory . --title '选择 Skill 目录'`, 'args');
  }
  if (await hasCommand('yad')) {
    return runDialogCommand(
      `yad --file --directory --separator='|' --title '选择 Skill 目录'`,
      'pipe',
    );
  }
  return { paths: [], reason: 'unavailable' };
}

/** 单个删除成功记录 */
export interface SkillRemoveEntry {
  /** skill 名（frontmatter name） */
  name: string;
  /** 被删除目录（resolve 后） */
  dir: string;
  /** 作用域 */
  scope: SkillScope;
}

/** 批量删除结果（单项失败不阻断其余） */
export interface SkillRemoveResult {
  removed: SkillRemoveEntry[];
  failed: { name: string; reason: string }[];
}

/**
 * 批量删除 skill（Task-20261015-002，D1/D3/D5）。
 *
 * 需求 20261112-008：skill 目录收敛为全局唯一一份，`scope`/`workspaceDir` 参数已移除。
 * - D1：仅按 frontmatter name 定位，不做目录名兜底
 * - D3：逐项 confirm（默认 N 由调用方实现）
 * - D5：护栏——目标必须是 skills 根的直接子目录，防路径穿越
 * @param names 待删除 skill 名列表
 * @param opts.skills 候选元数据（同一目录扫描结果）
 * @param opts.rootDir skills 根目录（护栏基准）
 */
export async function removeSkills(
  names: string[],
  opts: {
    skills: SkillMetadata[];
    rootDir: string;
    confirm: (name: string, dir: string, scope: SkillScope) => Promise<boolean>;
  },
): Promise<SkillRemoveResult> {
  const result: SkillRemoveResult = { removed: [], failed: [] };
  if (names.length === 0) return result;

  for (const name of names) {
    try {
      const target = opts.skills.find((s) => s.name === name);
      if (!target) {
        result.failed.push({ name, reason: '未找到已安装的 Skill' });
        continue;
      }

      // D5 护栏：resolve(dir) 必须是 skills 根的直接子目录
      const abs = resolve(target.dir);
      const root = resolve(opts.rootDir);
      if (dirname(abs) !== root) {
        result.failed.push({ name, reason: '目标路径异常，拒绝删除' });
        continue;
      }

      const yes = await opts.confirm(name, abs, target.scope);
      if (!yes) {
        result.failed.push({ name, reason: '已跳过' });
        continue;
      }
      await rm(abs, { recursive: true, force: true });
      result.removed.push({ name, dir: abs, scope: target.scope });
    } catch (e) {
      result.failed.push({ name, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
