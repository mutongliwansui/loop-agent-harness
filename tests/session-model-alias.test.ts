/**
 * 会话级模型选择元数据（task-20261025-002 D7）
 *
 * 覆盖验收项：
 * - setSessionModelAlias 写入后 listSessions 能读到
 * - 传 undefined / 空串时清除字段（不是留空串）
 * - 未设置过的会话该字段不存在（不能因为默认值把旧会话写脏）
 * - 写入不触碰 messageCount / title / updatedAt（最小写入，不混进 updateSession）
 * - 不存在的会话 id 静默无操作，不新建条目
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/session/index.js';

let root: string;
let store: SessionStore;
let sessionId: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loop-agent-model-alias-'));
  store = new SessionStore(root);
  await store.init();
  const created = await store.createSession('你好', [{ role: 'user', content: '你好' }]);
  sessionId = created.id;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function metaOf(id: string) {
  return (await store.listSessions()).find((s) => s.id === id);
}

describe('SessionStore.setSessionModelAlias', () => {
  it('新建会话默认无 modelAlias（跟随全局语义靠字段缺省表达）', async () => {
    const meta = await metaOf(sessionId);
    expect(meta).toBeDefined();
    expect(meta?.modelAlias).toBeUndefined();
  });

  it('写入后 listSessions 能读回', async () => {
    await store.setSessionModelAlias(sessionId, 'glm');
    expect((await metaOf(sessionId))?.modelAlias).toBe('glm');
  });

  it('覆盖写入取最后一次值', async () => {
    await store.setSessionModelAlias(sessionId, 'glm');
    await store.setSessionModelAlias(sessionId, 'deepseek');
    expect((await metaOf(sessionId))?.modelAlias).toBe('deepseek');
  });

  it('传 undefined 清除字段（而不是留下空串）', async () => {
    await store.setSessionModelAlias(sessionId, 'glm');
    await store.setSessionModelAlias(sessionId, undefined);
    const meta = await metaOf(sessionId);
    expect(meta).toBeDefined();
    expect('modelAlias' in (meta as object)).toBe(false);
  });

  it('传空白字符串等价于清除', async () => {
    await store.setSessionModelAlias(sessionId, 'glm');
    await store.setSessionModelAlias(sessionId, '   ');
    expect('modelAlias' in ((await metaOf(sessionId)) as object)).toBe(false);
  });

  it('前后空格被裁掉', async () => {
    await store.setSessionModelAlias(sessionId, '  glm  ');
    expect((await metaOf(sessionId))?.modelAlias).toBe('glm');
  });

  it('不触碰计数/标题/更新时间（最小写入）', async () => {
    const before = await metaOf(sessionId);
    await store.setSessionModelAlias(sessionId, 'glm');
    const after = await metaOf(sessionId);
    expect(after?.messageCount).toBe(before?.messageCount);
    expect(after?.title).toBe(before?.title);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  it('未知会话 id 不抛错也不新增条目', async () => {
    const count = (await store.listSessions()).length;
    await expect(store.setSessionModelAlias('不存在的会话', 'glm')).resolves.toBeUndefined();
    expect((await store.listSessions()).length).toBe(count);
  });
});
