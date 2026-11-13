/**
 * 技能扫描契约验收（需求 20261112-008 D5 取代 Task-20261021-010-06 的「双语义」）
 *
 * 008 后：
 * - 技能目录收敛为全局唯一一份 `~/.loop-agent/skills`（测试下被 LOOP_AGENT_HOME 重定向）
 * - `scan()` / `reload()` 不再接收 root/cwd 参数；`getWorkspaceDir()` 已删除
 * - `SkillMetadata.scope` 保留（协议稳定）但恒为 `'global'`
 * - 工作空间目录下的 `.loop-agent/skills` 不再被扫描
 *
 * 本文件由 tests/skill-loader-dual-semantics.test.ts 改写而来（原 A7.2 双语义等价已随资源层删除失效）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillLoader } from '../src/skill/loader.js';
import { loopAgentHome } from '../src/user-home.js';

const ROOT = join(tmpdir(), 'loop-agent-tests', 'test-skill-global-only');
const WS_SKILLS = join(ROOT, '.loop-agent', 'skills');

/** 落一个最小可用 SKILL.md（frontmatter 含 name/description） */
function writeSkill(baseDir: string, dirName: string, name: string): string {
  const dir = join(baseDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 全局唯一扫描验收用的示例技能 ${name}\n---\n\n# ${name}\n\n正文示例。\n`,
    'utf-8',
  );
  return dir;
}

let globalSkillDir = '';

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  // 空间内 skill：008 后应被彻底忽略
  writeSkill(WS_SKILLS, 'ws-only-skill', 'ws-only-skill');
  // 全局 skill：唯一扫描目标
  globalSkillDir = join(loopAgentHome(), 'skills');
  writeSkill(globalSkillDir, 'alpha-skill', 'alpha-skill');
  writeSkill(globalSkillDir, 'beta-skill', 'beta-skill');
});

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
    rmSync(globalSkillDir, { recursive: true, force: true });
  } catch {
    // Windows 目录句柄释放有延迟：残留临时目录不影响测试结果
  }
});

describe('D5 全局唯一扫描契约', () => {
  it('globalDir 为 loopAgentHome()/skills', () => {
    expect(new SkillLoader().globalDir).toBe(join(loopAgentHome(), 'skills'));
  });

  it('scan() 无参数，扫到全局目录下的 skill', () => {
    // 008 收敛后 scan() 不再接收 root 参数；此处显式传参仅用于证明参数被忽略
    const loader = new SkillLoader() as unknown as { scan: (root?: string) => { name: string }[] };
    const list = loader.scan(ROOT).map((s) => s.name);
    expect(list).toEqual(['alpha-skill', 'beta-skill']);
  });

  it('工作空间内的 skill 不被扫描', () => {
    const names = new SkillLoader().scan().map((s) => s.name);
    expect(names).not.toContain('ws-only-skill');
  });

  it('reload() 与 scan() 结果一致', () => {
    const loader = new SkillLoader();
    expect(loader.reload().map((s) => s.name)).toEqual(loader.scan().map((s) => s.name));
  });

  it('scope 恒为 global（协议字段保留）', () => {
    const list = new SkillLoader().scan();
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((s) => s.scope === 'global')).toBe(true);
  });

  it('getWorkspaceDir 已移除（008 删除空间级技能目录）', () => {
    expect((new SkillLoader() as unknown as Record<string, unknown>).getWorkspaceDir).toBeUndefined();
  });

  it('chdir 到工作空间目录不影响扫描结果（不再有 cwd 语义）', () => {
    const before = new SkillLoader().scan().map((s) => s.name);
    const prev = process.cwd();
    try {
      process.chdir(ROOT);
      expect(new SkillLoader().scan().map((s) => s.name)).toEqual(before);
    } finally {
      process.chdir(prev);
    }
  });
});
