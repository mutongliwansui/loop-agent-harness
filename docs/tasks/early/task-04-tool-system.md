# Task-04：工具系统（Registry + Runner）

## 需求目标

实现可扩展的工具注册与执行系统，支持工具注册、查询、转换为 OpenAI tools 参数格式，以及统一的工具执行器（含错误处理、超时控制）。

### 目标清单
1. 实现 `src/tools/registry.ts`：工具注册表
2. 实现 `src/tools/runner.ts`：工具执行器
3. 提供 `register` / `get` / `list` / `toOpenAITools()` 方法
4. Runner 统一捕获异常、控制超时、结果转字符串
5. 支持同一轮多个工具并发执行

## 实现方案

### 1. src/tools/registry.ts

```typescript
import type { Tool, OpenAIToolDef } from '../types.js';

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具 ${tool.name} 已注册`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool {
    const t = this.tools.get(name);
    if (!t) throw new Error(`工具 ${name} 未注册`);
    return t;
  }

  list(): Tool[] { return [...this.tools.values()]; }

  toOpenAITools(): OpenAIToolDef[] {
    return this.list().map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
}

export const registry = new ToolRegistry();
```

### 2. src/tools/runner.ts

```typescript
import type { Tool } from '../types.js';

export interface RunOptions {
  timeout?: number; // 毫秒，默认 30000
}

export class ToolRunner {
  async run(tool: Tool, args: Record<string, unknown>, options: RunOptions = {}): Promise<string> {
    const timeout = options.timeout ?? 30000;
    try {
      const result = await this.withTimeout(tool.execute(args), timeout);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `工具执行失败: ${msg}`; // 返回错误字符串作为 Observation
    }
  }

  async runParallel(
    calls: { tool: Tool; args: Record<string, unknown> }[],
    options?: RunOptions
  ): Promise<string[]> {
    return Promise.all(calls.map(c => this.run(c.tool, c.args, options)));
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`工具执行超时 (${ms}ms)`)), ms)
      ),
    ]);
  }
}

export const runner = new ToolRunner();
```

### 3. 设计要点

- **错误不抛出**：Runner 捕获所有异常，转为字符串 Observation 返回，让 Agent 自行决定换思路（符合 ReAct 思想）
- **超时控制**：默认 30s，避免工具卡死整个 Agent
- **并发执行**：`runParallel` 用 `Promise.all`，用于同一轮多工具调用
- **结果归一化**：无论工具返回什么，Runner 统一转成字符串给 LLM

## 验收测试清单

- [x] 项1：`ToolRegistry` 类已实现，含 register/get/list/has/toOpenAITools 5 个方法（比方案多 has）
- [x] 项2：`register` 重复注册同名工具时抛出错误（实测：抛 "工具 xxx 已注册，不可重复注册"）
- [x] 项3：`get` 未注册工具时抛出错误（实测：抛 "工具 xxx 未注册"）
- [x] 项4：`toOpenAITools()` 输出符合 OpenAI tools 参数格式（type:'function'，含 name/description/parameters）
- [x] 项5：`ToolRunner.run()` 正常执行工具并返回字符串（实测：返回 'ok'）
- [x] 项6：工具抛异常时，`run()` 返回"工具执行失败: xxx"字符串而非抛错（实测：返回 "工具执行失败: boom"）
- [x] 项7：工具超时时，返回"工具执行超时 (xxxms)"字符串（实测：返回 "工具执行超时 (50ms)"，不嵌套"工具执行失败"前缀）
- [x] 项8：`runParallel()` 并发执行多个工具，结果顺序与输入一致（实测：2 个 500ms 工具并发 514ms 完成，顺序正确）
- [x] 项9：工具返回对象/数组时，Runner 自动 JSON.stringify（实测：`{a:1,b:[2,3]}` → 含 `"a":1` 的字符串）
- [x] 项10：`npm run typecheck` 通过

## 验证记录

```
===== Registry 测试 =====
  ✓ 项1: register/get/list/toOpenAITools 方法存在
  ✓ 项2: 重复注册抛错
  ✓ 项3: 获取未注册工具抛错
  ✓ 项4: toOpenAITools 数量/格式正确

===== Runner 测试 =====
  ✓ 项5: 正常执行返回 ok
  ✓ 项6: 抛异常返回 "工具执行失败: boom"
  ✓ 项7: 超时返回 "工具执行超时 (50ms)"
  ✓ 项8: 并发执行 514ms（接近单工具 500ms，非 1000ms）
  ✓ 项9: 对象结果自动 JSON.stringify

===== 结果: 15 通过 / 0 失败 =====
```

## 状态

- 状态：已完成
- 更新时间：2026-08-04
- 负责人：Agent
- 依赖：Task-02
- 备注：超时错误单独识别，不嵌套"工具执行失败"前缀，让 Agent 更清晰区分超时与一般错误

> 完成时同步更新 plan.md 状态汇总表与本文件验收清单。
