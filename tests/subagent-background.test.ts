/**
 * 20261107-002：后台子 Agent 端到端接线测试（mock LLM）
 *
 * 覆盖：
 * - delegate({background:true}) 立即返回提交提示，不阻塞主 Agent（D5/D6）
 * - 过程事件以 taskId 作为 callId 转发（D2），并装配出轨迹（D3）
 * - 完成后走 onSubAgentComplete 回调（API 层据此落盘结果卡片，D8）
 * - 子 Agent 执行完了主 Agent 才结束 → 主对话最终回答正确
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReActAgent } from '../src/agent/react-agent.js';
import { ConfigLoader } from '../src/config/index.js';
import { registerBuiltinTools } from '../src/tools/index.js';
import { registry } from '../src/tools/registry.js';
import { subAgentRegistry } from '../src/agent/subagent-registry.js';
import type { ChatMessage, SubAgentCompleteInfo, SubAgentEventInfo } from '../src/types.js';

const mocks = vi.hoisted(() => ({
  chatStream: vi.fn(),
}));

vi.mock('../src/llm/client.js', () => ({
  llm: {
    chat: async () => ({ content: null }),
    chatStream: async function* (...args: unknown[]) {
      yield* mocks.chatStream(...args);
    },
  },
  LLMClient: class {},
}));

const BASE = join(tmpdir(), 'loop-agent-tests', 'subagent-background');

function writeWorkspaceConfig(wsDir: string): void {
  mkdirSync(join(wsDir, 'global'), { recursive: true });
  writeFileSync(
    join(wsDir, 'global', 'config.json'),
    JSON.stringify({
      skill: { enabled: false },
      session: { autoSave: false, autoRestore: false },
      model: { name: 'test-model', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', temperature: 0 },
      agent: {
        verbose: false,
        showTokenStats: false,
        llmLogEnabled: false,
        maxIterations: 5,
        subAgent: { background: true, maxConcurrent: 3 },
      },
      memory: { enabled: false },
    }),
    'utf-8',
  );
}

/** 取最后一条 user 消息文本，用于区分「父 Agent」与「子 Agent」的 LLM 调用 */
function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') return m.content ?? '';
  }
  return '';
}

beforeAll(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(BASE, { recursive: true, force: true });
  } catch {
    // Windows 下句柄释放延迟
  }
});

beforeEach(() => {
  registry.clear();
  subAgentRegistry.reset();
  mocks.chatStream.mockReset();
});

describe('后台子 Agent 端到端接线', () => {
  it('提交即返回，完成走回调，事件按 taskId 归属', async () => {
    registerBuiltinTools();
    const wsDir = join(BASE, 'ok');
    writeWorkspaceConfig(wsDir);
    const agent = new ReActAgent(new ConfigLoader(join(wsDir, 'global')));
    agent.setWorkspaceRoot(wsDir);

    const events: SubAgentEventInfo[] = [];
    const completed = new Promise<SubAgentCompleteInfo>((resolve) => {
      let parentCalls = 0;
      mocks.chatStream.mockImplementation(async function* (messages: ChatMessage[]) {
        const userText = lastUserText(messages);
        // 子 Agent：任务描述里带标记
        if (userText.includes('后台任务B')) {
          yield { type: 'delta', content: '后台结论B' };
          yield {
            type: 'done',
            response: {
              content: '后台结论B',
              finish_reason: 'stop',
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              iterations: 1,
              max_iterations: 5,
              elapsed_ms: 1,
            },
          };
          return;
        }
        parentCalls += 1;
        if (parentCalls === 1) {
          yield {
            type: 'done',
            response: {
              content: null,
              finish_reason: 'tool_calls',
              tool_calls: [
                {
                  id: 'call_bg',
                  type: 'function',
                  function: {
                    name: 'delegate',
                    arguments: JSON.stringify({ task: '后台任务B', background: true }),
                  },
                },
              ],
            },
          };
          return;
        }
        yield { type: 'delta', content: '主 Agent 完成' };
        yield { type: 'done', response: { content: '主 Agent 完成', finish_reason: 'stop' } };
      });

      void agent.run('并行处理', {
        verbose: false,
        resetHistory: true,
        onSubAgentEvent: (info) => events.push(info),
        onSubAgentComplete: (info) => resolve(info),
      });
    });

    const info = await completed;
    expect(info.status).toBe('done');
    expect(info.answer).toBe('后台结论B');
    expect(info.taskId).toMatch(/^sub_/);
    expect(info.trace?.iterations).toBeGreaterThanOrEqual(1);
    expect(info.trace?.final).toContain('后台结论B');

    // 提交事件与完成事件都以 taskId 作为 callId（同一归属）
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.callId === info.taskId)).toBe(true);
    expect(events[0].phase).toBe('start');

    // 注册表已收敛
    expect(subAgentRegistry.get(info.taskId)?.status).toBe('done');
    expect(subAgentRegistry.countRunning()).toBe(0);

    agent.dispose();
  });

  it('配置关闭后台 → 返回错误提示，不登记任务（D5 兜底）', async () => {
    registerBuiltinTools();
    const wsDir = join(BASE, 'disabled');
    writeWorkspaceConfig(wsDir);
    // 直接把配置改成关闭（writeWorkspaceConfig 后覆写）
    writeFileSync(
      join(wsDir, 'global', 'config.json'),
      JSON.stringify({
        skill: { enabled: false },
        session: { autoSave: false, autoRestore: false },
        model: { name: 'test-model', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test' },
        agent: {
          verbose: false,
          showTokenStats: false,
          llmLogEnabled: false,
          maxIterations: 5,
          subAgent: { background: false, maxConcurrent: 3 },
        },
        memory: { enabled: false },
      }),
      'utf-8',
    );
    const agent = new ReActAgent(new ConfigLoader(join(wsDir, 'global')));
    agent.setWorkspaceRoot(wsDir);

    let observation = '';
    let parentCalls = 0;
    mocks.chatStream.mockImplementation(async function* (messages: ChatMessage[]) {
      parentCalls += 1;
      if (parentCalls === 1) {
        yield {
          type: 'done',
          response: {
            content: null,
            finish_reason: 'tool_calls',
            tool_calls: [
              {
                id: 'call_bg2',
                type: 'function',
                function: {
                  name: 'delegate',
                  arguments: JSON.stringify({ task: '后台任务B', background: true }),
                },
              },
            ],
          },
        };
        return;
      }
      const toolMsg = messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_bg2');
      observation = toolMsg?.content ?? '';
      yield { type: 'delta', content: '结束' };
      yield { type: 'done', response: { content: '结束', finish_reason: 'stop' } };
    });

    await agent.run('试试', { verbose: false, resetHistory: true });
    expect(observation).toContain('配置已关闭后台子任务');
    expect(subAgentRegistry.countRunning()).toBe(0);
    agent.dispose();
  });
});
