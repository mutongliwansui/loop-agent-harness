/**
 * 会话文件撕裂恢复（2026-11-07 会话展示报错修复）
 *
 * 背景：原子写的临时文件名曾用 pid+毫秒，同一毫秒内并发落盘会撞名，
 * 两个 writeFile 交错截断会把旧 payload 尾段留在新 JSON 后面，
 * 表现为 `Unexpected non-whitespace character after JSON at position N`。
 *
 * 覆盖：
 * - 有效 JSON + 尾部残留 → loadSession 按有效前缀读成功
 * - 前缀本身非法（真截断）→ 仍然抛错，不把坏文件当成功
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore, workspaceId } from '../src/session/store.js';

let root: string;
let userDir: string;
let store: SessionStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loop-agent-session-recovery-'));
  userDir = join(root, 'user');
  store = new SessionStore(join(root, 'workspace'), false, userDir);
  await store.init();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 还原落盘路径：<userDir>/sessions/<workspaceId>/<id>.json */
function sessionFile(id: string): string {
  return join(userDir, 'sessions', workspaceId(join(root, 'workspace')), `${id}.json`);
}

describe('readSession：尾部残留字节容错', () => {
  it('有效 JSON 后追加旧 payload 尾段 → 按有效前缀读取成功', async () => {
    const created = await store.createSession('你好', [{ role: 'user', content: '你好' }]);
    const file = sessionFile(created.id);
    const raw = await readFile(file, 'utf-8');
    // 模拟撕裂：完整 JSON 后残留上一版 payload 的结构尾段
    await writeFile(file, `${raw}agent_result"\n    }\n  ]\n}`, 'utf-8');

    await expect(store.loadSession(created.id)).resolves.toMatchObject({
      id: created.id,
      messages: [{ role: 'user', content: '你好' }],
    });
  });

  it('前缀本身非法（真截断）→ 仍然抛错', async () => {
    const created = await store.createSession('hi', [{ role: 'user', content: 'hi' }]);
    await writeFile(sessionFile(created.id), '{"id":"x","messages":[', 'utf-8');

    await expect(store.loadSession(created.id)).rejects.toThrow(/Unterminated|Unexpected/);
  });
});
