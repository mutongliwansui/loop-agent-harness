// activateSkill 工具：激活指定 Skill，返回 SKILL.md 完整内容 + 技能所在目录供 Agent 参考执行
// 需求 20261111-004：内置工具名统一驼峰（原 activate_skill）
import { skillLoader } from '../skill/loader.js';
import type { Tool } from '../types.js';

export const activateSkill: Tool = {
  name: 'activateSkill',
  description:
    '激活一个 Skill（技能包），返回该 Skill 的完整指令内容与技能目录（SKILL.md 绝对路径）。'
    + '技能内引用的脚本、参考文档等附加文件，用返回的技能目录拼接路径后读取或执行。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Skill 名称（区分大小写）',
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
    // 需求 20261112-008：skill 只剩全局一份，作用域恒为全局
    const scope = '全局';

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
