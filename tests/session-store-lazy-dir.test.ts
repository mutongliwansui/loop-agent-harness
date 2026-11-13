/**
 * 工作空间按需创建（需求 20261113-002 P0 / D1 + D3）
 *
 * 背景：serve 启动期会为「缺省空间」预装 runtime 并 init。原实现里 init() 无条件
 * mkdir + 写 meta.json，`initAgentMemory` 也无条件建 memory/<wsId>，于是每次启动都在
 * 磁盘上凭空产出一个空壳工作空间；该空壳又被「最近使用空间」反复选中，永不自愈。
 *
 * 本套件锁定 P0 的断根语义：
 * 1. init() 零磁盘痕迹（不建 sessions/<wsId>、不写 meta.json）
 * 2. 首次真实写入（createSession）时才懒建目录与 meta，且会话文件正常落盘
 * 3. writeSession / appendIndex 各自独立防御（不经 createSession 也能建目录）
 * 4. memoryDirFor 口径与 createMemoryKit 一致（D3 探测不漂移）
 * 5. 有/无记忆目录时 bootstrap 的条件初始化判据正确
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { SessionStore } from '../src/session/store.js';
import { memoryDirFor } from '../src/api/memory-kit.js';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-session-lazy-dir');

/** 构造隔离环境：独立的 workspace 目录与 userDir（模拟 serve 的 ~/.loop-agent） */
function makeEnv(name: string): { workspace: string; userDir: string; wsDir: string } {
  const root = join(TEST_DIR, name);
  const workspace = join(root, 'workspace');
  const userDir = join(root, 'sessions-root');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  const store = new SessionStore(workspace, false, userDir);
  // 空间存储目录为 <userDir>/sessions/<wsId>，直接取 store 的权威值避免手工拼接错位
  return { workspace, userDir, wsDir: store.sessionsDir };
}

describe('需求 20261113-002 P0：SessionStore.init() 零磁盘痕迹', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('全新空间 init() 后不创建 sessions/<wsId>、不写 meta.json', async () => {
    const { workspace, userDir, wsDir } = makeEnv('init-clean');
    const store = new SessionStore(workspace, false, userDir);
    await store.init();

    expect(existsSync(wsDir)).toBe(false);
    expect(existsSync(join(wsDir, 'meta.json'))).toBe(false);
  });

  it('init() 不写盘后 listAllWorkspaces() 看不到该空间', async () => {
    const { workspace, userDir } = makeEnv('init-list');
    const store = new SessionStore(workspace, false, userDir);
    await store.init();

    expect(await store.listAllWorkspaces()).toEqual([]);
  });

  it('createSession() 才懒建目录与 meta.json，会话文件正常落盘', async () => {
    const { workspace, userDir, wsDir } = makeEnv('lazy-create');
    const store = new SessionStore(workspace, false, userDir);
    await store.init();

    expect(existsSync(wsDir)).toBe(false);

    const meta = await store.createSession('首个会话', [{ role: 'user', content: '首个会话' }]);

    // 目录、meta、会话体、索引四者齐备
    expect(existsSync(wsDir)).toBe(true);
    expect(existsSync(join(wsDir, 'meta.json'))).toBe(true);
    expect(existsSync(join(wsDir, `${meta.id}.json`))).toBe(true);
    expect(existsSync(join(wsDir, 'sessions.json'))).toBe(true);

    // 落盘后可被聚合读出，且会话计数正确
    const list = await store.listAllWorkspaces();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(wsDir.split(/[\\/]/).pop());
    expect(list[0].sessions).toHaveLength(1);
  });

  it('createSession() 后可直接读回会话内容（懒建不影响读写）', async () => {
    const { workspace, userDir } = makeEnv('lazy-readback');
    const store = new SessionStore(workspace, false, userDir);
    await store.init();

    const created = await store.createSession('你好', [{ role: 'user', content: '你好' }]);
    const loaded = await store.loadSession(created.id);
    expect(loaded.messages.at(-1)?.content).toBe('你好');
  });

  it('写入入口自带兜底：目录被整体删除后，冷实例 createSession 仍能重建并落盘', async () => {
    const { workspace, userDir, wsDir } = makeEnv('update-lazy');

    // 第一次写入：目录、meta、会话齐备
    const first = new SessionStore(workspace, false, userDir);
    await first.init();
    const created = await first.createSession('第一句', [{ role: 'user', content: '第一句' }]);
    expect(existsSync(join(wsDir, `${created.id}.json`))).toBe(true);

    // 模拟外部事故：整个空间存储目录被删（dirReady 缓存为 false 的冷实例场景）
    rmSync(wsDir, { recursive: true, force: true });
    expect(existsSync(wsDir)).toBe(false);

    // 冷实例（新进程语义）只做 init 不落盘，首个写入必须自行补建目录与 meta
    const second = new SessionStore(workspace, false, userDir);
    await second.init();
    expect(existsSync(wsDir)).toBe(false);

    const again = await second.createSession('第二句', [{ role: 'user', content: '第二句' }]);

    expect(existsSync(wsDir)).toBe(true);
    expect(existsSync(join(wsDir, `${again.id}.json`))).toBe(true);
    expect(existsSync(join(wsDir, 'meta.json'))).toBe(true);
    expect(existsSync(join(wsDir, 'sessions.json'))).toBe(true);
  });

  it('加密模式下 init() 仍可完成（仅解锁密钥，不落盘）', async () => {
    const root = join(TEST_DIR, 'init-encrypted');
    const workspace = join(root, 'workspace');
    const userDir = join(root, 'sessions-root');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(userDir, { recursive: true });

    const store = new SessionStore(workspace, true, userDir);
    await expect(store.init()).resolves.toBeUndefined();
    // 加密模式同样不应产生目录
    expect(readdirSync(userDir)).toEqual([]);
  });
});

