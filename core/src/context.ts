/**
 * Context 门面。
 *
 * 一个 Context 绑定一个「属主」：根 Context 的属主是空串，
 * 插件内 `apply(ctx)` 拿到的 Context 属主是该插件 Fiber 的 id。
 * 凡通过该 Context 注册的副作用（服务 / 监听器 / effect / 子 Fiber）
 * 都会挂到属主 Fiber 上，随其卸载自动撤销——这是 D11 的落地。
 *
 * 隔离域（D12 / `isolate`）：每个 Context 携带一条**由外到内**的
 * `IsolationScope` 链。查找规则是「最内层声明该 key 的 scope 胜出，
 * 且不回退外层」——这样隔离域内的插件既看不到外层同名服务，
 * 也不会被外层覆盖。事件总线**不隔离**（跨域通知必须全局）。
 */

import { FiberDisposedError } from './errors.js';
import { TypedEventBus } from './events.js';
import { FiberImpl, type Fiber } from './fiber.js';
import { ServiceRegistry } from './service.js';
import type {
  DiagnosticReport,
  Disposer,
  EventMapBase,
  Inject,
  Plugin,
  PluginOptions,
} from './types.js';

/** 一个隔离域：声明若干 key，并为它们持有独立的分仓 */
export interface IsolationScope {
  /** 本域声明的 key（这些 key 在本域内不再回退外层） */
  readonly keys: ReadonlySet<string>;
  /** 本域的分仓 */
  readonly store: ServiceRegistry;
}

/** Context 对外接口 */
export interface Context<E extends EventMapBase = EventMapBase> {
  // ── 服务 ──
  /** 读服务；未提供返回 undefined（软依赖用法） */
  get<T>(key: string): T | undefined;
  /** 提供服务；返回的 Disposer 在 Fiber 卸载时自动执行 */
  provide<T>(key: string, impl: T): Disposer;
  /** 当前可见服务 key（诊断用） */
  services(): readonly string[];

  // ── 可逆副作用 ──
  /** 立即执行 body，其返回的 disposer 挂到当前 Fiber */
  effect(body: () => Disposer, label?: string): Disposer;

  // ── 事件 ──
  on<K extends keyof E & string>(event: K, listener: E[K]): Disposer;

  // ── 子插件 ──
  plugin(p: Plugin<E>, opts?: PluginOptions): Fiber;
  /** 隔离域：子树内指定 key 指向独立服务实例，父子互不可见 */
  isolate(keys: readonly string[]): Context<E>;

  // ── 诊断 ──
  /** 全部 Fiber 状态 + 未满足 inject + 失败原因 */
  diagnose(): DiagnosticReport;
}

/**
 * 跨 Context 共享的内核状态。
 *
 * 共享是刻意的（D10）：服务与事件总线必须对所有插件可见，
 * 否则「插件间协作」这个内核存在的前提就不成立。
 */
export interface CoreHost<E extends EventMapBase = EventMapBase> {
  readonly store: ServiceRegistry;
  readonly bus: TypedEventBus<E>;
  /** 根级 Fiber（无父 Fiber 的插件） */
  readonly rootFibers: Set<FiberImpl>;
  /** 本 host 创建过的全部 Fiber（含已卸载），供 diagnose 使用 */
  readonly allFibers: FiberImpl[];
  /** 本 host 创建过的全部隔离域，供 diagnose 标注 `isolated` */
  readonly scopes: IsolationScope[];
  nextId(): string;
  /**
   * 触发一次依赖收敛（异步、单飞）。
   *
   * 服务增删后调用：把依赖失效的 ACTIVE Fiber 降级、把依赖就绪的
   * PENDING Fiber 启动。返回的 Promise 在**本轮收敛完成**后 resolve。
   */
  scheduleReconcile(): Promise<void>;
  /**
   * 等待当前（含后续触发的）收敛彻底静止。
   *
   * 与 `scheduleReconcile` 的区别：后者只保证「这一轮」，而 apply 内部
   * 又注册服务会再触发新的一轮，故测试与 `mount()` 需要这个「跑到不动为止」。
   */
  settle(): Promise<void>;
}

/** 规范化 inject 声明 */
function normalizeInject(inject?: Inject): { required: string[]; optional: string[] } {
  if (!inject) return { required: [], optional: [] };
  if (Array.isArray(inject)) return { required: [...inject], optional: [] };
  return {
    required: [...(inject.required ?? [])],
    optional: [...(inject.optional ?? [])],
  };
}

