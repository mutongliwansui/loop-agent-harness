/**
 * ReAct Agent 编程式调用示例
 * ===========================
 * 运行方式：
 *   # 先确保 .env 中已配置 OPENAI_API_KEY / OPENAI_BASE_URL / MODEL_NAME
 *   npx tsx examples/run.ts
 *
 * 本示例演示三种用法：
 *   1. 基础单轮调用（verbose 日志全开）
 *   2. 多轮对话（自动持久化历史，无需手动传 messages）
 *   3. 自定义 events 监听器（参考 langchain callbacks 扩展点）
 */
import { agent } from '../src/agent/react-agent.js';
import { registerBuiltinTools } from '../src/tools/index.js';
import type { AgentEvents, AgentStep } from '../src/types.js';

/** 注册内置工具（幂等，每个进程只需调用一次） */
registerBuiltinTools();

/** ==============================
 *  示例 1：基础单轮调用
 *  ============================== */
async function example1_BasicSingleRound() {
  console.log('\n========== 示例 1：基础单轮调用（读取 package.json） ==========\n');
  // resetHistory=true 确保每次运行示例都从干净的会话开始
  const result = await agent.run('帮我读取项目根目录下的 package.json，告诉我项目名称和版本号', {
    resetHistory: true,
    verbose: true,
  });

  console.log('\n--- 结果汇总 ---');
  console.log('最终答案 :', result.answer);
  console.log('迭代次数 :', result.iterations);
  console.log('工具步数 :', result.steps.length);
  console.log('消息历史 :', result.messages.length, '条');
}

/** ==============================
 *  示例 2：多轮对话（自动保留上下文）
 *  ============================== */
async function example2_MultiTurn() {
  console.log('\n========== 示例 2：多轮对话 ==========\n');
  // 第一轮：先问 package.json 的 name
  const r1 = await agent.run('先看看 package.json 里项目叫什么名字？', {
    resetHistory: true, // 开启新一轮多轮会话
    verbose: false,
  });
  console.log('[Q1 结果] 答案含项目名？', r1.answer.includes('loop-agent-command') ? '是' : '否');

  // 第二轮：继续追问 version —— 无需显式传 messages，agent 内部自动复用历史
  // 同时用自定义 events 把 Thought 内容收集起来（不依赖 verbose 日志打印）
  const collected: string[] = [];
  const thoughtCollector: AgentEvents = {
    onLLMEnd(resp) {
      if (resp.content) collected.push(`[Thought] ${resp.content}`);
    },
    onToolStart(tool, args) {
      collected.push(`[ToolStart] ${tool}(${JSON.stringify(args)})`);
    },
    onToolEnd(tool, result) {
      const short = result.length > 80 ? result.slice(0, 80) + '...' : result;
      collected.push(`[ToolEnd] ${tool} → ${short.replace(/\n/g, '\\n')}`);
    },
  };

  const r2 = await agent.run('那它的版本号是多少？', {
    verbose: false,
    events: [thoughtCollector],
  });

  console.log('\n--- 多轮 Q2 结果 ---');
  console.log('最终答案 :', r2.answer);
  console.log('迭代次数 :', r2.iterations);
  console.log('消息数   :', r2.messages.length, '（含 Q1 历史 + Q2）');
  console.log('\n--- 收集到的 Thought/Tool 事件 ---');
  for (const c of collected) console.log(' •', c);
}

/** ==============================
 *  示例 3：自定义 events 监听器（步骤级结构化记录）
 *  ============================== */
async function example3_CustomEvents() {
  console.log('\n========== 示例 3：自定义 events 监听器（结构化步骤记录） ==========\n');

  interface StepRecord {
    index: number;
    tool?: string;
    args?: Record<string, unknown>;
    observationLength?: number;
  }
  const stepRecords: StepRecord[] = [];
  const finalAnswer = { value: '' };
  let idx = 0;

  const structuredListener: AgentEvents = {
    onToolStart(tool, args) {
      stepRecords.push({ index: ++idx, tool, args });
    },
    onToolEnd(tool, result) {
      const rec = stepRecords.find((r) => r.tool === tool && !r.observationLength);
      if (rec) rec.observationLength = result.length;
    },
    onFinal(answer) {
      finalAnswer.value = answer;
    },
  };

  await agent.run(
    '使用 grep 工具在项目 src 目录下查找包含 "buildSystemPrompt" 字符串的文件，列出匹配文件与命中行，并告诉我总共有多少处命中。',
    {
      resetHistory: true,
      verbose: false, // 关闭默认彩色日志，全部通过 structuredListener 收集
      events: [structuredListener],
    },
  );

  console.log('\n--- 结构化步骤记录 ---');
  for (const rec of stepRecords) {
    const argsStr = rec.args ? JSON.stringify(rec.args).slice(0, 70) : '(无参数)';
    console.log(
      `  Step #${rec.index}: ${rec.tool}  args=${argsStr}  observationLen=${rec.observationLength ?? 0}`,
    );
  }
  console.log('\n--- 最终答案（前 200 字符）---\n', finalAnswer.value.slice(0, 200));
  console.log('\n--- 总工具步数:', stepRecords.length);
}

/** 主函数：按顺序运行三个示例 */
async function main() {
  try {
    await example1_BasicSingleRound();
    await example2_MultiTurn();
    await example3_CustomEvents();
    console.log('\n✅ 所有示例运行完成！');
  } catch (e) {
    const msg = e instanceof Error ? e.stack ?? e.message : String(e);
    console.error('\n❌ 示例运行失败:\n', msg);
    process.exit(1);
  }
}

// 支持作为脚本直接运行
if (process.argv[1] && process.argv[1].endsWith('run.ts')) {
  void main();
}

// 允许被其他文件 import（示例：import { example1_BasicSingleRound } from './examples/run.ts'）
export { example1_BasicSingleRound, example2_MultiTurn, example3_CustomEvents };
export type { AgentStep };
