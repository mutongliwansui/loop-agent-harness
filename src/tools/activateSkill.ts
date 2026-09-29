// activate_skill 工具：激活指定 Skill，返回 SKILL.md 完整内容 + 技能所在目录供 Agent 参考执行
import { skillLoader } from '../skill/loader.js';
import type { Tool } from '../types.js';

export const activateSkill: Tool = {
  name: 'activate_skill',
  description:
    '激活一个 Skill（技能包），返回该 Skill 的完整指令内容，以及技能所在目录（技能目录 / SKILL.md 绝对路径）。当你判断用户需求匹配某个 Skill 时使用此工具获取详细执行步骤；若技能内部引用了脚本、参考文档等附加文件，可用返回的技能目录拼接其路径后再读取或执行。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '要激活的 Skill 名称（区分大小写）',
      },
    },
    required: ['name'],
  },
  async execute(args) {
    const name = String(args.name);
    if (!name) {
      return '错误：必须提供 Skill 名称参数';
    }

    const content = skillLoader.load(name);
    if (!content) {
      const available = skillLoader.list().map((s) => s.name).join(', ');
      return `Skill "${name}" 未找到。可用的 Skill: ${available || '(无)'}`;
    }

    const { metadata } = content;
    const scope = metadata.scope === 'workspace' ? '工作空间' : '全局';

    return [
      `【Skill: ${metadata.name}】`,
      `描述: ${metadata.description}`,
      `作用域: ${scope}`,
      `技能目录: ${metadata.dir}`,
      `SKILL.md: ${metadata.path}`,
      '',
      `提示：技能目录下的脚本、参考文档、模板、资源等附加文件均位于「技能目录」内。如需读取或执行技能附带文件，请基于上述绝对路径拼接访问，例如用 fileRead 读取 ${metadata.dir}/references/xxx.md，或用 commandRun 执行 ${metadata.dir}/scripts/xxx.py。`,
      '',
      '---',
      '',
      content.fullContent,
    ].join('\n');
  },
};
