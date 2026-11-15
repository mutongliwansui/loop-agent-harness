/**
 * 大模型 provider 目录服务与安装器。
 *
 * ## 为什么事件不走 core 的 `host.bus`
 *
 * core 的 `Context` 接口只暴露 `on()`（注册监听），**没有 `emit()`**——
 * 事件总线在 `CoreHost.bus` 上，而插件（`PluginObject.apply(ctx)`）拿不到
 * host。若 llm 硬依赖 core 总线发事件，就必须让 installLlm 额外要求宿主
 * 注入 host，把简单契约复杂化。
 *
 * 因此 registry 自带一个极小的发射器：`registry.on(...)` 订阅、内部 emit。
 * 好处是 llm 包对外只需 `ctx.get('llm:registry')` 一个动作就能用全，
 * 也便于在没有 core 的单元测试里单独验证事件。
 *
 * ## 服务 key 布局
 *
 * `llm:registry` 一个目录实例 + 每个 provider 独占 `llm:provider:<id>`。
 * 理由见 `keys.ts` 的注释（core 重复 key 抛冲突、不覆盖）。
 */

import { ServiceConflictError, type Context, type Disposer, type EventMapBase, type PluginObject } from '@loop-agent/core';

import { assertRequestCapabilities, type LlmCapabilities } from './capabilities.js';
import {
  LlmError,
  LlmProviderConflictError,
  LlmProviderNotFoundError,
  normalizeLlmError,
} from './errors.js';
import type { LlmEvents } from './events.js';
import { LLM_SERVICE_KEYS, providerServiceKey } from './keys.js';
import type { LlmProvider, LlmCallOptions } from './provider.js';
import type { LlmRequest, LlmResponse, LlmStreamEvent } from './types.js';

/** `list()` 返回的 provider 摘要 */
export interface LlmProviderInfo {
  id: string;
  displayName: string;
  capabilities: LlmCapabilities;
  isDefault: boolean;
}

/** 目录服务对外契约 */
export interface LlmRegistry {
  /** 已注册 provider 摘要（按注册序） */
  list(): LlmProviderInfo[];
  /** 取实例；未注册返回 undefined */
  get(id: string): LlmProvider | undefined;
  /** 取实例；未注册抛 `LlmProviderNotFoundError` */
  require(id: string): LlmProvider;
  /** 缺省 provider：`isDefault` 显式指定者，否则首个注册者 */
  defaultProvider(): LlmProvider | undefined;
  /** 改缺省；目标不存在抛 `LlmProviderNotFoundError` */
  setDefault(id: string): void;

  /** 便捷调用：能力校验 → 调 provider → 发事件 → 归一错误 */
  complete(id: string, req: LlmRequest, opts?: LlmCallOptions): Promise<LlmResponse>;
  /** 流式调用；末尾保证有一个 `done` */
  stream(id: string, req: LlmRequest, opts?: LlmCallOptions): AsyncIterable<LlmStreamEvent>;

  /** 注册；重复 id 抛 `LlmProviderConflictError`。返回的 Disposer 注销并调 onDispose */
  register(provider: LlmProvider, opts?: { isDefault?: boolean }): Disposer;

  /** 订阅事件；返回取消订阅函数 */
  on<K extends keyof LlmEvents & string>(event: K, listener: LlmEvents[K]): Disposer;
}

/** 内部登记结构 */
interface Entry {
  provider: LlmProvider;
  isDefault: boolean;
}

/** 默认实现 */
class LlmRegistryImpl implements LlmRegistry {
  /** id → 登记；Map 保持插入序，`list()` 直接受益 */
  private readonly entries = new Map<string, Entry>();
  /** 事件监听器表；与 entries 分离，便于订阅者独立增删 */
  private readonly listeners = new Map<string, Set<(...args: never[]) => void>>();
  /** 显式缺省 id；为 undefined 时回落到首个注册者 */
  private defaultId?: string;

  list(): LlmProviderInfo[] {
    return [...this.entries.entries()].map(([id, entry]) => ({
      id,
      displayName: entry.provider.displayName,
      capabilities: entry.provider.capabilities(),
      isDefault: this.isDefaultId(id),
    }));
  }

  get(id: string): LlmProvider | undefined {
    return this.entries.get(id)?.provider;
  }

  require(id: string): LlmProvider {
    const provider = this.get(id);
    if (!provider) throw new LlmProviderNotFoundError(id);
    return provider;
  }

  defaultProvider(): LlmProvider | undefined {
    const id = this.effectiveDefaultId();
    return id === undefined ? undefined : this.get(id);
  }

  setDefault(id: string): void {
    this.require(id);
    this.defaultId = id;
  }

