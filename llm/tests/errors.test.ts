import { CoreError } from '@loop-agent/core';
import { describe, expect, it } from 'vitest';

import {
  LlmAbortedError,
  LlmAuthError,
  LlmCapabilityError,
  LlmConfigError,
  LlmError,
  LlmProviderConflictError,
  LlmProviderNotFoundError,
  LlmRateLimitError,
  LlmRequestError,
  normalizeLlmError,
} from '../src/index.js';

describe('错误族 code 稳定性', () => {
  const cases: Array<[string, LlmError, string]> = [
    ['LlmError', new LlmError('m'), 'LLM_ERROR'],
    ['LlmConfigError', new LlmConfigError('m'), 'LLM_CONFIG_INVALID'],
    ['LlmProviderNotFoundError', new LlmProviderNotFoundError('x'), 'LLM_PROVIDER_NOT_FOUND'],
    ['LlmProviderConflictError', new LlmProviderConflictError('x'), 'LLM_PROVIDER_CONFLICT'],
    [
      'LlmCapabilityError',
      new LlmCapabilityError('p', 'toolCalling', 'm'),
      'LLM_CAPABILITY_UNSUPPORTED',
    ],
    ['LlmAuthError', new LlmAuthError('m'), 'LLM_AUTH_FAILED'],
    ['LlmRateLimitError', new LlmRateLimitError('m'), 'LLM_RATE_LIMIT'],
    ['LlmRequestError', new LlmRequestError('m'), 'LLM_REQUEST_FAILED'],
    ['LlmAbortedError', new LlmAbortedError(), 'LLM_ABORTED'],
  ];

  for (const [name, err, code] of cases) {
    it(`${name}.code === '${code}'`, () => {
      expect(err.code).toBe(code);
    });

    it(`${name} 是 CoreError 实例（宿主兜底捕获不漏）`, () => {
      expect(err).toBeInstanceOf(CoreError);
      expect(err).toBeInstanceOf(LlmError);
    });
  }

  it('name 与类名一致（日志可读）', () => {
    for (const [name, err] of cases) {
      expect(err.name).toBe(name);
    }
  });
});

describe('错误的附加字段', () => {
  it('LlmProviderNotFoundError 带 providerId', () => {
    expect(new LlmProviderNotFoundError('abc').providerId).toBe('abc');
  });

  it('LlmProviderConflictError 带 providerId', () => {
    expect(new LlmProviderConflictError('abc').providerId).toBe('abc');
  });

  it('LlmCapabilityError 带 providerId + capability', () => {
    const e = new LlmCapabilityError('p1', 'vision', 'm');
    expect(e.providerId).toBe('p1');
    expect(e.capability).toBe('vision');
  });

  it('LlmRateLimitError 带 retryAfterMs', () => {
    expect(new LlmRateLimitError('m', { retryAfterMs: 1500 }).retryAfterMs).toBe(1500);
  });

  it('LlmRequestError 带 status', () => {
    expect(new LlmRequestError('m', { status: 502 }).status).toBe(502);
  });

  it('CoreError 的 pluginName / fiberId 可透传', () => {
    const e = new LlmError('m', { pluginName: 'pl', fiberId: 'f1' });
    expect(e.pluginName).toBe('pl');
    expect(e.fiberId).toBe('f1');
  });
});

describe('normalizeLlmError', () => {
  it('已是 LlmError 的原样返回（保留精确 code 与附加字段）', () => {
    const original = new LlmRequestError('x', { status: 500 });
    expect(normalizeLlmError(original)).toBe(original);
  });

  it('普通 Error → 包为 LlmError，原错误挂 cause', () => {
    const boom = new Error('network');
    const e = normalizeLlmError(boom);
    expect(e).toBeInstanceOf(LlmError);
    expect(e.code).toBe('LLM_ERROR');
    expect(e.cause).toBe(boom);
    expect(e.message).toBe('network');
  });

  it('带 message 前缀时拼接细节', () => {
    const e = normalizeLlmError(new Error('boom'), { message: 'provider a 失败' });
    expect(e.message).toBe('provider a 失败: boom');
  });

  it('非 Error 抛出物（字符串）也能归一', () => {
    const e = normalizeLlmError('plain string');
    expect(e).toBeInstanceOf(LlmError);
    expect(e.message).toBe('plain string');
  });

  it('补全 pluginName / fiberId', () => {
    const e = normalizeLlmError(new Error('x'), { pluginName: 'p', fiberId: 'f' });
    expect(e.pluginName).toBe('p');
    expect(e.fiberId).toBe('f');
  });
});
