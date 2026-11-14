/**
 * Fiber 生命周期。
 *
 * 四条不变量（单测逐条覆盖）：
 * 1. `dispose()` 幂等——重复调用返回**同一 Promise**，disposer 不重复执行。
 * 2. disposer **逆序**执行，异步 disposer **串行** await。
 * 3. 单个 disposer 抛错**不中断**后续撤销，错误聚合为 `AggregateError` 记录。
 * 4. 父 Fiber 卸载时先递归 dispose 子 Fiber，再撤销自身 disposer。
 *
 * 设计取舍（D11）：Fiber 的**所有**清理都走统一的 disposer 栈——
 * provide / effect / on / 子 Fiber 全部折算成 disposer 入栈。
 * 好处是撤销顺序、幂等、错误聚合只有一处实现，四条不变量天然一致，
 * 不会出现「某类副作用忘了删」的分支遗漏。
 */

import { CoreError, FiberDisposedError, PluginLoadError } from './errors.js';
import type { Disposer, FiberState } from './types.js';

/** 单条 disposer 记录 */
export interface DisposerRecord {
  /** 撤销函数 */
  fn: Disposer;
  /** 人类可读标签，进错误信息与诊断 */
  label: string;
}

export interface FiberOptions {
  id: string;
  name: string;
  /** 硬依赖 key 列表（已规范化） */
  required: readonly string[];
  /** 软依赖 key 列表（已规范化） */
  optional: readonly string[];
  /** 执行 apply 的回调，由 Context 提供（apply 需要 ctx） */
  run: () => void | Promise<void>;
  /** 服务可用性判定（由 host 的共享 store 提供） */
  probe: (key: string) => boolean;
}

/** Fiber 对外接口 */
export interface Fiber {
  readonly id: string;
  readonly name: string;
  readonly state: FiberState;
  /** FAILED 时有值，含原始 error 与 apply 栈 */
  readonly error?: CoreError;
  /** 显式卸载；等全部 disposer（含异步）执行完才 resolve */
  dispose(): Promise<void>;
  /** 从 FAILED 重新加载；依赖变更时由内核自动调用（03） */
  reload(): Promise<void>;
  /**
   * 「本次加载尝试结束」即 resolve（终态 ACTIVE / FAILED，或依赖未满足停在 PENDING）。
   * 注意语义不是「已激活」：调用方仍需读 `state`。
   *
   * 为什么需要：`ctx.plugin()` 必须同步返回 Fiber（apply 可能是异步的），
   * 否则调用方拿不到「加载已结束」的时刻，测试只能靠轮询或数微任务次数——两者都脆弱。
   */
  ready(): Promise<void>;
}


/** Fiber 实现 */
export class FiberImpl implements Fiber {
  readonly id: string;
  readonly name: string;

  private _state: FiberState = 'PENDING';
  private _error?: CoreError;
  private readonly required: readonly string[];
  private readonly optional: readonly string[];
  private readonly run: () => void | Promise<void>;
  private readonly probe: (key: string) => boolean;

  /** disposer 栈：按注册序 push，撤销时逆序 pop */
  private readonly stack: DisposerRecord[] = [];
  /** 子 Fiber（顺序上先于自身 disposer 撤销） */
  private readonly children = new Set<FiberImpl>();
  /** 父 Fiber（无父为 undefined）；依赖收敛时用于判定「祖先未激活则子也不启动」 */
  private _parent?: FiberImpl;

  /** 缓存的 dispose Promise，保证幂等 */
  private disposePromise?: Promise<void>;
  /** 本次加载尝试的完成信号 */
  private readyPromise?: Promise<void>;
  private readyResolve?: () => void;
  /** 撤销过程中聚合的错误 */
  private disposalErrors: unknown[] = [];
  /** 是否已回滚过（FAILED 路径与 dispose 路径都可能触发） */
  private rolledBack = false;

  constructor(opts: FiberOptions) {
    this.id = opts.id;
    this.name = opts.name;
    this.required = opts.required;
    this.optional = opts.optional;
    this.run = opts.run;
    this.probe = opts.probe;
  }

  get state(): FiberState {
    return this._state;
  }

