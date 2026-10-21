/**
 * 工作空间运行时注册表测试（Task-20261021-010-01 验收 6.2.2 / 6.2.3 / 6.3.1 ~ 6.3.3）
 *
 * 覆盖：
 * - 6.2.2 registry.get(sameRoot) 两次（含并发）返回同一 runtime
 * - 6.2.3 ensureRoot 对不存在/非目录抛 not_found
 * - 6.3.1 evictIdle 淘汰最久未用；有 in-flight 的 runtime 不被淘汰
 * - 6.3.2 maxRuntimes / LOOP_AGENT_MAX_WORKSPACES 生效，非法值回退默认
 * - 6.3.3 list() 长度不超过 maxRuntimes
 *
 * 目录注入临时路径（userDir 覆盖 ~/.loop-agent），避免污染真实用户目录。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceRegistry, ensureDirUsable } from '../src/api/workspace-runtime.js';
import { canonicalWorkspacePath } from '../src/session/path-utils.js';
import { workspaceId } from '../src/session/index.js';
import { keychain } from '../src/session/keychain.js';
import { ApiHttpError } from '../src/api/errors.js';

const ROOT = join(tmpdir(), 'loop-agent-tests', 'test-workspace-registry');
const USER_DIR = join(ROOT, 'user');
const WS = [join(ROOT, 'ws-a'), join(ROOT, 'ws-b'), join(ROOT, 'ws-c')];
const PLAIN_FILE = join(ROOT, 'plain.txt');

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  for (const dir of WS) mkdirSync(dir, { recursive: true });
  writeFileSync(PLAIN_FILE, 'not a directory', 'utf8');
  keychain.ensureUnlocked(); // 与 session-isolation.test 同口径：先解一次锁，避免并发首解竞态
});

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // Windows 目录句柄释放有延迟：残留临时目录不影响测试结果
  }
});

describe('WorkspaceRegistry 懒建与复用', () => {
  it('6.2.2 同一 root 两次调用返回同一 runtime（含并发）', async () => {
    const reg = new WorkspaceRegistry({ userDir: USER_DIR });
    try {
      const a = await reg.get(WS[0]);
      const b = await reg.get(WS[0]);
      expect(a).toBe(b);

      const [c, d] = await Promise.all([reg.get(WS[0]), reg.get(WS[0])]);
      expect(c).toBe(a);
      expect(d).toBe(a);

      // canonical 等价书写（尾分隔符）命中同一实例
      expect(await reg.get(`${WS[0]}${sep}`)).toBe(a);
      expect(reg.list()).toHaveLength(1);
    } finally {
      reg.reset();
    }
  });

  it('runtime 三元组按 canonical root 建立且命名与现状一致', async () => {
    const reg = new WorkspaceRegistry({ userDir: USER_DIR });
    try {
      const rt = await reg.get(WS[1]);
      const canonical = await canonicalWorkspacePath(WS[1]);
      expect(rt.root).toBe(canonical);
      expect(rt.id).toBe(workspaceId(canonical));
      expect(rt.store.path).toBe(canonical);
      expect(rt.store.id).toBe(rt.id);
      expect(rt.sessions.hasInFlight()).toBe(false);
      expect(typeof rt.getMemoryKit).toBe('function');
    } finally {
      reg.reset();
    }
  });

  it('peek 不触发建造；未装载返回 undefined', async () => {
    const reg = new WorkspaceRegistry({ userDir: USER_DIR });
    try {
      const root = await canonicalWorkspacePath(WS[1]);
      expect(reg.peek(root)).toBeUndefined();
      const rt = await reg.get(WS[1]);
      expect(reg.peek(root)).toBe(rt);
    } finally {
      reg.reset();
    }
  });
});

describe('ensureRoot 目录校验', () => {
  it('6.2.3 不存在目录 → not_found', async () => {
    const ghost = join(ROOT, 'no-such-dir');
    const reg = new WorkspaceRegistry({ userDir: USER_DIR });
    const err = await reg.ensureRoot(ghost).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiHttpError);
    expect((err as ApiHttpError).code).toBe('not_found');
  });

  it('6.2.3 普通文件 → not_found', async () => {
    const err = await ensureDirUsable(PLAIN_FILE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiHttpError);
    expect((err as ApiHttpError).code).toBe('not_found');
  });

  it('6.2.3 正常目录 → 返回 canonical root', async () => {
    const reg = new WorkspaceRegistry({ userDir: USER_DIR });
    await expect(reg.ensureRoot(WS[2])).resolves.toBe(await canonicalWorkspacePath(WS[2]));
  });
});

describe('evictIdle 回收', () => {
  it('6.3.1 / 6.3.3 超出 maxRuntimes 时淘汰最久未用', async () => {
    const reg = new WorkspaceRegistry({ userDir: USER_DIR, maxRuntimes: 2 });
    try {
      const r1 = await reg.get(WS[0]);
      r1.lastUsedAt = 1_000;
      const r2 = await reg.get(WS[1]);
      r2.lastUsedAt = 2_000;
      const r3 = await reg.get(WS[2]);
      r3.lastUsedAt = 3_000;
      expect(reg.list()).toHaveLength(3);

      // 未超空闲阈值（30min 默认）：只按 LRU 淘汰最旧的 r1
      reg.evictIdle(1_000 + 60_000);
      expect(reg.list()).toHaveLength(2);
      expect(reg.peek(r1.root)).toBeUndefined();
      expect(reg.peek(r2.root)).toBe(r2);
      expect(reg.peek(r3.root)).toBe(r3);
      expect(reg.list().length).toBeLessThanOrEqual(reg.limit);
    } finally {
      reg.reset();
    }
  });

  it('6.3.1 有 in-flight 的 runtime 不被淘汰且刷新 lastUsedAt', async () => {
    const reg = new WorkspaceRegistry({ userDir: USER_DIR, idleTtlMs: 1_000 });
    try {
      const busy = await reg.get(WS[0]);
      busy.sessions.set('sess_busy', { history: [], inFlight: Promise.resolve() });
      const idle = await reg.get(WS[1]);

      const now = Date.now() + 5_000;
      reg.evictIdle(now);

      expect(reg.peek(busy.root)).toBe(busy);
      expect(busy.lastUsedAt).toBe(now);
      expect(reg.peek(idle.root)).toBeUndefined();
    } finally {
      reg.reset();
    }
  });

  it('reset 清空全部 runtime', async () => {
    const reg = new WorkspaceRegistry({ userDir: USER_DIR });
    await reg.get(WS[0]);
    await reg.get(WS[1]);
    expect(reg.list()).toHaveLength(2);
    reg.reset();
    expect(reg.list()).toHaveLength(0);
  });
});

describe('6.3.2 配置读取', () => {
  it('maxRuntimes 显式传入生效', () => {
    expect(new WorkspaceRegistry({ userDir: USER_DIR, maxRuntimes: 2 }).limit).toBe(2);
  });

  it('LOOP_AGENT_MAX_WORKSPACES 生效，非法值回退默认 4', () => {
    const prev = process.env.LOOP_AGENT_MAX_WORKSPACES;
    try {
      process.env.LOOP_AGENT_MAX_WORKSPACES = '2';
      expect(new WorkspaceRegistry({ userDir: USER_DIR }).limit).toBe(2);

      process.env.LOOP_AGENT_MAX_WORKSPACES = 'abc';
      expect(new WorkspaceRegistry({ userDir: USER_DIR }).limit).toBe(4);

      process.env.LOOP_AGENT_MAX_WORKSPACES = '0';
      expect(new WorkspaceRegistry({ userDir: USER_DIR }).limit).toBe(4);
    } finally {
      if (prev === undefined) delete process.env.LOOP_AGENT_MAX_WORKSPACES;
      else process.env.LOOP_AGENT_MAX_WORKSPACES = prev;
    }
  });
});
