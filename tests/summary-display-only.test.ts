/**
 * 回归：摘要消息不能被「展示专用消息」判定误伤（需求 20261114-007）
 *
 * 故障现场：压缩摘要正文引用了历史里的后台任务通知，恰好以
 * `</background_task_notification>` 结尾；旧实现只按 content 后缀判定展示消息，
 * 导致整条摘要被从 LLM 视图 / 会话恢复视图剔除，表现为
 * 「system 后面直接跟着 assistant，历史摘要消失」。
 */
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/session/store.js';
import { isDisplayOnlyMessage, isSummaryMessage } from '../src/memory/summary-message.js';
import type { ChatMessage } from '../src/types.js';
import type { SessionData } from '../src/session/types.js';

function summary(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    role: 'user',
    content:
      '- 仓库 D:\\trae_workspace\\loop-agent-command\n' +
      'status: exited (exitCode=0)\n' +
      'logTail:\n(无输出)\n' +
      '</background_task_notification>',
    kind: 'summary',
    is_show: false,
    ...over,
  } as ChatMessage;
}

describe('isDisplayOnlyMessage', () => {
  it('摘要正文即使以通知/卡片闭合标签结尾，也不算展示专用消息', () => {
    expect(isSummaryMessage(summary())).toBe(true);
    expect(isDisplayOnlyMessage(summary())).toBe(false);
  });

  it('摘要正文以 </subagent_result> 结尾同样保留', () => {
    const s = summary({ content: '历史结论\n</subagent_result>' });
    expect(isDisplayOnlyMessage(s)).toBe(false);
  });

  it('真正的通知 / 结果卡片仍按展示专用剔除', () => {
    const notice: ChatMessage = {
      role: 'user',
      content: '<background_task_notification>task done</background_task_notification>',
      is_show: true,
    };
    const card: ChatMessage = {
      role: 'user',
      content: '<subagent_result>status: done</subagent_result>',
      is_show: true,
    };
    expect(isDisplayOnlyMessage(notice)).toBe(true);
    expect(isDisplayOnlyMessage(card)).toBe(true);
  });
});

describe('SessionStore.getRestoreMessages', () => {
  it('恢复视图包含摘要消息，同时剔除通知与结果卡片', () => {
    const s = summary();
    const notice: ChatMessage = {
      role: 'user',
      content: '<background_task_notification>done</background_task_notification>',
      is_show: true,
    };
    const archived: ChatMessage = {
      role: 'user',
      content: '已折叠历史',
      is_show: true,
      is_compact: true,
    };
    const data = {
      id: 'sess_test',
      messages: [
        { role: 'system', content: 'sys' },
        s,
        notice,
        archived,
        { role: 'assistant', content: '最近一条回答', is_show: true },
      ],
    } as unknown as SessionData;

    const restored = SessionStore.getRestoreMessages(data, 'current system');
    expect(restored[0]).toMatchObject({ role: 'system', content: 'current system' });
    expect(restored).toContain(s);
    expect(restored).not.toContain(notice);
    expect(restored).not.toContain(archived);
  });
});
