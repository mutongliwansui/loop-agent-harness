/**
 * 需求 20261113-008：当前轮 user 落入丢弃区时的「原文随摘要占位携带」机制
 *
 * 背景（缺陷）：L1 压缩在单轮长任务里会把当前轮 user 从丢弃区摘出、插到保留区头部
 * （「任务锚点 pin」）。磁盘落盘按 transcript 下标重建时，这条 user 的 seq 是这一轮最早的，
 * 却排到了它引发的 11 条应答之后，表现为会话历史里「提问在最后、应答在最前」。
 *
 * 修复（D2）：pin 直接删除，droppable / kept 恢复为纯前缀 / 纯后缀，消息位置完全不动；
 * 当前轮 user 的可见性改由摘要占位的原文段承载（D1/D4/D5）。
 *
 * 本文件锁定以下不变量：
 *   1) 截断 —— 原文段超出上限时头尾保留（保住尾部上传附件 note），长度可控
 *   2) 切分 —— 未命中标记时兼容存量摘要，不报错
 *   3) 拼装 —— 摘要主体 + 原文段各只出现一次，重复压缩不叠加（幂等）
 *   4) 去重 —— archive 回退时 summaryText 已含原文，不再重复追加
 *   5) 分别截断 —— 摘要主体写满硬上限时，原文段仍完整（最需要它的场景不能失效）
 *   6) 位置 —— planCompaction 不再 pin，droppable/kept 为纯前缀/纯后缀
 */

import { describe, it, expect } from 'vitest';
import {
  WorkingMemory,
  buildCompactedView,
  isSummaryPlaceholder,
  SUMMARY_PLACEHOLDER_PREFIX,
} from '../src/memory/working.js';
import {
  ANCHOR_DEDUPE_CHARS,
  ANCHOR_HEAD_CHARS,
  ANCHOR_SECTION_MARK,
  ANCHOR_TAIL_CHARS,
  ANCHOR_USER_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  SUMMARY_TRUNCATE_MAX_CHARS,
  composeSummaryBody,
  dedupeAnchorText,
  splitAnchorSection,
  truncateAnchorText,
} from '../src/memory/summary-message.js';
import type { ChatMessage } from '../src/types.js';

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  if (role === 'tool') return { role, tool_call_id: `call_${content.length}`, content };
  return { role, content } as ChatMessage;
}

/** 摘要占位正文（不含 `[历史摘要] ` 前缀） */
function placeholderBody(m: ChatMessage): string {
  const text = typeof m.content === 'string' ? m.content : '';
  return text.startsWith(`${SUMMARY_PLACEHOLDER_PREFIX} `)
    ? text.slice(SUMMARY_PLACEHOLDER_PREFIX.length + 1)
    : text;
}

/** 一轮完整对话：4 次调用，保留 1 次时头部 4 条会被丢弃 */
const chain = (): ChatMessage[] => [
  msg('system', 'sys'),
  msg('user', 'u1'),
  msg('assistant', 'a1'),
  msg('user', 'u2'),
  msg('assistant', 'a2'),
  msg('user', 'u3'),
  msg('assistant', 'a3'),
];

