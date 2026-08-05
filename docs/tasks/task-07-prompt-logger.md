# Task-07：System Prompt 与执行日志

## 需求目标

构造引导 LLM 进行 ReAct 推理的 System Prompt，并实现彩色终端日志，让用户能清晰看到 Thought / Action / Observation 每一步。

### 目标清单
1. 实现 `src/agent/prompt.ts`：动态构造 System Prompt（含工具列表）
2. 实现 `src/agent/logger.ts`：彩色输出 Thought / Action / Observation / Final
3. Prompt 明确告知 LLM：可用工具、思考方式、何时直接回答
4. Logger 支持 verbose 开关关闭

## 实现方案

### 1. src/agent/prompt.ts（无工具列表，规则含工具前自然语言说明）

```typescript
// System Prompt 构造器：仅含行为指导，不重复工具列表
// 工具 schema 由 OpenAI function calling 的 tools 参数暴露，避免冗余

export function buildSystemPrompt(): string {
  return `你是一个能够使用工具的 ReAct（Reasoning + Acting）Agent。通过 Thought → Action → Observation 的循环解决用户问题。

## 工作模式
1. **Thought**：分析用户问题，判断是否需要使用工具
2. **Action**：如果需要工具，调用合适的工具（可同时调用多个独立工具）
3. **Observation**：根据工具返回结果继续思考
4. 重复以上步骤，直到能给出最终答案
5. 如果不需要工具，直接回答用户问题

## 规则
- 优先使用工具获取准确信息，不要凭空臆造
- 在调用工具前，请先用自然语言简要说明你要做什么
- 工具调用失败时，尝试换一种参数或换一个工具，不要重复同样的失败调用
- 多个独立的工具调用可在同一轮发起，减少迭代次数
- 得到足够信息后，必须直接给出最终答案，不要继续调用工具
- 最终答案要用自然语言清晰回答用户问题，不要包含工具调用的原始格式

## 工具使用指导
- 工具的参数 schema 通过 function calling 协议暴露，按需调用即可
- 工具名前缀 \`{serverName}__\` 表示来自 MCP server 的工具，可正常使用`;
}
```

### 2. src/agent/logger.ts（ConsoleLogger 类实现 AgentEvents 接口）

```typescript
// 默认事件监听器：彩色日志输出
// 实现 AgentEvents 接口，作为 ReActAgent 的默认 events
import type { AgentEvents, AgentResult, LLMResponse } from '../types.js';

/** ANSI 颜色码 */
const COLOR = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  bold: '\x1b[1m',
} as const;

export class ConsoleLogger implements AgentEvents {
  constructor(private verbose: boolean = true) {}

  onStart(input: string): void {
    if (!this.verbose) return;
    console.log(`${COLOR.bold}${COLOR.yellow}━━━ ReAct Agent 启动 ━━━${COLOR.reset}`);
    console.log(`${COLOR.gray}Query:${COLOR.reset} ${input}\n`);
  }

  onIterationStart(iteration: number, maxIterations: number): void {
    if (!this.verbose) return;
    console.log(`\n${COLOR.gray}━━━ 迭代 ${iteration + 1}/${maxIterations} ━━━${COLOR.reset}`);
  }

  onLLMStream(delta: string): void {
    if (!this.verbose) return;
    // 流式输出 Thought：首次出现时打 [Thought] 前缀
    if (!this._thoughtHeaderPrinted) {
      process.stdout.write(`\n${COLOR.cyan}${COLOR.bold}[Thought]${COLOR.reset} `);
      this._thoughtHeaderPrinted = true;
    }
    process.stdout.write(delta);
  }

  onLLMEnd(response: LLMResponse): void {
    if (!this.verbose) return;
    if (this._thoughtHeaderPrinted) {
      process.stdout.write('\n');
      this._thoughtHeaderPrinted = false;
    }
  }

  onToolStart(tool: string, args: Record<string, unknown>): void {
    if (!this.verbose) return;
    const argsStr = Object.keys(args).length ? JSON.stringify(args) : '(无参数)';
    console.log(`${COLOR.magenta}${COLOR.bold}[Action]${COLOR.reset} ${tool}(${COLOR.magenta}${argsStr}${COLOR.reset})`);
  }

