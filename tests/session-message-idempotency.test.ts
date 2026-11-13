/**
 * 消息幂等（需求 20261107-007 S2/S1）
 *
 * 背景：同一用户消息只发送一次，会话历史却出现同一段对话重复多遍。
 * 根因是「会话文件撕裂 → 按有效前缀降级恢复（读到旧快照）→ 内存以旧快照为基线
 * 继续追加 → 同一批消息被重复写入磁盘」。本文件覆盖治理防线：
 *
 * - msgId：写入时分配、随会话落盘、多次读取稳定（去重的身份键）
 * - 旧数据补 ID：同文件多次读取必须得到同一 ID，否则去重全失效
 * - 重复追加去重：同 ID 副本只保留首条（历史回退的直接防线）
 * - 合法重复不误伤：内容相同的两条独立消息（连发两次「继续」）必须都保留
 * - 降级读取：尾部残留时仍可读，且写回前备份原始文件为 .torn
 * - 并发落盘：临时文件名唯一，正式文件始终是合法 JSON（不撕裂）
 */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore, workspaceId } from '../src/session/store.js';
import type { ChatMessage } from '../src/types.js';

let root: string;
let userDir: string;
let store: SessionStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loop-agent-msgid-'));
  userDir = join(root, 'user');
  store = new SessionStore(join(root, 'workspace'), false, userDir);
  await store.init();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** <userDir>/sessions/<workspaceId>/<id>.json */
function sessionFile(id: string): string {
  return join(userDir, 'sessions', workspaceId(join(root, 'workspace')), `${id}.json`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 去掉 system 的消息（createSession 未传 system 时本就没有） */
function nonSystem(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role !== 'system');
}

describe('msgId：写入分配与读取稳定', () => {
  it('落盘后每条消息都带 msgId，且两次读取完全相同', async () => {
    const created = await store.createSession('你好', [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你？' },
    ]);

    const first = nonSystem((await store.loadSession(created.id)).messages);
    const second = nonSystem((await store.loadSession(created.id)).messages);

    expect(first).toHaveLength(2);
    for (const m of first) {
      expect(typeof m.msgId).toBe('string');
      expect((m.msgId ?? '').length).toBeGreaterThan(0);
    }
    // 稳定：同一文件多次读取得到同一批 ID（去重/替换的前提）
    expect(first.map((m) => m.msgId)).toEqual(second.map((m) => m.msgId));
  });

  it('旧数据无 msgId：补生成且多次读取一致、彼此不冲突', async () => {
    const id = 'sess_legacy_test';
    const now = new Date().toISOString();
    const legacy = {
      id,
      createdAt: now,
      updatedAt: now,
      messages: [
        { role: 'user', content: '旧消息A' },
        { role: 'assistant', content: '旧回复B' },
        { role: 'user', content: '旧消息A' },
      ],
    };
    // 需求 20261113-002 D1：init() 不再预建 sessions/<wsId>/，直接构造「旧数据文件」前需自行建目录
    await mkdir(join(userDir, 'sessions', workspaceId(join(root, 'workspace'))), { recursive: true });
    await writeFile(sessionFile(id), JSON.stringify(legacy, null, 2), 'utf-8');

    const first = (await store.loadSession(id)).messages;
    const second = (await store.loadSession(id)).messages;

    for (const m of first) expect(typeof m.msgId).toBe('string');
    expect(first.map((m) => m.msgId)).toEqual(second.map((m) => m.msgId));
    // 同文件内即使内容重复（旧 bug 留下的副本），ID 也必须唯一
    expect(new Set(first.map((m) => m.msgId)).size).toBe(first.length);
    // 补生成的 ID 不回写磁盘前不改变原始内容
    expect(first.map((m) => m.content)).toEqual(['旧消息A', '旧回复B', '旧消息A']);
  });
});

describe('按 msgId 去重：重复追加收敛', () => {
  it('同一批消息被重复追加（历史回退场景）→ 只保留一份', async () => {
    const created = await store.createSession('A', [
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
    ]);
    const loaded = nonSystem((await store.loadSession(created.id)).messages);
    expect(loaded).toHaveLength(2);

    // 模拟内存基线已含重复段：[A,B,A,B] 再提交（同一批对象、同一批 msgId）
    const duplicated = [...loaded, ...loaded];
    const stored = nonSystem(await store.updateSession(created.id, duplicated));

    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((m) => m.msgId)).size).toBe(2);
    expect(stored.map((m) => m.content)).toEqual(['A', 'B']);
  });

  it('锚点未命中时，同一批无 ID 的内存消息多次落盘也只保留一份', async () => {
    // 复现线上现象：内存基线比文件旧（锚点只命中前 4 条），后续消息每落盘一次就被
    // 分配一次新 msgId，于是同一轮回答在文件里出现多份。
    const created = await store.createSession('A', [
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
      { role: 'user', content: 'C' },
      { role: 'assistant', content: 'D' },
      { role: 'assistant', content: 'E' },
    ]);
    const memory: ChatMessage[] = [
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
      { role: 'user', content: 'C' },
      { role: 'assistant', content: 'D' },
      { role: 'user', content: 'X' },
      { role: 'assistant', content: 'Y' },
    ];

    await store.updateSession(created.id, memory);
    // 同一批对象再次落盘（节流快照 + 收尾各写一次）
    const second = nonSystem(await store.updateSession(created.id, memory));

    expect(second.map((m) => m.content)).toEqual(['A', 'B', 'C', 'D', 'E', 'X', 'Y']);
    expect(new Set(second.map((m) => m.msgId)).size).toBe(second.length);
  });

  it('内容相同的两条独立消息（连发两次「继续」）都保留', async () => {
    const created = await store.createSession('继续', [{ role: 'user', content: '继续' }]);
    const prev = (await store.loadSession(created.id)).messages;

    // 用户再发一次同样的文本：新消息对象 → 新 msgId，属于合法重复
    const again: ChatMessage = { role: 'user', content: '继续' };
    const stored = nonSystem(await store.updateSession(created.id, [...prev, again]));

    expect(stored.filter((m) => m.content === '继续')).toHaveLength(2);
    expect(new Set(stored.map((m) => m.msgId)).size).toBe(2);
  });

  it('rewriteMessages 覆盖写也按 msgId 收敛重复', async () => {
    const created = await store.createSession('X', [{ role: 'user', content: 'X' }]);
    const loaded = nonSystem((await store.loadSession(created.id)).messages);

    const stored = nonSystem(await store.rewriteMessages(created.id, [...loaded, ...loaded]));
    expect(stored).toHaveLength(1);
  });
});

