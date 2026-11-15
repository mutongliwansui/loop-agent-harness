/**
 * `ToolBase` 抽象基类 —— 本包的核心契约之一。
 *
 * ## 为什么是抽象基类而非 interface
 *
 * 需求原话是「供…**继承**」，继承本身就是需求。纯 interface 只能声明，
 * 什么都给不了：每个实现都得自己重复写「参数校验」「失败归一」「耗时埋点」，
 * 而这些恰恰是**所有工具都该有**的公共能力。抽象类能承载已实现的模板方法
 * （`invoke()`）与只读访问器，还能用 `protected` 限制子类误覆写。
 *
 * ## 子类只需实现 `execute()`
 *
 * ```ts
 * class FileReadTool extends ToolBase {
 *   constructor() {
 *     super({
 *       name: 'fileRead',
 *       description: '读取文件内容',
 *       parameters: {
 *         type: 'object',
 *         properties: { path: { type: 'string' } },
 *         required: ['path'],
 *       },
 *     });
 *   }
 *   protected async execute(args, ctx) {
 *     return await readFile(String(args.path));   // 只返回字符串也行
 *   }
 * }
 * ```
 *
 * ## 模板方法固化了什么
 *
 * `invoke()` 是宿主唯一调用入口，依次做：参数形状检查 → JSON Schema 校验 →
 * `execute()` → 结果归一 → 事件。**任何环节失败都返回 `isError:true` 的
 * `ToolResult`，不向上抛**——与 `src/tools/runner.ts` 的既有语义一致
 * （异常不抛出、转为失败文本，让 ReAct 自行换思路），避免打断循环。
 *
 * 唯一例外：`ctx.signal` 已 abort 时直接返回取消结果，**不调用** `execute()`。
 */

import { resolveAnnotations, type ToolAnnotations } from './annotations.js';
import type { ToolsError } from './errors.js';
import { formatIssues, validateArgs, validateParametersSchema } from './schema.js';
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  type JsonSchema,
  type ToolInvokeContext,
  type ToolResult,
  type ToolSpec,
} from './types.js';

/** `invoke()` 的可选行为控制（属宿主诊断用途，不改变契约语义） */
export interface InvokeOptions {
  /**
   * 观测钩子：`invoke()` 内部何时触发事件由 registry 负责；本钩子只让
   * **直接调用** `tool.invoke()` 的场景（测试、脚本）也能拿到埋点。
   */
  onResult?(name: string, result: ToolResult, elapsedMs: number): void;
}

/**
 * 单个工具的抽象基类。
 *
 * 构造时传入 `ToolSpec` 并定稿，运行期只读——避免「注册后改规格」
 * 让目录里的元信息与实际行为不一致。
 */
export abstract class ToolBase {
  /** 规格快照：构造函数里浅拷贝，防止外部持有引用后篡改 */
  protected readonly spec: ToolSpec;

  constructor(spec: ToolSpec) {
    // 只做结构性兜底；完整的注册期校验在 registry/define 层（要报出 providerId）
    const paramIssues = validateParametersSchema(spec.parameters);
    if (paramIssues.length > 0) {
      throw new Error(`工具 '${String(spec.name)}' 的 ${paramIssues[0]!.message}`);
    }
    this.spec = {
      ...spec,
      // 深拷贝 parameters 的一层，防止外部对象被改动后影响已注册工具
      parameters: spec.parameters,
      ...(spec.annotations !== undefined ? { annotations: { ...spec.annotations } } : {}),
      ...(spec.display !== undefined ? { display: { ...spec.display } } : {}),
    };
  }

  /** 工具名（唯一寻址键） */
  get name(): string {
    return this.spec.name;
  }

  /** 能力说明（给模型看） */
  get description(): string {
    return this.spec.description;
  }

  /** 参数 JSON Schema */
  get parameters(): JsonSchema {
    return this.spec.parameters;
  }

  /**
   * 行为声明：**已补全 MCP 悲观默认**。
   *
   * 未声明的 hint 取「可能写 / 可能破坏 / 可能不幂等 / 可能触网」，
   * 保证第三方工具缺省即最保守（见 `annotations.ts`）。
   */
  get annotations(): Required<Omit<ToolAnnotations, 'title'>> & Pick<ToolAnnotations, 'title'> {
    return resolveAnnotations(this.spec.annotations);
  }

  /** 单次执行默认超时；缺省 30_000（对齐 runner.ts:65） */
  get timeoutMs(): number {
    return this.spec.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  }

