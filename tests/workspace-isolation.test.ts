/**
 * 两空间隔离验收（Task-20261021-010-03 6.4）
 *
 * 覆盖：
 * - 每空间独立 runtime：store / ConfigLoader / ConfigWriter / SkillLoader / AgentPool 各一实例
 * - 会话文件按 workspaceId 落盘，两空间互不覆盖（A5：id 公式不变，存量目录仍可见）
 * - 工作空间配置分层读写互不串（D7 构造期定根）
 * - 技能扫描按实例隔离：两空间交替 scan/reload 不互相 clear 覆盖（D14 / A7.2）
 * - 记忆 L2 目录按 workspaceId 隔离（D8）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceRegistry } from '../src/api/workspace-runtime.js';
import { createMemoryKit } from '../src/api/memory-kit.js';
import { canonicalWorkspacePath } from '../src/session/path-utils.js';
import { workspaceId } from '../src/session/index.js';
import type { WorkspaceRuntime } from '../src/api/workspace-runtime.js';

const ROOT = join(tmpdir(), 'loop-agent-tests', 'test-workspace-isolation');
const USER_DIR = join(ROOT, 'user');
const WS_A = join(ROOT, 'ws-a');
const WS_B = join(ROOT, 'ws-b');
const MEMORY_ROOT = join(ROOT, 'memory');

let registry: WorkspaceRegistry;
let rtA: WorkspaceRuntime;
let rtB: WorkspaceRuntime;
let rootA = '';
let rootB = '';

/** 在两个空间各放一个同名 skill，用于验证实例级扫描互不覆盖 */
function seedSkill(workspace: string, name: string): void {
  const dir = join(workspace, '.loop-agent', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 隔离测试用 ${name}\n---\n\n# ${name}\n`,
    'utf-8',
  );
}

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(WS_A, { recursive: true });
  mkdirSync(WS_B, { recursive: true });
  seedSkill(WS_A, 'skill-only-a');
  seedSkill(WS_B, 'skill-only-b');

  registry = new WorkspaceRegistry({ userDir: USER_DIR });
  rtA = await registry.get(WS_A);
  rtB = await registry.get(WS_B);
  rootA = await canonicalWorkspacePath(WS_A);
  rootB = await canonicalWorkspacePath(WS_B);
});

afterAll(() => {
  registry.reset();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // Windows 句柄释放延迟：残留临时目录不影响测试结果
  }
});

describe('6.4.1 每空间独立实例', () => {
  it('store / ConfigLoader / ConfigWriter / SkillLoader / AgentPool 均不共享', () => {
    expect(rtA).not.toBe(rtB);
    expect(rtA.store).not.toBe(rtB.store);
    expect(rtA.configLoader).not.toBe(rtB.configLoader);
    expect(rtA.configWriter).not.toBe(rtB.configWriter);
    expect(rtA.skillLoader).not.toBe(rtB.skillLoader);
    expect(rtA.pool).not.toBe(rtB.pool);
    expect(rtA.sessions).not.toBe(rtB.sessions);
  });

  it('根与 workspaceId 一一对应且公式未改变（A5）', () => {
    expect(rtA.root).toBe(rootA);
    expect(rtB.root).toBe(rootB);
    expect(rtA.id).toBe(workspaceId(rootA));
    expect(rtB.id).toBe(workspaceId(rootB));
    expect(rtA.id).not.toBe(rtB.id);
  });
});

describe('6.4.2 会话存储与配置按空间隔离', () => {
  it('两空间创建会话落在各自 workspaceId 目录，互不可见', async () => {
    const metaA = await rtA.store.createSession('空间A的会话', []);
    // 跨空间同秒 id 撞名与写入路由消歧属 task-04（D5）范围；本任务用间隔规避，聚焦存储隔离
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const metaB = await rtB.store.createSession('空间B的会话', []);

    expect(metaA.id).not.toBe(metaB.id);
    expect(rtA.store.sessionsDir).not.toBe(rtB.store.sessionsDir);
    expect(rtA.store.sessionsDir).toBe(join(USER_DIR, 'sessions', workspaceId(rootA)));
    expect(rtB.store.sessionsDir).toBe(join(USER_DIR, 'sessions', workspaceId(rootB)));
    expect(existsSync(join(rtA.store.sessionsDir, metaA.file))).toBe(true);
    expect(existsSync(join(rtB.store.sessionsDir, metaB.file))).toBe(true);

    const listA = (await rtA.store.listSessions()).map((s) => s.id);
    const listB = (await rtB.store.listSessions()).map((s) => s.id);
    expect(listA).toContain(metaA.id);
    expect(listA).not.toContain(metaB.id);
    expect(listB).toContain(metaB.id);
    expect(listB).not.toContain(metaA.id);
  });

  it('工作空间配置写 A 不影响 B（构造期定根，D7）', async () => {
    await rtA.configWriter.writeWorkspace({ skill: { enabled: false } });

    expect(rtA.configLoader.loadWorkspaceSync().skill?.enabled).toBe(false);
    expect(rtB.configLoader.loadWorkspaceSync().skill?.enabled).toBeUndefined();
    expect(rtA.configWriter.workspaceConfigPath).not.toBe(rtB.configWriter.workspaceConfigPath);
  });

  it('listAllWorkspaces 从任一 store 均可看全两个空间（无"当前"标记）', async () => {
    const fromA = await rtA.store.listAllWorkspaces();
    expect(fromA).toHaveLength(2);
    expect(fromA.every((w) => !('current' in w))).toBe(true);

    const fromB = await rtB.store.listAllWorkspaces();
    expect(fromB).toHaveLength(2);
    expect(fromB.map((w) => w.path).sort()).toEqual(fromA.map((w) => w.path).sort());
  });
});

describe('6.4.3 技能扫描实例级隔离（D14 / A7.2）', () => {
  it('两空间交替 reload 互不 clear；scan(root) 对同一根结果稳定', () => {
    rtA.skillLoader.reload(rootA);
    rtB.skillLoader.reload(rootB);
    rtA.skillLoader.reload(rootA);

    const namesA = rtA.skillLoader.list().map((s) => s.name);
    const namesB = rtB.skillLoader.list().map((s) => s.name);
    expect(namesA).toContain('skill-only-a');
    expect(namesA).not.toContain('skill-only-b');
    expect(namesB).toContain('skill-only-b');
    expect(namesB).not.toContain('skill-only-a');

    // A7.2 双语义：同一 root 反复 scan 结果一致
    const again = rtA.skillLoader.reload(rootA).map((s) => s.name);
    expect(again).toEqual(rtA.skillLoader.list().map((s) => s.name));
  });
});

describe('6.4.4 记忆 L2 目录按空间隔离（D8）', () => {
  it('同一 memoryRoot 下两空间各自独立目录', async () => {
    const kitA = await createMemoryKit(rootA, rtA.configLoader, {
      memoryRoot: MEMORY_ROOT,
      globalCuratedDir: join(ROOT, 'curated'),
    });
    const kitB = await createMemoryKit(rootB, rtB.configLoader, {
      memoryRoot: MEMORY_ROOT,
      globalCuratedDir: join(ROOT, 'curated'),
    });

    const dirA = kitA.episodic.getMemoryDir();
    const dirB = kitB.episodic.getMemoryDir();
    expect(dirA).not.toBe(dirB);
    expect(dirA).toBe(join(MEMORY_ROOT, workspaceId(rootA)));
    expect(dirB).toBe(join(MEMORY_ROOT, workspaceId(rootB)));
    expect(existsSync(dirA)).toBe(true);
    expect(existsSync(dirB)).toBe(true);
  });
});
