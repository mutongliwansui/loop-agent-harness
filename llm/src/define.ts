/**
 * 把 provider 工厂编译成 core 插件。
 *
 * ## 为什么必须有两个导出
 *
 * `@loop-agent/main` 的 `defaultLoadPlugin`（`main/src/registry.ts`）把清单
 * 条目的 `options` 传给**模块默认导出的工厂函数**，兼容三种形态：
 * `export default (options) => Plugin`、`export default pluginObject`、
 * `export const plugin`。也就是说 **options 的通道是「外层工厂函数」，
 * `ctx` 上没有任何 options 通道**。
 *
 * 因此：
 * - 只给 `defineLlmProvider()`（形态 A，直接返回插件对象）→ 用户在清单里
 *   填的 `options` 会被**静默丢弃**，属于最难排查的一类「配置不生效」；
 * - 只给 `defineLlmProviderFactory()`（形态 B）→ 无覆盖需求时也要多包一层
 *   函数，且不满足 `export default pluginObject` 这一 main 支持的形态。
 *
 * 所以两者都提供，内部共用 `buildPlugin()`，差异仅在于 runtimeOptions
 * 从哪来（A 为空对象，B 由 main 注入）。
 */

import type { Context, Disposer, EventMapBase, PluginObject } from '@loop-agent/core';

import { LlmConfigError } from './errors.js';
import { LLM_SERVICE_KEYS } from './keys.js';
import type { LlmProvider } from './provider.js';
import { getLlmRegistry } from './registry.js';

/** provider 定义：代码侧声明「怎么造一个实例」 */
export interface LlmProviderDefinition {
  /** 唯一标识；非空、不含 `:`（`:` 会破坏服务 key 分段） */
  id: string;
  /** 展示名；缺省用实例的 displayName（再缺省回落 id） */
  displayName?: string;
  /**
   * 代码侧默认配置（JSON 可序列化）。
   *
   * 与清单条目的 `options` 做**浅合并**，清单侧同名键优先——这样「同一份
   * 实现、多套配置」可以靠清单表达，不必改代码。
   */
  options?: Record<string, unknown>;
  /** 工厂：接收合并后的 options，返回实例；可在内部 await（如预热连接） */
  create(options?: Record<string, unknown>): LlmProvider | Promise<LlmProvider>;
  /** 是否设为缺省 provider */
  isDefault?: boolean;
}

/** 同步校验定义；配置错误应在挂载前炸，而不是留到运行期第一次调用 */
function assertValidDefinition(def: LlmProviderDefinition): void {
  if (typeof def !== 'object' || def === null) {
    throw new LlmConfigError('LlmProviderDefinition 必须是对象');
  }
  const { id, create } = def;

  if (typeof id !== 'string' || id.trim() === '') {
    throw new LlmConfigError('LlmProviderDefinition.id 必须是非空字符串');
  }
  if (id.includes(':')) {
    // 冒号是服务 key 的分段符：'llm:provider:a:b' 无法反解出 id
    throw new LlmConfigError(`LlmProviderDefinition.id 不得包含冒号: '${id}'`);
  }
  if (typeof create !== 'function') {
    throw new LlmConfigError(`LlmProviderDefinition.create 必须是函数 (id: '${id}')`);
  }
}

/**
 * 构建插件对象（两个导出共用的唯一实现）。
 *
 * @param def 定义
 * @param runtimeOptions 部署侧覆盖值（来自清单条目）
 */
function buildPlugin<E extends EventMapBase>(
  def: LlmProviderDefinition,
  runtimeOptions: Record<string, unknown>,
): PluginObject<E> {
  assertValidDefinition(def);

  // 浅合并：代码侧默认值 ← 清单侧覆盖值（同名键后者胜）
  const mergedOptions = { ...def.options, ...runtimeOptions };

  return {
    name: `llm-provider:${def.id}`,
    // 硬依赖：llm:registry 未就绪时 Fiber 停在 PENDING、apply 不执行，
    // 绝不会出现「provider 抢跑后找不到目录」的中间态
    inject: { required: [LLM_SERVICE_KEYS.registry] },
    async apply(ctx: Context<E>) {
      const registry = getLlmRegistry(ctx);

      const provider = await def.create(mergedOptions);

      if (!provider || typeof provider !== 'object') {
        throw new LlmConfigError(`provider 工厂未返回实例 (id: '${def.id}')`);
      }
      if (provider.id !== def.id) {
        // key 由 def.id 决定，实例自报 id 不同会让服务 key 与实例永久错位，
        // diagnose() 与日志都对不上，属必须早期炸掉的错误
        throw new LlmConfigError(
          `provider.id ('${provider.id}') 与定义 id ('${def.id}') 不一致`,
        );
      }

      // 服务登记与目录登记都挂到 Fiber：卸载时自动撤销（顺序相反）
      ctx.provide(`${LLM_SERVICE_KEYS.providerPrefix}${def.id}`, provider);
      ctx.effect(
        () => registry.register(provider, { isDefault: def.isDefault === true }),
        `llm:provider:${def.id}`,
      );
    },
  };
}

/**
 * 形态 A：直接得到插件对象。
 *
 * ```ts
 * export default defineLlmProvider({ id: 'my-llm', create });
 * ```
 */
export function defineLlmProvider<E extends EventMapBase = EventMapBase>(
  def: LlmProviderDefinition,
): PluginObject<E> {
  return buildPlugin<E>(def, {});
}

/**
 * 形态 B：得到工厂，供 main 清单注入 `options`。
 *
 * ```ts
 * export default defineLlmProviderFactory({ id: 'my-llm', create });
 * // 清单里写 options 即可覆盖 def.options 的同名键
 * ```
 */
export function defineLlmProviderFactory<E extends EventMapBase = EventMapBase>(
  def: LlmProviderDefinition,
): (options?: Record<string, unknown>) => PluginObject<E> {
  // 定义错误尽早炸：工厂还没被调用时就先校验一遍
  assertValidDefinition(def);
  return (runtimeOptions) => buildPlugin<E>(def, runtimeOptions ?? {});
}

/** 供测试断言用：暴露合并逻辑，避免测试重复实现 */
export function mergeProviderOptions(
  defOptions: Record<string, unknown> | undefined,
  runtimeOptions: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...defOptions, ...runtimeOptions };
}

export type { Disposer };
