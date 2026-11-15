/**
 * `ToolProvider` 抽象基类 —— 「一个插件提供 N 个工具」的契约。
 *
 * ## 为什么需要第二层契约
 *
 * 只有单工具契约时，「一个 MCP server 连上来给出 47 个工具」「视觉三件套按
 * 开关成组注册」这类场景只能由用户在外面手写循环 + 手写撤销逻辑。提供者层
 * 把「成组」变成一等概念：登记由 `ctx.effect` 批量托管，卸载时逆序撤销。
 *
 * ## 职责边界（刻意不做三件事）
 *
 * - **不做命名空间前缀**：`server__tool` 这类前缀取决于命名空间如何划分
 *   （MCP server 名 / 插件 id / 市场包 id），属**装配决策**，归宿主适配器（D13）。
 * - **不做去重**：重名语义归目录（`ToolRegistry`，D11），要报出双方 providerId。
 * - **不做排序**：稳定排序归 `toToolDefs()`（D12，保住前缀缓存不变量）。
 *
 * ## 为什么 `create()` 允许异步
 *
 * MCP 需要先握手、外部工具包可能要先读磁盘清单；同步签名会逼所有实现写
 * `await Promise.resolve()` 包装。异步签名对同步实现零成本（直接返回数组）。
 */

import type { Inject } from '@loop-agent/core';

import type { ToolBase } from './tool.js';

/**
 * 一组工具的提供者。
 *
 * ```ts
 * class VisionProvider extends ToolProvider {
 *   readonly id = 'vision';
 *   readonly displayName = '视觉工具';
 *   async create(options) {
 *     if (options.enabled !== true) return [];
 *     return [new AnalyzeImageTool()];
 *   }
 * }
 * ```
 */
export abstract class ToolProvider {
  /** 唯一标识；非空、不含 `:`（`:` 是服务 key 的分段符，会让 key 无法反解） */
  abstract readonly id: string;

  /**
   * 展示名；缺省回落 `id`（回落逻辑在 `define.ts` 里做，本类不设 getter，
   * 以免子类用属性覆盖 getter 时遇到访问器/属性冲突）。
   */
  readonly displayName?: string;

  /**
   * 提供者级**额外**依赖声明（可选）。
   *
   * `tools:registry` 由 `defineTools()` 无条件注入为硬依赖；这里只用于补充
   * 其他依赖（如某个工具组需要 `llm:registry` 才能工作）。合并策略见
   * `define.ts` 的 `mergeInject()`。
   */
  readonly inject?: Inject;

  /**
   * 产出本提供者负责的全部工具。
   *
   * @param options 合并后的配置（代码侧 `def.options` ← 清单侧 `options`，后者优先）
   */
  abstract create(options: Record<string, unknown>): ToolBase[] | Promise<ToolBase[]>;

  /**
   * 资源释放：连接池、子进程、定时器等。
   *
   * `protected` 的原因：卸载语义应由框架统一触发（框架调 `dispose()`），
   * 不希望业务代码随便调用一个「半卸载」动作。异常由框架吞掉（core 不变量 3）。
   */
  protected async onDispose(): Promise<void> {
    // 缺省无事可做
  }

  /**
   * 供框架调用的卸载入口。
   *
   * `onDispose` 是 `protected`，但框架不是子类，需要这个 public 转发点。
   * 与 `LlmProvider.dispose()` 同构，两个包用户手册口径一致。
   */
  async dispose(): Promise<void> {
    await this.onDispose();
  }
}