describe('需求 20261113-008 D6：原文段兜底截断', () => {
  it('未超上限时原样返回（仅去首尾空白）', () => {
    const text = '  请分析这个台区  ';
    expect(truncateAnchorText(text)).toBe('请分析这个台区');
  });

  it('空文本返回空串（不产生空原文段）', () => {
    expect(truncateAnchorText('')).toBe('');
    expect(truncateAnchorText('   \n\t ')).toBe('');
  });

  it('超上限时头尾保留并标注省略字数', () => {
    const head = 'H'.repeat(ANCHOR_HEAD_CHARS);
    const tail = 'T'.repeat(ANCHOR_TAIL_CHARS);
    const text = `${head}${'M'.repeat(2000)}${tail}`;
    const out = truncateAnchorText(text);

    expect(out.startsWith(head)).toBe(true);
    // 尾部必须保留：上传附件 note 在 user 正文末尾，模型要靠它拿绝对路径
    expect(out.endsWith(tail)).toBe(true);
    // 省略字数 = 原文长度 - 头 - 尾 = 2800 - 500 - 300 = 2000
    expect(out).toContain('已省略 2000 字');
    // 长度可控：头 + 尾 + 标记，略超上限但不放大
    expect(out.length).toBeLessThanOrEqual(ANCHOR_USER_MAX_CHARS + 20);
  });

  it('可被调用方调小上限：按 5:3 等比缩放，头尾都拿得到', () => {
    const text = `${'A'.repeat(100)}${'B'.repeat(900)}${'C'.repeat(100)}`;
    const out = truncateAnchorText(text, 100);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.startsWith('A')).toBe(true);
    expect(out.endsWith('C')).toBe(true);
  });
});

describe('需求 20261113-008 D5：摘要主体 / 原文段切分与拼装', () => {
  it('未命中标记时 anchor 为 undefined（兼容需求上线前的存量摘要）', () => {
    const { summary, anchor } = splitAnchorSection('旧摘要：已修复 store 合并写');
    expect(summary).toBe('旧摘要：已修复 store 合并写');
    expect(anchor).toBeUndefined();
  });

  it('命中标记时切出摘要主体与原文段', () => {
    const { summary, anchor } = splitAnchorSection(`要点 A${ANCHOR_SECTION_MARK}请分析台区 T1`);
    expect(summary).toBe('要点 A');
    expect(anchor).toBe('请分析台区 T1');
  });

  it('标记后为空视为无原文段（脏数据不产生空段）', () => {
    const { summary, anchor } = splitAnchorSection(`要点 A${ANCHOR_SECTION_MARK}   `);
    expect(summary).toBe('要点 A');
    expect(anchor).toBeUndefined();
  });

  it('无原文段时只返回摘要主体', () => {
    expect(composeSummaryBody('要点 A')).toBe('要点 A');
    expect(composeSummaryBody('要点 A', '   ')).toBe('要点 A');
  });

  it('拼装一次：主体 + 标记 + 原文段', () => {
    expect(composeSummaryBody('要点 A', '请分析台区 T1')).toBe(
      `要点 A${ANCHOR_SECTION_MARK}请分析台区 T1`,
    );
  });

  it('幂等（D5）：把上次拼好的结果再拼一次，标记仍只出现一次', () => {
    const once = composeSummaryBody('要点 A', '请分析台区 T1');
    const twice = composeSummaryBody(once, '请分析台区 T1');
    expect(twice).toBe(once);
    expect(twice.match(/\[当前问题\]/g)?.length).toBe(1);
  });

  it('本轮原文段替换上轮（不叠加历史原文）', () => {
    const once = composeSummaryBody('要点 A', '上轮问题');
    const next = composeSummaryBody(once, '本轮问题');
    expect(next).toBe(`要点 A${ANCHOR_SECTION_MARK}本轮问题`);
    expect(next).not.toContain('上轮问题');
  });

  it('仅有原文段、无摘要主体时不产生悬空标记', () => {
    expect(composeSummaryBody('', '请分析台区 T1')).toBe('请分析台区 T1');
  });
});

