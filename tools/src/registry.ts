/**
 * 工具目录服务与安装器。
 *
 * ## 为什么事件不走 core 的 `host.bus`
 *
 * core 的 `Context` 只暴露 `on()`（注册监听），**没有 `emit()`**——事件总线在
 * `CoreHost.bus` 上，而插件（`PluginObject.apply(ctx)`）拿不到 host。若 tools
 * 硬依赖 core 总线，`installTools()` 就必须额外要求宿主注入 host，把简单契约
 * 复杂化。因此 registry 自带极小发射器：`registry.on(...)` 订阅、内部 emit。
 * 好处是对外只需 `ctx.get('tools:registry')` 一个动作即可用全，也便于在没有
 * core 的单元测试里单独验证事件。（与 llm 的 `registry.ts` 同一结论。）
 *
 * ## 服务 key 布局
 *
 * `tools:registry` 一个目录实例 + 每个提供者独占 `tools:provider:<id>`。
 * 理由见 `keys.ts`（core 重复 key 抛冲突、不覆盖）。
 */

import {
  ServiceConflictError,
  type Context,
  type Disposer,
  type EventMapBase,
  type PluginObject,
} from '@loop-agent/core';

import {
  ToolsDuplicateError,
  ToolsError,
  ToolsInvalidNameError,
  ToolsNotFoundError,
  ToolsRegistryExistsError,
  ToolsRegistryMissingError,
} from './errors.js';
import { validateToolName } from './schema.js';
import type { ToolsEvents } from './events.js';
import { TOOLS_SERVICE_KEYS } from './keys.js';
import { canonicalize } from './schema.js';
import type { ToolBase } from './tool.js';
import type { ToolDefView, ToolInvokeContext, ToolResult, ToolSpec } from './types.js';

/** 注册选项 */
export interface RegisterOptions {
  /** 来源提供者 id；用于重名冲突诊断与注销事件归属 */
  providerId?: string;
}

/** 目录内登记项 */
interface Entry {
  tool: ToolBase;
  providerId?: string;
}

/** 目录服务对外契约 */
export interface ToolRegistry {
  /** 全部工具规格（按注册序，供诊断 / UI） */
  list(): ToolSpec[];
  /** 已注册工具名（按注册序） */
  names(): string[];
  /** 按名取实例；未注册返回 undefined */
  get(name: string): ToolBase | undefined;
  /** 按名取实例；未注册抛 `ToolsNotFoundError` */
  require(name: string): ToolBase;
  /** 已注册工具数 */
  count(): number;
  /** 某提供者名下的工具名列表（诊断用） */
  listByProvider(providerId: string): string[];

  /**
   * 注册单个工具；重名抛 `ToolsDuplicateError`。
   *
   * 返回的 `Disposer` 可注销；重复调用幂等（第二次起无事发生）。
   */
  register(tool: ToolBase, opts?: RegisterOptions): Disposer;

  /**
   * 批量注册：**先全部校验，全部通过后再落登记**。
   *
   * 任一项不合法即抛错且不留半挂载状态——避免「47 个工具挂到第 30 个炸了，
   * 前 29 个留在目录里」这种只能重启才能清理的中间态。
   *
   * 返回的 `Disposer` 一次性撤销整批（逆序）。
   */
  registerAll(tools: ToolBase[], opts?: RegisterOptions): Disposer;

  /** 唯一调用入口：require → tool.invoke() → 事件 */
  invoke(name: string, rawArgs: unknown, ctx?: ToolInvokeContext): Promise<ToolResult>;

  /**
   * 模型侧工具定义：**按 name 升序 + parameters 规范化**。
   *
   * 这两件事不是「好看」，而是前缀缓存不变量（见 `schema.ts` 的 canonicalize
   * 注释与 `src/tools/registry.ts:108-123` 的既有实证）。
   */
  toToolDefs(): ToolDefView[];

  /** 订阅事件；返回取消订阅函数 */
  on<K extends keyof ToolsEvents & string>(event: K, listener: ToolsEvents[K]): Disposer;
}

/** 默认实现 */
class ToolRegistryImpl implements ToolRegistry {
  /** name → 登记；Map 保持插入序，`list()` 直接受益 */
  private readonly entries = new Map<string, Entry>();
  /** 事件监听器表；与 entries 分离，便于订阅者独立增删 */
  private readonly listeners = new Map<string, Set<(payload: never) => void>>();

