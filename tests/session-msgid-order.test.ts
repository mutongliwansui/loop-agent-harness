/**
 * 需求 20261113-008 D3：落盘顺序护栏（msgId 单调性校验，只告警不重排）
 *
 * 背景：会话文件里出现过「首问 seq=21 排在 idx150、其 11 条应答 seq=22–31 排在 idx1–10」。
 * 根因是 L1 压缩的「任务锚点 pin」搬动了消息位置。pin 已删除（D2），本护栏作为回归防线：
 * msgId 内嵌 `(时间戳, 进程内序号)` 是消息真实创建顺序，磁盘顺序理应与之单调一致，
 * 出现倒序即告警——但**绝不自动重排**（重排会掩盖真实缺陷来源）。
 *
 * 本文件锁定：
 *   1) 解析口径 —— 只认 `msg_<ts36>_<seq36><rand2>`，其余一律跳过（legacy / `_n` 后缀 / 缺失）
 *   2) 单调判定 —— (ts, seq) 字典序不减；相等不算违例
 *   3) 容错 —— 不可解析项不打断比较链，也不产生误报
 *   4) 数量上限 —— 违例最多报 5 条，避免脏文件刷屏
 */

import { describe, it, expect } from 'vitest';
import { checkMsgIdOrder, parseMsgIdOrder } from '../src/session/store.js';
import type { ChatMessage } from '../src/types.js';

/** 按 newMsgId() 的格式构造：`msg_<ts36>_<seq36><rand2>` */
function mid(ts: number, seq: number, rand = 'aa'): string {
  return `msg_${ts.toString(36)}_${seq.toString(36)}${rand}`;
}

function msg(role: ChatMessage['role'], content: string, msgId?: string): ChatMessage {
  return (msgId ? { role, content, msgId } : { role, content }) as ChatMessage;
}

describe('parseMsgIdOrder：解析创建顺序', () => {
  it('标准格式解析出 (ts, seq)', () => {
    expect(parseMsgIdOrder(mid(1000, 21))).toEqual({ ts: 1000, seq: 21 });
  });

  it('序号跨 36 进位后仍正确（seq36 变长）', () => {
    // 36 → '10'，tail = '10aa'，末 2 位是随机段
    expect(parseMsgIdOrder(mid(1000, 36))).toEqual({ ts: 1000, seq: 36 });
  });

  it('缺失 / 非 msg_ 前缀 → null', () => {
    expect(parseMsgIdOrder(undefined)).toBeNull();
    expect(parseMsgIdOrder('')).toBeNull();
    expect(parseMsgIdOrder('abc_1_1aa')).toBeNull();
  });

  it('legacy 无下划线 ID → null（不参与判断）', () => {
    expect(parseMsgIdOrder('msg_l3f9a2')).toBeNull();
  });

  it('去重后缀 `_n` → null（无法切出纯净序号）', () => {
    expect(parseMsgIdOrder(`${mid(1000, 21)}_1`)).toBeNull();
  });

  it('随机段缺失（tail 过短）→ null', () => {
    expect(parseMsgIdOrder('msg_1_a')).toBeNull();
  });
});

describe('checkMsgIdOrder：落盘顺序护栏', () => {
  it('严格递增 → 无违例', () => {
    const messages = [
      msg('user', 'q1', mid(1000, 21)),
      msg('assistant', 'a1', mid(1000, 22)),
      msg('tool', 'r1', mid(1001, 23)),
    ];
    expect(checkMsgIdOrder(messages)).toEqual([]);
  });

  it('(ts, seq) 相等不算违例（同一毫秒同一序号仅随机段不同）', () => {
    const messages = [
      msg('user', 'q1', mid(1000, 21, 'aa')),
      msg('assistant', 'a1', mid(1000, 21, 'bb')),
    ];
    expect(checkMsgIdOrder(messages)).toEqual([]);
  });

  it('时间戳回退 → 报违例并带下标', () => {
    const messages = [
      msg('user', '应答方的第一条', mid(2000, 22)),
      msg('user', '首问', mid(1000, 21)),
    ];
    const issues = checkMsgIdOrder(messages);
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain('idx1');
    expect(issues[0]).toContain('idx0');
  });

  it('同一时间戳下序号回退 → 报违例（复刻「应答在前、提问在后」）', () => {
    const messages = [
      msg('assistant', '应答 1', mid(1000, 22)),
      msg('assistant', '应答 2', mid(1000, 23)),
      msg('user', '首问', mid(1000, 21)),
    ];
    const issues = checkMsgIdOrder(messages);
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain('idx2');
  });

  it('legacy / 缺失 msgId 的消息被跳过，不产生误报', () => {
    const messages = [
      msg('user', '存量消息', 'msg_l3f9a2'),
      msg('user', '另一条存量', undefined),
      msg('user', 'q', mid(1000, 21)),
      msg('assistant', 'a', mid(1000, 22)),
    ];
    expect(checkMsgIdOrder(messages)).toEqual([]);
  });

  it('跳过中间不可解析项后，仍与最近一次可解析项比较', () => {
    const messages = [
      msg('user', 'q', mid(2000, 30)),
      msg('user', '存量', 'msg_labc'),
      msg('assistant', 'a', mid(1000, 29)),
    ];
    const issues = checkMsgIdOrder(messages);
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain('idx2');
    expect(issues[0]).toContain('idx0');
  });

  it('违例最多报 5 条（脏文件不刷屏）', () => {
    const messages: ChatMessage[] = [];
    // 10 条时间戳整体倒序
    for (let i = 0; i < 10; i++) {
      messages.push(msg('user', `m${i}`, mid(5000 - i, 100 - i)));
    }
    const issues = checkMsgIdOrder(messages);
    expect(issues.length).toBe(5);
  });

  it('空数组 / 单条消息不报违例', () => {
    expect(checkMsgIdOrder([])).toEqual([]);
    expect(checkMsgIdOrder([msg('user', 'q', mid(1000, 1))])).toEqual([]);
  });
});
