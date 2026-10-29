/**
 * 回归：L1 压缩落盘顺序必须是「原始轨迹顺序」（需求 20261029-003）
 *
 * 缺陷背景：`planCompaction()` 在单轮长任务（整段历史只有 1 条 user、且消息 token 超预算）时
 * 走 `withinTurnTrim` 从尾部按 token 截尾，必然先把当前轮原始 user 削掉，于是把它从 droppable
 * 摘出、`kept = [anchor, ...tail]` 钉到最前；但 anchor 与其后 tail 之间的消息仍留在 droppable。
 * 旧落盘逻辑按「先 dropped → 再 summary → 最后 recent」拼接，导致被 pin 的 user 排到了
 * 它引发的那一整段归档消息之后，界面表现为「用户消息位置错误」。
 *
 * 修复：归档/保留只在 is_compact 标记上区分，磁盘顺序按 transcript 原始下标升序重建。
 * 本测试锁定三条不变量：
 *   1) 顺序 —— 任一 user 消息排在其后所有消息之前（轨迹下标 0 < 1）
 *   2) 标记 —— dropped 为 is_compact=true，anchor 与 tail 为 false（压缩语义不变）
 *   3) 恢复集合 —— getRestoreMessages 只取非折叠消息，与修复前一致（不丢不增）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SessionStore } from '../src/session/store.js';
import type { ChatMessage } from '../src/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const BASE = join(tmpdir(), 'loop-agent-tests', 'compaction-order');

function msg(
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { role, content, ...extra } as ChatMessage;
}

/**
 * 构造 planCompaction「单轮 token 截尾 + 任务锚点 pin」的产物。
 * transcript 下标：0 = 本轮 user（被 pin 的锚点），1..8 = 本轮被丢弃的工具往返，9..10 = 尾部保留。
 * messages（内存压缩视图）为 buildCompactedView 产物 [system, summary, anchor, ...tail]。
 */
function buildPinScenario(): {
  transcript: ChatMessage[];
  messages: ChatMessage[];
  userTurn: ChatMessage;
  dropped: ChatMessage[];
  tail: ChatMessage[];
} {
  const userTurn = msg('user', '按推荐来');
  const dropped: ChatMessage[] = [];
  for (let i = 1; i <= 8; i++) {
    dropped.push(msg(i % 2 === 1 ? 'assistant' : 'tool', `第 ${i} 步工具往返：${'x'.repeat(40)}`));
  }
  const tail = [msg('assistant', '尾部保留的回答 1'), msg('tool', '尾部保留的工具结果 2')];
  const transcript = [userTurn, ...dropped, ...tail];
  const placeholder = msg('user', '早前的关键事实', { is_show: false, kind: 'summary' });
  const messages = [msg('system', '你是智能助手'), placeholder, userTurn, ...tail];
  return { transcript, messages, userTurn, dropped, tail };
}

/** 磁盘上第一条 user 消息的位置应早于所有工具往返 */
function assertUserBeforeItsTurn(
  stored: ChatMessage[],
  userTurn: ChatMessage,
  dropped: ChatMessage[],
): void {
  const userIdx = stored.findIndex((m) => m.role === 'user' && m.content === userTurn.content);
  expect(userIdx, '应能在落盘消息中找到本轮 user').toBeGreaterThanOrEqual(0);
  const droppedIdx = dropped.map((d) => stored.findIndex((m) => m.content === d.content));
  // 全部工具往返都必须排在本轮 user 之后（修复前此处 user 位于它们之后，断言必失败）
  for (const [i, idx] of droppedIdx.entries()) {
    expect(idx, `第 ${i + 1} 条工具往返应存在`).toBeGreaterThanOrEqual(0);
    expect(
      idx,
      `本轮 user 应排在第 ${i + 1} 条工具往返之前（实际 user@${userIdx} / 往返@${idx}）`,
    ).toBeGreaterThan(userIdx);
  }
}

