import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { agent } from '../../src/agent/react-agent.js';
import { registerBuiltinTools } from '../../src/tools/index.js';
import { llm } from '../../src/llm/client.js';

beforeAll(() => registerBuiltinTools());

afterEach(() => {
  vi.restoreAllMocks();
});

describe('用例 E：不存在的工具（mock LLM）', () => {
  it('LLM 返回未注册工具名时，Observation 含错误信息，Agent 能继续', async () => {
    let callCount = 0;

    vi.spyOn(llm, 'chatStream').mockImplementation(async function* () {
      callCount++;
      if (callCount === 1) {
        // 第一次：返回未注册工具调用
        yield {
          type: 'done' as const,
          response: {
            content: '我需要调用工具来处理',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function' as const,
                function: { name: 'nonExistentTool', arguments: '{}' },
              },
            ],
            finish_reason: 'tool_calls',
          },
        };
      } else {
        // 第二次：返回最终答案
        yield {
          type: 'done' as const,
          response: {
            content: '抱歉，该工具不存在，无法完成请求。',
            finish_reason: 'stop',
          },
        };
      }
    });

    const result = await agent.run('测试不存在的工具', {
      resetHistory: true,
      verbose: false,
    });

    // 第一轮应调用 nonExistentTool
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
    expect(result.steps[0].action?.tool).toBe('nonExistentTool');
    // observation 应含错误信息
    expect(result.steps[0].observation).toMatch(
      /不存在|未注册|nonExistent|错误|找不到|not found/i,
    );
    // 最终应有答案
    expect(result.answer.length).toBeGreaterThan(0);
  });
}, 30000);
