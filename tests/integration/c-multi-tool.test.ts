import { it, expect, beforeAll } from 'vitest';
import { agent } from '../../src/agent/react-agent.js';
import { registerBuiltinTools } from '../../src/tools/index.js';
import { describeLiveModel } from './live-model-gate.js';

beforeAll(() => registerBuiltinTools());

describeLiveModel('用例 C：多工具顺序调用', () => {
  it('先 grep 搜索再 fileRead 读取，steps >= 2', async () => {
    const result = await agent.run(
      '先用 grep 在 src 目录搜索包含 buildSystemPrompt 的文件，然后读取其中一个匹配的文件，告诉我 buildSystemPrompt 函数的定义',
      { resetHistory: true, verbose: false },
    );

    expect(result.steps.length).toBeGreaterThanOrEqual(2);
    const toolNames = result.steps.map((s) => s.action?.tool);
    expect(toolNames).toContain('grep');
    expect(result.answer.length).toBeGreaterThan(0);
  });
}, 60000);
