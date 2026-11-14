/**
 * 内核核心类型。
 *
 * 设计要点：
 * - `Events` 由**泛型参数**注入（`Context<E>`），不用 TS 全局声明合并。
 *   原因：全局合并会让任何引入 core 的模块都能往同一张事件表里塞事件，
 *   多个模块各自扩展时极易撞名，且在库中无法控制命名空间。
 * - `FiberState` 六态与设计方案 5.5 状态机一一对应。
 */

import type { Context } from './context.js';

/** 清理函数：允许异步 */
export type Disposer = () => void | Promise<void>;

/**
 * 依赖声明：
 * - `string[]`               → 全部硬依赖
 * - `{ required, optional }` → 区分硬 / 软依赖
 *
 * 硬依赖未满足时 Fiber 停在 PENDING 且 `apply` 不被调用；
 * 软依赖只影响 `get()` 能否取到值，不阻塞加载。
 */
export type Inject = string[] | { required?: string[]; optional?: string[] };

/** 事件表基类型：任何 `(…args) => any` 的映射 */
export interface EventMapBase {
  [event: string]: (...args: any[]) => any;
}

/** 插件函数形态 */
export type PluginFunction<E extends EventMapBase = EventMapBase> = (
  ctx: Context<E>,
) => void | Promise<void>;

/** 插件对象形态 */
export interface PluginObject<E extends EventMapBase = EventMapBase> {
  /** 诊断显示名；缺省取函数名，再缺省 'anonymous' */
  name?: string;
  /** 硬依赖未满足时 Fiber 停在 PENDING，绝不执行 apply */
  inject?: Inject;
  /** 插件主体：apply 内注册的一切由 Fiber 托管 */
  apply(ctx: Context<E>): void | Promise<void>;
}

/** 插件：函数或对象两形态（不提供 Service 子类，少一层继承魔法） */
export type Plugin<E extends EventMapBase = EventMapBase> =
  | PluginFunction<E>
  | PluginObject<E>;

/**
 * Fiber 六态。
 *
 * ```
 * PENDING ──required 依赖满足──> LOADING ──apply 成功──> ACTIVE
 *    ↑                              │
 *    │                              └─apply 抛错→ FAILED（终态）
 *    │
 * 任意非 DISPOSED ──dispose()──> UNLOADING ──> DISPOSED
 * ```
 */
export type FiberState =
  /** 已声明，硬依赖未就绪；`apply` 不被调用 */
  | 'PENDING'
  /** 依赖就绪，`apply` 执行中 */
  | 'LOADING'
  /** 正常运行 */
  | 'ACTIVE'
  /** `apply` 抛错（终态，需显式 reload） */
  | 'FAILED'
  /** 正在撤销 */
  | 'UNLOADING'
  /** 已完全卸载 */
  | 'DISPOSED';

/** `ctx.plugin()` 的附加选项 */
export interface PluginOptions {
  /** 覆盖诊断显示名（优先于插件自身的 name） */
  name?: string;
}

/**
 * 诊断报告。
 *
 * 类型在本任务（02）定案，`diagnose()` 的实现属任务 03。
 * 先定类型是为了让 `Context` 的方法签名一次写对，避免 03 反过来改接口。
 */
export interface DiagnosticReport {
  fibers: Array<{
    id: string;
    name: string;
    state: FiberState;
    /** 硬依赖中尚未满足的 key —— PENDING 的直接原因 */
    missing: string[];
    /** FAILED 时的错误摘要 */
    error?: { code: string; message: string };
    /** 卸载期 disposer 抛错的摘要（不变量 3 要求可诊断） */
    disposeErrors?: string[];
  }>;
  /** 当前服务的归属信息 */
  services: Array<{
    key: string;
    ownerFiberId: string;
    /** 是否处于隔离域（该 key 被某个 isolate 声明过） */
    isolated: boolean;
  }>;
}
