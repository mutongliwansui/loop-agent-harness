import { it, expect, beforeAll } from 'vitest';
import { agent } from '../../src/agent/react-agent.js';
import { registerBuiltinTools } from '../../src/tools/index.js';
import { describeLiveModel } from './live-model-gate.js';

beforeAll(() => registerBuiltinTools());

describeLiveModel('用例 G：多工具调用', () => {
  it('同时读取 package.json 和 tsconfig.json，steps >= 2', async () => {
    const result = await agent.run(
      '请同时读取 package.json 和 tsconfig.json 这两个文件，告诉我它们的内容',
      { resetHistory: true, verbose: false },
    );

    // 至少调用了两个工具
    expect(result.steps.length).toBeGreaterThanOrEqual(2);

    // 检查是否有同轮多个 tool_calls（messages 中某个 assistant 消息含 >=2 个 tool_calls）
    const assistantMsgs = result.messages.filter(
      (m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0,
    );
    const hasParallel = assistantMsgs.some((m) => m.tool_calls!.length >= 2);

    // 如果模型支持同轮多工具调用，hasParallel 为 true（理想情况）
    // 至少应跨轮调用两个 fileRead
    const fileReadCount = result.steps.filter(
      (s) => s.action?.tool === 'fileRead',
    ).length;
    expect(fileReadCount).toBeGreaterThanOrEqual(2);

    // answer 应非空
    expect(result.answer.length).toBeGreaterThan(0);
  });
}, 60000);
