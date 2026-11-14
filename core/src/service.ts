/**
 * 服务注册表。
 *
 * 设计要点（D10）：服务存放在**共享**的 store，不按 Fiber 分层。
 * 插件间共享服务是内核存在的意义；若每个 Fiber 各持一层，兄弟 Fiber
 * 互相看不见，「同一 key 被两个 ACTIVE Fiber 提供 → 冲突」也无从判定。
 *
 * `isolate`（任务 03）实现为「在共享 store 之上按 key 覆盖的分支」，
 * 不需要改动本文件的结构。
 */

import { ServiceConflictError } from './errors.js';

/** 一条服务登记 */
export interface ServiceEntry<T = unknown> {
  key: string;
  impl: T;
  /** 提供者 Fiber id；根 Context 提供的记为空串 */
  ownerFiberId: string;
}

/** 服务注册表：key → 实现，带归属信息以便卸载与诊断 */
export class ServiceRegistry {
  private readonly entries = new Map<string, ServiceEntry>();

  /** 读服务；未提供返回 undefined（软依赖用法） */
  get<T>(key: string): T | undefined {
    return this.entries.get(key)?.impl as T | undefined;
  }

  /** 是否存在该 key */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** 当前已登记的 key 列表（注册序） */
  keys(): readonly string[] {
    return [...this.entries.keys()];
  }

  /**
   * 提供服务。
   *
   * 同一 key 已存在时抛 `ServiceConflictError`——不做「后来者覆盖」，
   * 因为静默覆盖会让原提供者的 disposer 删掉新提供者的值。
   */
  provide<T>(key: string, impl: T, ownerFiberId: string): void {
    if (this.entries.has(key)) {
      const existing = this.entries.get(key)!;
      throw new ServiceConflictError(key, {
        fiberId: ownerFiberId,
        cause: new Error(`已由 Fiber ${existing.ownerFiberId || '(root)'} 提供`),
      });
    }
    this.entries.set(key, { key, impl, ownerFiberId });
  }

  /** 移除登记；返回是否确实移除了 */
  remove(key: string): boolean {
    return this.entries.delete(key);
  }

  /** 快照，供 diagnose()（任务 03）读取，避免外部持有内部 Map */
  entriesSnapshot(): readonly ServiceEntry[] {
    return [...this.entries.values()];
  }

  /** 清空（仅测试与整体卸载用） */
  clear(): void {
    this.entries.clear();
  }
}
