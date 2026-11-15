import { describe, expect, it } from 'vitest';

import {
  assertRequestCapabilities,
  checkRequestCapabilities,
  defaultCapabilities,
  LlmCapabilityError,
  type LlmCapabilities,
} from '../src/index.js';
import { makeRequest } from './helpers.js';

/** 造一份「除指定项外全 false」的能力声明 */
function caps(overrides: Partial<LlmCapabilities> = {}): LlmCapabilities {
  return { ...defaultCapabilities(), ...overrides };
}

describe('defaultCapabilities', () => {
  it('缺省全 false，且 maxContextTokens 不伪造', () => {
    const c = defaultCapabilities();
    expect(c).toEqual({
      streaming: false,
      toolCalling: false,
      vision: false,
      jsonMode: false,
      usageReporting: false,
      cacheReporting: false,
    });
    expect(c.maxContextTokens).toBeUndefined();
  });
});

describe('checkRequestCapabilities', () => {
  it('能力充分时无违例', () => {
    expect(
      checkRequestCapabilities(
        makeRequest({ tools: [{ name: 'f', description: '', parameters: {} }] }),
        caps({ toolCalling: true }),
      ),
    ).toEqual([]);
  });

  it('带 tools 但 toolCalling:false → 一条 toolCalling 违例', () => {
    const v = checkRequestCapabilities(
      makeRequest({ tools: [{ name: 'f', description: '', parameters: {} }] }),
      caps(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.capability).toBe('toolCalling');
  });

  it('空 tools 数组不算违例（等价于没带工具）', () => {
    expect(checkRequestCapabilities(makeRequest({ tools: [] }), caps())).toEqual([]);
  });

  it('指定 toolChoice 但 toolCalling:false → 违例', () => {
    const v = checkRequestCapabilities(makeRequest({ toolChoice: 'required' }), caps());
    expect(v.some((x) => x.capability === 'toolCalling')).toBe(true);
  });

  it("toolChoice:'none' 不触发违例（明确表示不用工具）", () => {
    expect(checkRequestCapabilities(makeRequest({ toolChoice: 'none' }), caps())).toEqual([]);
  });

  it('responseFormat.type=json 但 jsonMode:false → 违例', () => {
    const v = checkRequestCapabilities(
      makeRequest({ responseFormat: { type: 'json' } }),
      caps(),
    );
    expect(v.some((x) => x.capability === 'jsonMode')).toBe(true);
  });

  it('responseFormat.type=text 不触发违例', () => {
    expect(
      checkRequestCapabilities(makeRequest({ responseFormat: { type: 'text' } }), caps()),
    ).toEqual([]);
  });

  it('消息含 image 分片但 vision:false → 违例', () => {
    const v = checkRequestCapabilities(
      makeRequest({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this' },
              { type: 'image', mimeType: 'image/png', data: 'AAA' },
            ],
          },
        ],
      }),
      caps(),
    );
    expect(v.some((x) => x.capability === 'vision')).toBe(true);
  });

  it('vision:true 时图片分片不违例', () => {
    expect(
      checkRequestCapabilities(
        makeRequest({
          messages: [
            { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'AAA' }] },
          ],
        }),
        caps({ vision: true }),
      ),
    ).toEqual([]);
  });

  it('maxTokens 超过 maxContextTokens → 违例', () => {
    const v = checkRequestCapabilities(
      makeRequest({ maxTokens: 1000 }),
      caps({ maxContextTokens: 100 }),
    );
    expect(v.some((x) => x.capability === 'maxContextTokens')).toBe(true);
  });

  it('maxContextTokens 未知（undefined）时不做上限检查', () => {
    expect(checkRequestCapabilities(makeRequest({ maxTokens: 999999 }), caps())).toEqual([]);
  });

  it('多项违例一次性全报（不「改一个报一个」）', () => {
    const v = checkRequestCapabilities(
      makeRequest({
        tools: [{ name: 'f', description: '', parameters: {} }],
        responseFormat: { type: 'json' },
        messages: [
          { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'A' }] },
        ],
      }),
      caps(),
    );
    const kinds = v.map((x) => x.capability);
    expect(kinds).toContain('toolCalling');
    expect(kinds).toContain('jsonMode');
    expect(kinds).toContain('vision');
    expect(v.length).toBe(3);
  });
});

describe('assertRequestCapabilities', () => {
  it('能力充分时不抛错', () => {
    expect(() =>
      assertRequestCapabilities('p', makeRequest(), caps({ toolCalling: true })),
    ).not.toThrow();
  });

  it('有违例时抛 LlmCapabilityError，带 providerId 与首个能力位', () => {
    let caught: unknown;
    try {
      assertRequestCapabilities(
        'my-provider',
        makeRequest({ tools: [{ name: 'f', description: '', parameters: {} }] }),
        caps(),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmCapabilityError);
    const e = caught as LlmCapabilityError;
    expect(e.providerId).toBe('my-provider');
    expect(e.capability).toBe('toolCalling');
    expect(e.code).toBe('LLM_CAPABILITY_UNSUPPORTED');
  });

  it('多项违例时消息提示总数，完整清单挂在 cause', () => {
    let caught: unknown;
    try {
      assertRequestCapabilities(
        'p',
        makeRequest({
          tools: [{ name: 'f', description: '', parameters: {} }],
          responseFormat: { type: 'json' },
        }),
        caps(),
      );
    } catch (err) {
      caught = err;
    }
    const e = caught as LlmCapabilityError;
    expect(e.message).toContain('另有 1 项');
    expect(Array.isArray(e.cause)).toBe(true);
    expect((e.cause as unknown[]).length).toBe(2);
  });
});
