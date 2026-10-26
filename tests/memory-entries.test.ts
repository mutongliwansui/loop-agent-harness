/**
 * 需求 20261026-004：webui/src/memory-entries.ts 纯函数单测
 *
 * 覆盖：条目头解析（完整头/缺省段/无头行）、三级筛选、按天分组、
 * 会话/标签提取、单行预览截断。
 */

import { describe, it, expect } from 'vitest';
import {
  parseDay,
  parseDays,
  filterEntries,
  groupByDay,
  sessionIdsOf,
  tagsOf,
  previewOf,
  type MemEntry,
} from '../webui/src/memory-entries.js';

const HEAD_FULL = '## [2026-10-26T10:00:00.000Z] [sessionId: s1] [scope: session] [tag: tool]';
const HEAD_MIN = '## [2026-10-25T08:00:00.000Z] [scope: global]';

describe('parseDay', () => {
  it('完整条目头解析（ts/sessionId/scope/tag/正文）', () => {
    const list = parseDay(`${HEAD_FULL}\n执行了工具 X，结果 ok\n第二行正文`, '2026-10-26');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      ts: '2026-10-26T10:00:00.000Z',
      sessionId: 's1',
      scope: 'session',
      tag: 'tool',
      day: '2026-10-26',
    });
    expect(list[0].text).toBe('执行了工具 X，结果 ok\n第二行正文');
    expect(list[0].sessionTitle).toBe('');
  });

  it('缺省段（无 sessionId/tag）按空串处理，scope 缺省 session；无头行忽略', () => {
    const list = parseDay(`开头游离行（无条目头）\n${HEAD_MIN}\n全局条目正文`, '2026-10-25');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sessionId: '', scope: 'global', tag: '', text: '全局条目正文' });
  });

  it('一天多条目：各归各的正文；CRLF 换行兼容', () => {
    const content = [
      HEAD_FULL,
      '第一条正文',
      '## [2026-10-26T11:00:00.000Z] [sessionId: s2] [scope: session] [tag: error]',
      '第二条正文',
    ].join('\r\n');
    const list = parseDay(content, '2026-10-26');
    expect(list.map((e) => e.sessionId)).toEqual(['s1', 's2']);
    expect(list.map((e) => e.tag)).toEqual(['tool', 'error']);
    expect(list[0].text).toBe('第一条正文');
    expect(list[1].text).toBe('第二条正文');
  });

  it('scope 非法值回落 session', () => {
    const list = parseDay('## [t] [scope: weird]', 'd');
    expect(list[0].scope).toBe('session');
  });
});

describe('parseDays / groupByDay', () => {
  it('多天合并；分组保持传入天序，组内保序', () => {
    const days = [
      { day: '2026-10-26', content: `${HEAD_FULL}\naaa\n${HEAD_MIN}\nbbb` },
      { day: '2026-10-25', content: '## [2026-10-25T01:00:00.000Z] [sessionId: s3] [scope: session] [tag: compaction]\nccc' },
    ];
    const all = parseDays(days);
    expect(all).toHaveLength(3);
    const groups = groupByDay(all);
    expect(groups.map((g) => g.day)).toEqual(['2026-10-26', '2026-10-25']);
    expect(groups[0].items.map((e) => e.text)).toEqual(['aaa', 'bbb']);
    expect(groups[1].items[0].tag).toBe('compaction');
  });
});

describe('filterEntries / sessionIdsOf / tagsOf', () => {
  const entries: MemEntry[] = [
    { ts: 't1', sessionId: 's1', sessionTitle: '', scope: 'session', tag: 'tool', text: 'a', day: 'd1' },
    { ts: 't2', sessionId: 's2', sessionTitle: '', scope: 'global', tag: '', text: 'b', day: 'd1' },
    { ts: 't3', sessionId: 's1', sessionTitle: '', scope: 'session', tag: 'error', text: 'c', day: 'd2' },
  ];

  it('空筛选 = 全部通过', () => {
    expect(filterEntries(entries, { sessionId: '', scope: '', tag: '' })).toHaveLength(3);
  });

  it('三维组合筛选', () => {
    expect(filterEntries(entries, { sessionId: 's1', scope: 'session', tag: '' })).toHaveLength(2);
    expect(filterEntries(entries, { sessionId: '', scope: 'global', tag: '' })).toHaveLength(1);
    expect(filterEntries(entries, { sessionId: 's1', scope: 'session', tag: 'error' })).toHaveLength(1);
    expect(filterEntries(entries, { sessionId: 'nope', scope: '', tag: '' })).toHaveLength(0);
  });

  it('会话/标签去重提取（保持首现顺序）', () => {
    expect(sessionIdsOf(entries)).toEqual(['s1', 's2']);
    expect(tagsOf(entries)).toEqual(['tool', 'error']);
  });
});

describe('previewOf', () => {
  it('空白压缩 + 超长截断', () => {
    expect(previewOf({ ts: '', sessionId: '', sessionTitle: '', scope: 'session', tag: '', text: '  a\n\nb  ', day: '' })).toBe('a b');
    const long = previewOf(
      { ts: '', sessionId: '', sessionTitle: '', scope: 'session', tag: '', text: 'x'.repeat(200), day: '' },
      50,
    );
    expect(long).toHaveLength(51);
    expect(long.endsWith('…')).toBe(true);
  });
});
