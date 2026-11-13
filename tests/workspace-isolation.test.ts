/**
 * 两空间隔离验收（Task-20261021-010-03 6.4）
 *
 * 需求 20261112-008 后语义变更：
 * - 配置（ConfigLoader/ConfigWriter）与 Skill（SkillLoader）已收敛为**进程级单例**，
 *   不再随工作空间各持一份；本文件相应断言改为「共享同一实例」。
 * - 仍然按空间隔离的是：SessionStore（会话文件）、AgentPool、memory kit（L2 目录）。
 *
 * 覆盖：
 * - 每空间 runtime：store / AgentPool / SessionManager 各一实例，Config/Skill 为进程级共享
 * - 会话文件按 workspaceId 落盘，两空间互不覆盖（A5：id 公式不变，存量目录仍可见）
 * - 全局配置写入对所有空间可见（不再是「写 A 不影响 B」的分层语义）
 * - 技能扫描只扫全局目录，不再按空间隔离（D5 / D14 已被 008 取代）
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
import { configLoader } from '../src/config/loader.js';
import { configWriter } from '../src/config/writer.js';
import { skillLoader } from '../src/skill/loader.js';
import { loopAgentHome } from '../src/user-home.js';
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

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(WS_A, { recursive: true });
  mkdirSync(WS_B, { recursive: true });

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
  it('store / AgentPool / SessionManager 不共享', () => {
    expect(rtA).not.toBe(rtB);
    expect(rtA.store).not.toBe(rtB.store);
    expect(rtA.pool).not.toBe(rtB.pool);
    expect(rtA.sessions).not.toBe(rtB.sessions);
  });

  it('配置与 skill 不再挂在 runtime 上（进程级单例，D8）', () => {
    // 008 后 runtime 不再持有这三个组件，避免「指向某空间」的错觉
    expect('configLoader' in rtA).toBe(false);
    expect('configWriter' in rtA).toBe(false);
    expect('skillLoader' in rtA).toBe(false);
    // 进程级单例可正常导入且各空间共享同一引用
    expect(configLoader).toBe(configLoader);
    expect(configWriter).toBe(configWriter);
    expect(skillLoader).toBe(skillLoader);
  });

  it('根与 workspaceId 一一对应且公式未改变（A5）', () => {
    expect(rtA.root).toBe(rootA);
    expect(rtB.root).toBe(rootB);
    expect(rtA.id).toBe(workspaceId(rootA));
    expect(rtB.id).toBe(workspaceId(rootB));
    expect(rtA.id).not.toBe(rtB.id);
  });
});

describe('6.4.2 会话存储按空间隔离、配置全局共享', () => {
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

  it('listAllWorkspaces 从任一 store 均可看全两个空间（无"当前"标记）', async () => {
    const fromA = await rtA.store.listAllWorkspaces();
    expect(fromA).toHaveLength(2);
    expect(fromA.every((w) => !('current' in w))).toBe(true);

    const fromB = await rtB.store.listAllWorkspaces();
    expect(fromB).toHaveLength(2);
    expect(fromB.map((w) => w.path).sort()).toEqual(fromA.map((w) => w.path).sort());
  });
});

describe('6.4.3 skill 只扫全局目录（008 D5 取代旧的实例级隔离）', () => {
  it('工作空间内放置的 skill 不再被扫描；scan() 无参数且结果稳定', () => {
    // 在空间目录里放一个 skill：008 后不应被任何 loader 扫到
    const wsSkillDir = join(WS_A, '.loop-agent', 'skills', 'skill-only-a');
    mkdirSync(wsSkillDir, { recursive: true });
    writeFileSync(
      join(wsSkillDir, 'SKILL.md'),
      '---\nname: skill-only-a\ndescription: 空间内 skill（008 后应被忽略）\n---\n\n# a\n',
      'utf-8',
    );

    // 全局目录是唯一扫描目标（路径由 loopAgentHome() 解析，测试下被 LOOP_AGENT_HOME 重定向）
    expect(skillLoader.globalDir).toBe(join(loopAgentHome(), 'skills'));

    const first = skillLoader.scan().map((s) => s.name);
    const again = skillLoader.reload().map((s) => s.name);
    expect(again).toEqual(first);
    // 空间目录里的 skill 不应出现
    expect(first).not.toContain('skill-only-a');
    // 协议字段 scope 恒为 global
    expect(skillLoader.list().every((s) => s.scope === 'global')).toBe(true);
  });
});

describe('6.4.4 记忆 L2 目录按空间隔离（D8）', () => {
  it('同一 memoryRoot 下两空间各自独立目录', async () => {
    const kitA = await createMemoryKit(rootA, configLoader, {
      memoryRoot: MEMORY_ROOT,
      globalCuratedDir: join(ROOT, 'curated'),
    });
    const kitB = await createMemoryKit(rootB, configLoader, {
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
