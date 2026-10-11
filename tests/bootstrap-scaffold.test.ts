// 幂等补建单测：目录/骨架文件创建与不覆盖语义（Task-20261011-001 6.5/6.6/6.11）
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureScaffold, backupCorruptedFile } from '../src/bootstrap/scaffold.js';
import type { BootstrapPaths } from '../src/bootstrap/doctor.js';

const tempDirs: string[] = [];

async function makePaths(): Promise<BootstrapPaths> {
  const globalDir = await mkdtemp(join(tmpdir(), 'bootstrap-g-'));
  const wsDir = await mkdtemp(join(tmpdir(), 'bootstrap-w-'));
  tempDirs.push(globalDir, wsDir);
  return {
    globalConfigPath: join(globalDir, 'config.json'),
    workspaceConfigPath: join(wsDir, '.loop-agent', '.agent-config.json'),
    skillsGlobalDir: join(globalDir, 'skills'),
    skillsWorkspaceDir: join(wsDir, '.loop-agent', 'skills'),
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('ensureScaffold（幂等补建）', () => {
  it('全缺失时创建两级 skills 目录与 workspace 骨架，不创建全局 config', async () => {
    const paths = await makePaths();
    const { created } = await ensureScaffold(paths);
    expect(created).toEqual([
      paths.skillsGlobalDir,
      paths.skillsWorkspaceDir,
      paths.workspaceConfigPath,
    ]);
    await expect(readFile(paths.workspaceConfigPath, 'utf-8')).resolves.toBe('{}\n');
    await expect(access(paths.globalConfigPath)).rejects.toThrow();
  });

  it('重复调用幂等：第二次 created 为空，不覆盖已有内容', async () => {
    const paths = await makePaths();
    await ensureScaffold(paths);
    await writeFile(paths.workspaceConfigPath, '{\n  "custom": true\n}\n', 'utf-8');
    const second = await ensureScaffold(paths);
    expect(second.created).toEqual([]);
    await expect(readFile(paths.workspaceConfigPath, 'utf-8')).resolves.toContain('"custom": true');
  });

  it('workspace 配置已存在时不覆盖', async () => {
    const paths = await makePaths();
    await mkdir(join(paths.workspaceConfigPath, '..'), { recursive: true });
    await writeFile(paths.workspaceConfigPath, '{"model":{"apiKey":"keep"}}\n', 'utf-8');
    const { created } = await ensureScaffold(paths);
    expect(created).not.toContain(paths.workspaceConfigPath);
    await expect(readFile(paths.workspaceConfigPath, 'utf-8')).resolves.toContain('"keep"');
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
