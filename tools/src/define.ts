/**
 * 把工具提供者编译成 core 插件。
 *
 * ## 为什么必须有两个导出
 *
 * `@loop-agent/main` 的 `defaultLoadPlugin`（`main/src/registry.ts`）把清单条目的
 * `options` 传给**模块默认导出的工厂函数**，兼容三种形态：
 * `export default (options) => Plugin`、`export default pluginObject`、
 * `export const plugin`。也就是说 **options 的通道是「外层工厂函数」，
 * `ctx` 上没有任何 options 通道**。
 *
 * 因此：
 * - 只给 `defineTools()`（形态 A）→ 用户在清单里填的 `options` 会被
 *   **静默丢弃**，属于最难排查的一类「配置不生效」；
 * - 只给 `defineToolsFactory()`（形态 B）→ 无覆盖需求时也要多包一层函数，
 *   且不满足 `export default pluginObject` 这一 main 支持的形态。
 *
 * 所以两者都提供，内部共用 `buildPlugin()`，差异仅在于 `runtimeOptions`
 * 从哪来（A 为空对象，B 由 main 注入）。与 llm 的 `define.ts` 同构。
 *
 * ## apply 流程（方案 3.7）
 *
 * 1. `getToolRegistry(ctx)` 取目录；
 * 2. 解析 `tools`（数组 / `provider.create(merged)` / 工厂调用）；
 * 3. 逐个工具同步校验——**任一个不合法即整批失败**，不留半挂载状态；
 * 4. `ctx.provide('tools:provider:<id>', facade)`（同 id 重复 → `TOOLS_PROVIDER_EXISTS`）；
 * 5. `ctx.effect(() => registry.registerAll(...))` 批量登记，卸载逆序撤销；
 * 6. 有 `dispose` 时挂一条资源释放 effect。
 */

import {
  ServiceConflictError,
  type Context,
  type EventMapBase,
  type Inject,
  type PluginObject,
} from '@loop-agent/core';

import {
  ToolsConfigError,
  ToolsInvalidNameError,
  ToolsProviderExistsError,
} from './errors.js';
import { TOOLS_SERVICE_KEYS, providerServiceKey } from './keys.js';
import type { ToolProvider } from './provider.js';
import { getToolRegistry } from './registry.js';
import { validateDescription, validateParametersSchema, validateToolName } from './schema.js';
import type { ToolBase } from './tool.js';

/** 工具来源：实例数组 / 提供者实例 / 工厂函数 */
export type ToolsSource =
  | ToolBase[]
  | ToolProvider
  | ((options: Record<string, unknown>) => ToolBase[] | Promise<ToolBase[]>);

/** 工具提供者定义：代码侧声明「怎么产出一组工具」 */
export interface ToolsDefinition {
  /** 唯一标识；非空、不含 `:`（`:` 会破坏服务 key 分段） */
  id: string;
  /** 展示名；缺省用提供者的 displayName（再缺省回落 id） */
  displayName?: string;
  /**
   * 代码侧默认配置（JSON 可序列化）。
   *
   * 与清单条目的 `options` 做**浅合并**，清单侧同名键优先——这样「同一份
   * 实现、多套配置」可以靠清单表达，不必改代码。
   */
  options?: Record<string, unknown>;
  /** 工具来源三选一 */
  tools: ToolsSource;
  /** 是否设为缺省提供者（本期不消费，预留） */
  isDefault?: boolean;
}

/** 提供者服务 key 上暴露的只读门面（不暴露工具实例，避免绕开目录） */
export interface ToolProviderFacade {
  id: string;
  displayName: string;
  /** 本提供者登记的工具名（挂载时快照） */
  toolNames: string[];
  isDefault: boolean;
}

/**
 * 同步校验定义；配置错误应在挂载前炸，而不是留到运行期。
 *
 * 暴露为导出函数是为了让 `defineToolsFactory()` 能在**工厂被调用之前**
 * 就校验一遍——配置写错时错误发生在 import 期，而不是用户点启用时。
 */
