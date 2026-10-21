/**
 * 会话归属定位验收（Task-20261021-010-04 P0 / D17）
 *
 * 覆盖（对应任务文档 3.2 三级策略）：
 * - 新格式 id：已装载 runtime O(1) 段解析命中
 * - 新格式 id：未装载空间按 wsId8 扫 meta.json 反查 root 并懒建
 * - 老格式 id：全扫回退定位 + 进程内映射缓存复用
 * - 未知 id：not_found
 * - resolveCurrentRuntime：最近使用指针优先，缺省回落启动空间
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceRegistry } from '../src/api/workspace-runtime.js';
import { locateSession, resolveCurrentRuntime } from '../src/api/session-locator.js';
import { ApiHttpError } from '../src/api/errors.js';
import { canonicalWorkspacePath } from '../src/session/path-utils.js';
import { workspaceId } from '../src/session/index.js';

const ROOT = join(tmpdir(), 'loop-agent-tests', 'test-session-locator');
const USER_DIR = join(ROOT, 'user');
const WS_A = join(ROOT, 'ws-a');
const WS_B = join(ROOT, 'ws-b');

let registry: WorkspaceRegistry;
let rootA = '';
let rootB = '';
let sessionA = '';
let sessionB = '';

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(WS_A, { recursive: true });
  mkdirSync(WS_B, { recursive: true });
  rootA = await canonicalWorkspacePath(WS_A);
  rootB = await canonicalWorkspacePath(WS_B);
  registry = new WorkspaceRegistry({ userDir: USER_DIR });
  const rtA = await registry.get(rootA);
  const rtB = await registry.get(rootB);
  sessionA = (await rtA.store.createSession('A 的会话', [])).id;
  sessionB = (await rtB.store.createSession('B 的会话', [])).id;
});

afterAll(() => {
  registry.reset();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // Windows 句柄释放延迟：残留临时目录不影响测试结果
  }
});

describe('新格式 id 段解析', () => {
  it('已装载 runtime：O(1) 前缀命中归属空间', async () => {
    const rt = await locateSession(registry, sessionA);
    expect(rt.root).toBe(rootA);
    const rtB = await locateSession(registry, sessionB);
    expect(rtB.root).toBe(rootB);
  });

  it('未装载空间：按 wsId8 扫 meta.json 反查 root 并懒建 runtime', async () => {
    // 全新 registry（同 userDir）：没有任何已装载 runtime，靠磁盘反查
    const fresh = new WorkspaceRegistry({ userDir: USER_DIR });
    const rt = await locateSession(fresh, sessionB);
    expect(rt.root).toBe(rootB);
    expect(rt.id).toBe(workspaceId(rootB));
    expect(fresh.peek(rootB)).toBe(rt); // 懒建后已装载
    fresh.reset();
  });
});

describe('老格式 id 全扫回退', () => {
  it('sess_<ts> 老 id 经全扫定位到归属空间，二次定位走缓存结果一致', async () => {
    const oldId = 'sess_20210606_120000';
    const now = new Date('2021-06-06T12:00:00.000Z').toISOString();
    const dirB = join(USER_DIR, 'sessions', workspaceId(rootB));
    writeFileSync(
      join(dirB, `${oldId}.json`),
      JSON.stringify({ id: oldId, createdAt: now, updatedAt: now, messages: [] }, null, 2),
      'utf-8',
    );

    const fresh = new WorkspaceRegistry({ userDir: USER_DIR });
    const first = await locateSession(fresh, oldId);
    expect(first.root).toBe(rootB);
    // 第二次（命中进程内映射缓存）：结果一致
    const second = await locateSession(fresh, oldId);
    expect(second.root).toBe(rootB);
    fresh.reset();
  });
});

describe('异常路径', () => {
  it('未知 id → not_found（新格式段无法解析 + 全扫未命中）', async () => {
    await expect(locateSession(registry, 'sess_00000000_20990101_000000')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(locateSession(registry, 'sess_20990101_000000')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(locateSession(registry, 'sess_00000000_20990101_000000')).rejects.toBeInstanceOf(
      ApiHttpError,
    );
  });
});

describe('resolveCurrentRuntime（D9 最近使用指针）', () => {
  it('无指针时回落 fallback 空间；取用后跟随最近使用', async () => {
    const fresh = new WorkspaceRegistry({ userDir: USER_DIR });
    // currentRoot 为空 → fallback（启动空间）
    const boot = await resolveCurrentRuntime(fresh, rootA);
    expect(boot.root).toBe(rootA);
    // 显式取用 B（如跨空间定位/创建）后，最近使用指针跟随 B
    await fresh.get(rootB);
    const again = await resolveCurrentRuntime(fresh, rootA);
    expect(again.root).toBe(rootB);
    fresh.reset();
  });
});
