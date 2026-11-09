/**
 * 回归：后台子任务结果卡片的 kind 标记在全量重写中不得丢失（需求 20261108-003）
 *
 * 缺陷背景：旧版 toStoredMessage 对非 summary 消息无条件 `delete out.kind`，
 * 压缩轮次会把磁盘全量历史重新 map(toStoredMessage)（轨迹重建/legacy 回退两条路径），
 * 卡片的 kind='subagent_result' 被抹掉——后端按内容特征（isSubAgentResultContent）
 * 仍能正确过滤 LLM 上下文，但前端（只认 kind）进不了卡片分支，
 * <subagent_result> 原文被当普通文本渲染到界面上（模型看不见、用户全看见）。
 *
 * 修复：
 *   1) toStoredMessage 按内容特征补回卡片 kind（与后端判据同源，天然幂等）；
 *   2) 新增 repairSubAgentCardKinds 修复存量脏数据（冷启动时调用）；
 *   3) 前端识别加内容兜底（见 webui-subagent-card-fallback.test.ts）。
 *
 * 本文件锁定后端三条不变量：
 *   A) 非压缩路径落盘：卡片 kind 保留
 *   B) 压缩全量重写落盘：卡片 kind 仍保留（缺陷场景）
 *   C) repairSubAgentCardKinds：补回缺失标记、幂等；getRestoreMessages 过滤不受影响
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SessionStore } from '../src/session/store.js';
import type { ChatMessage } from '../src/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const BASE = join(tmpdir(), 'loop-agent-tests', 'subagent-card-kind');

function msg(
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { role, content, ...extra } as ChatMessage;
}

const CARD = [
  '<subagent_result>',
  'taskId: sub_kind_1',
  'status: done',
  'task: 检查 kind 保留',
  'elapsedMs: 1200',
  'iterations: 2',
  'answer: 完成',
  'error: ',
  '</subagent_result>',
].join('\n');

/** 构造 planCompaction「单轮 token 截尾 + 任务锚点 pin」场景，卡片放在尾部保留区 */
function buildPinScenarioWithCard(): { transcript: ChatMessage[]; messages: ChatMessage[] } {
  const userTurn = msg('user', '按推荐来');
  const dropped: ChatMessage[] = [];
  for (let i = 1; i <= 8; i++) {
    dropped.push(msg(i % 2 === 1 ? 'assistant' : 'tool', `第 ${i} 步工具往返：${'x'.repeat(40)}`));
  }
  // 卡片在尾部保留区（is_compact=false），压缩重建时必然被重新 toStoredMessage
  const tail = [msg('assistant', '尾部保留的回答'), msg('user', CARD, { is_show: true, kind: 'subagent_result' })];
  const transcript = [userTurn, ...dropped, ...tail];
  const placeholder = msg('user', '早前的关键事实', { is_show: false, kind: 'summary' });
  const messages = [msg('system', '你是智能助手'), placeholder, userTurn, ...tail];
  return { transcript, messages };
}

describe('需求 20261108-003：卡片 kind 标记不因全量重写丢失', () => {
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

  it('A) 非压缩路径：卡片落盘后 kind 保留', async () => {
    const wsDir = join(BASE, 'plain');
    const store = new SessionStore(wsDir, false, join(wsDir, 'user'));
    await store.init();
    const meta = await store.createSession('种子会话', [msg('system', '你是智能助手')]);

    const stored = await store.updateSession(
      meta.id,
      [
        msg('system', '你是智能助手'),
        msg('user', '你好'),
        msg('assistant', '回答'),
        msg('user', CARD, { is_show: true, kind: 'subagent_result' }),
      ],
      '你好',
    );

    const card = stored.find((m) => m.role === 'user' && m.content === CARD);
    expect(card, '卡片消息应落盘').toBeDefined();
    expect(card?.kind, '卡片 kind 应保留').toBe('subagent_result');
    expect(card?.is_compact).toBe(false);
  });

  it('B) 压缩全量重写：卡片 kind 仍保留（缺陷场景）', async () => {
    const wsDir = join(BASE, 'compact');
    const store = new SessionStore(wsDir, false, join(wsDir, 'user'));
    await store.init();
    const meta = await store.createSession('种子会话', [msg('system', '你是智能助手')]);

    const { transcript, messages } = buildPinScenarioWithCard();
    const stored = await store.updateSession(meta.id, messages, '按推荐来', { transcript });

    const card = stored.find((m) => m.role === 'user' && m.content === CARD);
    expect(card, '卡片消息应落盘').toBeDefined();
    expect(card?.kind, '压缩重建后卡片 kind 应保留（修复前被 delete 抹掉）').toBe('subagent_result');
    expect(card?.is_compact, '尾部保留区卡片不应被折叠').toBe(false);
  });

  it('C) repairSubAgentCardKinds：补回存量缺失标记且幂等；LLM 上下文过滤不受影响', async () => {
    const wsDir = join(BASE, 'repair');
    const store = new SessionStore(wsDir, false, join(wsDir, 'user'));
    await store.init();
    const meta = await store.createSession('种子会话', [msg('system', '你是智能助手')]);

    await store.updateSession(
      meta.id,
      [
        msg('system', '你是智能助手'),
        msg('user', '你好'),
        msg('user', CARD, { is_show: true, kind: 'subagent_result' }),
      ],
      '你好',
    );

    // 模拟存量脏数据：覆盖写抹掉 kind（rewriteMessages 不重算标记，等价于旧版落盘产物）
    const data = await store.loadSession(meta.id);
    const dirty = data.messages.map((m) =>
      m.kind === 'subagent_result' ? { ...m, kind: undefined } : m,
    );
    await store.rewriteMessages(meta.id, dirty);
    const before = await store.loadSession(meta.id);
    expect(before.messages.find((m) => m.content === CARD)?.kind).toBeUndefined();

    // 修复：按内容特征补回
    const changed = await store.repairSubAgentCardKinds(meta.id);
    expect(changed).toBe(1);
    const after = await store.loadSession(meta.id);
    expect(after.messages.find((m) => m.content === CARD)?.kind).toBe('subagent_result');

    // 幂等：再跑一次不再有改动
    expect(await store.repairSubAgentCardKinds(meta.id)).toBe(0);

    // LLM 上下文过滤不受 kind 影响（按内容特征，卡片不进恢复集合）
    const restored = SessionStore.getRestoreMessages(after).filter((m) => m.role !== 'system');
    expect(restored.some((m) => m.content === CARD)).toBe(false);
    expect(restored.some((m) => m.content === '你好')).toBe(true);
  });
});
