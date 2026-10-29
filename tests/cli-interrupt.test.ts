/**
 * CLI Ctrl+C 分派与中断收尾测试（Task-20261029-001 P2）
 *
 * 覆盖：
 * - decideSigint 全部 6 种动作与优先级顺序（aborting 必须压过 running；
 *   confirming/exiting 压过一切）——这是"连按两下 Ctrl+C 也不会退出进程"的核心保证；
 * - resolveExitArm 退出确认窗口（含边界、时钟回拨异常）；
 * - sealPendingToolCalls 下移后的新引用路径（src/agent/abort-utils.ts）仍可用，
 *   合成 tool 消息文案标明"已被用户停止"（D4-B：模型据此知道工具未完成）；
 * - ReActAgent.adoptHistory 过滤 system / is_compact，作为中断后的内存基线回写通道。
 */
import { describe, it, expect } from 'vitest';
import {
  decideSigint,
  resolveExitArm,
  EXIT_WINDOW_MS,
  type SigintState,
} from '../src/cli/interrupt.js';
import { sealPendingToolCalls } from '../src/agent/abort-utils.js';
import { ReActAgent } from '../src/agent/react-agent.js';
import type { ChatMessage } from '../src/types.js';

/** 空闲态基准状态：其余字段按需覆盖 */
const idle = (over: Partial<SigintState> = {}): SigintState => ({
  running: false,
  aborting: false,
  confirming: false,
  exiting: false,
  abortable: false,
  exitArmed: false,
  ...over,
});

describe('decideSigint 分派（Task-20261029-001 D1/D2/D3/D6/D7）', () => {
  it('回答中（running + abortable）→ abort-run（只中断本次回答）', () => {
    expect(decideSigint(idle({ running: true, abortable: true }))).toBe('abort-run');
  });

  it('命令执行中（running 但不可中断）→ ignore-busy', () => {
    expect(decideSigint(idle({ running: true, abortable: false }))).toBe('ignore-busy');
  });

  it('收尾中（aborting）→ ignore-busy，且压过 running（连按两下也不退出）', () => {
    expect(decideSigint(idle({ running: true, abortable: true, aborting: true }))).toBe(
      'ignore-busy',
    );
    // 收尾中即使持有 controller 也不再 abort
    expect(decideSigint(idle({ running: true, abortable: true, aborting: true }))).not.toBe(
      'abort-run',
    );
  });

  it('y/N 确认中 → cancel-confirm，且压过 running 与 aborting', () => {
    expect(decideSigint(idle({ confirming: true }))).toBe('cancel-confirm');
    expect(decideSigint(idle({ confirming: true, running: true, abortable: true }))).toBe(
      'cancel-confirm',
    );
    expect(
      decideSigint(idle({ confirming: true, running: true, abortable: true, aborting: true })),
    ).toBe('cancel-confirm');
  });

  it('Dreaming 收尾中（exiting）→ force-exit，优先级最高', () => {
    expect(decideSigint(idle({ exiting: true }))).toBe('force-exit');
    expect(
      decideSigint(
        idle({ exiting: true, confirming: true, running: true, abortable: true, aborting: true }),
      ),
    ).toBe('force-exit');
  });

  it('空闲未开窗 → arm-exit；空闲已开窗 → exit（D2 双击确认）', () => {
    expect(decideSigint(idle())).toBe('arm-exit');
    expect(decideSigint(idle({ exitArmed: true }))).toBe('exit');
  });
});

describe('resolveExitArm 退出确认窗口（Task-20261029-001 D2）', () => {
  it('未开窗（0）→ 不算窗口内', () => {
    expect(resolveExitArm(0, 1_000_000)).toBe(false);
  });

  it('窗口内（含右端点）→ 退出', () => {
    const t = 1_000_000;
    expect(resolveExitArm(t, t + 1)).toBe(true);
    expect(resolveExitArm(t, t + EXIT_WINDOW_MS)).toBe(true);
  });

  it('超出窗口 → 重新开窗（不退出）', () => {
    const t = 1_000_000;
    expect(resolveExitArm(t, t + EXIT_WINDOW_MS + 1)).toBe(false);
    expect(resolveExitArm(t, t + 60_000)).toBe(false);
  });

  it('时钟回拨（now < lastArmAt）→ 按窗口内处理，宁可多提示一次也不误退', () => {
    expect(resolveExitArm(2_000_000, 1_000_000)).toBe(true);
  });

  it('支持自定义窗口时长', () => {
    expect(resolveExitArm(0, 0, 100)).toBe(false);
    expect(resolveExitArm(1000, 1050, 100)).toBe(true);
    expect(resolveExitArm(1000, 1200, 100)).toBe(false);
  });
});

describe('sealPendingToolCalls 新路径（src/agent/abort-utils.ts，D8 下移）', () => {
  const assistantWithCalls = (ids: string[]): ChatMessage =>
    ({
      role: 'assistant',
      content: null,
      tool_calls: ids.map((id) => ({
        id,
        type: 'function' as const,
        function: { name: 'fileRead', arguments: '{}' },
      })),
    }) as ChatMessage;

  it('孤立 tool_call → 补合成 tool 消息，文案标明被用户停止', () => {
    const sealed = sealPendingToolCalls([{ role: 'user', content: 'hi' }, assistantWithCalls(['c1'])]);
    expect(sealed).toHaveLength(3);
    const last = sealed[2] as { role: string; tool_call_id: string; content: string };
    expect(last.role).toBe('tool');
    expect(last.tool_call_id).toBe('c1');
    expect(last.content).toContain('已被用户停止');
  });

  it('已响应的 tool_call 不重复补', () => {
    const messages: ChatMessage[] = [
      assistantWithCalls(['c1']),
      { role: 'tool', tool_call_id: 'c1', content: 'ok' } as ChatMessage,
    ];
    expect(sealPendingToolCalls(messages)).toHaveLength(2);
  });
});

describe('ReActAgent.adoptHistory（Task-20261029-001 D4-B 内存基线回写）', () => {
  it('丢弃 system 与 is_compact===true，保留真实历史', () => {
    const agent = new ReActAgent();
    const history: ChatMessage[] = [
      { role: 'system', content: 'sys' } as ChatMessage,
      { role: 'user', content: '已折叠', is_compact: true } as ChatMessage,
      { role: 'user', content: '问题' } as ChatMessage,
      { role: 'assistant', content: '半截回答' } as ChatMessage,
    ];
    agent.adoptHistory(history);
    const kept = agent.getSessionMessages();
    expect(kept.map((m) => m.content)).toEqual(['问题', '半截回答']);
  });

  it('接管封口后的历史：合成 tool 消息会进入基线（消息序自洽）', () => {
    const agent = new ReActAgent();
    const sealed = sealPendingToolCalls([
      { role: 'user', content: '跑个命令' } as ChatMessage,
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'x1', type: 'function' as const, function: { name: 'commandRun', arguments: '{}' } },
        ],
      } as ChatMessage,
    ]);
    agent.adoptHistory(sealed);
    const kept = agent.getSessionMessages();
    expect(kept).toHaveLength(3);
    expect((kept[2] as { tool_call_id?: string }).tool_call_id).toBe('x1');
  });

  it('空数组可安全接管', () => {
    const agent = new ReActAgent();
    agent.adoptHistory([]);
    expect(agent.getSessionMessages()).toEqual([]);
  });
});