  register(provider: LlmProvider, opts: { isDefault?: boolean } = {}): Disposer {
    const { id } = provider;
    if (this.entries.has(id)) throw new LlmProviderConflictError(id);

    this.entries.set(id, { provider, isDefault: opts.isDefault === true });
    if (opts.isDefault === true) this.defaultId = id;

    this.emit('llm/registered', { providerId: id, displayName: provider.displayName });

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.entries.delete(id);
      if (this.defaultId === id) this.defaultId = undefined;
      this.emit('llm/unregistered', { providerId: id });
      // 卸载时释放实现侧资源；异常不得阻断调用方的 disposer 链
      void Promise.resolve()
        .then(() => provider.dispose())
        .catch(() => {
          // 吞掉：卸载期异常不应让 Fiber 的 disposer 链中断
        });
    };
  }

  async complete(id: string, req: LlmRequest, opts?: LlmCallOptions): Promise<LlmResponse> {
    const provider = this.require(id);
    // 能力校验在调用**之前**：不满足即拒绝，绝不发出网络请求
    assertRequestCapabilities(id, req, provider.capabilities());

    this.emit('llm/request', { providerId: id, request: req });
    const startedAt = Date.now();

    try {
      const response = await provider.complete(req, opts);
      const elapsedMs = Date.now() - startedAt;
      this.emit('llm/response', { providerId: id, response, elapsedMs });
      return response;
    } catch (err) {
      const error = normalizeLlmError(err, { message: `provider ${id} 调用失败` });
      this.emit('llm/error', { providerId: id, error });
      throw error;
    }
  }

  async *stream(
    id: string,
    req: LlmRequest,
    opts?: LlmCallOptions,
  ): AsyncIterable<LlmStreamEvent> {
    const provider = this.require(id);
    assertRequestCapabilities(id, req, provider.capabilities());

    this.emit('llm/request', { providerId: id, request: req });
    const startedAt = Date.now();

    // 累积分片，用于「实现忘了发 done」时尽力构造收尾响应
    let text = '';
    let usage: LlmResponse['usage'];
    let last: LlmStreamEvent | undefined;

    try {
      for await (const event of provider.stream(req, opts)) {
        last = event;
        if (event.type === 'text-delta') text += event.delta;
        else if (event.type === 'usage') usage = event.usage;
        yield event;
      }
    } catch (err) {
      const error = normalizeLlmError(err, { message: `provider ${id} 流式调用失败` });
      this.emit('llm/error', { providerId: id, error });
      throw error;
    }

    // 防御：实现未以 done 收尾时补齐。不视为错误（宽松契约），但文档写明。
    if (last?.type !== 'done') {
      const response: LlmResponse = {
        content: text === '' ? null : text,
        finishReason: 'stop',
        model: req.model,
        ...(usage ? { usage } : {}),
      };
      yield { type: 'done', response };
    }

    // 流式耗时在 done 之后才有意义，事件里只带 providerId 与总耗时
    this.emit('llm/response', {
      providerId: id,
      response: last?.type === 'done' ? last.response : { content: null, finishReason: 'stop', model: req.model },
      elapsedMs: Date.now() - startedAt,
    });
  }

  on<K extends keyof LlmEvents & string>(event: K, listener: LlmEvents[K]): Disposer {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const stored = listener as (...args: never[]) => void;
    set.add(stored);
    return () => {
      set.delete(stored);
      if (set.size === 0) this.listeners.delete(event);
    };
  }

  /** 安全 emit：监听器抛错被吞，绝不中断调用链 */
  private emit<K extends keyof LlmEvents & string>(
    event: K,
    payload: Parameters<LlmEvents[K]>[0],
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        (listener as (p: unknown) => void)(payload);
      } catch {
        // 事件是只读观测，监听器故障不应影响业务调用
      }
    }
  }

  /** 显式缺省优先，否则首个注册者 */
  private effectiveDefaultId(): string | undefined {
    if (this.defaultId !== undefined && this.entries.has(this.defaultId)) return this.defaultId;
    const first = this.entries.keys().next();
    return first.done ? undefined : first.value;
  }

  private isDefaultId(id: string): boolean {
    return this.effectiveDefaultId() === id;
  }
}

/**
 * 创建目录实例（供 installLlm 与测试使用）。
 *
 * 不直接导出 `LlmRegistryImpl`：实现细节应可自由重构，使用方只依赖接口。
 */
export function createLlmRegistry(): LlmRegistry {
  return new LlmRegistryImpl();
}

/**
 * llm 包自身的 bootstrap 插件：提供 `llm:registry`。
 *
 * 重复安装不静默忽略 —— core 的设计哲学是冲突显式化，llm 不另立标准。
 * 但把 `CORE_SERVICE_CONFLICT` 翻译成可读的 `LLM_REGISTRY_EXISTS`，
 * 避免使用者对着 code 猜。
 */
export function installLlm<E extends EventMapBase = EventMapBase>(): PluginObject<E> {
  return {
    name: 'llm',
    apply(ctx: Context<E>) {
      try {
        ctx.provide(LLM_SERVICE_KEYS.registry, createLlmRegistry());
      } catch (err) {
        if (err instanceof ServiceConflictError) {
          throw new LlmError('llm 已安装，请勿重复调用 installLlm()', {
            code: 'LLM_REGISTRY_EXISTS',
            cause: err,
          });
        }
        throw err;
      }
    },
  };
}

/** 取目录服务；未安装时抛带提示的错误 */
export function getLlmRegistry<E extends EventMapBase>(ctx: Context<E>): LlmRegistry {
  const registry = ctx.get<LlmRegistry>(LLM_SERVICE_KEYS.registry);
  if (!registry) {
    throw new LlmError(
      `未找到 ${LLM_SERVICE_KEYS.registry}：请先挂载 installLlm()`,
      { code: 'LLM_REGISTRY_MISSING' },
    );
  }
  return registry;
}

export { providerServiceKey };
