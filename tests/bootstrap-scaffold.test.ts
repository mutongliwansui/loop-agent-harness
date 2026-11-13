// 幂等补建单测：目录/骨架文件创建与不覆盖语义（Task-20261011-001 6.5/6.6/6.11）
//
// 需求 20261112-008（D2/D5）：ensureScaffold 只建全局 skills 目录，不再产出任何工作空间产物
// （{ws}/.loop-agent/ 既不建目录也不写配置骨架）。
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureScaffold, backupCorruptedFile } from '../src/bootstrap/scaffold.js';
import type { BootstrapPaths } from '../src/bootstrap/doctor.js';

const tempDirs: string[] = [];

async function makePaths(): Promise<BootstrapPaths & { wsDir: string }> {
  const globalDir = await mkdtemp(join(tmpdir(), 'bootstrap-g-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'bootstrap-w-'));
  tempDirs.push(globalDir, wsDir);
  return {
    wsDir,
    globalConfigPath: join(globalDir, 'config.json'),
    skillsGlobalDir: join(globalDir, 'skills'),
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('ensureScaffold（幂等补建）', () => {
  it('全缺失时只创建全局 skills 目录，不建工作空间产物、不创建全局 config', async () => {
    const paths = await makePaths();
    const { created } = await ensureScaffold(paths);
    expect(created).toEqual([paths.skillsGlobalDir]);
    // 工作空间 .loop-agent 目录不再被创建
    await expect(access(join(paths.wsDir, '.loop-agent'))).rejects.toThrow();
    // 全局 config.json 缺失时不写空文件（留待向导写入）
    await expect(access(paths.globalConfigPath)).rejects.toThrow();
  });

  it('重复调用幂等：第二次 created 为空，不覆盖已有内容', async () => {
    const paths = await makePaths();
    await ensureScaffold(paths);
    await writeFile(join(paths.skillsGlobalDir, 'keep.txt'), 'custom', 'utf-8');
    const second = await ensureScaffold(paths);
    expect(second.created).toEqual([]);
    await expect(readFile(join(paths.skillsGlobalDir, 'keep.txt'), 'utf-8')).resolves.toBe('custom');
  });

  it('工作空间已被外部写入配置时不触碰（008 后脚手架不管理该文件）', async () => {
    const paths = await makePaths();
    const wsCfg = join(paths.wsDir, '.loop-agent', '.agent-config.json');
    await mkdir(join(paths.wsDir, '.loop-agent'), { recursive: true });
    await writeFile(wsCfg, '{"model":{"apiKey":"keep"}}\n', 'utf-8');
    const { created } = await ensureScaffold(paths);
    expect(created).not.toContain(wsCfg);
    await expect(readFile(wsCfg, 'utf-8')).resolves.toContain('"keep"');
  });
});

describe('backupCorruptedFile（损坏配置备份，Task-20261011-001 3.8）', () => {
  it('文件不存在返回 null', async () => {
    const paths = await makePaths();
    await expect(backupCorruptedFile(paths.globalConfigPath)).resolves.toBeNull();
  });

  it('合法 JSON 返回 null 且不动文件', async () => {
    const paths = await makePaths();
    await writeFile(paths.globalConfigPath, '{"model":{"apiKey":"keep"}}', 'utf-8');
    await expect(backupCorruptedFile(paths.globalConfigPath)).resolves.toBeNull();
    await expect(readFile(paths.globalConfigPath, 'utf-8')).resolves.toContain('"keep"');
  });

  it('损坏 JSON 重命名为 .bak-<时间戳> 并返回备份路径，内容完整保留', async () => {
    const paths = await makePaths();
    await writeFile(paths.globalConfigPath, '{broken!!', 'utf-8');
    const backup = await backupCorruptedFile(paths.globalConfigPath);
    expect(backup).toMatch(/config\.json\.bak-\d+$/);
    await expect(access(paths.globalConfigPath)).rejects.toThrow();
    await expect(readFile(backup as string, 'utf-8')).resolves.toBe('{broken!!');
  });
});