describe('需求 20261029-003：L1 压缩落盘顺序 = 原始轨迹顺序', () => {
  beforeAll(() => {
    rmSync(BASE, { recursive: true, force: true });
    mkdirSync(BASE, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(BASE, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放，残留不影响结果
    }
  });

  it('updateSession：锚点被 pin 时用户消息仍在其引发的消息之前', async () => {
    const wsDir = join(BASE, 'update');
    const store = new SessionStore(wsDir, false, join(wsDir, 'user'));
    await store.init();
    const meta = await store.createSession('种子会话', [msg('system', '你是智能助手')]);

    const { transcript, messages, userTurn, dropped, tail } = buildPinScenario();
    const stored = await store.updateSession(meta.id, messages, '按推荐来', { transcript });

    // 1) 顺序不变量
    assertUserBeforeItsTurn(stored, userTurn, dropped);
    // 尾部保留消息也应排在 user 之后
    for (const t of tail) {
      const idx = stored.findIndex((m) => m.content === t.content);
      const userIdx = stored.findIndex((m) => m.role === 'user' && m.content === userTurn.content);
      expect(idx).toBeGreaterThan(userIdx);
    }
    // 2) 标记不变量：compacted = dropped，recent = anchor + tail
    for (const d of dropped) {
      const item = stored.find((m) => m.content === d.content);
      expect(item?.is_compact, '被丢弃消息应标记折叠').toBe(true);
    }
    for (const r of [userTurn, ...tail]) {
      const item = stored.find((m) => m.content === r.content);
      expect(item?.is_compact, '保留消息不应标记折叠').toBe(false);
    }
    // 集合不变量：条数 = system + summary + 轨迹全部
    expect(stored.length).toBe(1 + 1 + transcript.length);
  });

  it('updateSession：getRestoreMessages 恢复集合与修复前一致（只取非折叠 + 摘要）', async () => {
    const wsDir = join(BASE, 'restore');
    const store = new SessionStore(wsDir, false, join(wsDir, 'user'));
    await store.init();
    const meta = await store.createSession('种子会话', [msg('system', '你是智能助手')]);

    const { transcript, messages, userTurn, dropped, tail } = buildPinScenario();
    await store.updateSession(meta.id, messages, '按推荐来', { transcript });
    const data = await store.loadSession(meta.id);
    const restored = SessionStore.getRestoreMessages(data).filter((m) => m.role !== 'system');

    // 摘要恰好一条（kind=summary，不展示）
    const summaries = restored.filter((m) => m.kind === 'summary');
    expect(summaries.length).toBe(1);
    // 折叠消息不进入上下文
    for (const d of dropped) {
      expect(restored.some((m) => m.content === d.content)).toBe(false);
    }
    // 保留消息全部进入上下文，且顺序为 user → tail
    const body = restored.filter((m) => m.kind !== 'summary');
    expect(body.map((m) => m.content)).toEqual([userTurn, ...tail].map((m) => m.content));
  });

  it('updateSession：连续两次同内容快照幂等（不重复、不重排）', async () => {
    const wsDir = join(BASE, 'idem');
    const store = new SessionStore(wsDir, false, join(wsDir, 'user'));
    await store.init();
    const meta = await store.createSession('种子会话', [msg('system', '你是智能助手')]);

    const first = buildPinScenario();
    const stored1 = await store.updateSession(meta.id, first.messages, '按推荐来', {
      transcript: first.transcript,
    });
    // 同一 run 的第二次快照：transcript 与内存视图都增长（尾部多一轮）
    const extra = msg('assistant', '尾部新增的回答');
    const transcript2 = [...first.transcript, extra];
    const messages2 = [...first.messages, extra];
    const stored2 = await store.updateSession(meta.id, messages2, '按推荐来', {
      transcript: transcript2,
    });

    expect(stored2.length).toBe(stored1.length + 1);
    assertUserBeforeItsTurn(stored2, first.userTurn, first.dropped);
    // 无重复条目
    const contents = stored2.map((m) => m.content);
    expect(new Set(contents).size).toBe(contents.length);
  });

  it('createSession：首轮即压缩时同样按轨迹顺序落盘', async () => {
    const wsDir = join(BASE, 'create');
    const store = new SessionStore(wsDir, false, join(wsDir, 'user'));
    await store.init();

    const { transcript, messages, userTurn, dropped } = buildPinScenario();
    const meta = await store.createSession('按推荐来', messages, { transcript });
    const data = await store.loadSession(meta.id);

    assertUserBeforeItsTurn(data.messages, userTurn, dropped);
    for (const d of dropped) {
      expect(data.messages.find((m) => m.content === d.content)?.is_compact).toBe(true);
    }
  });
});
