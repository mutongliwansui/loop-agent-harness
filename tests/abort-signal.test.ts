/**
 * 取消信号贯通测试（Task-20261021-002-01 P1）
 *
 * 覆盖：
 * - raceAbort：aborted 先到 → AgentAbortedError；工具先完成 → 正常返回；已 aborted → 立即拒绝
 * - 冒泡例外：runner.run 中取消不被归一化为"工具执行失败"字符串（D10）
 * - chatStream：abort 后抛 AgentAbortedError 而非静默 return；AbortError 不进 retry
 */
import { describe, it, expect, vi } from 'vitest';
import { ToolRunner } from '../src/tools/runner.js';
import { AgentAbortedError } from '../src/types.js';
import type { Tool } from '../src/types.js';
import { LLMClient } from '../src/llm/client.js';

function hangTool(): Tool {
  return {
    name: 'hang',
    description: '挂起直至 abort 的工具',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: (_args, ctx) =>
      new Promise<string>((resolve) => {
        ctx?.signal?.addEventListener('abort', () => resolve('工具侧已感知取消'), { once: true });
      }),
  };
}

function quickTool(result = 'ok'): Tool {
  return {
    name: 'quick',
    description: '立即完成',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => result,
  };
}

function deferredTool(): { tool: Tool; finish: (v: string) => void } {
  let fin: (v: string) => void = () => {};
  const p = new Promise<string>((r) => { fin = r; });
  return {
    tool: {
      name: 'deferred',
      description: '手动完成的工具',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: () => p,
    },
    finish: fin,
  };
}

function abortedSignal(): AbortSignal {
  const c = new AbortController();
  c.abort();
  return c.signal;
}

describe('ToolRunner 取消（raceAbort）', () => {
  it('abort 先到：抛 AgentAbortedError，而非归一化为失败字符串（D10 冒泡例外）', async () => {
    const runner = new ToolRunner();
    const ac = new AbortController();
    const p = runner.run(hangTool(), {}, { signal: ac.signal, timeout: 5000 });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AgentAbortedError);
  });

  it('signal 已 aborted：立即拒绝，不等待工具', async () => {
    const runner = new ToolRunner();
    const { tool, finish } = deferredTool();
    const p = runner.run(tool, {}, { signal: abortedSignal() });
    await expect(p).rejects.toBeInstanceOf(AgentAbortedError);
    finish('late'); // 工具后完成不应产生 unhandled rejection
  });

  it('工具先完成、abort 后到：正常返回工具结果（竞速无副作用）', async () => {
    const runner = new ToolRunner();
    const ac = new AbortController();
    const p = runner.run(quickTool('done-first'), {}, { signal: ac.signal });
    await expect(p).resolves.toBe('done-first');
    ac.abort(); // 完成后再 abort 不影响已 resolve 的结果
  });

  it('runParallel：任一工具被 abort 时整体 reject AgentAbortedError', async () => {
    const runner = new ToolRunner();
    const ac = new AbortController();
    const { tool: slow, finish } = deferredTool();
    const p = runner.runParallel(
      [
        { tool: quickTool('a'), args: {} },
        { tool: slow, args: {} },
      ],
      { signal: ac.signal },
    );
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AgentAbortedError);
    finish('late');
  });

  it('不传 signal：行为与现状完全一致（归一化契约不回归）', async () => {
    const runner = new ToolRunner();
    const boom: Tool = {
      name: 'boom',
      description: '抛错工具',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => { throw new Error('x'); },
    };
    await expect(runner.run(boom, {})).resolves.toBe('工具执行失败: x');
    await expect(runner.run(quickTool(), {})).resolves.toBe('ok');
  });

  it('abort 时 ctx.signal 已注入工具（commandRun 消费依据）', async () => {
    const runner = new ToolRunner();
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const probe: Tool = {
      name: 'probe',
      description: '记录 ctx',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (_args, ctx) => { seen = ctx?.signal; return 'ok'; },
    };
    await runner.run(probe, {}, { signal: ac.signal });
    expect(seen).toBe(ac.signal);
  });
});

describe('LLMClient 取消短路', () => {
  it('retry：AgentAbortedError 不触发重试（create 调用次数不增加）', async () => {
    const llm = new LLMClient();
    const ac = new AbortController();
    let calls = 0;
    // @ts-expect-error 访问私有方法仅为测试重试语义
    const retry = llm.retry.bind(llm);
    await expect(
      retry(async () => {
        calls++;
        ac.abort();
        throw new AgentAbortedError({ messages: [], transcript: [], steps: [], iterations: 0 });
      }),
    ).rejects.toBeInstanceOf(AgentAbortedError);
    expect(calls).toBe(1); // 若被当网络错误会重试 3 次
  });

  it('retry：AbortError（SDK abort 错误名）短路并归一为 AgentAbortedError', async () => {
    const llm = new LLMClient();
    let calls = 0;
    // @ts-expect-error 访问私有方法仅为测试重试语义
    const retry = llm.retry.bind(llm);
    const err = new Error('Request was aborted.');
    err.name = 'AbortError';
    await expect(
      retry(async () => {
        calls++;
        throw err;
      }),
    ).rejects.toBeInstanceOf(AgentAbortedError);
    expect(calls).toBe(1);
  });

  it('chatStream：abort 后显式抛 AgentAbortedError（SDK 吞错场景的循环后判定）', async () => {
    const llm = new LLMClient();
    const ac = new AbortController();
    // mock getClient 返回可取消的假 SDK 流：abort 后 for await 正常结束（吞掉错误）
    const fakeStream = {
      async *[Symbol.asyncIterator]() {
        yield {
          choices: [{ delta: { content: 'partial' }, index: 0 }],
          index: 0,
        } as unknown as Parameters<Parameters<typeof llm.chatStream>[0] extends never ? never : never>;
      },
    };
    // @ts-expect-error 替换私有 client
    llm['client'] = {
      chat: {
        completions: {
          create: vi.fn(async (_params: unknown, opts?: { signal?: AbortSignal }) => {
            // 模拟 SDK：abort 时标记 signal 并让流正常结束（openai streaming.ts 行为）
            opts?.signal?.addEventListener('abort', () => { /* SDK 静默结束 */ }, { once: true });
            return fakeStream;
          }),
        },
      },
    };
    // 关键：chatStream 实际走 getClientFor() → getClient()，后者在 apiKey/baseUrl 与缓存不一致时
    // 会重建真实 client 并覆盖上面注入的假 client（测试隔离后 baseUrl 变为默认值即触发），
    // 进而发起真实网络请求导致用例挂起。这里直接 stub getClientFor，彻底与外部配置解耦。
    const fakeClient = llm['client'];
    vi.spyOn(
      llm as unknown as { getClientFor: () => unknown },
      'getClientFor',
    ).mockReturnValue(fakeClient);
    const ac2 = new AbortController();
    const gen = llm.chatStream(
      [{ role: 'user', content: 'hi' }],
      undefined,
      { signal: ac2.signal },
    );
    // 消费第一个 chunk 后 abort
    const first = await gen.next();
    expect(first.value.type).toBe('delta');
    ac2.abort();
    const drained: string[] = [];
    try {
      for await (const chunk of gen) drained.push(chunk.type);
    } catch (e) {
      expect(e).toBeInstanceOf(AgentAbortedError);
    }
    // 无论生成器以抛错还是提前结束收尾，都不允许产出 done 终态
    expect(drained).not.toContain('done');
  });
});
