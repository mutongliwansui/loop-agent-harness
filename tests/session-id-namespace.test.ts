/**
 * sessionId 空间命名空间验收（Task-20261021-010-04 P0 / D5）
 *
 * 覆盖：
 * - 6.1.1 新会话 id 形如 sess_<wsId8>_<YYYYMMDD_HHMMSS>，wsId8 与 workspaceId(root) 前 8 位一致
 * - 6.1.3 同秒两空间创建 → id 不同、文件落在各自目录（无需再靠 1.1s 间隔规避）
 * - 6.1.2 老格式 id（sess_<ts>，无空间段）会话仍可读（兼容，不迁移）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore, workspaceId } from '../src/session/index.js';
import { canonicalWorkspacePath } from '../src/session/path-utils.js';

const ROOT = join(tmpdir(), 'loop-agent-tests', 'test-session-id-namespace');
const USER_DIR = join(ROOT, 'user');
const WS_A = join(ROOT, 'ws-a');
const WS_B = join(ROOT, 'ws-b');

let storeA: SessionStore;
let storeB: SessionStore;
let rootA = '';
let rootB = '';

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(WS_A, { recursive: true });
  mkdirSync(WS_B, { recursive: true });
  rootA = await canonicalWorkspacePath(WS_A);
  rootB = await canonicalWorkspacePath(WS_B);
  storeA = new SessionStore(rootA, false, USER_DIR);
  storeB = new SessionStore(rootB, false, USER_DIR);
  await storeA.init();
  await storeB.init();
});

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // Windows 句柄释放延迟：残留临时目录不影响测试结果
  }
});

describe('6.1.1 新格式 id 含空间段', () => {
  it('id 形如 sess_<wsId8>_<YYYYMMDD_HHMMSS> 且 wsId8 与本空间一致', async () => {
    const meta = await storeA.createSession('命名空间校验', []);
    const wsId8 = workspaceId(rootA).slice(0, 8);
    expect(meta.id).toMatch(new RegExp(`^sess_${wsId8}_\\d{8}_\\d{6}$`));
  });
});

describe('6.1.3 同秒两空间创建不撞名', () => {
  it('无间隔并发创建：id 不同、文件各自落盘、索引互不可见', async () => {
    // 同一秒内两个空间各建一条（不同 wsId8 → 不撞；不再需要 task-03 的 1.1s 间隔规避）
    const [metaA, metaB] = await Promise.all([
      storeA.createSession('空间A同秒', []),
      storeB.createSession('空间B同秒', []),
    ]);

    expect(metaA.id).not.toBe(metaB.id);
    expect(metaA.id.startsWith(`sess_${workspaceId(rootA).slice(0, 8)}_`)).toBe(true);
    expect(metaB.id.startsWith(`sess_${workspaceId(rootB).slice(0, 8)}_`)).toBe(true);
    expect(existsSync(join(storeA.sessionsDir, metaA.file))).toBe(true);
    expect(existsSync(join(storeB.sessionsDir, metaB.file))).toBe(true);

    const listA = (await storeA.listSessions()).map((s) => s.id);
    const listB = (await storeB.listSessions()).map((s) => s.id);
    expect(listA).toContain(metaA.id);
    expect(listA).not.toContain(metaB.id);
    expect(listB).toContain(metaB.id);
    expect(listB).not.toContain(metaA.id);
  });
});

describe('6.1.2 老格式 id 兼容读取', () => {
  it('手工落盘的 sess_<ts> 老会话可被 loadSession 正常读取', async () => {
    const oldId = 'sess_20200101_000000';
    const now = new Date('2020-01-01T00:00:00.000Z').toISOString();
    // 直接写明文会话文件（无空间段的老格式）
    writeFileSync(
      join(storeB.sessionsDir, `${oldId}.json`),
      JSON.stringify(
        {
          id: oldId,
          createdAt: now,
          updatedAt: now,
          messages: [
            { role: 'user', content: '老会话问题', is_compact: false, is_show: true },
            { role: 'assistant', content: '老会话回答', is_compact: false, is_show: true },
          ],
        },
        null,
        2,
      ),
      'utf-8',
    );

    const data = await storeB.loadSession(oldId);
    expect(data.id).toBe(oldId);
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0].content).toBe('老会话问题');

    // 清理，避免影响其他用例
    await storeB.deleteSession(oldId);
    expect(existsSync(join(storeB.sessionsDir, `${oldId}.json`))).toBe(false);
  });
});
