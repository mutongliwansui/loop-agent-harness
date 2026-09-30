/**
 * 流式 chunk 派发测试（Task-20260930-001 方案 1）
 *
 * 覆盖：delta → onLLMStream；toolCallStart 记录工具名；toolCallDelta 累积字节并派发 onToolCallDelta；done 返回响应
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createToolCallGenTracker,
  dispatchStreamChunk,
} from '../src/agent/stream-forward.js';
import type { AgentEvents, LLMResponse, StreamChunk } from '../src/types.js';

function makeEvents() {
  return {
    onLLMStream: vi.fn(),
    onToolCallDelta: vi.fn(),
  } as unknown as Required<AgentEvents> & {
    onLLMStream: ReturnType<typeof vi.fn>;
    onToolCallDelta: ReturnType<typeof vi.fn>;
  };
}

const doneChunk: StreamChunk = {
  type: 'done',
  response: {
    content: null,
    tool_calls: [],
    finish_reason: 'tool_calls',
  } as unknown as LLMResponse,
};

describe('dispatchStreamChunk', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delta → 派发 onLLMStream', async () => {
    const events = makeEvents();
    const tracker = createToolCallGenTracker();
    const ret = await dispatchStreamChunk({ type: 'delta', content: 'hi' }, tracker, events);
    expect(events.onLLMStream).toHaveBeenCalledWith('hi');
    expect(ret).toBeNull();
  });

  it('toolCallStart 仅记录工具名，不产生事件', async () => {
    const events = makeEvents();
    const tracker = createToolCallGenTracker();
    const ret = await dispatchStreamChunk(
      { type: 'toolCallStart', index: 0, toolCallId: 'c0', name: 'fileWrite' },
      tracker,
      events,
    );
    expect(events.onToolCallDelta).not.toHaveBeenCalled();
    expect(tracker.nameByIndex.get(0)).toBe('fileWrite');
    expect(ret).toBeNull();
  });

  it('toolCallDelta 累积字节并派发工具名 + 已用时', async () => {
    const events = makeEvents();
    const tracker = createToolCallGenTracker();
    await dispatchStreamChunk(
      { type: 'toolCallStart', index: 0, toolCallId: 'c0', name: 'fileWrite' },
      tracker,
      events,
    );
    vi.advanceTimersByTime(500);
    await dispatchStreamChunk(
      { type: 'toolCallDelta', index: 0, argumentsDelta: 'abc' },
      tracker,
      events,
    );
    expect(events.onToolCallDelta).toHaveBeenLastCalledWith('fileWrite', 3, 500);
  });

  it('多字节字符按 UTF-8 字节数累积', async () => {
    const events = makeEvents();
    const tracker = createToolCallGenTracker();
    await dispatchStreamChunk(
      { type: 'toolCallStart', index: 0, toolCallId: 'c0', name: 'fileWrite' },
      tracker,
      events,
    );
    await dispatchStreamChunk(
      { type: 'toolCallDelta', index: 0, argumentsDelta: '中' },
      tracker,
      events,
    );
    await dispatchStreamChunk(
      { type: 'toolCallDelta', index: 0, argumentsDelta: 'a' },
      tracker,
      events,
    );
    expect(events.onToolCallDelta).toHaveBeenLastCalledWith('fileWrite', 4, 0);
  });

  it('未收到 toolCallStart 时用占位名「工具」', async () => {
    const events = makeEvents();
    const tracker = createToolCallGenTracker();
    await dispatchStreamChunk(
      { type: 'toolCallDelta', index: 2, argumentsDelta: 'x' },
      tracker,
      events,
    );
    expect(events.onToolCallDelta).toHaveBeenCalledWith('工具', 1, 0);
  });

  it('按 index 分别累积互不干扰', async () => {
    const events = makeEvents();
    const tracker = createToolCallGenTracker();
    await dispatchStreamChunk({ type: 'toolCallStart', index: 0, toolCallId: 'a', name: 'A' }, tracker, events);
    await dispatchStreamChunk({ type: 'toolCallStart', index: 1, toolCallId: 'b', name: 'B' }, tracker, events);
    await dispatchStreamChunk({ type: 'toolCallDelta', index: 0, argumentsDelta: 'aa' }, tracker, events);
    await dispatchStreamChunk({ type: 'toolCallDelta', index: 1, argumentsDelta: 'bbbb' }, tracker, events);
    expect(events.onToolCallDelta).toHaveBeenNthCalledWith(1, 'A', 2, 0);
    expect(events.onToolCallDelta).toHaveBeenNthCalledWith(2, 'B', 4, 0);
  });

  it('done → 返回完整响应', async () => {
    const events = makeEvents();
    const tracker = createToolCallGenTracker();
    const ret = await dispatchStreamChunk(doneChunk, tracker, events);
    expect(ret).toBe(doneChunk.response);
  });
});
