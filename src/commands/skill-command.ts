// /skill 命令处理器
// 支持: list, reload, show <name>, upload（Task-20261015-001）, remove（Task-20261015-002）
import { formatSkillList, installSkillDirs, pickDirectoryViaDialog, removeSkills, scanSkillsDir } from '../skill/index.js';
import { parseUploadArgs } from '../upload/manager.js';
import { COLORS } from '../ui/colors.js';
import { WORKSPACE_FLAG_REMOVED } from './utils.js';
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
 * /skill upload [目录...]（Task-20261015-001）
 * 需求 20261112-008：skill 目录收敛为全局唯一（~/.loop-agent/skills），--workspace 已移除；
 * 无路径弹系统目录选择框（D3）；同名冲突 y/N 询问（D5）；装完自动 reload（D6）
 */
async function runSkillUpload(ctx: CommandContext, rest: string): Promise<void> {
  const { out, skillLoader } = ctx;

  if (/(^|\s)--workspace(?=\s|$)/i.test(rest)) {
    out.blank();
    out.log(`${COLORS.red}${WORKSPACE_FLAG_REMOVED}${COLORS.reset}`);
    out.blank();
    return;
  }
  const pathText = rest
    .replace(/(^|\s)--global(?=\s|$)/gi, '$1')
    .replace(/(^|\s)--workspace(?=\s|$)/gi, '$1')
    .trim();
  const targetRoot = skillLoader.globalDir;

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

  // D5：冲突确认（统一走 ctx.askConfirm，禁止新建临时 readline——其 close 会 pause 共享 stdin 导致进程退出）
  const confirmOverwrite = (name: string, targetDir: string): Promise<boolean> => {
    void targetDir;
    return ctx.askConfirm(
      `${COLORS.yellow}目标已存在同名 Skill「${name}」，覆盖？(y/N):${COLORS.reset} `,
    );
  };

  const result = await installSkillDirs(paths, { targetRoot, confirmOverwrite });

  out.blank();
  for (const e of result.installed) {
    out.log(`${COLORS.green}✓ ${e.name}${COLORS.reset}`);
    out.log(`  ${COLORS.gray}→ ${e.targetDir}（全局）${COLORS.reset}`);
  }
  for (const f of result.failed) {
    out.log(`${COLORS.red}✗ ${f.path}：${f.reason}${COLORS.reset}`);
  }
  if (result.installed.length > 0) {
    // D6：自动 reload，/skill list 立即可见
    skillLoader.reload();
    out.log(`${COLORS.gray}已重新扫描 Skill，立即可用${COLORS.reset}`);
  }
  out.blank();
}

/**
 * /skill remove <name...>（Task-20261015-002）
 * 需求 20261112-008：skill 目录收敛为全局唯一，--workspace 已移除；
 * 无参报错提示用法（D4）；逐个 y/N 确认，无 --yes（D3）；删完自动 reload（D6）
 */
async function runSkillRemove(ctx: CommandContext, rest: string): Promise<void> {
  const { out, skillLoader } = ctx;

  if (/(^|\s)--workspace(?=\s|$)/i.test(rest)) {
    out.blank();
    out.log(`${COLORS.red}${WORKSPACE_FLAG_REMOVED}${COLORS.reset}`);
    out.blank();
    return;
  }
  const nameText = rest
    .replace(/(^|\s)--global(?=\s|$)/gi, '$1')
    .replace(/(^|\s)--workspace(?=\s|$)/gi, '$1')
    .trim();

  const names = parseUploadArgs(nameText);
  if (names.length === 0) {
    out.log(`${COLORS.red}用法: /skill remove <name...>${COLORS.reset}`);
    out.blank();
    return;
  }

  const globalDir = skillLoader.globalDir;
  const skills = scanSkillsDir(globalDir, 'global');

  // D3：逐项确认（统一走 ctx.askConfirm，禁止新建临时 readline——其 close 会 pause 共享 stdin 导致进程退出）
  const confirm = (name: string, dir: string): Promise<boolean> =>
    ctx.askConfirm(
      `${COLORS.yellow}确认删除 Skill「${name}」？(${dir}) (y/N):${COLORS.reset} `,
    );

  const result = await removeSkills(names, { skills, rootDir: globalDir, confirm });

  out.blank();
  for (const e of result.removed) {
    out.log(`${COLORS.green}✓ ${e.name}${COLORS.reset} ${COLORS.gray}（全局）${COLORS.reset}`);
    out.log(`  ${COLORS.gray}→ 已删除 ${e.dir}${COLORS.reset}`);
  }
  for (const f of result.failed) {
    out.log(`${COLORS.red}✗ ${f.name}：${f.reason}${COLORS.reset}`);
  }
  if (result.removed.length > 0) {
    // D6：自动 reload，/skill list 立即不可见
    skillLoader.reload();
    out.log(`${COLORS.gray}已重新扫描 Skill${COLORS.reset}`);
  }
  out.blank();
}

export const skillCommand: CommandHandler = {
  name: '/skill',
  description: 'Skill 管理（list/reload/show/upload/remove）',
  subcommands: ['list', 'reload', 'show', 'upload', 'remove', 'help'],
  subcommandHelp: {
    list: '列出已发现的 Skill（全局唯一目录）',
    reload: '重新扫描 Skill 目录',
    show: '查看指定 Skill 的完整内容（/skill show <name>）',
    upload: '安装 Skill 目录（无参弹目录选择框；--workspace 已移除）',
    remove: '删除已安装 Skill（逐个确认；--workspace 已移除）',
  },
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
        out.log(`  ${COLORS.gray}（暂无 Skill，可在 ~/.loop-agent/skills/ 下创建）${COLORS.reset}`);
      } else {
        for (const s of skills) {
          out.log(`  ${COLORS.bold}${s.name}${COLORS.reset} ${COLORS.magenta}[全局]${COLORS.reset}`);
          out.log(`    ${COLORS.gray}${s.description}${COLORS.reset}`);
        }
      }
      out.blank();
      return;
    }

    if (sub === 'reload') {
      out.blank();
      out.log(`${COLORS.gray}重新扫描 Skill...${COLORS.reset}`);
      const skills = skillLoader.reload();
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
      out.log(`${COLORS.bold}${content.metadata.name}${COLORS.reset} ${COLORS.gray}(全局)${COLORS.reset}`);
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
