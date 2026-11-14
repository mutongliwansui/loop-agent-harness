/**
 * 持久化插件注册中心。
 *
 * 相对 core 已删掉的纯内存 `PluginRegistry`，这里多承担三件事：
 * 1. **清单持久化**：5 个写操作（mount/enable/disable/unmount/reorder）后立即原子落盘（D4）。
 * 2. **启停是一等状态**（D7）：`disable` 卸 Fiber 但保留条目，`enable` 再挂回来，
 *    位置不变——「我暂时不想要它」与「我没装它」是两个不同的意思。
 * 3. **隔离失败**（D10）：一条插件加载失败只记 `loadError`，绝不锁死其余条目。
 *
 * 组合 `Context` 而非继承（D5）：core 侧零耦合，core 演进不牵动本类。
 */
import type { Context, CoreHost, EventMapBase, Fiber, FiberState, Plugin } from '@loop-agent/core';

import { createPluginStore, type PluginStore } from './store.js';
import {
  MANIFEST_SCHEMA_VERSION,
  type PluginManifestEntry,
  type RegistryDiagnostic,
} from './types.js';

export interface PersistentPluginRegistryOptions<E extends EventMapBase = EventMapBase> {
  /** 根 Context（由 createMainHost 提供） */
  context: Context<E>;
  /**
   * core 宿主；提供后 `restore()` 末尾可用 `host.settle()` 等链式依赖收敛。
   *
   * 为什么需要它：`Context` 接口不暴露 host，而「A 提供 → B 依赖 → B 提供 → C 依赖」
   * 这类链式依赖必须收敛到静止，否则 `restore()` 返回时后面的插件还是 PENDING。
   */
  host?: CoreHost<E>;
  /** 清单存储；缺省用默认路径（D3） */
  store?: PluginStore;
  /** specifier → Plugin 工厂；缺省动态 `import()`（D10） */
  loadPlugin?: (specifier: string, options?: Record<string, unknown>) => Promise<Plugin<E>>;
}

/**
 * 缺省加载器：只收 ESM（D10）。
 *
 * 说明符是**运行期值**，故用变量 `import()`；这会让 bundler 无法静态分析
 * （tsup 已按 3.6 静音该告警），但 ESM 产物里保留原样，运行时由 Node 解析，行为正确。
 *
 * 兼容三种导出形态：`export default (options) => Plugin`、
 * `export default pluginObject`、`export const plugin = ...`。
 */
export const defaultLoadPlugin = async <E extends EventMapBase>(
  specifier: string,
  options?: Record<string, unknown>,
): Promise<Plugin<E>> => {
  const mod = (await import(specifier)) as Record<string, unknown>;
  const factory = (mod.default ?? mod.plugin ?? mod) as unknown;
  if (typeof factory === 'function') {
    return (factory as (o?: unknown) => Plugin<E> | Promise<Plugin<E>>)(options);
  }
  if (typeof factory === 'object' && factory !== null) return factory as Plugin<E>;
  throw new TypeError(`插件模块未导出可用的 Plugin：${specifier}`);
};

export class PersistentPluginRegistry<E extends EventMapBase = EventMapBase> {
  private readonly context: Context<E>;
  private readonly host?: CoreHost<E>;
  private readonly store: PluginStore;
  private readonly loadPlugin: NonNullable<PersistentPluginRegistryOptions<E>['loadPlugin']>;

  /** 内存镜像；顺序 == 挂载顺序（D17） */
  private items: PluginManifestEntry[] = [];
  private readonly mounted = new Map<string, Fiber>();
  private readonly loadErrors = new Map<string, Error>();
  /** 串行写队列（D18）：避免并发写交叉覆盖 tmp 文件 */
  private writeChain: Promise<void> = Promise.resolve();
  private disposePromise?: Promise<void>;

  constructor(options: PersistentPluginRegistryOptions<E>) {
    this.context = options.context;
    this.host = options.host;
    this.store = options.store ?? createPluginStore();
    this.loadPlugin = options.loadPlugin ?? defaultLoadPlugin;
  }

  /** 已登记清单（只读副本，外部改动不影响内部状态） */
  entries(): readonly PluginManifestEntry[] {
    return this.items.map((e) => ({
      ...e,
      ...(e.options ? { options: { ...e.options } } : {}),
    }));
  }

  /**
   * 启动还原：读清单 → 逐条挂载 enabled（D6）。
   *
   * 幂等：重复调用会先卸掉当前挂载再按最新清单重挂。
   */
  async restore(): Promise<void> {
    const manifest = this.store.read();
    this.items = manifest.entries.map((e) => ({ ...e }));

    for (const id of [...this.mounted.keys()].reverse()) {
      await this.stopFiber(id);
    }
    this.mounted.clear();
    this.loadErrors.clear();

    for (const entry of this.items) {
      if (!entry.enabled) continue;
      // D10：单条加载失败不中断其余，错误已由 start() 记入 loadErrors
      try {
        await this.start(entry);
      } catch {
        // 继续下一条
      }
    }
    await this.settle();
  }

  /** 新增并挂载；id 重复抛 `PLUGIN_ID_CONFLICT` */
  async mount(entry: PluginManifestEntry): Promise<Fiber> {
    if (this.items.some((e) => e.id === entry.id)) {
      throw codedError('PLUGIN_ID_CONFLICT', `插件 id 重复：${entry.id}`);
    }
    this.items.push({ ...entry });
    try {
      const fiber = await this.start({ ...entry, enabled: true });
      this.markEnabled(entry.id, true);
      await this.persist();
      return fiber;
    } catch (error) {
      // 用户显式操作：错误抛给调用方（他需要知道「我装失败了」），
      // 但**条目保留** + loadError 已记录，便于 diagnose() 排查。
      await this.persist();
      throw error;
    }
  }