/** 从插件形态中提取 apply、名称与依赖 */
function describePlugin<E extends EventMapBase>(
  p: Plugin<E>,
  opts?: PluginOptions,
): { name: string; inject?: Inject; apply: (ctx: Context<E>) => void | Promise<void> } {
  if (typeof p === 'function') {
    return {
      name: opts?.name ?? p.name ?? 'anonymous',
      inject: undefined,
      apply: p,
    };
  }
  return {
    name: opts?.name ?? p.name ?? 'anonymous',
    inject: p.inject,
    apply: p.apply.bind(p),
  };
}

/** Context 实现 */
export class ContextImpl<E extends EventMapBase = EventMapBase> implements Context<E> {
  /** 属主 Fiber id；根 Context 为空串 */
  readonly ownerFiberId: string;
  private readonly host: CoreHost<E>;
  private readonly ownerFiber?: FiberImpl;
  /** 由外到内的隔离域链（空数组 = 无隔离，全部走根 store） */
  private readonly scopes: readonly IsolationScope[];

  constructor(
    host: CoreHost<E>,
    ownerFiberId: string,
    ownerFiber?: FiberImpl,
    scopes: readonly IsolationScope[] = [],
  ) {
    this.host = host;
    this.ownerFiberId = ownerFiberId;
    this.ownerFiber = ownerFiber;
    this.scopes = scopes;
  }

  /** 属主 Fiber（调试 / 诊断用） */
  get fiber(): FiberImpl | undefined {
    return this.ownerFiber;
  }

  private assertNotDisposed(what: string): void {
    if (this.ownerFiber && this.ownerFiber.state === 'DISPOSED') {
      throw new FiberDisposedError(`Fiber 已卸载，无法 ${what}`, {
        fiberId: this.ownerFiber.id,
        pluginName: this.ownerFiber.name,
      });
    }
  }

  // ── 服务定位 ──