  onToolEnd(tool: string, result: string): void {
    if (!this.verbose) return;
    const indented = result.split('\n').join('\n  ');
    console.log(`${COLOR.green}[Observation]${COLOR.reset}\n  ${indented}`);
  }

  onFinal(answer: string): void {
    if (!this.verbose) return;
    console.log(`\n${COLOR.bold}${COLOR.green}━━━ Final Answer ━━━${COLOR.reset}\n${answer}\n`);
  }

  onError(error: Error): void {
    if (!this.verbose) return;
    console.error(`\n${COLOR.red}${COLOR.bold}[Error]${COLOR.reset} ${COLOR.red}${error.message}${COLOR.reset}\n`);
  }

  onEnd(result: AgentResult | null): void {
    if (!this.verbose) return;
    if (result) {
      console.log(`${COLOR.gray}━━━ 完成（${result.iterations} 轮，${result.steps.length} 步） ━━━${COLOR.reset}`);
    }
  }

  /** 内部状态：标记当前轮 Thought 前缀是否已打印 */
  private _thoughtHeaderPrinted = false;
}

/** 默认日志实例（verbose=true） */
export const logger = new ConsoleLogger(true);
```

### 3. Prompt 设计要点

- **明确角色 + 工作模式**：告知 LLM 是 ReAct Agent，Thought→Action→Observation 循环
- **不重复工具列表**：工具名/描述/参数由 OpenAI function calling 的 `tools` 参数原生暴露
  - 避免 Prompt 冗余、节省 token、避免模型将 Prompt 文本与 tools schema 混淆
- **工具前自然语言说明**：规则第二条明确要求"在调用工具前，请先用自然语言简要说明你要做什么"
  - 让用户能直观看到每一步 Agent 的意图，提升可解释性
- **多工具并发**：明确支持同一轮多个独立工具调用，减少迭代次数
- **错误恢复**：工具失败时换参数/换工具，不要重复同样失败
- **MCP 前缀说明**：`{serverName}__` 前缀告知 LLM 这是外部 MCP 工具，可正常使用
- **何时停止**：得到足够信息必须给出 Final Answer，不要继续调用工具

### 4. Logger（ConsoleLogger）设计要点

- **实现 AgentEvents 接口**：9 个钩子全覆盖（onStart/onIterationStart/onLLMStream/onLLMEnd/onToolStart/onToolEnd/onFinal/onError/onEnd）
- **流式 onLLMStream**：Thought 逐字输出，首次打 `[Thought]` 前缀，onLLMEnd 收尾换行
- **实例内状态**：`_thoughtHeaderPrinted` 记录当前轮前缀是否已打，每轮由 onLLMEnd 重置
- **颜色区分**：Thought 青色、Action 品红、Observation 绿色、Final 绿色粗体、Error 红色、迭代/启动用灰色+黄色粗体
- **verbose 开关**：构造函数参数控制，false 时所有钩子直接 return（静默）
- **stderr 错误**：onError 使用 console.error
- **Observation 缩进**：多行结果每行前加 2 空格对齐，视觉更清晰

## 验收测试清单

- [x] 项1：`buildSystemPrompt(tools)` 返回字符串，包含所有工具名与 description（实测：含 commandRun 与 fileRead 描述）
- [x] 项2：Prompt 包含"Thought / Action / Observation"工作模式说明（实测验证）
- [x] 项3：Prompt 包含"不需要工具时直接回答"规则
- [x] 项4：Prompt 包含"得到足够信息后必须给出最终答案"规则（含"不要继续调用工具"约束）
- [x] 项5：空工具列表时，Prompt 仍能正常生成（含"当前无可用工具，请直接回答用户问题"）
- [x] 项6：`logger.thought()` 输出含 `[Thought]` 前缀（青色 ANSI 码）
- [x] 项7：`logger.action()` 输出含 `[Action]`（实测：含工具名与参数 JSON）
- [x] 项8：`logger.final()` 输出含 `Final Answer` 分隔线
- [x] 项9：日志包含 ANSI 颜色码（cyan/magenta/green/red/yellow/gray）
- [x] 项10：`logger.error()` 输出到 stderr（console.error）
- [x] 项11：在 react-agent 中 verbose=false 时不输出任何日志（实测验证：捕获 console.log 确认无输出）
- [x] 项12：`npm run typecheck` 通过

### 额外验收（Task-05-1 项14/17）
- [x] Task-05-1 项14：MCP 工具出现在 System Prompt 中（实测：含 `memory-test__` 前缀工具）
- [x] Task-05-1 项17：MCP 工具含描述（实测：`memory-test__xxx：描述` 格式正确）

## 验证记录

```
测试A：buildSystemPrompt
  - 660 字符 prompt，含角色/工作模式/工具列表/描述/参数/规则
  - 空工具列表时含"无可用工具"提示

