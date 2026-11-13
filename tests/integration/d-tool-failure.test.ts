import { it, expect, beforeAll } from 'vitest';
import { agent } from '../../src/agent/react-agent.js';
import { registerBuiltinTools } from '../../src/tools/index.js';
import { describeLiveModel } from './live-model-gate.js';

beforeAll(() => registerBuiltinTools());

describeLiveModel('用例 D：工具失败容错', () => {
  it('读取不存在文件时 Agent 不崩溃，Observation 含错误信息', async () => {
    const result = await agent.run(
      '请读取 /nonexistent__abc__123.json 文件的完整内容',
      { resetHistory: true, verbose: false },
    );

    // Agent 应给出回复
    expect(result.answer.length).toBeGreaterThan(0);
    // steps 中应有调用记录
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
    // observation 应包含错误关键词
    const hasErrorObs = result.steps.some(
      (s) =>
        s.observation &&
        (s.observation.includes('ENOENT') ||
          s.observation.includes('no such file') ||
          s.observation.includes('不存在') ||
          s.observation.includes('错误') ||
          s.observation.includes('失败')),
    );
    expect(hasErrorObs).toBe(true);
  });
}, 60000);
