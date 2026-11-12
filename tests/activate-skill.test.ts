/**
 * activateSkill 工具单元测试：输出应包含技能目录与 SKILL.md 绝对路径，便于定位技能内附带文件
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { activateSkill } from '../src/tools/activateSkill.js';
import { skillLoader } from '../src/skill/loader.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const DIR = join(tmpdir(), 'loop-agent-tests', 'test-activate-skill');

function seedSkill(
  dirName: string,
  name: string,
  description: string,
  body = '技能正文内容',
): { skillDir: string; skillMd: string } {
  const skillDir = join(DIR, '.loop-agent', 'skills', dirName);
  mkdirSync(skillDir, { recursive: true });
  const skillMd = join(skillDir, 'SKILL.md');
  writeFileSync(
    skillMd,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    'utf-8',
  );
  return { skillDir, skillMd };
}

describe('activateSkill 工具', () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it('输出包含技能目录与 SKILL.md 绝对路径', async () => {
    const { skillDir, skillMd } = seedSkill('demo', 'demo', '演示技能');
    skillLoader.scan(DIR);

    const r = await activateSkill.execute({ name: 'demo' });

    expect(r).toContain('【Skill: demo】');
    expect(r).toContain('技能目录: ' + skillDir);
    expect(r).toContain('SKILL.md: ' + skillMd);
    expect(r).toContain('技能正文内容');
  });

  it('输出保留作用域信息（工作空间）', async () => {
    seedSkill('ws', 'ws-skill', '工作空间技能');
    skillLoader.scan(DIR);

    const r = await activateSkill.execute({ name: 'ws-skill' });

    expect(r).toContain('作用域: 工作空间');
  });

  it('未找到 Skill 时返回可用列表', async () => {
    seedSkill('demo', 'demo', '演示技能');
    skillLoader.scan(DIR);

    const r = await activateSkill.execute({ name: 'not-exist' });

    expect(r).toContain('未找到');
  });

  it('缺少 name 参数时返回错误', async () => {
    const r = await activateSkill.execute({ name: '' });
    expect(r).toContain('错误');
  });
});
