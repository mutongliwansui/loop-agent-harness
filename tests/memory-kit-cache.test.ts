/**
 * memory-kit 共享缓存测试（Task-20261021-002-05 验收 6.2.6/6.2.8）
 *
 * 覆盖：
 * - 6.2.6 getMemoryKit 同 cwd 两次调用返回同一 Promise 实例；resetMemoryKitCache 后重建
 * - 不同 cwd → 不同 kit（按 workspaceId 分键）
 * - createMemoryKit 直接工厂不受缓存影响（每次新建）
 *
 * 目录注入临时路径，避免污染真实 ~/.loop-agent。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getMemoryKit, resetMemoryKitCache, createMemoryKit } from '../src/api/memory-kit.js';
import { configLoader } from '../src/config/loader.js';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-memory-kit-cache');
const WS_A = join(TEST_DIR, 'ws-a');
const WS_B = join(TEST_DIR, 'ws-b');
const MEM_ROOT = join(TEST_DIR, 'mem-root');
const CURATED_DIR = join(TEST_DIR, 'curated');

beforeAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  resetMemoryKitCache(); // 隔离其他测试可能残留的缓存状态
});

afterAll(async () => {
  // resetMemoryKitCache 仅清 Map 引用不关句柄：先取缓存中的 kit 关闭 sqlite 索引，再清理目录
  for (const ws of [WS_A, WS_B]) {
    const kit = await getMemoryKit(ws, { memoryRoot: MEM_ROOT, globalCuratedDir: CURATED_DIR }).catch(() => null);
    kit?.episodic.closeIndex();
  }
  resetMemoryKitCache();
  // Windows sqlite 句柄释放有 OS 级延迟（reset 前的旧 kit 引用已不可达），
  // 残留临时目录不影响测试结果，容忍清理失败
  try {
    rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // ignore
  }
});

describe('memory-kit Map 缓存（20261021-002-05 D2）', () => {
  it('6.2.6 同 cwd 两次调用返回同一 Promise；reset 后重建（新实例）', async () => {
    const opts = { memoryRoot: MEM_ROOT, globalCuratedDir: CURATED_DIR };
    const p1 = getMemoryKit(WS_A, opts);
    const p2 = getMemoryKit(WS_A, opts);
    expect(p2).toBe(p1); // memoized：同一 Promise 实例

    const k1 = await p1;
    const k1b = await getMemoryKit(WS_A, opts);
    expect(k1b).toBe(k1); // 解引用后仍是同一 kit 对象

    resetMemoryKitCache();
    const k2 = await getMemoryKit(WS_A, opts);
    expect(k2).not.toBe(k1); // reset 后新建 kit 实例
  });

  it('不同 cwd → 不同 kit 实例（按 workspaceId 分键）', async () => {
    const opts = { memoryRoot: MEM_ROOT, globalCuratedDir: CURATED_DIR };
    const ka = await getMemoryKit(WS_A, opts);
    const kb = await getMemoryKit(WS_B, opts);
    expect(ka).not.toBe(kb);
  });

  it('6.2.8 createMemoryKit 工厂不缓存（/memory 端点独立组装语义不回归）', async () => {
    const k1 = await createMemoryKit(WS_A, configLoader, {
      memoryRoot: MEM_ROOT,
      globalCuratedDir: CURATED_DIR,
    });
    const k2 = await createMemoryKit(WS_A, configLoader, {
      memoryRoot: MEM_ROOT,
      globalCuratedDir: CURATED_DIR,
    });
    expect(k2).not.toBe(k1);
    // 关闭测试自建实例的索引句柄（Windows 下避免文件锁阻碍清理）
    k1.episodic.closeIndex();
    k2.episodic.closeIndex();
  });
});
