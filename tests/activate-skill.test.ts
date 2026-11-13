/**
 * activateSkill 工具单元测试：输出应包含技能目录与 SKILL.md 绝对路径，便于定位技能内附带文件
 *
 * 需求 20261112-008（D5）：skill 目录收敛为全局唯一一份 `~/.loop-agent/skills`。
 * 测试通过 LOOP_AGENT_HOME 环境变量把全局目录重定向到临时目录（vitest setupFiles 已重定向，
 * 此处显式再设一次以保证与其他用例隔离）。
 */
import { describe, it, expect, beforeEach, afterAll, afterEach } from 'vitest';
import { activateSkill } from '../src/tools/activateSkill.js';
import { skillLoader } from '../src/skill/loader.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const HOME = join(tmpdir(), 'loop-agent-tests', 'test-activate-skill-home');
const SKILLS = join(HOME, 'skills');
const prevHome = process.env.LOOP_AGENT_HOME;

function seedSkill(
  dirName: string,
  name: string,
  description: string,
  body = '技能正文内容',
): { skillDir: string; skillMd: string } {
  const skillDir = join(SKILLS, dirName);
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
    process.env.LOOP_AGENT_HOME = HOME;
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(SKILLS, { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LOOP_AGENT_HOME;
    else process.env.LOOP_AGENT_HOME = prevHome;
  });

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  it('输出包含技能目录与 SKILL.md 绝对路径', async () => {
    const { skillDir, skillMd } = seedSkill('demo', 'demo', '演示技能');
    skillLoader.scan();

    const r = await activateSkill.execute({ name: 'demo' });

    expect(r).toContain('【Skill: demo】');
    expect(r).toContain('技能目录: ' + skillDir);
    expect(r).toContain('SKILL.md: ' + skillMd);
    expect(r).toContain('技能正文内容');
  });

  it('输出作用域恒为全局（008 后不再有工作空间级 skill）', async () => {
    seedSkill('g', 'global-skill', '全局技能');
    skillLoader.scan();

    const r = await activateSkill.execute({ name: 'global-skill' });

    expect(r).toContain('作用域: 全局');
    expect(r).not.toContain('作用域: 工作空间');
  });

  it('未找到 Skill 时返回可用列表', async () => {
    seedSkill('demo', 'demo', '演示技能');
    skillLoader.scan();

    const r = await activateSkill.execute({ name: 'not-exist' });

    expect(r).toContain('未找到');
  });

  it('缺少 name 参数时返回错误', async () => {
    const r = await activateSkill.execute({ name: '' });
    expect(r).toContain('错误');
  });
});