describe('需求 20261113-008：原文段去重（archive 回退）', () => {
  it('summaryBody 已含原文头部指纹 → 不再追加', () => {
    const anchor = '请分析台区 T1 的停复电情况';
    const summaryBody = `user: ${anchor}\nassistant: 已开始分析`;
    expect(dedupeAnchorText(summaryBody, anchor)).toBeUndefined();
  });

  it('summaryBody 不含原文 → 正常返回原文段', () => {
    expect(dedupeAnchorText('要点 A', '请分析台区 T1')).toBe('请分析台区 T1');
  });

  it('summaryBody 为空 → 直接返回原文段', () => {
    expect(dedupeAnchorText('', '请分析台区 T1')).toBe('请分析台区 T1');
  });

  it('无原文段 → undefined', () => {
    expect(dedupeAnchorText('要点 A', undefined)).toBeUndefined();
    expect(dedupeAnchorText('要点 A', '  ')).toBeUndefined();
  });

  it('长原文只比对头部指纹长度（避免半截误判）', () => {
    const anchor = 'X'.repeat(ANCHOR_DEDUPE_CHARS * 2);
    // 只含尾部片段 → 不认为已包含
    expect(dedupeAnchorText(`摘要 + ${'X'.repeat(ANCHOR_DEDUPE_CHARS - 1)}`, anchor)).toBe(anchor);
  });
});

describe('需求 20261113-008 D1：摘要主体与原文段分别截断', () => {
  it('摘要主体写满硬上限时，原文段仍完整保留', () => {
    const anchor = '请分析台区 T1 的停复电情况，并给出结论';
    const result = buildCompactedView(chain(), {
      keepRecentTurns: 1,
      summaryText: 'S'.repeat(SUMMARY_TRUNCATE_MAX_CHARS + 500),
      anchorUserText: anchor,
    });
    const placeholder = result.find((m) => isSummaryPlaceholder(m));
    expect(placeholder).toBeDefined();

    const { summary, anchor: got } = splitAnchorSection(placeholderBody(placeholder!));
    // 主体被截到硬上限，不会挤掉原文段
    expect(summary.length).toBe(SUMMARY_TRUNCATE_MAX_CHARS);
    expect(got).toBe(anchor);
  });

  it('摘要目标上限为 800（写入压缩指令的目标值）', () => {
    expect(SUMMARY_MAX_CHARS).toBe(800);
    expect(SUMMARY_TRUNCATE_MAX_CHARS).toBe(Math.ceil(800 * 1.2));
  });

  it('沿用旧占位（无新摘要）+ 本轮原文段：旧原文段被替换而非叠加', () => {
    const messages: ChatMessage[] = [
      msg('system', 'sys'),
      {
        role: 'user',
        content: `${SUMMARY_PLACEHOLDER_PREFIX} 旧要点${ANCHOR_SECTION_MARK}上轮问题原文`,
        is_show: false,
        kind: 'summary',
      },
      ...chain().slice(1),
    ];
    const result = buildCompactedView(messages, {
      keepRecentTurns: 1,
      anchorUserText: '本轮问题原文',
    });
    const placeholder = result.find((m) => isSummaryPlaceholder(m));
    const body = placeholderBody(placeholder!);
    expect(body).toContain('旧要点');
    expect(body).toContain('本轮问题原文');
    expect(body).not.toContain('上轮问题原文');
    expect(body.match(/\[当前问题\]/g)?.length).toBe(1);
  });

  it('存量摘要（无原文段标记）+ 本轮原文段：追加在后，不报错', () => {
    const messages: ChatMessage[] = [
      msg('system', 'sys'),
      {
        role: 'user',
        content: `${SUMMARY_PLACEHOLDER_PREFIX} 存量摘要内容`,
        is_show: false,
        kind: 'summary',
      },
      ...chain().slice(1),
    ];
    const result = buildCompactedView(messages, {
      keepRecentTurns: 1,
      anchorUserText: '本轮问题原文',
    });
    const { summary, anchor } = splitAnchorSection(
      placeholderBody(result.find((m) => isSummaryPlaceholder(m))!),
    );
    expect(summary).toBe('存量摘要内容');
    expect(anchor).toBe('本轮问题原文');
  });

  it('archive 回退：summaryText 已含本轮原文时不重复追加', () => {
    const anchor = '请分析台区 T1 的停复电情况';
    const rawArchive = `user: ${anchor}\nassistant: 收到\nuser: 补充：仅看昨日`;
    const result = buildCompactedView(chain(), {
      keepRecentTurns: 1,
      summaryText: rawArchive,
      anchorUserText: anchor,
    });
    const body = placeholderBody(result.find((m) => isSummaryPlaceholder(m))!);
    expect(body).not.toContain('[当前问题]');
    expect(body.match(/请分析台区 T1 的停复电情况/g)?.length).toBe(1);
  });
});