  /**
   * 按隔离链定位某个 key 该落在哪个 store。
   *
   * 从**最内层**往外找第一个声明了该 key 的 scope；找到即用它，**不回退**。
   * 没有任何 scope 声明 → 用根 store。
   */
  private storeFor(key: string): ServiceRegistry {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].keys.has(key)) return this.scopes[i].store;
    }
    return this.host.store;
  }

  /** 某 key 在当前 Context 是否可见（考虑隔离遮蔽） */
  hasService(key: string): boolean {
    return this.storeFor(key).has(key);
  }

  // ── 服务 ──

  get<T>(key: string): T | undefined {
    return this.storeFor(key).get<T>(key);
  }

  provide<T>(key: string, impl: T): Disposer {
    this.assertNotDisposed(`提供服务 ${key}`);
    const store = this.storeFor(key);
    store.provide(key, impl, this.ownerFiberId);

    let removed = false;
    const disposer: Disposer = () => {
      if (removed) return;
      removed = true;
      store.remove(key);
      // 服务表变化 → 依赖关系需要重算（D11 的 epoch 收敛入口）
      void this.host.scheduleReconcile();
    };
    // 仅在 Fiber 内注册时才自动挂载；根 Context 的 provide 由调用方自行持有 disposer
    if (this.ownerFiber) this.ownerFiber.addDisposer(disposer, `service:${key}`);
    // 新服务可能让 PENDING 的 Fiber 就绪
    void this.host.scheduleReconcile();
    return disposer;
  }

  services(): readonly string[] {
    // 根 store 的 key 扣除被隔离域遮蔽的，再并上各域实际提供的
    const shadowed = new Set<string>();
    for (const scope of this.scopes) {
      for (const k of scope.keys) shadowed.add(k);
    }
    const visible = this.host.store
      .keys()
      .filter((k) => !shadowed.has(k));
    for (const scope of this.scopes) {
      for (const k of scope.store.keys()) visible.push(k);
    }
    return visible;
  }

  // ── 可逆副作用 ──

  effect(body: () => Disposer, label?: string): Disposer {
    this.assertNotDisposed('注册 effect');
    // 立即执行：调用方期望 body 的副作用在返回前已生效
    const disposer = body();
    if (typeof disposer !== 'function') {
      throw new TypeError(
        `effect body 必须返回 disposer 函数，实际收到 ${typeof disposer}${label ? `（label: ${label}）` : ''}`,
      );
    }
    if (this.ownerFiber) this.ownerFiber.addDisposer(disposer, label ?? 'effect');
    return disposer;
  }

  // ── 事件 ──

  on<K extends keyof E & string>(event: K, listener: E[K]): Disposer {
    this.assertNotDisposed(`注册事件监听 ${event}`);
    const disposer = this.host.bus.on(event, listener, this.ownerFiberId);
    if (this.ownerFiber) this.ownerFiber.addDisposer(disposer, `event:${event}`);
    return disposer;
  }

  // ── 子插件 ──

  plugin(p: Plugin<E>, opts?: PluginOptions): Fiber {
    this.assertNotDisposed('挂载子插件');
    const desc = describePlugin(p, opts);
    const { required, optional } = normalizeInject(desc.inject);

    // 先声明一个可变引用，apply 执行时（异步、稍后）再读取它。
    // 这样 FiberImpl 的 run 无需回填，也不必把 readonly 字段强改。
    let childCtx: ContextImpl<E> | undefined;

    const fiber = new FiberImpl({
      id: this.host.nextId(),
      name: desc.name,
      required,
      optional,
      // 依赖可用性按**子 Context 的可见性**判定：隔离域内的插件应当只认
      // 隔离域内的服务，否则「隔离」会在依赖检查这一环被绕过。
      probe: (key: string) => childCtx?.hasService(key) ?? this.hasService(key),
      run: () => {
        if (!childCtx) throw new Error('内部错误：子 Context 尚未就绪');
        return desc.apply(childCtx);
      },
    });

    // Context 的属主是该子 Fiber 本身：其内注册的副作用随子 Fiber 卸载撤销。
    // 隔离域链随之继承：父在隔离域内挂的子插件仍在该隔离域内。
    childCtx = new ContextImpl<E>(this.host, fiber.id, fiber, this.scopes);

    // 归属：有父 Fiber 挂父，否则挂根集合
    if (this.ownerFiber) {
      const parent = this.ownerFiber;
      parent.addChild(fiber);
      fiber.onDisposed = () => parent.removeChild(fiber);
    } else {
      const rootFibers = this.host.rootFibers;
      rootFibers.add(fiber);
      fiber.onDisposed = () => rootFibers.delete(fiber);
    }
    this.host.allFibers.push(fiber);

    // 异步启动，不阻塞 plugin() 返回（apply 可能是异步的）
    void fiber.start();
    // 插件加载期间可能提供新服务，需触发一轮依赖收敛
    void fiber.ready().then(() => this.host.scheduleReconcile());
    return fiber;
  }

  // ── 隔离域 ──

  isolate(keys: readonly string[]): Context<E> {
    this.assertNotDisposed('创建隔离域');
    const scope: IsolationScope = {
      keys: new Set(keys),
      store: new ServiceRegistry(),
    };
    this.host.scopes.push(scope);
    // 新隔离域内的 Context 不挂属主 Fiber：它只是「视图」，副作用仍归调用方 Fiber。
    // 若这里新建 Fiber，`const iso = ctx.isolate([...])` 就成了一次插件加载，
    // 与 isolate 的语义（换视角，不换生命周期）不符。
    return new ContextImpl<E>(this.host, this.ownerFiberId, this.ownerFiber, [
      ...this.scopes,
      scope,
    ]);
  }

  // ── 诊断 ──

  diagnose(): DiagnosticReport {
    const isolatedKeys = new Set<string>();
    for (const scope of this.host.scopes) {
      for (const k of scope.keys) isolatedKeys.add(k);
    }

    const services: DiagnosticReport['services'] = [];
    // 根 store：未被隔离域声明的才算「不隔离」
    for (const entry of this.host.store.entriesSnapshot()) {
      services.push({
        key: entry.key,
        ownerFiberId: entry.ownerFiberId,
        isolated: isolatedKeys.has(entry.key),
      });
    }
    // 各隔离域实际提供的 key
    for (const scope of this.host.scopes) {
      for (const entry of scope.store.entriesSnapshot()) {
        services.push({
          key: entry.key,
          ownerFiberId: entry.ownerFiberId,
          isolated: true,
        });
      }
    }

    return {
      fibers: this.host.allFibers.map((f) => {
        const report: DiagnosticReport['fibers'][number] = {
          id: f.id,
          name: f.name,
          state: f.state,
          missing: f.state === 'PENDING' ? f.missingDeps() : [],
        };
        if (f.error) {
          report.error = { code: f.error.code, message: f.error.message };
        }
        const disposalErrors = f.errorsDuringDisposal();
        if (disposalErrors.length > 0) {
          // AggregateError 的 message 只有「有几个 disposer 抛错」，排障要看的是
          // 具体哪条抛了什么，故摊平其 errors 后再序列化。
          report.disposeErrors = disposalErrors.flatMap((e) => {
            const inner = e instanceof AggregateError ? [...e.errors] : [e];
            return inner.map((x) => (x instanceof Error ? x.message : String(x)));
          });
        }
        return report;
      }),
      services,
    };
  }
}

