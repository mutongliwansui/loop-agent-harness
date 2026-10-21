/**
 * RunHub 取消能力测试（Task-20261021-002-03 P1）
 *
 * 覆盖（任务文档 6.2）：
 * - 6.2.3 abort：running run → controller.abort 触发、signal.aborted 置位
 * - 6.1.2 / 6.2.4 幂等：重复 abort 仅一次 controller.abort；非 running 返回 null
 * - signal()：无 run → null；start 后返回 controller 的 signal（D8 同源）
 * - start() 替换仍在跑的旧 run：旧 signal 被取消（superseded）
 * - drop()/dispose()：仍 running 的 run 先取消
 * - aborted 作为终态：finish('aborted') 事件可下发、状态正确（attach 回放语义不变）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { RunHub } from '../src/api/run-hub.js';

describe('RunHub abort（Task-20261021-002-03）', () => {
  let hub: RunHub;

  beforeEach(() => {
    hub = new RunHub();
  });

  it('signal()：无 run → null；start 后与 controller 同源', () => {
    expect(hub.signal('s1')).toBeNull();
    hub.start('s1');
    const sig = hub.signal('s1');
    expect(sig).toBeInstanceOf(AbortSignal);
    expect(sig?.aborted).toBe(false);
  });

  it('6.2.3 abort：running run → signal.aborted 置位，返回 runId', () => {
    const runId = hub.start('s1');
    const sig = hub.signal('s1');
    const r = hub.abort('s1');
    expect(r).toEqual({ runId, alreadyAborting: false });
    expect(sig?.aborted).toBe(true);
  });

  it('6.1.2/6.2.4 幂等：重复 abort 仅触发一次 controller.abort；无 run/非 running → null', () => {
    hub.start('s1');
    const sig = hub.signal('s1');
    let abortCount = 0;
    sig?.addEventListener('abort', () => abortCount++);

    expect(hub.abort('s1')?.alreadyAborting).toBe(false);
    const second = hub.abort('s1');
    expect(second?.alreadyAborting).toBe(true);
    expect(abortCount).toBe(1);

    // 非 running → null
    hub.finish('s1', 'done', { event: 'done', data: {} });
    expect(hub.abort('s1')).toBeNull();
    // 从未运行 → null
    expect(hub.abort('s_unknown')).toBeNull();
  });

  it('start() 替换仍在跑的旧 run：旧 signal 被取消，新 signal 正常', () => {
    const oldSig = (() => {
      hub.start('s1');
      return hub.signal('s1');
    })();
    hub.start('s1'); // 旧 run 仍在 running 时再次 start
    expect(oldSig?.aborted).toBe(true);
    const newSig = hub.signal('s1');
    expect(newSig?.aborted).toBe(false);
    expect(hub.abort('s1')).not.toBeNull();
  });

  it('drop()：仍 running 的 run 先取消再删除', () => {
    hub.start('s1');
    const sig = hub.signal('s1');
    hub.drop('s1');
    expect(sig?.aborted).toBe(true);
    expect(hub.signal('s1')).toBeNull();
  });

  it('dispose()：全部 running run 取消', () => {
    hub.start('s1');
    hub.start('s2');
    const s1 = hub.signal('s1');
    const s2 = hub.signal('s2');
    hub.dispose();
    expect(s1?.aborted).toBe(true);
    expect(s2?.aborted).toBe(true);
  });

  it("aborted 终态：finish('aborted') 先 publish 终态事件（订阅者可收到）再置状态", () => {
    hub.start('s1');
    const seen: string[] = [];
    hub.subscribe('s1', 0, (ev) => seen.push(ev.event));
    hub.finish('s1', 'aborted', { event: 'aborted', data: { partial: true } });
    expect(seen).toEqual(['aborted']);
    expect(hub.snapshot('s1')?.status).toBe('aborted');
    // 终态后 publish 短路（既有语义不变）
    expect(hub.publish('s1', 'llm_stream', {})).toBe(0);
    // 保留期内 attach 语义：subscribe 返回 finished
    expect(hub.subscribe('s1', 0, () => {})?.finished).toBe(true);
  });
});
