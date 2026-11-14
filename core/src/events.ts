/**
 * 类型化事件总线（四模式）。
 *
 * | 方法        | await | 顺序                        | 返回 | 异常处理       |
 * |-------------|-------|-----------------------------|------|----------------|
 * | `emit`      | 否    | 注册序                      | 无   | 记录，不外抛   |
 * | `serial`    | 是    | 注册序，首个非 undefined 即停 | 有   | 外抛           |
 * | `parallel`  | 是    | 全部并行（allSettled）       | 无   | 记录，不外抛   |
 * | `waterfall` | 是    | 注册序，监听器可调 `next()`   | 有   | 外抛           |
 *
 * `waterfall` 的监听器比普通监听器多一个**尾部参数 `next`**：调用表示
 * 「我不处理，交给下一个」，不调用即短路。全链都委托才走 `fallback`。
 *
 * 监听器异常**不 console.error**：库不应污染宿主输出。异常收集到
 * `listenerErrors()`，`diagnose()` 可读取。
 */

import type { Disposer, EventMapBase } from './types.js';

/** 一条监听器登记 */
interface ListenerEntry {
  fn: (...args: any[]) => any;
  /** 注册者 Fiber id；根 Context 注册的记为空串 */
  ownerFiberId: string;
}

/** 监听器异常记录 */
export interface ListenerErrorRecord {
  event: string;
  ownerFiberId: string;
  error: unknown;
}

/** 类型化事件总线：`E` 为业务侧自定义的事件表 */
export class TypedEventBus<E extends EventMapBase = EventMapBase> {
  private readonly listeners = new Map<string, ListenerEntry[]>();
  private readonly errors: ListenerErrorRecord[] = [];

  /**
   * 注册监听器，返回移除函数。
   *
   * 用数组而非 Set：同一函数被注册两次应当被调用两次（Set 会去重，
   * 与「注册即生效」的直觉不符，且移除时无法区分是哪一次）。
   */
  on<K extends keyof E & string>(
    event: K,
    listener: E[K],
    ownerFiberId = '',
  ): Disposer {
    const entry: ListenerEntry = { fn: listener, ownerFiberId };
    const list = this.listeners.get(event);
    if (list) list.push(entry);
    else this.listeners.set(event, [entry]);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const cur = this.listeners.get(event);
      if (!cur) return;
      const idx = cur.indexOf(entry);
      if (idx >= 0) cur.splice(idx, 1);
      if (cur.length === 0) this.listeners.delete(event);
    };
  }

  /** 某事件的监听器数量（测试与诊断用） */
  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  /** 累计的监听器异常（供任务 03 的 diagnose 读取） */
  listenerErrors(): readonly ListenerErrorRecord[] {
    return this.errors;
  }

  /** 取当前监听器快照（注册序），供内部模式方法复用 */
  private snapshot(event: string): ListenerEntry[] {
    return this.listeners.get(event)?.slice() ?? [];
  }

  /**
   * 纯通知：同步按注册序调用，不等待返回值。
   * 无监听器时为空操作；监听器抛错只记录，不外抛。
   */
  emit<K extends keyof E & string>(event: K, ...args: Parameters<E[K]>): void {
    for (const entry of this.snapshot(event)) {
      try {
        const ret = entry.fn(...args);
        // 异步 reject 也要兜住，否则会变成 unhandledRejection
        if (ret && typeof ret.then === 'function') {
          (ret as Promise<unknown>).then(undefined, (error) => {
            this.errors.push({ event, ownerFiberId: entry.ownerFiberId, error });
          });
        }
      } catch (error) {
        this.errors.push({ event, ownerFiberId: entry.ownerFiberId, error });
      }
    }
  }

  /**
   * 单决策：按注册序 await，首个返回非 `undefined` 的值胜出并立即停止。
   * 无监听器或全部返回 undefined 时返回 `undefined`。
   * 监听器抛错**外抛**（调用方在等值，静默吞掉会让它拿到错误结论）。
   */
  async serial<K extends keyof E & string>(
    event: K,
    ...args: Parameters<E[K]>
  ): Promise<Awaited<ReturnType<E[K]>> | undefined> {
    for (const entry of this.snapshot(event)) {
      const ret = await entry.fn(...args);
      if (ret !== undefined) return ret as Awaited<ReturnType<E[K]>>;
    }
    return undefined;
  }

  /**
   * 扇出：全部并行，不关心返回值（`allSettled`）。
   * 无监听器时为空操作；异常只记录，不外抛。
   */
  async parallel<K extends keyof E & string>(
    event: K,
    ...args: Parameters<E[K]>
  ): Promise<void> {
    const list = this.snapshot(event);
    if (list.length === 0) return;
    const results = await Promise.allSettled(
      list.map((entry) => Promise.resolve().then(() => entry.fn(...args))),
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        this.errors.push({
          event,
          ownerFiberId: list[i].ownerFiberId,
          error: r.reason,
        });
      }
    });
  }

  /**
   * 拦截改写：按注册序串成一条链，监听器可调 `next()` 委托给下一个。
   *
   * - 无监听器 → 直接 `fallback(...args)`
   * - 某监听器不调 `next()` → 短路，其返回值即最终结果
   * - 全链都委托 → 最终 `fallback(...args)`
   * - 监听器抛错 → **外抛**（调用方在等值，与 `serial` 一致）
   *
   * `next()` 的返回值就是「后续链条（含 fallback）的结果」，因此监听器
   * 可以写成「拿 next() 结果再加工」这种包装形式。
   */
  async waterfall<K extends keyof E & string, R>(
    event: K,
    fallback: (...args: Parameters<E[K]>) => R | Promise<R>,
    ...args: Parameters<E[K]>
  ): Promise<R> {
    const list = this.snapshot(event);

    const run = async (index: number): Promise<R> => {
      const entry = list[index];
      if (!entry) return fallback(...args);
      // 监听器签名的尾部多一个 next，而 `E[K]` 描述的是普通监听器形状，
      // 故此处需断言解除参数个数约束。
      const fn = entry.fn as (...a: unknown[]) => unknown;
      return (await fn(...args, () => run(index + 1))) as R;
    };

    return run(0);
  }
}