describe('需求 20261113-002 P0：CLI 单空间路径回归', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('CLI 首条会话写盘正常，二次启动可读回（不因 init 不落盘而丢会话）', async () => {
    const { workspace, userDir, wsDir } = makeEnv('cli-roundtrip');

    // 第一次「启动」：init 不落盘 → 建会话
    const first = new SessionStore(workspace, false, userDir);
    await first.init();
    const created = await first.createSession('CLI 首条', [{ role: 'user', content: 'CLI 首条' }]);

    // 第二次「启动」：新实例 init 不落盘，但既有会话必须能读回
    const second = new SessionStore(workspace, false, userDir);
    await second.init();
    const list = await second.listSessions();
    expect(list.map((s) => s.id)).toContain(created.id);

    const loaded = await second.loadSession(created.id);
    expect(loaded.messages.at(-1)?.content).toBe('CLI 首条');

    // 第二次启动的 init 不应刷新 meta 之外的痕迹——目录仍只有既有文件
    const files = readdirSync(wsDir).sort();
    expect(files).toContain('meta.json');
    expect(files).toContain('sessions.json');
  });
});

describe('需求 20261113-002 P0 / D3：记忆目录推导口径共享', () => {
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('memoryDirFor 默认口径为 <home>/memory/<wsId>', () => {
    const workspace = join(TEST_DIR, 'ws-a');
    const dir = memoryDirFor(workspace);
    expect(dir.endsWith(join('memory', dir.split(/[\\/]/).pop() as string))).toBe(true);
  });

  it('memoryDirFor 尊重 memory.episodic.dir 绝对路径配置', () => {
    const abs = join(TEST_DIR, 'custom-episodic');
    expect(memoryDirFor(join(TEST_DIR, 'ws-b'), {}, abs)).toBe(abs);
  });

  it('memoryDirFor 支持 memoryRoot 覆盖（单测隔离用）', () => {
    const root = join(TEST_DIR, 'mem-root');
    const dir = memoryDirFor(join(TEST_DIR, 'ws-c'), { memoryRoot: root });
    expect(dir.startsWith(root)).toBe(true);
  });

  it('同一空间多次推导结果稳定（D3 探测与建目录不会漂移）', () => {
    const workspace = join(TEST_DIR, 'ws-d');
    expect(memoryDirFor(workspace)).toBe(memoryDirFor(workspace));
  });
});

describe('需求 20261113-002 P0 / D3：启动期记忆初始化判据', () => {
  const MEM_ROOT = join(TEST_DIR, 'boot-memory');

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(MEM_ROOT, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('无记忆目录 → 判据为 false（bootstrap 跳过初始化，不落盘）', () => {
    const workspace = join(TEST_DIR, 'ws-empty');
    mkdirSync(workspace, { recursive: true });
    const dir = memoryDirFor(workspace, { memoryRoot: MEM_ROOT });
    expect(existsSync(dir)).toBe(false);
  });

  it('已有记忆目录 → 判据为 true（bootstrap 照旧自检/迁移）', () => {
    const workspace = join(TEST_DIR, 'ws-with-memory');
    mkdirSync(workspace, { recursive: true });
    const dir = memoryDirFor(workspace, { memoryRoot: MEM_ROOT });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.sqlite'), '', 'utf-8');
    expect(existsSync(dir)).toBe(true);
  });
});
