import { describe, it, expect, beforeAll } from 'vitest';
import { agent } from '../../src/agent/react-agent.js';
import { registerBuiltinTools } from '../../src/tools/index.js';

beforeAll(() => registerBuiltinTools());

describe('用例 A：无工具直接回答', () => {
  it('iterations=1, steps 为空, answer 非空', async () => {
    const result = await agent.run('你好，请用一句话介绍你自己', {
      resetHistory: true,
      verbose: false,
    });

    expect(result.iterations).toBe(1);
    expect(result.steps.length).toBe(0);
    expect(result.answer.length).toBeGreaterThan(0);
  });
}, 60000);
