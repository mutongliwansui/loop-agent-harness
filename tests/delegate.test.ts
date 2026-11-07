/**
 * 20261107-001：子 Agent 委托（delegate）单元测试
 *
 * 覆盖：
 * - delegate 工具：正常传参（task/context）并返回子 Agent answer
 * - delegate 工具：task 为空 / ctx.runSubAgent 缺失 → 降级返回错误字符串（不抛异常）
 * - delegate 已注册进内置工具集（/tools 可见、可被配置禁用）
 * - ReActAgent.run：excludeTools 从传给 LLM 的 tools 列表中剔除
 * - ReActAgent.run：LLM 幻觉调用被排除工具时返回「不可用」而非递归执行（D4）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { delegate } from '../src/tools/delegate.js';
import { registerBuiltinTools } from '../src/tools/index.js';
import { registry } from '../src/tools/registry.js';
import { ReActAgent } from '../src/agent/react-agent.js';
import { ConfigLoader } from '../src/config/index.js';
import type { ChatMessage } from '../src/types.js';

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

const BASE = join(tmpdir(), 'loop-agent-tests', 'delegate');

function writeWorkspaceConfig(wsDir: string): void {
  mkdirSync(join(wsDir, '.loop-agent'), { recursive: true });
  writeFileSync(
    join(wsDir, '.loop-agent', '.agent-config.json'),
    JSON.stringify({
      skill: { enabled: false },
      session: { autoSave: false, autoRestore: false },
      model: { name: 'test-model', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test', temperature: 0 },
      agent: { verbose: false, showTokenStats: false, llmLogEnabled: false, maxIterations: 5 },
      memory: { enabled: false },
    }),
    'utf-8',
  );
}

/** 完成一次「无工具调用」的流式响应 */
function mockFinalAnswer(answer: string): void {
  mocks.chatStream.mockImplementation(async function* () {
    yield { type: 'delta', content: answer };
    yield {
      type: 'done',
      response: {
        content: answer,
        finish_reason: 'stop',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        iterations: 1,
        max_iterations: 5,
        elapsed_ms: 1,
      },
    };
  });
}

describe('delegate 工具', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('把 task/context 透传给 runSubAgent，返回子 Agent 的 answer', async () => {
    const calls: Array<{ task: string; opts?: { context?: string; background?: boolean; callId?: string } }> = [];
    const out = await delegate.execute(
      { task: '  调研记忆系统  ', context: '  项目用三层记忆  ' },
      {
        runSubAgent: async (task, opts) => {
          calls.push({ task, opts });
          return { answer: '子 Agent 结论', iterations: 3 };
        },
      },
    );
    expect(out).toBe('子 Agent 结论');
    expect(calls).toHaveLength(1);
    expect(calls[0].task).toBe('调研记忆系统');
    expect(calls[0].opts?.context).toBe('项目用三层记忆');
  });

  it('task 为空 → 返回错误字符串且不调用 runSubAgent', async () => {
    const runSubAgent = vi.fn();
    const out = await delegate.execute({ task: '   ' }, { runSubAgent });
    expect(out).toContain('非空的 task');
    expect(runSubAgent).not.toHaveBeenCalled();
  });

  it('未注入 runSubAgent（CLI/脱离 Agent 调用）→ 降级报错，不抛异常', async () => {
    const out = await delegate.execute({ task: 'x' }, {});
    expect(out).toContain('不支持子 Agent 委托');
  });

  it('background=true 透传，并回写提交提示与 taskId（20261107-002 D5/D6）', async () => {
    const calls: Array<{ task: string; opts?: { background?: boolean; callId?: string } }> = [];
    const out = await delegate.execute(
      { task: '并行调研 A', background: true },
      {
        callId: 'call_abc',
        runSubAgent: async (task, opts) => {
          calls.push({ task, opts });
          return {
            answer: '⏳ 已提交后台子任务 sub_1：并行调研 A',
            iterations: 0,
            taskId: 'sub_1',
            background: true,
          };
        },
      },
    );
    expect(out).toContain('sub_1');
    expect(calls[0].opts?.background).toBe(true);
    // D2：callId 由 runner 注入 ctx，delegate 必须原样透传用于过程事件归属
    expect(calls[0].opts?.callId).toBe('call_abc');
  });

  it('缺省 background=false（保持同步阻塞语义）', async () => {
    const optsSeen: Array<{ background?: boolean }> = [];
    await delegate.execute({ task: '同步任务' }, {
      runSubAgent: async (_task, opts) => {
        optsSeen.push(opts ?? {});
        return { answer: 'ok', iterations: 1 };
      },
    });
    expect(optsSeen[0].background).toBe(false);
  });

  it('超时上限高于普通工具（子 Agent 需跑完整个 ReAct 链）', () => {
    expect(delegate.timeoutMs).toBeGreaterThanOrEqual(300000);
    expect(delegate.name).toBe('delegate');
  });
});

