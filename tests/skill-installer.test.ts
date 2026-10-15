// Skill 安装器单测（Task-20261015-001）
// 覆盖：validateSkillDir 校验、installSkillDirs 复制/护栏/冲突/批量、pickDirectoryViaDialog 平台探测链
// Task-20261015-002：追加 removeSkills 定位/护栏/确认/批量/作用域语义
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// pickDirectoryViaDialog 依赖 manager 的 hasCommand/runDialogCommand，mock 掉外部进程
const managerMocks = vi.hoisted(() => ({
  hasCommand: vi.fn(),
  runDialogCommand: vi.fn(),
}));
vi.mock('../src/upload/manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/upload/manager.js')>();
  return { ...actual, ...managerMocks };
});

import { validateSkillDir, installSkillDirs, pickDirectoryViaDialog, removeSkills } from '../src/skill/installer.js';
import type { SkillMetadata, SkillScope } from '../src/skill/types.js';

let root: string;

/** 在 root 下造一个 skill 源目录 */
function makeSkillDir(
  dirName: string,
  opts: { name?: string; description?: string; withMd?: boolean; extraFile?: string } = {},
): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  if (opts.withMd !== false) {
    const fm = [
      '---',
      `name: ${opts.name ?? dirName}`,
      `description: ${opts.description ?? '测试 skill'}`,
      '---',
      '',
      '# body',
    ].join('\n');
    writeFileSync(join(dir, 'SKILL.md'), fm, 'utf-8');
  }
  if (opts.extraFile) writeFileSync(join(dir, opts.extraFile), 'extra', 'utf-8');
  return dir;
}

const confirmYes = () => Promise.resolve(true);
const confirmNo = () => Promise.resolve(false);

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'skill-installer-'));
});

describe('validateSkillDir', () => {
  it('目录不存在 → 拒绝', () => {
    const r = validateSkillDir(join(root, 'nope'));
    expect(r).toEqual({ ok: false, reason: '目录不存在' });
  });

  it('路径是文件 → 仅支持目录', () => {
    const f = join(root, 'a.txt');
    writeFileSync(f, 'x');
    const r = validateSkillDir(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('仅支持目录');
  });

  it('缺少 SKILL.md → 拒绝', () => {
    const dir = makeSkillDir('no-md', { withMd: false });
    const r = validateSkillDir(dir);
    expect(r).toEqual({ ok: false, reason: '缺少 SKILL.md' });
  });

  it('frontmatter 缺 name/description → 拒绝', () => {
    const dir = join(root, 'bad-fm');
    mkdirSync(dir);
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: only-name\n---\n# body\n');
    const r = validateSkillDir(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('frontmatter');
  });

  it('合法目录 → ok 且返回 name/description', () => {
    const dir = makeSkillDir('good', { name: 'my-skill', description: '我的技能' });
    const r = validateSkillDir(dir);
    expect(r).toEqual({ ok: true, name: 'my-skill', description: '我的技能' });
  });
});

describe('installSkillDirs', () => {
  it('空数组 → 直接返回空结果', async () => {
    const r = await installSkillDirs([], { targetRoot: join(root, 'skills'), confirmOverwrite: confirmYes });
    expect(r).toEqual({ installed: [], failed: [] });
  });

  it('正常安装：复制到 targetRoot/<basename>，文件齐全', async () => {
    const src = makeSkillDir('cool-skill', { extraFile: 'extra.txt' });
    const targetRoot = join(root, 'ws-skills');
    const r = await installSkillDirs([src], { targetRoot, confirmOverwrite: confirmYes });

    expect(r.failed).toEqual([]);
    expect(r.installed).toHaveLength(1);
    const entry = r.installed[0];
    expect(entry.name).toBe('cool-skill');
    expect(entry.targetDir).toBe(join(targetRoot, 'cool-skill'));
    expect(existsSync(join(entry.targetDir, 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(entry.targetDir, 'extra.txt'), 'utf-8')).toBe('extra');
  });

  it('批量：单项失败不阻断其余', async () => {
    const bad = makeSkillDir('bad-one', { withMd: false });
    const good = makeSkillDir('good-one');
    const r = await installSkillDirs([bad, good], {
      targetRoot: join(root, 'skills'),
      confirmOverwrite: confirmYes,
    });
    expect(r.installed.map((e) => e.name)).toEqual(['good-one']);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].path).toBe(bad);
    expect(r.failed[0].reason).toContain('缺少 SKILL.md');
  });

  it('护栏：源目录已在目标位置 → 拒绝', async () => {
    const targetRoot = join(root, 'skills');
    const src = makeSkillDir('skills/self-skill');
    const r = await installSkillDirs([src], { targetRoot, confirmOverwrite: confirmYes });
    expect(r.installed).toEqual([]);
    expect(r.failed[0].reason).toContain('无需安装');
  });

  it('护栏：目标位于源目录内部 → 拒绝（防递归复制）', async () => {
    const src = makeSkillDir('outer');
    const targetRoot = join(src, 'inner-skills');
    const r = await installSkillDirs([src], { targetRoot, confirmOverwrite: confirmYes });
    expect(r.installed).toEqual([]);
    expect(r.failed[0].reason).toContain('源目录内部');
  });

  it('冲突：已存在同名且拒绝覆盖 → 跳过，旧内容保留', async () => {
    const src = makeSkillDir('conflict-skill');
    const targetRoot = join(root, 'skills');
    const existing = join(targetRoot, 'conflict-skill');
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, 'old.txt'), 'old', 'utf-8');

    const r = await installSkillDirs([src], { targetRoot, confirmOverwrite: confirmNo });
    expect(r.installed).toEqual([]);
    expect(r.failed[0].reason).toContain('已跳过');
    expect(readFileSync(join(existing, 'old.txt'), 'utf-8')).toBe('old');
  });

  it('冲突：确认覆盖 → 先删再复制（旧文件消失，新文件在）', async () => {
    const src = makeSkillDir('conflict-skill');
    const targetRoot = join(root, 'skills');
    const existing = join(targetRoot, 'conflict-skill');
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, 'old.txt'), 'old', 'utf-8');

    const confirm = vi.fn().mockResolvedValue(true);
    const r = await installSkillDirs([src], { targetRoot, confirmOverwrite: confirm });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(r.installed).toHaveLength(1);
    expect(existsSync(join(existing, 'old.txt'))).toBe(false);
    expect(existsSync(join(existing, 'SKILL.md'))).toBe(true);
  });
});

