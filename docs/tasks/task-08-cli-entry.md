# Task-08：CLI 入口与使用示例

## 需求目标

实现 CLI 交互入口，支持用户输入问题、Agent 输出推理过程与答案，并提供使用示例文件。

### 目标清单
1. 实现 `src/index.ts`：CLI 交互式 REPL
2. 启动时自动注册内置工具
3. 支持单轮问答与多轮对话（保留上下文）
4. 实现 `examples/run.ts`：编程式调用示例
5. 支持 `Ctrl+C` / `exit` 优雅退出
6. 友好的启动提示与输入提示符

## 实现方案

### 1. src/index.ts

```typescript
import readline from 'node:readline';
import { agent } from './agent/react-agent.js';
import { registerBuiltinTools } from './tools/index.js';
import { logger } from './agent/logger.js';
import { config } from './config.js';

async function main() {
  registerBuiltinTools();

  console.log('=== ReAct Agent ===');
  console.log(`模型: ${config.modelName}`);
  console.log(`BaseURL: ${config.openaiBaseUrl}`);
  console.log('输入 exit 退出\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) return rl.prompt();
    if (['exit', 'quit', '退出'].includes(input.toLowerCase())) {
      rl.close();
      return;
    }
    try {
      const result = await agent.run(input, { verbose: true });
      console.log(`\n(共 ${result.iterations} 轮迭代)\n`);
    } catch (e) {
      logger.error(e instanceof Error ? e.message : String(e));
    }
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n再见！');
    process.exit(0);
  });
}

main().catch(e => {
  logger.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
```

### 2. examples/run.ts

```typescript
import { agent } from '../src/agent/react-agent.js';
import { registerBuiltinTools } from '../src/tools/index.js';

async function main() {
  registerBuiltinTools();

  const result = await agent.run('今天北京天气如何，以及 23 * 17 等于多少？', {
    verbose: true,
  });

  console.log('\n===== 结果汇总 =====');
  console.log('最终答案:', result.answer);
  console.log('迭代次数:', result.iterations);
  console.log('步骤数:', result.steps.length);
  console.log('步骤详情:', JSON.stringify(result.steps, null, 2));
}

main().catch(console.error);
```

### 3. CLI 交互流程

```
$ pnpm dev
=== ReAct Agent ===
模型: gpt-4o-mini
BaseURL: https://api.openai.com/v1
输入 exit 退出

> 今天北京天气如何，以及 23 * 17 等于多少？
[Thought] 用户问了两个问题...
[Action] weather({"city":"北京"})
[Observation] 北京今天晴，25℃
[Action] calculator({"expression":"23*17"})
[Observation] 23*17 = 391
[Thought] 现在可以综合回答了。
[Final] 北京今天晴，气温25℃；23*17=391。

(共 3 轮迭代)

> exit
再见！
```

### 4. 设计要点

- **REPL 模式**：用 `readline` 实现，无需第三方依赖
- **错误隔离**：单次输入出错不退出进程，打印错误后继续
- **优雅退出**：`exit` / `quit` / `退出` / `Ctrl+C` 均可退出
- **启动信息**：打印模型与 baseURL，便于确认配置正确
- **示例文件**：`examples/run.ts` 展示编程式调用，便于集成到其他项目

## 验收测试清单