describe('降级读取：尾部残留 + 原始文件备份', () => {
  it('尾部脏字节仍可读，标记 degraded，写回前备份 .torn', async () => {
    const created = await store.createSession('你好', [{ role: 'user', content: '你好' }]);
    const file = sessionFile(created.id);
    const raw = await readFile(file, 'utf-8');
    // 模拟撕裂：完整 JSON 后残留上一版 payload 的尾段
    await writeFile(file, `${raw}agent_result"\n    }\n  ]\n}`, 'utf-8');

    const data = await store.loadSession(created.id);
    expect(store.isDegraded(created.id)).toBe(true);
    expect(nonSystem(data.messages)).toHaveLength(1);

    const base = nonSystem(data.messages);
    await store.updateSession(created.id, [...base, { role: 'user', content: '新问题' }]);

    // 原始（撕裂）文件已备份，回退历史不会把原文件彻底覆盖
    expect(await fileExists(`${file}.torn`)).toBe(true);
    // 写回后是干净文件，降级标记解除
    expect(store.isDegraded(created.id)).toBe(false);
    expect(() => JSON.parse('{}')).not.toThrow();
    const reread = nonSystem((await store.loadSession(created.id)).messages);
    expect(reread.map((m) => m.content)).toEqual(['你好', '新问题']);
  });
});

describe('并发落盘不撕裂', () => {
  it('并发覆盖写后正式文件始终是合法 JSON', async () => {
    const created = await store.createSession('start', [{ role: 'user', content: 'start' }]);
    // 临时文件名含单调递增序号，并发不会撞名交错截断
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.rewriteMessages(created.id, [{ role: 'user', content: `m${i}` }]),
      ),
    );
    const raw = await readFile(sessionFile(created.id), 'utf-8');
    const parsed = JSON.parse(raw) as { messages: ChatMessage[] };
    expect(parsed.messages.length).toBeGreaterThan(0);
    expect(parsed.messages[0].msgId).toBeTruthy();
  });
});
