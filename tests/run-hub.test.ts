/**
 * RunHub 单测（Task-20261021-001 P0）
 *
 * 覆盖：seq 单调递增、cursor 回放、双上限溢出判定、多订阅者 fan-out、
 * 抛错订阅者摘除、结束态回放与保留期清理。
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  RunHub,
  RUN_BUFFER_MAX_EVENTS,
  RUN_RETAIN_AFTER_FINISH_MS,
  type RunEvent,
} from '../src/api/run-hub.js';

let hub: RunHub | null = null;

function makeHub(): RunHub {
  hub = new RunHub();
  return hub;
}

afterEach(() => {
  hub?.dispose();
  hub = null;
  vi.useRealTimers();
});

describe('RunHub', () => {
  it('无 run 时 publish 返回 0，snapshot 为 null', () => {
    const h = makeHub();
    expect(h.publish('s1', 'llm_stream', { text: 'x' })).toBe(0);
    expect(h.snapshot('s1')).toBeNull();
    expect(h.isRunning('s1')).toBe(false);
    expect(h.subscribe('s1', 0, () => {})).toBeNull();
  });

  it('start 后 seq 从 1 单调递增，snapshot 反映运行中', () => {
    const h = makeHub();
    const runId = h.start('s1');
    expect(runId).toBeTruthy();
    expect(h.publish('s1', 'start', { input: 'hi' })).toBe(1);
    expect(h.publish('s1', 'llm_stream', { text: 'a' })).toBe(2);
    expect(h.publish('s1', 'llm_stream', { text: 'b' })).toBe(3);
    expect(h.snapshot('s1')).toMatchObject({ runId, status: 'running' });
    expect(h.snapshot('s1')?.startedAt).toBeTypeOf('number');
    expect(h.isRunning('s1')).toBe(true);
  });

  it('subscribe 先回放 cursor 之后的事件，再接收实时事件', () => {
    const h = makeHub();
    h.start('s1');
    h.publish('s1', 'start', { n: 1 });
    h.publish('s1', 'llm_stream', { n: 2 });
    h.publish('s1', 'llm_stream', { n: 3 });

    const got: RunEvent[] = [];
    const sub = h.subscribe('s1', 1, (ev) => got.push(ev));
    expect(sub).not.toBeNull();
    expect(sub?.finished).toBe(false);
    expect(got.map((e) => e.seq)).toEqual([2, 3]);

    h.publish('s1', 'tool_start', { n: 4 });
    expect(got.map((e) => e.seq)).toEqual([2, 3, 4]);

    sub?.unsubscribe();
    h.publish('s1', 'tool_end', { n: 5 });
    expect(got.map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  it('多订阅者各自收到同一批事件；抛错订阅者被摘除且不影响其它', () => {
    const h = makeHub();
    h.start('s1');
    const a: number[] = [];
    const b: number[] = [];
    const bad = (): void => {
      throw new Error('write failed');
    };
    h.subscribe('s1', 0, (ev) => a.push(ev.seq));
    h.subscribe('s1', 0, bad);
    h.subscribe('s1', 0, (ev) => b.push(ev.seq));

    h.publish('s1', 'x', {});
    h.publish('s1', 'y', {});
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);
  });

  it('事件数超上限时从头部丢弃，落后 cursor 判定为 stale', () => {
    const h = makeHub();
    h.start('s1');
    const total = RUN_BUFFER_MAX_EVENTS + 50;
    for (let i = 0; i < total; i++) h.publish('s1', 'llm_stream', { i });

    expect(h.oldestSeq('s1')).toBe(total - RUN_BUFFER_MAX_EVENTS + 1);
    expect(h.isCursorStale('s1', 0)).toBe(true);
    expect(h.isCursorStale('s1', h.oldestSeq('s1') - 1)).toBe(false);

    // 落后过多的订阅者只能拿到仍保留的事件
    const got: number[] = [];
    h.subscribe('s1', 0, (ev) => got.push(ev.seq));
    expect(got.length).toBe(RUN_BUFFER_MAX_EVENTS);
    expect(got[0]).toBe(h.oldestSeq('s1'));
  });

  it('字节超上限同样触发裁剪（至少保留最新一条）', () => {
    const h = makeHub();
    h.start('s1');
    const chunk = 'x'.repeat(256 * 1024); // 每条约 256KB
    for (let i = 0; i < 12; i++) h.publish('s1', 'tool_end', { chunk });
    const oldest = h.oldestSeq('s1');
    expect(oldest).toBeGreaterThan(1);
    expect(h.isCursorStale('s1', 0)).toBe(true);
    expect(oldest).toBeLessThanOrEqual(12);
  });

  it('finish 发布终态事件并可被回放，之后订阅直接 finished', () => {
    const h = makeHub();
    h.start('s1');
    h.publish('s1', 'start', {});
    const seq = h.finish('s1', 'done', { event: 'done', data: { sessionId: 's1' } });
    expect(seq).toBe(2);
    expect(h.isRunning('s1')).toBe(false);
    expect(h.snapshot('s1')?.status).toBe('done');
    expect(h.snapshot('s1')?.finishedAt).toBeTypeOf('number');

    const got: RunEvent[] = [];
    const sub = h.subscribe('s1', 1, (ev) => got.push(ev));
    expect(sub?.finished).toBe(true);
    expect(got.map((e) => e.event)).toEqual(['done']);
    expect(got[0].data).toEqual({ sessionId: 's1' });

    // 结束后的 publish 不再分配 seq
    expect(h.publish('s1', 'late', {})).toBe(0);
  });

  it('实时订阅者能收到终态事件', () => {
    const h = makeHub();
    h.start('s1');
    const events: string[] = [];
    h.subscribe('s1', 0, (ev) => events.push(ev.event));
    h.publish('s1', 'start', {});
    h.finish('s1', 'failed', { event: 'fatal', data: { message: 'boom' } });
    expect(events).toEqual(['start', 'fatal']);
  });

  it('结束后保留 RUN_RETAIN_AFTER_FINISH_MS，随后自动清理', () => {
    vi.useFakeTimers();
    const h = makeHub();
    h.start('s1');
    h.finish('s1', 'done', { event: 'done', data: {} });
    expect(h.snapshot('s1')).not.toBeNull();

    vi.advanceTimersByTime(RUN_RETAIN_AFTER_FINISH_MS - 1);
    expect(h.snapshot('s1')).not.toBeNull();

    vi.advanceTimersByTime(2);
    expect(h.snapshot('s1')).toBeNull();
  });

  it('start 覆盖旧状态，drop 立即清理', () => {
    const h = makeHub();
    h.start('s1');
    h.finish('s1', 'done', { event: 'done', data: {} });
    const runId = h.start('s1');
    expect(h.snapshot('s1')).toMatchObject({ runId, status: 'running' });
    expect(h.publish('s1', 'start', {})).toBe(1);

    h.drop('s1');
    expect(h.snapshot('s1')).toBeNull();
  });
});
