// /skill 命令处理器
// 支持: list, reload, show <name>, upload（Task-20261015-001）, remove（Task-20261015-002）
import readline from 'node:readline';
import { formatSkillList, installSkillDirs, pickDirectoryViaDialog, removeSkills, scanSkillsDir } from '../skill/index.js';
import { parseUploadArgs } from '../upload/manager.js';
import { COLORS } from '../ui/colors.js';
import type { CommandContext, CommandHandler } from './registry.js';

/** /skill upload：取 upload 之后的原文（保留引号，交给 parseUploadArgs 归一） */
function uploadArgText(input: string): string {
  const m = input.trim().match(/^\/skill\s+upload\b(.*)$/i);
  return (m?.[1] ?? '').trim();
}

/** /skill remove：取 remove 之后的原文（保留引号，交给 parseUploadArgs 归一） */
function removeArgText(input: string): string {
  const m = input.trim().match(/^\/skill\s+remove\b(.*)$/i);
  return (m?.[1] ?? '').trim();
}

/**
 * /skill upload [目录...] [--global|--workspace]（Task-20261015-001）
 * 默认工作空间（D2）；无路径弹系统目录选择框（D3）；同名冲突 y/N 询问（D5）；装完自动 reload（D6）
 */
async function runSkillUpload(ctx: CommandContext, rest: string): Promise<void> {
  const { out, skillLoader } = ctx;

  // D2：剥离作用域 flag（位置无关），默认工作空间；两者同现时 --global 优先
  const scope: 'global' | 'workspace' = /(^|\s)--global(?=\s|$)/i.test(rest) ? 'global' : 'workspace';
  const pathText = rest
    .replace(/(^|\s)--global(?=\s|$)/gi, '$1')
    .replace(/(^|\s)--workspace(?=\s|$)/gi, '$1')
    .trim();
  const targetRoot =
    scope === 'global' ? skillLoader.globalDir : skillLoader.getWorkspaceDir(process.cwd());

  let paths = parseUploadArgs(pathText);
  if (paths.length === 0) {
    // D3：无路径（或仅 flag）→ 弹系统目录选择框（单选）
    out.blank();
    out.log(`${COLORS.gray}正在打开目录选择框…（关闭对话框后继续）${COLORS.reset}`);
    const picked = await pickDirectoryViaDialog();
    if (picked.paths.length === 0) {
      out.blank();
      if (picked.reason === 'unavailable') {
        out.log(`${COLORS.yellow}⚠ 当前环境无可用目录选择框，可拖拽目录到终端或使用 /skill upload <目录>${COLORS.reset}`);
      } else {
        out.log(`${COLORS.gray}已取消${COLORS.reset}`);
      }
      out.blank();
      return;
    }
    paths = picked.paths;
  }

  // D5：冲突确认（临时 readline，与 /upload clean 同款）
  const confirmOverwrite = (name: string, targetDir: string): Promise<boolean> =>
    new Promise((resolve) => {
      const tempRl = readline.createInterface({ input: process.stdin, output: process.stdout });
      tempRl.question(
        `${COLORS.yellow}目标已存在同名 Skill「${name}」，覆盖？(y/N):${COLORS.reset} `,
        (a) => {
          tempRl.close();
          resolve(a.trim().toLowerCase() === 'y');
        },
      );
      void targetDir;
    });

  const result = await installSkillDirs(paths, { targetRoot, confirmOverwrite });

  const scopeTag = scope === 'global' ? '全局' : '工作空间';
  out.blank();
  for (const e of result.installed) {
    out.log(`${COLORS.green}✓ ${e.name}${COLORS.reset}`);
    out.log(`  ${COLORS.gray}→ ${e.targetDir}（${scopeTag}）${COLORS.reset}`);
  }
  for (const f of result.failed) {
    out.log(`${COLORS.red}✗ ${f.path}：${f.reason}${COLORS.reset}`);
  }
  if (result.installed.length > 0) {
    // D6：自动 reload，/skill list 立即可见
    skillLoader.reload(process.cwd());
    out.log(`${COLORS.gray}已重新扫描 Skill，立即可用${COLORS.reset}`);
  }
  out.blank();
}

/**
 * /skill remove <name...> [--global|--workspace]（Task-20261015-002）
 * 无参报错提示用法（D4）；默认 auto 工作空间优先 → 全局 fallback（D2）；
 * 逐个 y/N 确认，无 --yes（D3）；删完自动 reload（D6）
 */