let hostSeq = 0;

/**
 * 创建一个内核宿主（独立的一份服务表 + 事件总线 + Fiber 树）。
 *
 * 依赖动态重载（D11 epoch）的实现是**单飞 + 脏标记**的收敛循环：
 * 服务增删只置脏并触发 pump，pump 反复「降级失效者 / 启动就绪者」
 * 直到没有新变更。单飞避免并发重入把同一 Fiber 拉两次；脏标记循环
 * 保证 `apply` 内部再注册服务这种链式变更也能被追平。
 */
export function createHost<E extends EventMapBase = EventMapBase>(): CoreHost<E> {
  const prefix = `h${++hostSeq}`;
  let seq = 0;

  /** 是否有待处理的新变更 */
  let dirty = false;
  /** 正在跑的那一轮（单飞用） */
  let inFlight: Promise<void> | undefined;

  const host: CoreHost<E> = {
    store: new ServiceRegistry(),
    bus: new TypedEventBus<E>(),
    rootFibers: new Set<FiberImpl>(),
    allFibers: [],
    scopes: [],
    nextId: () => `${prefix}-f${++seq}`,

    scheduleReconcile(): Promise<void> {
      dirty = true;
      if (inFlight) return inFlight;
      inFlight = runPump();
      return inFlight;
    },

    async settle(): Promise<void> {
      // 反复等「当前一轮」，直到某一轮结束后不再有新脏标记。
      // 收敛循环自己会追平链式变更，这里只需处理「最后一轮结束后又置脏」的窗口。
      while (inFlight || dirty) {
        await host.scheduleReconcile();
      }
    },
  };

  async function runPump(): Promise<void> {
    try {
      // 脏标记循环：每轮都可能产生新变更（apply 内再 provide）
      while (dirty) {
        dirty = false;
        await reconcileOnce();
      }
    } finally {
      inFlight = undefined;
    }
  }

  /** 一轮收敛：先降级失效者，再启动就绪者 */
  async function reconcileOnce(): Promise<void> {
    // 快照：收敛过程中 allFibers 只增不减，但状态会变，故按 id 遍历副本
    const fibers = [...host.allFibers];

    // ① 依赖失效的 ACTIVE Fiber → 降级到 PENDING
    for (const fiber of fibers) {
      if (fiber.state !== 'ACTIVE') continue;
      if (fiber.depsSatisfied()) continue;
      await fiber.deactivate();
      dirty = true;
    }

    // ② 依赖就绪的 PENDING Fiber → 启动
    // 仅处理「声明了就绪」的：FAILED 是终态（D10），不自动重试
    for (const fiber of fibers) {
      if (fiber.state !== 'PENDING') continue;
      if (fiber.isDisposed()) continue;
      if (!fiber.depsSatisfied()) continue;
      // 祖先未激活（如父 Fiber 还在 PENDING）时不单独启动子 Fiber，
      // 否则子插件会在父插件未加载时跑起来，违反父子时序直觉
      if (!fiber.parentActive()) continue;
      await fiber.start();
      dirty = true;
    }
  }

  return host;
}

/**
 * 创建根 Context。
 *
 * 属主为空串：根 Context 上 `provide` / `on` / `effect` **不**自动撤销
 * （没有 Fiber 可挂），由调用方持有返回的 disposer。
 * 宿主层可在此之上建立清单式挂载与整体卸载（见 @loop-agent/main）。
 */
export function createRootContext<E extends EventMapBase = EventMapBase>(
  host: CoreHost<E> = createHost<E>(),
): Context<E> {
  return new ContextImpl<E>(host, '');
}