describe('pickDirectoryViaDialog（平台探测链）', () => {
  const originalPlatform = process.platform;
  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }
  afterEach(() => setPlatform(originalPlatform));

  it('win32 → powershell FolderBrowserDialog，不探测 hasCommand', async () => {
    setPlatform('win32');
    managerMocks.runDialogCommand.mockResolvedValue({ paths: ['D:\\skills\\my-skill'] });
    const r = await pickDirectoryViaDialog();
    expect(r.paths).toEqual(['D:\\skills\\my-skill']);
    expect(managerMocks.hasCommand).not.toHaveBeenCalled();
    const cmd = managerMocks.runDialogCommand.mock.calls[0][0] as string;
    expect(cmd).toContain('powershell');
    expect(cmd).toContain('FolderBrowserDialog');
  });

  it('darwin → osascript choose folder', async () => {
    setPlatform('darwin');
    managerMocks.runDialogCommand.mockResolvedValue({ paths: ['/Users/u/skill'] });
    const r = await pickDirectoryViaDialog();
    expect(r.paths).toEqual(['/Users/u/skill']);
    const cmd = managerMocks.runDialogCommand.mock.calls[0][0] as string;
    expect(cmd).toContain('osascript');
    expect(cmd).toContain('choose folder');
  });

  it('linux：zenity 命中即用（--directory）', async () => {
    setPlatform('linux');
    managerMocks.hasCommand.mockImplementation(async (c: string) => c === 'zenity');
    managerMocks.runDialogCommand.mockResolvedValue({ paths: ['/home/u/skill'] });
    const r = await pickDirectoryViaDialog();
    expect(r.paths).toEqual(['/home/u/skill']);
    const cmd = managerMocks.runDialogCommand.mock.calls[0][0] as string;
    expect(cmd).toContain('zenity');
    expect(cmd).toContain('--directory');
  });

  it('linux：zenity 无、kdialog 命中', async () => {
    setPlatform('linux');
    managerMocks.hasCommand.mockImplementation(async (c: string) => c === 'kdialog');
    managerMocks.runDialogCommand.mockResolvedValue({ paths: ['/home/u/skill'] });
    const r = await pickDirectoryViaDialog();
    expect(r.paths).toEqual(['/home/u/skill']);
    expect(managerMocks.runDialogCommand.mock.calls[0][0]).toContain('kdialog');
  });

  it('linux：全部不可用 → unavailable，不抛错', async () => {
    setPlatform('linux');
    managerMocks.hasCommand.mockResolvedValue(false);
    const r = await pickDirectoryViaDialog();
    expect(r).toEqual({ paths: [], reason: 'unavailable' });
    expect(managerMocks.runDialogCommand).not.toHaveBeenCalled();
  });
});