  /** 展示元信息（可选；本期 WebUI 不消费） */
  get display(): ToolSpec['display'] {
    return this.spec.display;
  }

  /**
   * 投影为纯数据规格。
   *
   * 返回**浅拷贝**：调用方（目录 / 诊断 / toToolDefs）可自由读取，
   * 但改动不会回写工具自身。
   */
  toSpec(): ToolSpec {
    return {
      ...this.spec,
      annotations: this.annotations,
      ...(this.spec.display !== undefined ? { display: { ...this.spec.display } } : {}),
    };
  }

  /**
   * 宿主唯一调用入口（模板方法）。
   *
   * 步骤固定，子类**不应覆写**（TS 无 `final`，靠文档与本注释约束；
   * 覆写会绕过参数校验与结果归一，属已知风险但保留逃生能力）。
   */
  async invoke(
    rawArgs: unknown,
    ctx: ToolInvokeContext = {},
    options: InvokeOptions = {},
  ): Promise<ToolResult> {
    const startedAt = Date.now();

    // ① 取消优先：已 abort 就不执行（避免白跑一次昂贵命令）
    if (ctx.signal?.aborted === true) {
      return this.finish({ text: '工具已取消', isError: true }, startedAt, options);
    }

    // ② 参数必须是普通对象：null / 数组 / 原始值都不是合法的 function arguments
    if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      const actual = Array.isArray(rawArgs) ? 'array' : rawArgs === null ? 'null' : typeof rawArgs;
      return this.finish(
        { text: `工具执行失败: 参数必须是对象，实际收到 ${actual}`, isError: true },
        startedAt,
        options,
      );
    }

    const args = rawArgs as Record<string, unknown>;

    // ③ JSON Schema 校验（手写子集）：把「参数形状错」与「执行失败」分开
    const issues = validateArgs(this.spec.parameters, args);
    if (issues.length > 0) {
      return this.finish(
        {
          text: `工具执行失败: 参数不符合 schema\n${formatIssues(issues)}`,
          isError: true,
        },
        startedAt,
        options,
      );
    }

    // ④ 执行 + 归一
    try {
      const out = await this.execute(args, ctx);
      return this.finish(this.normalize(out), startedAt, options);
    } catch (err) {
      // 取消冒泡特例：宿主若用可中止实现，应保留 aborted 语义而非当作工具失败
      if ((err as { aborted?: boolean } | null)?.aborted === true) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      return this.finish({ text: `工具执行失败: ${detail}`, isError: true }, startedAt, options);
    }
  }

  /**
   * 子类唯一必须实现的方法。
   *
   * `protected` 是刻意的：宿主不该绕过校验直接调裸执行体。
   * 需要逃生口时由实现方自行在子类上公开一个方法，责任归实现方。
   *
   * 返回 `string` 或 `ToolResult` 均可——`string` 会被包成
   * `{ text, isError:false }`，便于现状 12 个 `Promise<string>` 工具平移。
   */
  protected abstract execute(
    args: Record<string, unknown>,
    ctx: ToolInvokeContext,
  ): Promise<string | ToolResult> | string | ToolResult;

  /** 把 `string | ToolResult` 归一为 `ToolResult` */
  private normalize(out: string | ToolResult): ToolResult {
    if (typeof out === 'string') return { text: out, isError: false };
    if (out === null || typeof out !== 'object') {
      // 实现方违约（如 return undefined）：不抛给宿主，转成可诊断的失败
      return { text: `工具执行失败: execute() 返回了非法值 ${String(out)}`, isError: true };
    }
    return { text: out.text, isError: out.isError === true, ...(out.structured ? { structured: out.structured } : {}) };
  }

  /** 统一收尾：埋点 + 返回（所有出口共用，避免遗漏 elapsedMs） */
  private finish(result: ToolResult, startedAt: number, options: InvokeOptions): ToolResult {
    const elapsedMs = Date.now() - startedAt;
    options.onResult?.(this.spec.name, result, elapsedMs);
    return result;
  }
}

/**
 * 由错误对象构造失败结果的辅助函数。
 *
 * 供实现方在 `execute()` 内自行捕获时复用统一文案，避免各写一套。
 */
export function failWith(error: ToolsError | Error | string): ToolResult {
  const detail = typeof error === 'string' ? error : error.message;
  return { text: `工具执行失败: ${detail}`, isError: true };
}

/** 构造成功结果的辅助函数 */
export function okResult(text: string, structured?: Record<string, unknown>): ToolResult {
  return structured ? { text, isError: false, structured } : { text, isError: false };
}
