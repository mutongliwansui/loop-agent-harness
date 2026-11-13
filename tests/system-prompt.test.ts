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

  it('有技能时列出技能名称、描述与作用域（恒为全局）', () => {
    const p = buildSystemPrompt([
      meta('alpha', '处理甲事务', 'global'),
      meta('beta', '处理乙事务', 'global'),
    ]);
    expect(p).toContain('- **alpha**: 处理甲事务 (全局)');
    expect(p).toContain('- **beta**: 处理乙事务 (全局)');
    expect(p).not.toContain('(工作空间)');
    expect(p).toContain('以上即为当前全部可用 Skill');
  });

  it('有技能时仍提示依据列表回答、不检索文件系统', () => {
    const p = buildSystemPrompt([meta('alpha', '处理甲事务', 'global')]);
    expect(p).toContain('不要通过检索文件系统');
    expect(p).not.toContain('当前没有可用的技能');
  });
});

describe('buildSystemPrompt 的环境信息区块', () => {
  it('传入工作空间目录时在末尾注入环境信息', () => {
    const p = buildSystemPrompt([], 'D:\\work\\proj');
    expect(p).toContain('## 环境信息');
    expect(p).toContain('当前工作空间目录：D:\\work\\proj');
    expect(p.trimEnd().endsWith('以该目录为基准描述路径')).toBe(true);
  });

  it('未传工作空间目录时不注入环境信息（向后兼容）', () => {
    const p = buildSystemPrompt([]);
    expect(p).not.toContain('## 环境信息');
    expect(p).not.toContain('当前工作空间目录');
  });
});

describe('buildSystemPrompt 的视觉能力区块', () => {
  it('visionEnabled=true 时注入图片理解段（工具取舍规则已下沉到工具描述）', () => {
    const p = buildSystemPrompt([], 'D:\\work', true);
    expect(p).toContain('## 图片理解');
    // 需求 20261111-003 / 20261111-004：三种用法与取舍规则改由 analyzeImage 的 description 承载
    // （模型每轮都能看到 schema），system 只留 schema 表达不了的通用事实
    expect(p).toContain('路径/URL/dataURI');
    expect(p).toContain('支持多图数组');
    expect(p).toContain('analyzeImage');
    for (const name of ['ask_image', 'describe_image', 'extract_json', 'ocr_image', 'activate_skill']) {
      expect(p).not.toContain(name);
    }
  });

  it('visionEnabled 未传或 false 时不注入（prompt 字节级一致，保护前缀缓存）', () => {
    const base = buildSystemPrompt([], 'D:\\work');
    expect(base).not.toContain('## 图片理解');
    expect(buildSystemPrompt([], 'D:\\work', false)).toBe(base);
    expect(buildSystemPrompt([], 'D:\\work', undefined)).toBe(base);
  });

  it('视觉段位于 Skill 区块之前（能力说明 → 技能包 → 环境信息）', () => {
    const p = buildSystemPrompt([meta('alpha', '处理甲事务', 'global')], 'D:\\work', true);
    expect(p.indexOf('## 图片理解')).toBeLessThan(p.indexOf('## 可用 Skill（技能包）'));
    expect(p.indexOf('## 可用 Skill（技能包）')).toBeLessThan(p.indexOf('## 环境信息'));
  });
});