async function runSkillRemove(ctx: CommandContext, rest: string): Promise<void> {
  const { out, skillLoader } = ctx;

  // 剥离作用域 flag（位置无关），与 upload 同款
  const scope: 'auto' | 'global' | 'workspace' = /(^|\s)--global(?=\s|$)/i.test(rest)
    ? 'global'
    : /(^|\s)--workspace(?=\s|$)/i.test(rest)
      ? 'workspace'
      : 'auto';
  const nameText = rest
    .replace(/(^|\s)--global(?=\s|$)/gi, '$1')
    .replace(/(^|\s)--workspace(?=\s|$)/gi, '$1')
    .trim();

  const names = parseUploadArgs(nameText);
  if (names.length === 0) {
    out.log(`${COLORS.red}用法: /skill remove <name...> [--global|--workspace]${COLORS.reset}`);
    out.blank();
    return;
  }

  // auto 需要同时看到工作空间与全局（list() 合并视图会遮蔽同名全局项），直接扫两个目录
  const globalDir = skillLoader.globalDir;
  const workspaceDir = skillLoader.getWorkspaceDir(process.cwd());
  const skills = [...scanSkillsDir(workspaceDir, 'workspace'), ...scanSkillsDir(globalDir, 'global')];

  // D3：逐项确认（临时 readline，与 upload 覆盖确认同款）
  const confirm = (name: string, dir: string): Promise<boolean> =>
    new Promise((resolve) => {
      const tempRl = readline.createInterface({ input: process.stdin, output: process.stdout });
      tempRl.question(
        `${COLORS.yellow}确认删除 Skill「${name}」？(${dir}) (y/N):${COLORS.reset} `,
        (a) => {
          tempRl.close();
          resolve(a.trim().toLowerCase() === 'y');
        },
      );
    });

  const result = await removeSkills(names, { skills, scope, globalDir, workspaceDir, confirm });

  out.blank();
  for (const e of result.removed) {
    const scopeTag = e.scope === 'global' ? '全局' : '工作空间';
    out.log(`${COLORS.green}✓ ${e.name}${COLORS.reset} ${COLORS.gray}（${scopeTag}）${COLORS.reset}`);
    out.log(`  ${COLORS.gray}→ 已删除 ${e.dir}${COLORS.reset}`);
  }
  for (const f of result.failed) {
    out.log(`${COLORS.red}✗ ${f.name}：${f.reason}${COLORS.reset}`);
  }
  if (result.removed.length > 0) {
    // D6：自动 reload，/skill list 立即不可见
    skillLoader.reload(process.cwd());
    out.log(`${COLORS.gray}已重新扫描 Skill${COLORS.reset}`);
  }
  out.blank();
}

export const skillCommand: CommandHandler = {
  name: '/skill',
  description: 'Skill 管理（list/reload/show/upload/remove）',
  subcommands: ['list', 'reload', 'show', 'upload', 'remove'],
  match: (input) => input.toLowerCase().startsWith('/skill'),
  async execute(input, ctx) {
    const { out, configLoader, skillLoader } = ctx;
    const parts = input.split(/\s+/);
    const sub = parts[1] ?? 'list';
    const args = parts.slice(2);

    if (sub === 'list') {
      const { config: cfg } = configLoader.load();
      if (!cfg.skill.enabled) {
        out.log(`${COLORS.gray}Skill 功能未启用${COLORS.reset}`);
        out.blank();
        return;
      }
      const skills = skillLoader.list();
      out.blank();
      out.log(`${COLORS.bold}可用 Skill 列表 (${skills.length} 个):${COLORS.reset}`);
      if (skills.length === 0) {
        out.log(`  ${COLORS.gray}（暂无 Skill，可在 ~/.loop-agent/skills/ 或 <cwd>/.loop-agent/skills/ 下创建）${COLORS.reset}`);
      } else {
        for (const s of skills) {
          const scopeTag = s.scope === 'workspace' ? `${COLORS.green}[工作空间]${COLORS.reset}` : `${COLORS.magenta}[全局]${COLORS.reset}`;
          out.log(`  ${COLORS.bold}${s.name}${COLORS.reset} ${scopeTag}`);
          out.log(`    ${COLORS.gray}${s.description}${COLORS.reset}`);
        }
      }
      out.blank();
      return;
    }

    if (sub === 'reload') {
      out.blank();
      out.log(`${COLORS.gray}重新扫描 Skill...${COLORS.reset}`);
      const skills = skillLoader.reload(process.cwd());
      out.log(`${COLORS.green}✓${COLORS.reset} 已发现 ${skills.length} 个 Skill`);
      out.log(formatSkillList(skills));
      out.blank();
      return;
    }

    if (sub === 'show') {
      if (args.length === 0) {
        out.log(`${COLORS.red}用法: /skill show <name>${COLORS.reset}`);
        out.blank();
        return;
      }
      const name = args[0];
      const content = skillLoader.load(name);
      if (!content) {
        out.log(`${COLORS.red}Skill "${name}" 未找到${COLORS.reset}`);
        out.blank();
        return;
      }
      out.blank();
      out.log(`${COLORS.bold}${content.metadata.name}${COLORS.reset} ${COLORS.gray}(${content.metadata.scope === 'workspace' ? '工作空间' : '全局'})${COLORS.reset}`);
      out.log(`${COLORS.gray}描述:${COLORS.reset} ${content.metadata.description}`);
      out.log(`${COLORS.gray}路径:${COLORS.reset} ${content.metadata.path}`);
      out.log(`${COLORS.gray}内容:${COLORS.reset}`);
      out.log(content.fullContent);
      out.blank();
      return;
    }

    if (sub === 'upload') {
      await runSkillUpload(ctx, uploadArgText(input));
      return;
    }

    if (sub === 'remove') {
      await runSkillRemove(ctx, removeArgText(input));
      return;
    }

    out.log(`${COLORS.red}未知 /skill 子命令: ${sub}。支持 list / reload / show / upload / remove${COLORS.reset}`);
    out.blank();
  },
};