describe('removeSkills（Task-20261015-002）', () => {
  let wsRoot: string;
  let globalRoot: string;

  /** 造 SkillMetadata（在指定作用域根下建真实目录 + SKILL.md） */
  function makeMeta(name: string, scope: SkillScope, dirName = name): SkillMetadata {
    const base = scope === 'workspace' ? wsRoot : globalRoot;
    const dir = join(base, dirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n# body\n`, 'utf-8');
    return { name, description: 'd', path: join(dir, 'SKILL.md'), dir, scope };
  }

  function opts(
    skills: SkillMetadata[],
    scope: 'auto' | 'global' | 'workspace',
    confirm: (name: string, dir: string, scope: SkillScope) => Promise<boolean> = confirmYes,
  ) {
    return { skills, scope, globalDir: globalRoot, workspaceDir: wsRoot, confirm };
  }

  beforeEach(() => {
    wsRoot = join(root, 'ws', 'skills');
    globalRoot = join(root, 'gl', 'skills');
  });

  it('空数组 → 直接返回空结果', async () => {
    const r = await removeSkills([], opts([], 'auto'));
    expect(r).toEqual({ removed: [], failed: [] });
  });

  it('auto：仅工作空间存在 → 删除工作空间目录', async () => {
    const meta = makeMeta('alpha', 'workspace');
    const r = await removeSkills(['alpha'], opts([meta], 'auto'));
    expect(r.failed).toEqual([]);
    expect(r.removed).toHaveLength(1);
    expect(r.removed[0]).toMatchObject({ name: 'alpha', scope: 'workspace' });
    expect(existsSync(meta.dir)).toBe(false);
  });

  it('auto：同名两作用域 → 优先删工作空间，全局保留', async () => {
    const ws = makeMeta('dup', 'workspace');
    const gl = makeMeta('dup', 'global');
    const r = await removeSkills(['dup'], opts([ws, gl], 'auto'));
    expect(r.removed).toHaveLength(1);
    expect(r.removed[0].scope).toBe('workspace');
    expect(existsSync(ws.dir)).toBe(false);
    expect(existsSync(gl.dir)).toBe(true);
  });

  it('auto：仅全局存在 → fallback 删全局', async () => {
    const gl = makeMeta('only-global', 'global');
    const r = await removeSkills(['only-global'], opts([gl], 'auto'));
    expect(r.removed).toHaveLength(1);
    expect(r.removed[0].scope).toBe('global');
    expect(existsSync(gl.dir)).toBe(false);
  });

  it('--global：同名两作用域 → 只删全局', async () => {
    const ws = makeMeta('dup', 'workspace');
    const gl = makeMeta('dup', 'global');
    const r = await removeSkills(['dup'], opts([ws, gl], 'global'));
    expect(r.removed[0].scope).toBe('global');
    expect(existsSync(gl.dir)).toBe(false);
    expect(existsSync(ws.dir)).toBe(true);
  });

  it('--workspace：仅全局存在 → 未找到，不 fallback', async () => {
    const gl = makeMeta('g', 'global');
    const r = await removeSkills(['g'], opts([gl], 'workspace'));
    expect(r.removed).toEqual([]);
    expect(r.failed[0].reason).toBe('未找到已安装的 Skill');
    expect(existsSync(gl.dir)).toBe(true);
  });

  it('未找到 → failed「未找到已安装的 Skill」', async () => {
    const r = await removeSkills(['ghost'], opts([], 'auto'));
    expect(r.removed).toEqual([]);
    expect(r.failed).toEqual([{ name: 'ghost', reason: '未找到已安装的 Skill' }]);
  });

  it('护栏：dir 非 skills 根直接子目录 → 拒绝删除', async () => {
    const meta = makeMeta('evil', 'workspace', 'nested/evil');
    const r = await removeSkills(['evil'], opts([meta], 'workspace'));
    expect(r.removed).toEqual([]);
    expect(r.failed[0].reason).toBe('目标路径异常，拒绝删除');
    expect(existsSync(meta.dir)).toBe(true);
  });

  it('确认 N → 已跳过，目录保留', async () => {
    const meta = makeMeta('skipme', 'workspace');
    const r = await removeSkills(['skipme'], opts([meta], 'auto', confirmNo));
    expect(r.removed).toEqual([]);
    expect(r.failed[0].reason).toBe('已跳过');
    expect(existsSync(meta.dir)).toBe(true);
  });

  it('批量：单项失败不阻断其余', async () => {
    const a = makeMeta('a', 'workspace');
    const b = makeMeta('b', 'workspace');
    const r = await removeSkills(['a', 'ghost', 'b'], opts([a, b], 'auto'));
    expect(r.removed.map((e) => e.name)).toEqual(['a', 'b']);
    expect(r.failed).toEqual([{ name: 'ghost', reason: '未找到已安装的 Skill' }]);
    expect(existsSync(a.dir)).toBe(false);
    expect(existsSync(b.dir)).toBe(false);
  });

  it('按 frontmatter name 定位，目录名不同也能删（D1）', async () => {
    const meta = makeMeta('real-name', 'workspace', 'weird-dir-name');
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await removeSkills(['real-name'], opts([meta], 'auto', confirm));
    expect(r.removed).toHaveLength(1);
    expect(confirm).toHaveBeenCalledWith('real-name', expect.any(String), 'workspace');
    expect(existsSync(meta.dir)).toBe(false);
  });
});