  /** 彻底移除：卸载 Fiber + 删条目；未知 id 幂等空操作，不写盘 */
  async unmount(id: string): Promise<void> {
    const index = this.items.findIndex((e) => e.id === id);
    if (index < 0) return;
    await this.stopFiber(id);
    this.items.splice(index, 1);
    this.loadErrors.delete(id);
    await this.persist();
  }

  /** 停用：卸 Fiber，保留条目（D7）；已停用或未知 id 为幂等空操作 */
  async disable(id: string): Promise<void> {
    const entry = this.items.find((e) => e.id === id);
    if (!entry || !entry.enabled) return;
    await this.stopFiber(id);
    entry.enabled = false;
    await this.persist();
  }

  /** 启用：重新挂载，保持条目位置（D7） */
  async enable(id: string): Promise<Fiber> {
    const entry = this.items.find((e) => e.id === id);
    if (!entry) throw codedError('PLUGIN_NOT_FOUND', `插件不存在：${id}`);
    const existing = this.mounted.get(id);
    if (entry.enabled && existing) return existing;

    entry.enabled = true;
    let fiber: Fiber;
    try {
      fiber = await this.start(entry);
    } catch (error) {
      await this.persist();
      throw error;
    }
    await this.persist();
    return fiber;
  }

  /** 排序：按给定 id 顺序重排（D17）；未列出的按原相对序追加尾部 */
  async reorder(ids: readonly string[]): Promise<void> {
    const known = new Set(this.items.map((e) => e.id));
    for (const id of ids) {
      if (!known.has(id)) throw codedError('PLUGIN_NOT_FOUND', `插件不存在：${id}`);
    }
    const rank = new Map(ids.map((id, i) => [id, i]));
    // 未列出者赋同一秩，靠 Array.prototype.sort 的稳定性保持原相对顺序
    this.items = [...this.items].sort((a, b) => {
      const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (ra === rb) return 0;
      return ra - rb;
    });
    await this.persist();
  }

  /** 按 id 取运行期 Fiber */
  fiberOf(id: string): Fiber | undefined {
    return this.mounted.get(id);
  }

  /** core 诊断 + 清单/落盘状态合并（D19） */
  diagnose(): RegistryDiagnostic {
    const persistError = this.store.lastError();
    return {
      core: this.context.diagnose(),
      entries: this.items.map((e) => {
        const fiber = this.mounted.get(e.id);
        const err = this.loadErrors.get(e.id);
        return {
          id: e.id,
          specifier: e.specifier,
          enabled: e.enabled,
          ...(fiber ? { state: fiber.state as FiberState } : {}),
          ...(err
            ? {
                loadError: {
                  code: (err as Error & { code?: string }).code ?? 'PLUGIN_LOAD_ERROR',
                  message: err.message,
                },
              }
            : {}),
        };
      }),
      file: this.store.file,
      ...(persistError ? { persistError: { message: persistError.message } } : {}),
    };
  }

  /** 逆序卸载全部；幂等（重复调用返回同一 Promise） */
  dispose(): Promise<void> {
    if (!this.disposePromise) this.disposePromise = this.doDispose();
    return this.disposePromise;
  }

  // ── 内部 ──

  private async doDispose(): Promise<void> {
    // 逆序：后挂载的先卸载（与 disposer 栈直觉一致）
    for (const id of [...this.mounted.keys()].reverse()) {
      await this.stopFiber(id);
    }
    this.mounted.clear();
    // 等写队列排空，避免退出时落盘被截断
    await this.writeChain;
  }

  private async start(entry: PluginManifestEntry): Promise<Fiber> {
    this.loadErrors.delete(entry.id);
    let plugin: Plugin<E>;
    try {
      plugin = await this.loadPlugin(entry.specifier, entry.options);
    } catch (error) {
      this.loadErrors.set(entry.id, toError(error));
      throw error;
    }
    const fiber = this.context.plugin(plugin);
    this.mounted.set(entry.id, fiber);
    await fiber.ready();
    return fiber;
  }

  /** 等依赖收敛静止：有 host 时走 `host.settle()`，否则逐条 ready 已够 */
  private async settle(): Promise<void> {
    if (this.host) await this.host.settle();
  }

  private async stopFiber(id: string): Promise<void> {
    const fiber = this.mounted.get(id);
    if (!fiber) return;
    this.mounted.delete(id);
    await fiber.dispose();
  }

  private markEnabled(id: string, enabled: boolean): void {
    const entry = this.items.find((e) => e.id === id);
    if (entry) entry.enabled = enabled;
  }

  /**
   * 串行落盘：失败只记录（D4）。
   *
   * 队列本身不 reject——落盘失败信息走 `store.lastError()`，
   * 若让 Promise 以 reject 结束，后续所有写都会被一个历史错误连带失败。
   */
  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(() => {
      this.store.write({
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        entries: this.items.map((e) => ({
          ...e,
          ...(e.options ? { options: { ...e.options } } : {}),
        })),
        updatedAt: new Date().toISOString(),
      });
    });
    return this.writeChain;
  }
}

function codedError(code: string, message: string): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = code;
  return err;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
