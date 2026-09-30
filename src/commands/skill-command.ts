// /skill 命令处理器
// 支持: list, reload, show <name>
import { formatSkillList } from '../skill/index.js';
import { COLORS } from '../ui/colors.js';
import type { CommandContext, CommandHandler } from './registry.js';

export const skillCommand: CommandHandler = {
  name: '/skill',
  description: 'Skill 管理（list/reload/show）',
  subcommands: ['list', 'reload', 'show'],
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

    out.log(`${COLORS.red}未知 /skill 子命令: ${sub}。支持 list / reload / show${COLORS.reset}`);
    out.blank();
  },
};