  get error(): CoreError | undefined {
    return this._error;
  }

  /** 未满足的硬依赖（PENDING 的直接原因） */
  missingDeps(): string[] {
    return this.required.filter((k) => !this.probe(k));
  }

  /** 硬依赖是否全部满足 */
  depsSatisfied(): boolean {
    return this.required.every((k) => this.probe(k));
  }

  /** 内部沿用旧名，避免大面积改动 */
  private isSatisfied(): boolean {
    return this.depsSatisfied();
  }

  /** 注册 disposer（逆序撤销的基础） */
  addDisposer(fn: Disposer, label: string): void {
    if (this._state === 'DISPOSED') {
      throw new FiberDisposedError(`Fiber ${this.name} 已卸载，无法继续注册：${label}`, {
        fiberId: this.id,
        pluginName: this.name,
      });
    }
    this.stack.push({ fn, label });
  }

  /** 挂子 Fiber（不变量 4 执行顺序用） */
  addChild(child: FiberImpl): void {
    this.children.add(child);
    child._parent = this;
  }

  /** 解除子 Fiber 归属（子自行卸载后调用，防止泄漏引用） */
  removeChild(child: FiberImpl): void {
    this.children.delete(child);
    if (child._parent === this) child._parent = undefined;
  }

  /** 子 Fiber 列表（诊断用） */
  childFibers(): readonly FiberImpl[] {
    return [...this.children];
  }

  /** 父 Fiber（诊断用） */
  get parent(): FiberImpl | undefined {
    return this._parent;
  }

  /** 是否已彻底卸载 */
  isDisposed(): boolean {
    return this._state === 'DISPOSED';
  }

  /**
   * 祖先链是否都已 ACTIVE（根 Fiber 恒为 true）。
   *
   * 依赖收敛启动 PENDING 子 Fiber 前必须检查：父插件还没加载起来时
   * 子插件不应抢先运行，否则父子时序直觉被打破。
   */
  parentActive(): boolean {
    let p = this._parent;
    while (p) {
      if (p.state !== 'ACTIVE') return false;
      p = p._parent;
    }
    return true;
  }

  ready(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    // start() 尚未调用时也给出一个可等待对象
    return Promise.resolve();
  }

