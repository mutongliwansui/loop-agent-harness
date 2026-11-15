/**
 * `LlmProvider` 抽象基类 —— 本包的核心契约。
 *
 * 为什么是**抽象基类**而非纯 interface：需求原话是「供…**继承**」，继承本身
 * 就是需求。纯 interface 会让每个实现重复写「流式降级」「能力默认值」等
 * 模板逻辑，且无法用 `instanceof` 判别。
 *
 * 抽象面**只有 `id` + `complete()` 两个必实现项**，其余全有默认实现。
 * 这是接口最小化原则：provider 作者的负担最低，不实现流式的也能用。
 */

import { defaultCapabilities, type LlmCapabilities } from './capabilities.js';
import type { LlmRequest, LlmResponse, LlmStreamEvent } from './types.js';

/** 单次调用的可选参数 */
export interface LlmCallOptions {
  /** 中止信号；已 aborted 时实现应立即抛 `LlmAbortedError` */
  signal?: AbortSignal;
  /**
   * 最小观测钩子：**只读**，不得改变请求/响应语义。
   *
   * 本期不做中间件链（重试/限流/预算/路由）：那些横切关注点的正确形态
   * 强依赖「谁来决定降级」，现在定就是拍脑袋。先留最小钩子位。
   */
  hooks?: LlmCallHooks;
}

/** 观测钩子；任一钩子抛错不应中断调用链（实现方自行 try/catch） */
export interface LlmCallHooks {
  onRequest?(providerId: string, req: LlmRequest): void;
  onResponse?(providerId: string, res: LlmResponse, elapsedMs: number): void;
  onError?(providerId: string, err: unknown): void;
}

/**
 * 大模型服务商契约。
 *
 * 最小实现只需两个成员：
 * ```ts
 * class MyProvider extends LlmProvider {
 *   readonly id = 'my-llm';
 *   async complete(req) { return { content: '…', finishReason: 'stop', model: req.model }; }
 * }
 * ```
 */
export abstract class LlmProvider {
  /** 唯一标识；由 `defineLlmProvider()` 校验非空、不含 `:`（会破坏服务 key 分段） */
  abstract readonly id: string;

  /** 展示名；缺省回落 id */
  get displayName(): string {
    return this.id;
  }

  /**
   * 能力声明。
   *
   * 缺省全 `false`：保守默认逼实现者**显式声明**自己支持什么，而不是
   * 默认「什么都能」然后在运行期炸。
   */
  capabilities(): LlmCapabilities {
    return defaultCapabilities();
  }

  /** 唯一必实现的抽象方法 */
  abstract complete(req: LlmRequest, opts?: LlmCallOptions): Promise<LlmResponse>;

  /**
   * 流式调用。
   *
   * 默认由 `complete()` 降级：一次性发 `text-delta` → `usage`（若有）→ `done`。
   * 原生支持流式的 provider 覆写此方法，**必须保证最后一个事件是 `done`**
   * （`LlmRegistry.stream()` 会兜底补齐，但那只是防御，正常路径应自己发）。
   *
   * 注意：默认降级**不发** `tool-call-start` / `tool-call-delta`。工具调用在
   * `complete()` 里已是完整结果，伪造增量没有意义；`done.response.toolCalls`
   * 足以表达。
   */
  async *stream(req: LlmRequest, opts?: LlmCallOptions): AsyncIterable<LlmStreamEvent> {
    const response = await this.complete(req, opts);
    if (response.content) {
      yield { type: 'text-delta', delta: response.content };
    }
    if (response.usage) {
      yield { type: 'usage', usage: response.usage };
    }
    yield { type: 'done', response };
  }

  /**
   * 卸载钩子：释放连接池、子进程、定时器等。
   *
   * 由 `LlmRegistry` 在 Fiber 撤销时调用，异常被捕获记录、不阻断其他 disposer。
   */
  protected async onDispose(): Promise<void> {
    // 缺省无事可做
  }

  /**
   * 供 registry 调用的卸载入口。
   *
   * `onDispose` 是 `protected`（不希望外部随意触发卸载语义），但 registry
   * 不是子类，需要这个 public 转发点。用 `Symbol` 风格的下划线前缀表明
   * 「框架内部使用」。
   */
  async dispose(): Promise<void> {
    await this.onDispose();
  }
}
