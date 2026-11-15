/**
 * 测试共用的假工具与假提供者。
 *
 * 刻意用真实 `class ... extends ToolBase / ToolProvider` 而非 mock 对象：
 * 本包的核心价值就是「能不能被继承」，用 mock 会把最该验证的东西跳过。
 */

import { ToolBase, ToolProvider, type ToolInvokeContext, type ToolResult } from '../src/index.js';

/** 记录调用情况的假工具：默认回显 JSON 参数 */
export class EchoTool extends ToolBase {
  /** 每次 execute() 收到的实参，供断言「是否被调用」「收到什么」 */
  readonly calls: Array<Record<string, unknown>> = [];
  /** 每次 execute() 收到的执行期上下文 */
  readonly contexts: ToolInvokeContext[] = [];

  constructor(
    name = 'echo',
    private readonly responder: (
      args: Record<string, unknown>,
    ) => string | ToolResult | Promise<string | ToolResult> = (args) => JSON.stringify(args),
    parameters: Record<string, unknown> = {
      type: 'object',
      properties: { text: { type: 'string' } },
    },
  ) {
    super({ name, description: `${name} 的测试用说明`, parameters });
  }

  protected override execute(
    args: Record<string, unknown>,
    ctx: ToolInvokeContext,
  ): string | ToolResult | Promise<string | ToolResult> {
    this.calls.push(args);
    this.contexts.push(ctx);
    return this.responder(args);
  }

  /** 测试需要主动观测「execute 到底有没有被调用」 */
  get callCount(): number {
    return this.calls.length;
  }
}

/** 永远抛异常的假工具 */
export class ThrowingTool extends ToolBase {
  constructor(name = 'boom', message = '内部炸了') {
    super({
      name,
      description: '总是抛异常',
      parameters: { type: 'object', properties: {} },
    });
    this.message = message;
  }

  private readonly message: string;

  protected override execute(): string {
    throw new Error(this.message);
  }
}

/** 假提供者：产出一组 EchoTool，可配置产出数量与异步行为 */
export class FakeProvider extends ToolProvider {
  readonly id: string;
  override readonly displayName?: string;
  /** create() 收到的 options，供断言合并规则 */
  readonly seenOptions: Array<Record<string, unknown>> = [];
  /** dispose() 被调用次数 */
  disposeCount = 0;
  /** create() 是否走异步分支 */
  private readonly async: boolean = false;
  /** 产出数量 */
  private readonly count: number;

  constructor(opts: { id?: string; count?: number; async?: boolean; displayName?: string } = {}) {
    super();
    this.id = opts.id ?? 'fake-provider';
    this.count = opts.count ?? 2;
    this.async = opts.async ?? false;
    this.displayName = opts.displayName;
  }

  override create(options: Record<string, unknown>): ToolBase[] | Promise<ToolBase[]> {
    this.seenOptions.push(options);
    const tools = Array.from({ length: this.count }, (_, i) => new EchoTool(`${this.id}-t${i}`));
    if (this.async) return Promise.resolve(tools);
    return tools;
  }

  protected override async onDispose(): Promise<void> {
    this.disposeCount++;
  }
}
