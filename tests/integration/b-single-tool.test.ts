import { describe, it, expect, beforeAll } from 'vitest';
import { agent } from '../../src/agent/react-agent.js';
import { registerBuiltinTools } from '../../src/tools/index.js';

beforeAll(() => registerBuiltinTools());

describe('用例 B：单工具调用', () => {
  it('调用 fileRead 读 package.json，answer 含项目名或版本号', async () => {
    const result = await agent.run(
      '帮我读取项目根目录的 package.json，告诉我项目名称和版本号',
      { resetHistory: true, verbose: false },
    );

    expect(result.steps.length).toBeGreaterThanOrEqual(1);
    const toolNames = result.steps.map((s) => s.action?.tool);
    expect(toolNames).toContain('fileRead');
    expect(result.answer).toMatch(/loop-agent-command|0\.1\.0/);
  });
}, 60000);