  /**
   * 启动本次加载。由 Context 在 `plugin()` 时调用（异步，不阻塞返回）。
   *
   * 三态出口：ACTIVE / FAILED / 停在 PENDING。
   */
  async start(): Promise<void> {
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });

    try {
      if (this._state === 'DISPOSED') {
        // 已被卸载：直接结束，不执行 apply
        return;
      }

      if (!this.isSatisfied()) {
        // 硬依赖未满足：停在 PENDING，apply **绝不被调用**
        this._state = 'PENDING';
        return;
      }
      this._state = 'LOADING';
      // 本次加载会重新登记副作用，必须复位回滚标志；否则下一次
      // deactivate 会因 rolledBack 仍为 true 而直接跳过撤销（残留副作用）。
      this.rolledBack = false;
      try {
        await this.run();
        // apply 期间若已被 dispose（state 已离开 LOADING），不得覆盖成 ACTIVE
        if (this._state === 'LOADING') {
          this._state = 'ACTIVE';
        }
      } catch (err) {
        this._error =
          err instanceof CoreError
            ? err
            : new PluginLoadError(`插件 ${this.name} 加载失败：${(err as Error)?.message ?? err}`, {
                fiberId: this.id,
                pluginName: this.name,
                cause: err,
              });
        this._state = 'FAILED';
        // D13：FAILED 必须无泄漏——立即回滚已注册副作用
        await this.rollback();
      }
    } finally {
      this.readyResolve?.();
    }
  }

  async reload(): Promise<void> {
    if (this._state === 'DISPOSED') {
      throw new FiberDisposedError(`Fiber ${this.name} 已卸载，无法 reload`, {
        fiberId: this.id,
        pluginName: this.name,
      });
    }
    await this.rollback();
    this._error = undefined;
    this.rolledBack = false;
    this.disposePromise = undefined;
    this.readyPromise = undefined;
    this.readyResolve = undefined;
    this._state = 'PENDING';
    await this.start();
  }

  /**
   * 依赖失效时回滚到 `PENDING`（D18）。
   *
   * 为什么不是 `DISPOSED`：`DISPOSED` 是终态（`start()` 直接返回、`reload()`
   * 抛 `FiberDisposedError`），一旦置 DISPOSED 就不可能「依赖恢复后自动回 ACTIVE」。
   * `PENDING` 的语义本就是「已声明、硬依赖未就绪」，恰好等于「等 provider 回来」。
   *
   * 副作用照样撤销干净（复用同一 disposer 栈），不留悬空引用。
   *
   * 子 Fiber 走**彻底卸载**而非降级：父 Fiber 重新 apply 时会重建子插件，
   * 若把旧子 Fiber 留在 PENDING，它们会成为孤儿并被 reconcile 再次激活，
   * 导致同一插件跑两份。
   */
  async deactivate(): Promise<void> {
    if (this._state === 'DISPOSED' || this._state === 'UNLOADING') return;
    if (this._state === 'PENDING') return;
    await this.rollback();
    this._error = undefined;
  }

  /**
   * 撤销自身 + 子 Fiber。**不**把状态改为 DISPOSED（供 reload / deactivate 复用）。
   * 不变量 2/3 在此实现。
   *
   * `finalState` 指定撤销完成后停在哪：
   * - `PENDING`（默认）：降级待机，可被 reconcile 重新激活
   * - `UNLOADING`：**正在被彻底卸载**，绝不能被 reconcile 抢去重载
   *
   * 后者是必须的：`dispose()` 的撤销是异步的（async disposer 要 await），
   * 若中途把状态写成 PENDING，并发的 reconcile 会看到「PENDING 且依赖满足」
   * 就把它重新 `start()` 一遍——正是这会重新注册已撤销的服务。
   */
  private async rollback(finalState: FiberState = 'PENDING'): Promise<void> {
    if (this.rolledBack) return;
    this.rolledBack = true;

    const prevState = this._state;
    this._state = 'UNLOADING';

    // 不变量 4：先递归子 Fiber
    for (const child of [...this.children]) {
      await child.dispose();
      this.children.delete(child);
    }

    // 不变量 1（部分）：逆序弹出并执行，异步串行
    const errors: unknown[] = [];
    while (this.stack.length > 0) {
      const rec = this.stack.pop()!;
      try {
        await rec.fn();
      } catch (err) {
        // 不变量 2：单个失败不中断后续撤销
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      this.disposalErrors.push(
        new AggregateError(
          errors,
          `Fiber ${this.name} 撤销时有 ${errors.length} 个 disposer 抛错`,
        ),
      );
    }

    // 回滚后：FAILED 保持终态语义，否则按调用方要求停在 PENDING 或 UNLOADING
    if (prevState === 'FAILED') this._state = 'FAILED';
    else this._state = finalState;
  }

  /** 已发生的撤销错误（供 diagnose 读取，任务 03） */
  errorsDuringDisposal(): readonly unknown[] {
    return this.disposalErrors;
  }

  /**
   * 不变量 1：幂等——重复调用返回**同一 Promise**。
   *
   * 注意这里**不能**用 `async` 修饰：`async` 函数会把返回值再包一层新的
   * Promise，`dispose() === dispose()` 就永远为 false，幂等断言失效。
   */
  dispose(): Promise<void> {
    if (!this.disposePromise) this.disposePromise = this.doDispose();
    return this.disposePromise;
  }

  private async doDispose(): Promise<void> {
    if (this._state === 'DISPOSED') return;

    this.rolledBack = false; // 允许 rollback 再跑一次（dispose 路径）
    this._state = 'UNLOADING';
    // 传 UNLOADING 作为撤销后的停留态：dispose 是异步的，中途绝不能被
    // reconcile 当作「PENDING 待机」抢先重载（否则已撤销的服务会被重新注册）
    await this.rollback('UNLOADING');
    this._state = 'DISPOSED';

    // 通知父 Fiber 解除引用
    this.onDisposed?.();
  }

  /** 卸载完成回调（由 Context 注入，用于从父的 children 里摘除） */
  onDisposed?: () => void;
}