- [x] 项1：`npm run dev` 启动后输出 Agent 横幅与模型信息（实测：黄色边框横幅 + 模型/BaseURL/最大迭代/内置工具）
- [x] 项2：输入问题后能流式输出 Thought / Action / Observation / Final 日志（示例1实测：逐字 Thought 前缀 + 品红 Action + 绿色 Observation + 绿色粗体 Final）
- [x] 项3：输入"exit"或"quit"或"退出"或"q"能正常退出
- [x] 项4：`Ctrl+C` 能正常退出并打印"再见！感谢使用 ReAct Agent 👋"（SIGINT 监听 + readline close）
- [x] 项5：空输入不触发 Agent 调用（trim 后 return，直接重新 prompt）
- [x] 项6：Agent 抛错时不退出进程，打印错误后继续等待输入（try/catch + finally resume prompt）
- [x] 项7：`examples/run.ts` 可通过 `npx tsx examples/run.ts` 运行（实测：exit 0 完成，3 个示例依次执行）
- [x] 项8：示例输出包含最终答案、迭代次数、步骤数（示例1：answer含项目名+版本、iterations=2、steps=1、messages=5条）
- [x] 项9：多轮对话场景（连续输入两个相关问题）能正常工作（示例2：Q1 问 name，Q2 追问 version → 模型直接复用历史"从刚才的 package.json 中可以看到…"，iterations=1，无新工具调用）
- [x] 项10：CLI 启动时自动注册 4 个内置工具（registerBuiltinTools 幂等，实测：commandRun/fileRead/fileWrite/grep）
- [x] 项11：`npm run typecheck`（tsc --noEmit）通过
- [x] 项12：启动横幅中说明环境变量配置说明（.env：OPENAI_API_KEY / OPENAI_BASE_URL / MODEL_NAME / MAX_ITERATIONS）

### 新增验收项（超出任务文档原范围）
- [x] 项13：CLI 额外命令 `/help`（重打帮助横幅）、`/reset`（清空多轮历史）、`/status`（消息数/工具数）、`/tools`（列出全部工具含 MCP 前缀标识）
- [x] 项14：Agent 新增 `resetSession()` / `getSessionMessages()` 公共 API，支持外部手动管理多轮上下文
- [x] 项15：AgentOptions 支持 `resetHistory`（本轮清空重来）和 `messages`（外部传入历史）两个多轮控制参数
- [x] 项16：AgentResult 含完整 `messages: ChatMessage[]`，便于调用方检查/持久化/续接

## 验证记录（实测 deepseek-v4-flash）

```
=========================== examples/run.ts 实测结果 ===========================

示例 1：基础单轮调用（读取 package.json）
  Thought: "好的，我来读取项目根目录下的 `package.json` 文件。"  ← ✅ 工具前自然语言说明生效
  Action:  fileRead({"path":"package.json"})
  Observation: 返回完整 package.json
  迭代 2：模型总结项目名=loop-agent-command，版本=0.1.0 → Final Answer
  汇总：iterations=2, steps=1, messages=5 条

示例 2：多轮对话（Q1 问 name，Q2 追问 version）
  Q1 结果：answer 含 "loop-agent-command" ✔
  Q2：无新工具调用（复用历史），Thought = "从刚才的 package.json 中可以看到，版本号是 0.1.0"
  自定义 thoughtCollector events：成功收集 Thought/ToolStart/ToolEnd 事件
  汇总：Q2 iterations=1, messages=7 条（含 Q1 历史 + Q2）

示例 3：自定义 events 结构化步骤记录（verbose=false，纯结构化）
  问题：grep src 目录 "buildSystemPrompt" 字符串
  structuredListener 收集：Step #1=grep(args=..., observationLen=231)
  最终答案：3 处命中，2 个文件（prompt.ts + react-agent.ts）
  汇总：工具步数=1，answer 前 200 字符完整可读

===== 退出码: 0（所有 3 个示例成功完成） =====
```

## 状态

- 状态：已完成（含多轮上下文 + 自定义 events + 工具前自然语言说明验证）
- 更新时间：2026-08-05
- 负责人：Agent
- 依赖：Task-02（types/config）、Task-04（工具系统）、Task-06（ReAct 循环 + events）、Task-07（Prompt + ConsoleLogger）
- 备注：
  - Agent 新增多轮能力：内部 `_chatHistory` 持久化 + `resetSession()` / `getSessionMessages()` API
  - AgentOptions 扩展：`resetHistory` / `messages` 外部控制
  - AgentResult 扩展：`messages` 完整上下文返回
  - CLI 新增命令：/help /reset /status /tools
  - 示例覆盖：单轮 verbose / 多轮无工具复用历史 / 自定义 events 结构化收集
  - ✅ 验证了新增提示词规则：模型在调用工具前先自然语言说明意图（Thought=「好的，我来读取…」 → Action=fileRead）