describe('需求 20261113-008 D2：planCompaction 不再 pin 当前轮 user', () => {
  const wm = () => new WorkingMemory({ maxTokens: 10000, compactionThreshold: 0.8, keepRecentTurns: 1 });

  it('当前轮 user 落入丢弃区：留在 droppable，原文交给 anchorUserText', () => {
    const messages: ChatMessage[] = [
      msg('user', '当前轮提问：请分析台区 T1 的停复电'),
      msg('assistant', '第一段回答'),
      msg('tool', '工具结果'),
      msg('assistant', '最后一段回答'),
    ];
    const plan = wm().planCompaction(messages);

    // 位置不动：user 仍在 droppable，不在 kept
    expect(plan.droppable[0].content).toBe('当前轮提问：请分析台区 T1 的停复电');
    expect(plan.kept.some((m) => m.role === 'user')).toBe(false);
    // 顺序保真：纯前缀 / 纯后缀
    expect(plan.droppable).toEqual(messages.slice(0, plan.droppable.length));
    expect(plan.kept).toEqual(messages.slice(plan.droppable.length));
    // 可见性由原文段承载
    expect(plan.anchorUserText).toBe('当前轮提问：请分析台区 T1 的停复电');
  });

  it('当前轮 user 已在保留区内：不产生原文段（避免重复注入）', () => {
    const messages: ChatMessage[] = [
      msg('user', '旧问题'),
      msg('assistant', '回答'),
      msg('tool', '工具结果'),
      msg('user', '当前轮提问'),
    ];
    const plan = wm().planCompaction(messages);
    expect(plan.kept.some((m) => m.content === '当前轮提问')).toBe(true);
    expect(plan.anchorUserText).toBeUndefined();
  });

  it('原文段超上限时仍按头尾保留交给摘要（尾部附件 note 不丢）', () => {
    const note = '\n附件：/abs/path/截图.png（请用 analyzeImage 查看）';
    const messages: ChatMessage[] = [
      msg('user', `${'广'.repeat(1500)}${note}`),
      msg('assistant', '回答'),
      msg('tool', '工具结果'),
      msg('assistant', '最后一段回答'),
    ];
    const plan = wm().planCompaction(messages);
    expect(plan.anchorUserText).toBeDefined();
    expect(plan.anchorUserText).toContain('/abs/path/截图.png');
    expect(plan.anchorUserText!.length).toBeLessThanOrEqual(ANCHOR_USER_MAX_CHARS + 20);
  });

  it('compact 后的视图顺序与输入一致（丢弃区不再被重排）', () => {
    const messages: ChatMessage[] = [
      msg('system', 'sys'),
      msg('user', '当前轮提问'),
      msg('assistant', '第一段回答'),
      msg('tool', '工具结果'),
      msg('assistant', '最后一段回答'),
      msg('tool', '最后的工具结果'),
    ];
    const w = wm();
    const plan = w.planCompaction(messages);
    const view = w.compact(messages, '- 要点', plan);

    expect(view[0]).toEqual(msg('system', 'sys'));
    expect(isSummaryPlaceholder(view[1])).toBe(true);
    // 保留区严格等于 plan.kept，且与原数组尾部逐条相同
    expect(view.slice(2)).toEqual(plan.kept);
    expect(plan.kept).toEqual(messages.slice(messages.length - plan.kept.length));
    // 原文段挂在占位上
    expect(placeholderBody(view[1])).toContain('当前轮提问');
  });
});