测试B：AgentLogger
  - step/thought/action/observation/final/error 全部正常输出
  - ANSI 颜色码正确（cyan/magenta/green/red/yellow/gray）
  - verbose=false 时无输出

测试C：集成 ReAct Agent
  - 读取 package.json → iterations=2，answer 含 "loop-agent-command"
  - 彩色日志完整展示 Thought/Action/Observation/Final

测试D：MCP 工具出现在 prompt
  - 注册 memory-test MCP server 后，prompt 含 memory-test__ 前缀工具
  - Task-05-1 项14/17 补齐验证

===== 结果: 19 通过 / 0 失败 =====
```

## 重构记录（2026-08-04）

根据用户意见进行重构：

### 1. prompt.ts 移除工具列表
- 原实现：`buildSystemPrompt(tools)` 在 prompt 里写工具名/描述/参数
- 新实现：`buildSystemPrompt()` 无参数，只含角色/工作模式/规则
- 工具 schema 由 OpenAI function calling 的 `tools` 参数暴露，避免冗余
- 保留 MCP 前缀 `{serverName}__` 使用指导

### 2. logger.ts 改为 AgentEvents 实现
- 原实现：`AgentLogger` 类，硬编码 step/thought/action 等方法
- 新实现：`ConsoleLogger` 类，实现 `AgentEvents` 接口（9 个钩子）
- 增加 `onLLMStream` 钩子，支持流式 Thought 实时输出
- 作为 `ReActAgent` 的默认 events，可通过 `verbose=false` 关闭

### 3. 验收清单调整
- 移除"Prompt 包含工具列表"相关验收项
- 新增"Prompt 不含工具名"验收项
- 新增"ConsoleLogger 实现 AgentEvents 接口"验收项

## 验收测试清单（重构后）

- [x] 项1：`buildSystemPrompt()` 返回字符串，不含工具名（实测：不含 commandRun/fileRead）
- [x] 项2：Prompt 包含"Thought / Action / Observation"工作模式说明
- [x] 项3：Prompt 包含"不需要工具时直接回答"规则
- [x] 项4：Prompt 包含"得到足够信息后必须给出最终答案"规则
- [x] 项5：Prompt 含 MCP 前缀 `{serverName}__` 使用指导
- [x] 项6：Prompt 说明工具 schema 由 function calling 协议暴露
- [x] 项7：`ConsoleLogger` 实现 `AgentEvents` 接口（9 个钩子）
- [x] 项8：`logger.onLLMStream()` 支持流式 Thought 输出
- [x] 项9：`logger.onToolStart()` 输出含 `[Action]`（含工具名与参数）
- [x] 项10：`logger.onFinal()` 输出含 `Final Answer` 分隔线
- [x] 项11：日志包含 ANSI 颜色码
- [x] 项12：`logger.onError()` 输出到 stderr
- [x] 项13：verbose=false 时无日志输出
- [x] 项14：`npm run typecheck` 通过

## 状态

- 状态：已完成（含重构）
- 更新时间：2026-08-04
- 负责人：Agent
- 依赖：Task-06（react-agent 调用）、types.ts（AgentEvents 接口）
- 备注：
  - System Prompt 移除工具列表，由 tools 参数负责 schema 暴露
  - logger 改为 AgentEvents 实现，支持流式 onLLMStream
  - ConsoleLogger 作为默认 events，可通过 verbose 关闭
