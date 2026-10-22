/**
 * 技能层双语义等价验收（Task-20261021-010-06 6.1.4 / A7.2，对应决策 D14）
 *
 * 背景：`SkillLoader.scan(cwd)` 的 cwd 既是"工作空间技能目录"也是"结果集"来源。
 * serve 侧已把 7 处 `process.cwd()` 换成 runtime 根，CLI 侧仍传 `process.cwd()`。
 * 本用例证明：对同一物理根，两条调用路径结果一致 → 不需要新增 `*At` 方法（D14），
 * CLI 侧零改动即与 serve 侧语义等价。
 *
 * 注：本用例**允许**在测试内 `process.chdir` 以证等价性；生产代码禁止 chdir（A4-1）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillLoader } from '../src/skill/loader.js';

const ROOT = join(tmpdir(), 'loop-agent-tests', 'test-skill-dual-semantics');
const WS_SKILLS = join(ROOT, '.loop-agent', 'skills');

/** 落一个最小可用 SKILL.md（frontmatter 含 name/description） */
function writeSkill(dirName: string, name: string): void {
  const dir = join(WS_SKILLS, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 双语义验收用的示例技能 ${name}\n---\n\n# ${name}\n\n正文示例。\n`,
    'utf-8',
  );
}

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(WS_SKILLS, { recursive: true });
  writeSkill('alpha-skill', 'alpha-skill');
  writeSkill('beta-skill', 'beta-skill');
});

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // Windows 目录句柄释放有延迟：残留临时目录不影响测试结果
  }
});

describe('A7.2 scan(root) 与 scan(process.cwd()) 等价', () => {
  it('同一 root：显式传根 与 chdir 后传 process.cwd() 结果一致', () => {
    const prev = process.cwd();
    const a = new SkillLoader().scan(ROOT);
    try {
      process.chdir(ROOT);
      const b = new SkillLoader().scan(process.cwd());
      // 只比较工作空间作用域（全局技能目录与本次调用无关，恒等但依赖本机环境）
      const wsOf = (list: { name: string; scope: string }[]) =>
        list.filter((s) => s.scope === 'workspace').map((s) => s.name);
      expect(wsOf(a)).toEqual(['alpha-skill', 'beta-skill']);
      expect(wsOf(b)).toEqual(wsOf(a));
    } finally {
      process.chdir(prev);
    }
  });

  it('getWorkspaceDir(root) 与 chdir 后的 process.cwd() 指向同一技能目录', () => {
    const loader = new SkillLoader();
    const byRoot = loader.getWorkspaceDir(ROOT);
    expect(byRoot).toBe(WS_SKILLS);

    const prev = process.cwd();
    try {
      process.chdir(ROOT);
      expect(loader.getWorkspaceDir(process.cwd())).toBe(byRoot);
    } finally {
      process.chdir(prev);
    }
  });

  it('reload(root) 与 scan(root) 结果一致（同一参数契约）', () => {
    const loader = new SkillLoader();
    expect(loader.reload(ROOT).map((s) => s.name)).toEqual(loader.scan(ROOT).map((s) => s.name));
  });
});