function assertValidDefinition(def: ToolsDefinition): void {
  if (typeof def !== 'object' || def === null) {
    throw new ToolsConfigError('ToolsDefinition 必须是对象');
  }
  const { id, tools } = def;

  if (typeof id !== 'string' || id.trim() === '') {
    throw new ToolsConfigError('ToolsDefinition.id 必须是非空字符串', { field: 'id' });
  }
  if (id.includes(':')) {
    // 冒号是服务 key 的分段符：'tools:provider:a:b' 无法反解出 id
    throw new ToolsConfigError(`ToolsDefinition.id 不得包含冒号: '${id}'`, { field: 'id' });
  }
  if (tools === undefined || tools === null) {
    throw new ToolsConfigError(`ToolsDefinition.tools 缺失 (id: '${id}')`, { field: 'tools' });
  }
  if (!Array.isArray(tools) && typeof tools !== 'function') {
    // ToolProvider 实例：靠 create 方法判定，避免 import 循环
    const isProvider = typeof (tools as ToolProvider).create === 'function';
    if (!isProvider) {
      throw new ToolsConfigError(
        `ToolsDefinition.tools 必须是 ToolBase 数组、ToolProvider 实例或工厂函数 (id: '${id}')`,
        { field: 'tools' },
      );
    }
  }
}

/**
 * 校验单个工具（注册期同步）。
 *
 * 与 D8 一致：名字不合法抛 **`ToolsInvalidNameError`**（code `TOOLS_INVALID_NAME`），
 * 而不是笼统的 `TOOLS_CONFIG_INVALID`——名字错的定位信息（哪个名字、为什么）
 * 比「配置非法」有用得多，且方案 3.6 的错误表把它单列了一行。
 */
function assertValidTool(tool: ToolBase, providerId: string): void {
  if (tool === null || typeof tool !== 'object' || typeof tool.toSpec !== 'function') {
    throw new ToolsConfigError(`提供者 '${providerId}' 产出了非 ToolBase 的项`, {
      field: 'tools',
      pluginName: providerId,
    });
  }

  const nameCheck = validateToolName(tool.name);
  if (!nameCheck.ok) {
    throw new ToolsInvalidNameError(tool.name, nameCheck.reason ?? '格式不合法', {
      pluginName: providerId,
    });
  }

  const descIssues = validateDescription(tool.description);
  if (descIssues.length > 0) {
    throw new ToolsConfigError(
      `提供者 '${providerId}' 的工具 '${tool.name}' description 不能为空（模型靠它决定何时调用）`,
      { field: 'description', pluginName: providerId },
    );
  }

  const paramIssues = validateParametersSchema(tool.parameters);
  if (paramIssues.length > 0) {
    throw new ToolsConfigError(
      `提供者 '${providerId}' 的工具 '${tool.name}' 的 ${paramIssues[0]!.message}`,
      { field: 'parameters', pluginName: providerId },
    );
  }
}

/**
 * 合并 inject：`tools:registry` 恒为硬依赖，再并上提供者自报的额外依赖。
 *
 * 为什么不直接让用户在自己的 `inject` 里写 `tools:registry`：忘写就会
 * 「提供者抢跑到 apply 才发现目录不存在」，而这依赖是契约自带的前置条件，
 * 不该成为用户的记忆负担。用户的 `inject` 只承担**额外**依赖。
 */
function mergeInject(extra: Inject | undefined): Inject {
  const required = new Set<string>([TOOLS_SERVICE_KEYS.registry]);
  const optional = new Set<string>();

  if (extra) {
    const req = Array.isArray(extra) ? extra : (extra.required ?? []);
    const opt = Array.isArray(extra) ? [] : (extra.optional ?? []);
    for (const k of req) required.add(k);
    for (const k of opt) optional.add(k);
  }
  // 软依赖若与硬依赖重复，以硬依赖为准（否则语义矛盾）
  for (const k of required) optional.delete(k);

  return optional.size > 0
    ? { required: [...required], optional: [...optional] }
    : { required: [...required] };
}

/** 解析工具来源为实例数组 */
async function resolveTools(
  def: ToolsDefinition,
  mergedOptions: Record<string, unknown>,
): Promise<ToolBase[]> {
  const { tools } = def;

  if (Array.isArray(tools)) return tools;

  // 提供者实例：判据是 create 方法（duck typing，避免 import 循环）
  if (typeof (tools as ToolProvider).create === 'function') {
    const produced = await (tools as ToolProvider).create(mergedOptions);
    if (!Array.isArray(produced)) {
      throw new ToolsConfigError(`提供者 '${def.id}' 的 create() 未返回数组`, {
        field: 'tools',
        pluginName: def.id,
      });
    }
    return produced;
  }

  // 工厂函数
  const produced = await (tools as ToolsSource as (
    o: Record<string, unknown>,
  ) => ToolBase[] | Promise<ToolBase[]>)(mergedOptions);
  if (!Array.isArray(produced)) {
    throw new ToolsConfigError(`提供者 '${def.id}' 的工厂函数未返回数组`, {
      field: 'tools',
      pluginName: def.id,
    });
  }
  return produced;
}

