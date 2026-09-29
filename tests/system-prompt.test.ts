/**
 * buildSystemPrompt 单元测试：Skill 区块始终注入，无技能时需明确告知并禁止检索文件系统
 */
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/agent/prompt.js';
import type { SkillMetadata } from '../src/skill/types.js';

function meta(name: string, description: string, scope: 'global' | 'workspace'): SkillMetadata {
  return {
    name,
    description,
    path: `/skills/${name}/SKILL.md`,
    dir: `/skills/${name}`,
    scope,
  };
}

describe('buildSystemPrompt 的 Skill 区块', () => {
  it('无技能时明确告知"当前没有可用的技能"', () => {
    const p = buildSystemPrompt([]);
    expect(p).toContain('## 可用 Skill（技能包）');
    expect(p).toContain('当前没有可用的 Skill（技能包）');
    expect(p).toContain('当前没有可用的技能');
  });

  it('无技能时禁止通过文件系统检索技能目录', () => {
    const p = buildSystemPrompt([]);
    expect(p).toContain('不要通过');
    expect(p).toContain('检索文件系统');
  });

  it('有技能时列出技能名称、描述与作用域', () => {
    const p = buildSystemPrompt([
      meta('alpha', '处理甲事务', 'global'),
      meta('beta', '处理乙事务', 'workspace'),
    ]);
    expect(p).toContain('- **alpha**: 处理甲事务 (全局)');
    expect(p).toContain('- **beta**: 处理乙事务 (工作空间)');
    expect(p).toContain('以上即为当前全部可用 Skill');
  });

  it('有技能时仍提示依据列表回答、不检索文件系统', () => {
    const p = buildSystemPrompt([meta('alpha', '处理甲事务', 'global')]);
    expect(p).toContain('不要通过检索文件系统');
    expect(p).not.toContain('当前没有可用的技能');
  });
});
