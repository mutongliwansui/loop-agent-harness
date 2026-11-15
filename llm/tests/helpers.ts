/**
 * 测试共用的假 provider。
 *
 * 刻意用真实 `class ... extends LlmProvider` 而非 mock 对象：
 * 本包的核心价值就是「能不能被继承」，用 mock 会把最该验证的东西跳过。
 */

import { LlmProvider, type LlmCallOptions, type LlmRequest, type LlmResponse } from '../src/index.js';

/** 记录调用情况的假 provider */
export class FakeProvider extends LlmProvider {
  readonly id: string;
  /** 每次 complete() 收到的请求，供断言 */
  readonly calls: LlmRequest[] = [];
  /** 自定义响应构造函数 */
  private responder: (req: LlmRequest) => LlmResponse | Promise<LlmResponse>;
  /** onDispose 被调用次数 */
  disposeCount = 0;

  constructor(
    id = 'fake',
    responder?: (req: LlmRequest) => LlmResponse | Promise<LlmResponse>,
  ) {
    super();
    this.id = id;
    this.responder = responder ?? ((req) => makeResponse(req));
  }

  /** 覆写以声明能力（默认全 false 由基类给出） */
  override capabilities() {
    return {
      streaming: false,
      toolCalling: true,
      vision: false,
      jsonMode: false,
      usageReporting: true,
      cacheReporting: false,
    };
  }

  async complete(req: LlmRequest, _opts?: LlmCallOptions): Promise<LlmResponse> {
    this.calls.push(req);
    return this.responder(req);
  }

  protected override async onDispose(): Promise<void> {
    this.disposeCount++;
  }
}

/** 构造一个最小响应 */
export function makeResponse(req: LlmRequest, content = 'ok'): LlmResponse {
  return {
    content,
    finishReason: 'stop',
    model: req.model,
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
  };
}

/** 构造一个最小请求 */
export function makeRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}