describe('内置工具注册与 excludeTools', () => {
  beforeAll(() => {
    rmSync(BASE, { recursive: true, force: true });
    mkdirSync(BASE, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(BASE, { recursive: true, force: true });
    } catch {
      // Windows 下句柄释放延迟，残留临时目录不影响结果
    }
  });

  beforeEach(() => {
    registry.clear();
    mocks.chatStream.mockReset();
  });

  it('delegate 已注册进内置工具集', () => {
    const names = registerBuiltinTools();
    expect(names).toContain('delegate');
    expect(registry.has('delegate')).toBe(true);
  });

  it('excludeTools: delegate 不出现在传给 LLM 的 tools 列表', async () => {
    registerBuiltinTools();
    mockFinalAnswer('直接回答');
    const wsDir = join(BASE, 'exclude');
    writeWorkspaceConfig(wsDir);
    const agent = new ReActAgent(new ConfigLoader(wsDir, join(wsDir, 'global')));
    agent.setWorkspaceRoot(wsDir);
    let seenTools: Array<{ function: { name: string } }> = [];
    mocks.chatStream.mockImplementation(async function* (_messages: ChatMessage[], tools: Array<{ function: { name: string } }>) {
      seenTools = tools ?? [];
      yield { type: 'delta', content: '直接回答' };
      yield {
        type: 'done',
        response: { content: '直接回答', finish_reason: 'stop' },
      };
    });
    await agent.run('你好', { excludeTools: ['delegate'], verbose: false, resetHistory: true });
    const toolNames = seenTools.map((t) => t.function.name);
    expect(toolNames).not.toContain('delegate');
    expect(toolNames).toContain('fileRead');
    agent.dispose();
  });

  it('LLM 幻觉调用被排除工具 → 返回「不可用」且不递归执行（D4）', async () => {
    registerBuiltinTools();
    const wsDir = join(BASE, 'hallucinate');
    writeWorkspaceConfig(wsDir);
    const agent = new ReActAgent(new ConfigLoader(wsDir, join(wsDir, 'global')));
    agent.setWorkspaceRoot(wsDir);
    let secondCallMessages: ChatMessage[] = [];
    let call = 0;
    mocks.chatStream.mockImplementation(async function* (messages: ChatMessage[]) {
      call += 1;
      if (call === 1) {
        yield {
          type: 'done',
          response: {
            content: null,
            finish_reason: 'tool_calls',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'delegate', arguments: '{"task":"x"}' } },
            ],
          },
        };
        return;
      }
      secondCallMessages = messages;
      yield { type: 'delta', content: '收到' };
      yield { type: 'done', response: { content: '收到', finish_reason: 'stop' } };
    });
    await agent.run('试试', { excludeTools: ['delegate'], verbose: false, resetHistory: true });
    const toolMsg = secondCallMessages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('不可用');
    expect(call).toBe(2);
    agent.dispose();
  });
});
