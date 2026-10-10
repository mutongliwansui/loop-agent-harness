/**
 * 视觉模型调用 chatVision 单测（Task-20261010-001）
 * 覆盖：请求参数构造、jsonMode 降级重试（仅一次）、错误语境重写、空 choices 重试耗尽、视觉客户端缓存复用
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import OpenAI from 'openai';
import { llm } from '../src/llm/client.js';
import type { VisionChatOptions } from '../src/llm/client.js';
import type { VisionMessage } from '../src/types.js';

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
    constructor(opts: { apiKey: string; baseURL: string }) {
      constructed.push(`${opts.apiKey}@${opts.baseURL}`);
    }
  }
  return { default: MockOpenAI };
});

/** 用 mock 工厂暴露的 APIError 构造指定状态码错误（走 isRetryable/wrapError 真实分支） */
function apiError(status: number, message = 'request failed'): Error {
  const Ctor = (OpenAI as unknown as { APIError: new (status: number, message: string) => Error }).APIError;
  return new Ctor(status, message);
}

const messages: VisionMessage[] = [
  { role: 'system', content: 'sys' },
  {
    role: 'user',
    content: [
      { type: 'text', text: '描述图片' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
    ],
  },
];

function opts(overrides: Partial<VisionChatOptions> = {}): VisionChatOptions {
  return {
    baseUrl: 'https://v.example',
    apiKey: 'k1',
    model: 'v-model',
    temperature: 0.2,
    maxTokens: 512,
    ...overrides,
  };
}

const okResp = {
  choices: [{ message: { content: '识别结果' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

beforeEach(() => {
  createMock.mockReset();
});

describe('chatVision 基本流程', () => {
  it('成功调用：参数透传 + 返回 content/usage/elapsedMs', async () => {
    createMock.mockResolvedValue(okResp);
    const r = await llm.chatVision(messages, opts());
    expect(r.content).toBe('识别结果');
    expect(r.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(createMock).toHaveBeenCalledTimes(1);
    const params = createMock.mock.calls[0][0];
    expect(params).toMatchObject({
      model: 'v-model',
      temperature: 0.2,
      max_tokens: 512,
      messages,
    });
    expect(params.response_format).toBeUndefined();
  });

  it('usage 缺失时返回 undefined 而不报错', async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    const r = await llm.chatVision(messages, opts());
    expect(r.content).toBe('ok');
    expect(r.usage).toBeUndefined();
  });
});

describe('jsonMode 行为', () => {
  it('jsonMode=true 时请求携带 response_format: json_object', async () => {
    createMock.mockResolvedValue(okResp);
    await llm.chatVision(messages, opts({ jsonMode: true }));
    expect(createMock.mock.calls[0][0].response_format).toEqual({ type: 'json_object' });
  });

  it('jsonMode 请求失败（400）时自动降级为普通模式重试一次', async () => {
    createMock.mockRejectedValueOnce(apiError(400, 'response_format unsupported'));
    createMock.mockResolvedValueOnce(okResp);
    const r = await llm.chatVision(messages, opts({ jsonMode: true }));
    expect(r.content).toBe('识别结果');
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0][0].response_format).toEqual({ type: 'json_object' });
    expect(createMock.mock.calls[1][0].response_format).toBeUndefined();
  });

  it('降级重试仍失败时抛出视觉语境错误', async () => {
    createMock.mockRejectedValue(apiError(400, 'bad request'));
    await expect(llm.chatVision(messages, opts({ jsonMode: true }))).rejects.toThrow('视觉模型调用失败');
  });
});

describe('错误语境重写', () => {
  it('401 时把主模型 apiKey 提示重写为 vision.apiKey 提示', async () => {
    createMock.mockRejectedValue(apiError(401));
    await expect(llm.chatVision(messages, opts())).rejects.toThrow(
      'API Key 无效或已过期，请检查视觉配置 vision.apiKey（未设置时回退主模型 OPENAI_API_KEY）',
    );
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('404 时把主模型 MODEL_NAME 提示重写为 vision.model 提示', async () => {
    createMock.mockRejectedValue(apiError(404));
    await expect(llm.chatVision(messages, opts())).rejects.toThrow(
      '请检查视觉配置 vision.model（当前: v-model）',
    );
  });

  it('普通错误包装为"视觉模型调用失败"前缀', async () => {
    createMock.mockRejectedValue(apiError(403, 'forbidden'));
    await expect(llm.chatVision(messages, opts())).rejects.toThrow('视觉模型调用失败');
  });
});

describe('空响应与重试', () => {
  it('choices 为空时重试耗尽后抛出明确错误', async () => {
    createMock.mockResolvedValue({ choices: [] });
    vi.useFakeTimers();
    try {
      const p = llm.chatVision(messages, opts());
      const assertion = expect(p).rejects.toThrow('视觉模型返回为空');
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(createMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('视觉客户端缓存', () => {
  it('相同 apiKey/baseUrl 复用客户端实例，配置变化时重建', async () => {
    createMock.mockResolvedValue(okResp);
    const before = constructed.length;
    await llm.chatVision(messages, opts({ apiKey: 'k1', baseUrl: 'https://a' }));
    await llm.chatVision(messages, opts({ apiKey: 'k1', baseUrl: 'https://a' }));
    expect(constructed.length - before).toBe(1);
    await llm.chatVision(messages, opts({ apiKey: 'k2', baseUrl: 'https://a' }));
    expect(constructed.length - before).toBe(2);
    await llm.chatVision(messages, opts({ apiKey: 'k2', baseUrl: 'https://b' }));
    expect(constructed.length - before).toBe(3);
  });
});