  list(): ToolSpec[] {
    return [...this.entries.values()].map((e) => e.tool.toSpec());
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  get(name: string): ToolBase | undefined {
    return this.entries.get(name)?.tool;
  }

  require(name: string): ToolBase {
    const tool = this.get(name);
    if (!tool) throw new ToolsNotFoundError(name);
    return tool;
  }

  count(): number {
    return this.entries.size;
  }

  listByProvider(providerId: string): string[] {
    return [...this.entries.entries()]
      .filter(([, e]) => e.providerId === providerId)
      .map(([name]) => name);
  }

  register(tool: ToolBase, opts: RegisterOptions = {}): Disposer {
    const { name } = tool;
    // 注册期名字校验放在这里而非只放 define：用户也可能直接调用 register()，
    // 两条入口都必须拦（D8「注册期同步校验」不是「挂载期同步校验」）
    const nameCheck = validateToolName(name);
    if (!nameCheck.ok) {
      throw new ToolsInvalidNameError(name, nameCheck.reason ?? '格式不合法', {
        pluginName: opts.providerId,
      });
    }

    const existing = this.entries.get(name);
    if (existing) {
      // 不覆盖：工具名是模型调用的唯一寻址键，静默覆盖会导致「注册了新工具、
      // 模型却调到旧实现」，比崩溃更难查（与 core「冲突显式化」哲学一致）
      throw new ToolsDuplicateError(name, {
        existingProviderId: existing.providerId,
        incomingProviderId: opts.providerId,
      });
    }

    this.entries.set(name, { tool, providerId: opts.providerId });
    this.emit('tools/registered', { name, providerId: opts.providerId });

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      // 只摘自己登记的那一条：同一 name 可能已被新提供者重新注册
      const current = this.entries.get(name);
      if (current?.tool === tool) {
        this.entries.delete(name);
        this.emit('tools/unregistered', { name, providerId: opts.providerId });
      }
    };
  }

  registerAll(tools: ToolBase[], opts: RegisterOptions = {}): Disposer {
    // ① 批内自查重名（同一个 create() 返回两个同名工具属实现错误）
    const seen = new Set<string>();
    for (const tool of tools) {
      if (seen.has(tool.name)) {
        throw new ToolsDuplicateError(tool.name, {
          existingProviderId: opts.providerId,
          incomingProviderId: opts.providerId,
        });
      }
      seen.add(tool.name);
    }

    // ② 与目录自查重名（此时尚未写入任何一条）
    for (const tool of tools) {
      const existing = this.entries.get(tool.name);
      if (existing) {
        throw new ToolsDuplicateError(tool.name, {
          existingProviderId: existing.providerId,
          incomingProviderId: opts.providerId,
        });
      }
    }

    // ③ 全部通过后才落登记；中途失败（理论不可达）也能整体回滚
    const disposers: Disposer[] = [];
    try {
      for (const tool of tools) {
        disposers.push(this.register(tool, opts));
      }
    } catch (err) {
      for (const dispose of disposers.reverse()) dispose();
      throw err;
    }

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      // 逆序撤销：后注册的先摘，与 core 的 disposer 链语义一致
      for (const dispose of disposers.reverse()) dispose();
    };
  }

  async invoke(name: string, rawArgs: unknown, ctx: ToolInvokeContext = {}): Promise<ToolResult> {
    const tool = this.require(name);
    const args =
      rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};

    // invoke 事件在**校验之前**发：便于观测到「模型给了什么」，
    // 包括那些最终因参数非法而失败的情况
    this.emit('tools/invoke', { name, args });

    const startedAt = Date.now();
    const result = await tool.invoke(rawArgs, ctx);
    const elapsedMs = Date.now() - startedAt;

    this.emit('tools/result', { name, result, elapsedMs });
    if (result.isError === true) {
      this.emit('tools/error', {
        name,
        error: new ToolsError(result.text, { code: 'TOOLS_EXEC_FAILED' }),
      });
    }
    return result;
  }

  toToolDefs(): ToolDefView[] {
    // 基于快照遍历：并发注销不会导致迭代中途抛错
    return [...this.entries.values()]
      .map((e) => e.tool)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        // canonicalize：键序抖动会让 provider 前缀缓存整体失效（成本/延迟双升且不报错）
        parameters: canonicalize(tool.parameters),
      }));
  }

  on<K extends keyof ToolsEvents & string>(event: K, listener: ToolsEvents[K]): Disposer {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const stored = listener as (payload: never) => void;
    set.add(stored);
    return () => {
      set.delete(stored);
      if (set.size === 0) this.listeners.delete(event);
    };
  }

  /** 安全 emit：监听器抛错被吞，绝不中断调用链 */
  private emit<K extends keyof ToolsEvents & string>(
    event: K,
    payload: Parameters<ToolsEvents[K]>[0],
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
}

/**
 * 创建目录实例（供 installTools 与测试使用）。
 *
 * 不直接导出 `ToolRegistryImpl`：实现细节应可自由重构，使用方只依赖接口。
 */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistryImpl();
}

/**
 * tools 包自身的 bootstrap 插件：提供 `tools:registry`。
 *
 * 重复安装不静默忽略——core 的设计哲学是冲突显式化。但把
 * `CORE_SERVICE_CONFLICT` 翻译成可读的 `TOOLS_REGISTRY_EXISTS`，
 * 避免使用者对着 code 猜。
 */
export function installTools<E extends EventMapBase = EventMapBase>(): PluginObject<E> {
  return {
    name: 'tools',
    apply(ctx: Context<E>) {
      try {
        ctx.provide(TOOLS_SERVICE_KEYS.registry, createToolRegistry());
      } catch (err) {
        if (err instanceof ServiceConflictError) {
          throw new ToolsRegistryExistsError({ cause: err });
        }
        throw err;
      }
    },
  };
}

/** 取目录服务；未安装时抛带提示的错误 */
export function getToolRegistry<E extends EventMapBase>(ctx: Context<E>): ToolRegistry {
  const registry = ctx.get<ToolRegistry>(TOOLS_SERVICE_KEYS.registry);
  if (!registry) {
    throw new ToolsRegistryMissingError(TOOLS_SERVICE_KEYS.registry);
  }
  return registry;
}
