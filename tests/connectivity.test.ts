/**
 * 连通性校验 defaultCheckConnectivity 单测（Task-20261011-002 真机反馈加固）
 * 覆盖：成功路径、瞬时传输层错误自动重试一次、4xx/超时不重试、错误文案分类、SDK 客户端构造参数
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import OpenAI from 'openai';
import { defaultCheckConnectivity } from '../src/llm/connectivity.js';

const { createMock, constructed } = vi.hoisted(() => ({
  createMock: vi.fn(),
  constructed: [] as string[],
}));

vi.mock('openai', () => {
  class APIError extends Error {
    status: number | undefined;
    constructor(status: number | undefined, message: string) {
      super(message);
      this.name = 'APIError';
      this.status = status;
    }
  }
  class MockOpenAI {
    static APIError = APIError;
    chat = { completions: { create: createMock } };
    constructor(opts: { apiKey: string; baseURL: string; timeout?: number; maxRetries?: number }) {
      constructed.push(`${opts.apiKey}@${opts.baseURL}:timeout=${opts.timeout}:retries=${opts.maxRetries}`);
    }
  }
  return { default: MockOpenAI };
});

/** 用 mock 工厂暴露的 APIError 构造指定状态码错误（带 status，视为确定性失败） */
function apiError(status: number, message = 'request failed'): Error {
  const Ctor = (OpenAI as unknown as { APIError: new (status: number, message: string) => Error }).APIError;
  return new Ctor(status, message);
}

/** 构造流式响应 mock（含 AbortController，与 openai SDK Stream 形状一致） */
function mockStream(chunks: object[] = [{ id: 'c1', choices: [] }]): {
  controller: AbortController;
  [Symbol.asyncIterator](): AsyncIterator<object>;
} {
  const controller = new AbortController();
  async function* gen() {
    for (const c of chunks) yield c;
  }
  return { controller, [Symbol.asyncIterator]: () => gen() };
}

const candidate = { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', name: 'deepseek-chat' };

beforeEach(() => {
  createMock.mockReset();
  constructed.length = 0;
});

describe('defaultCheckConnectivity', () => {
  it('成功路径（流式）：收到首个响应块即 ok，create 收到流式极小 ping 请求', async () => {
    createMock.mockResolvedValueOnce(mockStream());
    const result = await defaultCheckConnectivity(candidate);
    expect(result.ok).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 16,
      stream: true,
    });
    expect(constructed[0]).toBe('sk-test@https://api.deepseek.com:timeout=15000:retries=0');
  });

  it('流式响应无内容块直接结束：同样判定连通（部分网关首块即 [DONE]）', async () => {
    createMock.mockResolvedValueOnce(mockStream([]));
    const result = await defaultCheckConnectivity(candidate);
    expect(result.ok).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('瞬时传输层错误（Premature close）：自动重试一次后成功', async () => {
    createMock
      .mockRejectedValueOnce(new TypeError('Invalid response body while trying to fetch url: Premature close'))
      .mockResolvedValueOnce(mockStream());
    const result = await defaultCheckConnectivity(candidate);
    expect(result.ok).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('瞬时错误重试仍失败：返回友好文案「连接被提前断开」，不透传原始报文', async () => {
    createMock
      .mockRejectedValueOnce(new TypeError('fetch failed: Premature close'))
      .mockRejectedValueOnce(new TypeError('fetch failed: Premature close'));
    const result = await defaultCheckConnectivity(candidate);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('连接被提前断开（网络抖动或服务端临时异常），请重试');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('401 确定性失败：不重试（仅 1 次调用）', async () => {
    createMock.mockRejectedValueOnce(apiError(401, 'Authentication Fails'));
    const result = await defaultCheckConnectivity(candidate);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('apiKey 无效或无权限');
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('超时错误：不重试（重试会成倍拖慢交互），提示检查网络或代理', async () => {
    createMock.mockRejectedValueOnce(new Error('Request timed out after 15000ms'));
    const result = await defaultCheckConnectivity(candidate);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('校验超时（15s），请检查网络或代理设置');
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('其他网络错误（无 status 且非超时）：重试一次后仍失败，透传原始报文', async () => {
    createMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await defaultCheckConnectivity(candidate);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('无法连接到服务地址：ECONNREFUSED');
    expect(createMock).toHaveBeenCalledTimes(2);
  });
});
