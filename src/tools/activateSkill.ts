// activate_skill 工具：激活指定 Skill，返回 SKILL.md 完整内容供 Agent 参考执行
import { skillLoader } from '../skill/loader.js';
import type { Tool } from '../types.js';

export const activateSkill: Tool = {
  name: 'activate_skill',
  description:
    '激活一个 Skill（技能包），返回该 Skill 的完整指令内容。当你判断用户需求匹配某个 Skill 时使用此工具获取详细执行步骤。',
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

    return `【Skill: ${content.metadata.name}】\n描述: ${content.metadata.description}\n作用域: ${content.metadata.scope === 'workspace' ? '工作空间' : '全局'}\n\n---\n\n${content.fullContent}`;
  },
};