/** 取提供者实例（数组/工厂来源没有提供者语义） */
function asProvider(source: ToolsSource): ToolProvider | undefined {
  if (Array.isArray(source) || typeof source === 'function') return undefined;
  return typeof (source as ToolProvider).create === 'function'
    ? (source as ToolProvider)
    : undefined;
}

/** 构建插件对象（两个导出共用的唯一实现） */
function buildPlugin<E extends EventMapBase>(
  def: ToolsDefinition,
  runtimeOptions: Record<string, unknown>,
): PluginObject<E> {
  assertValidDefinition(def);

  const provider = asProvider(def.tools);
  // 浅合并：代码侧默认值 ← 清单侧覆盖值（同名键后者胜）
  const mergedOptions = { ...def.options, ...runtimeOptions };
  const displayName = def.displayName ?? provider?.displayName ?? def.id;

  return {
    name: `tools-provider:${def.id}`,
    // 硬依赖：tools:registry 未就绪时 Fiber 停在 PENDING、apply 不执行，
    // 绝不会出现「提供者抢跑后找不到目录」的中间态
    inject: mergeInject(provider?.inject),
    async apply(ctx: Context<E>) {
      const registry = getToolRegistry(ctx);

      const tools = await resolveTools(def, mergedOptions);

      // 先全量校验，再落登记：任一项不合法即整批失败（不留半挂载状态）
      for (const tool of tools) assertValidTool(tool, def.id);

      // 提供者服务 key：让 diagnose() 能按提供者报 ownerFiberId，
      // 也让其他插件可做精确软依赖（inject.optional）
      const facade: ToolProviderFacade = {
        id: def.id,
        displayName,
        toolNames: tools.map((t) => t.name),
        isDefault: def.isDefault === true,
      };
      try {
        ctx.provide(providerServiceKey(def.id), facade);
      } catch (err) {
        if (err instanceof ServiceConflictError) {
          // 翻译成可读语义（D11）：用户看到的是「提供者重复挂载」而不是
          // 「服务已被其他 Fiber 提供: tools:provider:x」
          throw new ToolsProviderExistsError(def.id, {
            pluginName: def.id,
            cause: err,
          });
        }
        throw err;
      }

      // 批量登记挂到 Fiber：卸载时逆序撤销（成组撤销）
      ctx.effect(
        () => registry.registerAll(tools, { providerId: def.id }),
        `tools:provider:${def.id}`,
      );

      // 资源释放：仅提供者实例有此语义（数组/工厂来源无需释放）
      if (provider) {
        ctx.effect(
          () => (): void => {
            // 吞掉卸载期异常：不得阻断 Fiber 的 disposer 链（core 不变量 3）
            void Promise.resolve()
              .then(() => provider.dispose())
              .catch(() => undefined);
          },
          `tools:provider-dispose:${def.id}`,
        );
      }
    },
  };
}

/**
 * 形态 A：直接得到插件对象（无部署侧覆盖）。
 *
 * ```ts
 * export default defineTools({ id: 'my-tools', tools: [new MyTool()] });
 * ```
 */
export function defineTools<E extends EventMapBase = EventMapBase>(
  def: ToolsDefinition,
): PluginObject<E> {
  return buildPlugin<E>(def, {});
}

/**
 * 形态 B：得到工厂，供 main 清单注入 `options`。
 *
 * ```ts
 * export default defineToolsFactory({ id: 'my-tools', tools: [new MyTool()] });
 * // 清单里写 options 即可覆盖 def.options 的同名键
 * ```
 */
export function defineToolsFactory<E extends EventMapBase = EventMapBase>(
  def: ToolsDefinition,
): (options?: Record<string, unknown>) => PluginObject<E> {
  // 定义错误尽早炸：工厂还没被调用时就先校验一遍
  assertValidDefinition(def);
  return (runtimeOptions) => buildPlugin<E>(def, runtimeOptions ?? {});
}

/**
 * 供测试与文档使用的合并逻辑导出。
 *
 * 单独导出而不内联，是为了让「清单侧优先」这条规则有唯一实现，
 * 测试断言不会与生产逻辑各写一遍。
 */
export function mergeToolsOptions(
  defOptions: Record<string, unknown> | undefined,
  runtimeOptions: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...defOptions, ...runtimeOptions };
}
