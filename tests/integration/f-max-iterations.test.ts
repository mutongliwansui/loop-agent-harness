import { describe, it, expect, beforeAll } from 'vitest';
import { agent } from '../../src/agent/react-agent.js';
import { registerBuiltinTools } from '../../src/tools/index.js';

beforeAll(() => registerBuiltinTools());

describe('用例 F：达到最大迭代次数', () => {
  it('maxIterations=1 时抛出"达到最大迭代次数"错误', async () => {
    await expect(
      agent.run(
        '请先用 grep 搜索 src 目录中的 buildSystemPrompt，然后读取所有匹配文件的内容，再总结一下',
        {
          resetHistory: true,
          maxIterations: 1,
          verbose: false,
        },
      ),
    ).rejects.toThrow(/达到最大迭代次数/);
  });
}, 60000);
