import { createHost, createRootContext, type EventMapBase } from '@loop-agent/core';
import { describe, expect, it } from 'vitest';

import {
  defineLlmProvider,
  defineLlmProviderFactory,
  installLlm,
  LlmConfigError,
  LLM_SERVICE_KEYS,
  type LlmRegistry,
} from '../src/index.js';
import { FakeProvider } from './helpers.js';

/** 挂载 installLlm 并返回上下文 */
async function setup() {
  const host = createHost<EventMapBase>();
  const ctx = createRootContext<EventMapBase>(host);
  const fiber = ctx.plugin(installLlm());
  await fiber.ready();
  return { host, ctx };
}

describe('defineLlmProvider 校验', () => {
  it('id 为空字符串 → 抛 LlmConfigError', () => {
    expect(() => defineLlmProvider({ id: '', create: () => new FakeProvider() })).toThrow(
      LlmConfigError,
    );
  });

  it('id 仅空白 → 抛 LlmConfigError', () => {
    expect(() => defineLlmProvider({ id: '   ', create: () => new FakeProvider() })).toThrow(
      /非空字符串/,
    );
  });

  it('id 含冒号 → 抛 LlmConfigError（会破坏服务 key 分段）', () => {
    expect(() => defineLlmProvider({ id: 'a:b', create: () => new FakeProvider() })).toThrow(
      /不得包含冒号/,
    );
  });

  it('create 非函数 → 抛 LlmConfigError', () => {
    expect(() =>
      defineLlmProvider({
        id: 'x',
        // @ts-expect-error 故意传错类型以验证运行期校验
        create: 'not-a-function',
      }),
    ).toThrow(/必须是函数/);
  });

  it('校验在工厂阶段同步发生（不必等到挂载）', () => {
    expect(() => defineLlmProviderFactory({ id: '', create: () => new FakeProvider() })).toThrow(
      LlmConfigError,
    );
  });
});

describe('defineLlmProvider 产出的插件对象', () => {
  it('带硬依赖 inject.required = [llm:registry]', () => {
    const plugin = defineLlmProvider({ id: 'p', create: () => new FakeProvider('p') });
    expect(plugin.inject).toEqual({ required: [LLM_SERVICE_KEYS.registry] });
  });

  it('name 为 llm-provider:<id>', () => {
    const plugin = defineLlmProvider({ id: 'p', create: () => new FakeProvider('p') });
    expect(plugin.name).toBe('llm-provider:p');
  });
});

describe('defineLlmProvider 挂载到目录', () => {
  it('挂载后目录可取到 provider，且 llm:provider:<id> 服务存在', async () => {
    const { ctx } = await setup();
    const provider = new FakeProvider('p1');

    const fiber = ctx.plugin(defineLlmProvider({ id: 'p1', create: () => provider }));
    await fiber.ready();

    const registry = ctx.get<LlmRegistry>(LLM_SERVICE_KEYS.registry);
    expect(registry?.get('p1')).toBe(provider);
    expect(ctx.get(`llm:provider:p1`)).toBe(provider);
  });

  it('provider.id 与定义 id 不一致 → Fiber FAILED（key 与实例会永久错位）', async () => {
    const { ctx } = await setup();
    const fiber = ctx.plugin(
      defineLlmProvider({ id: 'declared', create: () => new FakeProvider('actual') }),
    );
    await fiber.ready().catch(() => undefined);

    expect(fiber.state).toBe('FAILED');
    const report = ctx.diagnose();
    const entry = report.fibers.find((f) => f.id === fiber.id);
    expect(entry?.error?.code).toBe('LLM_CONFIG_INVALID');
  });

  it('llm:registry 未安装时 provider 停在 PENDING、apply 不执行', async () => {
    const host = createHost<EventMapBase>();
    const ctx = createRootContext<EventMapBase>(host);
    let created = false;

    // 不挂 installLlm，直接挂 provider
    const fiber = ctx.plugin(
      defineLlmProvider({
        id: 'p',
        create: () => {
          created = true;
          return new FakeProvider('p');
        },
      }),
    );
    await fiber.ready().catch(() => undefined);

    expect(fiber.state).toBe('PENDING');
    expect(created).toBe(false);
    const entry = ctx.diagnose().fibers.find((f) => f.id === fiber.id);
    expect(entry?.missing).toContain(LLM_SERVICE_KEYS.registry);
  });

  it('卸载 provider 后目录清空、onDispose 被调用', async () => {
    const { ctx } = await setup();
    const provider = new FakeProvider('p2');

    const fiber = ctx.plugin(defineLlmProvider({ id: 'p2', create: () => provider }));
    await fiber.ready();

    const registry = ctx.get<LlmRegistry>(LLM_SERVICE_KEYS.registry);
    expect(registry?.get('p2')).toBe(provider);

    await fiber.dispose();

    expect(registry?.get('p2')).toBeUndefined();
    expect(ctx.get('llm:provider:p2')).toBeUndefined();
    // onDispose 是 fire-and-forget（void Promise），给它一个 tick
    await new Promise((r) => setTimeout(r, 0));
    expect(provider.disposeCount).toBe(1);
  });
});

describe('defineLlmProviderFactory 的 options 通道', () => {
  it('工厂接收清单侧 options 并传给 create()', async () => {
    const { ctx } = await setup();
    const seen: Array<Record<string, unknown> | undefined> = [];

    const factory = defineLlmProviderFactory({
      id: 'p3',
      create: (opts) => {
        seen.push(opts);
        return new FakeProvider('p3');
      },
    });

    const fiber = ctx.plugin(factory({ apiKey: 'from-manifest' }));
    await fiber.ready();

    expect(seen[0]).toEqual({ apiKey: 'from-manifest' });
  });

  it('清单侧同名键覆盖代码侧默认值（浅合并）', async () => {
    const { ctx } = await setup();
    let seen: Record<string, unknown> | undefined;

    const factory = defineLlmProviderFactory({
      id: 'p4',
      options: { apiKey: 'code-default', baseUrl: 'https://a', model: 'm1' },
      create: (opts) => {
        seen = opts;
        return new FakeProvider('p4');
      },
    });

    const fiber = ctx.plugin(factory({ apiKey: 'from-manifest' }));
    await fiber.ready();

    expect(seen).toEqual({
      apiKey: 'from-manifest', // 清单侧胜
      baseUrl: 'https://a', // 代码侧保留
      model: 'm1',
    });
  });

  it('不传 options 时用代码侧默认值', async () => {
    const { ctx } = await setup();
    let seen: Record<string, unknown> | undefined;

    const factory = defineLlmProviderFactory({
      id: 'p5',
      options: { apiKey: 'code-default' },
      create: (opts) => {
        seen = opts;
        return new FakeProvider('p5');
      },
    });

    const fiber = ctx.plugin(factory());
    await fiber.ready();

    expect(seen).toEqual({ apiKey: 'code-default' });
  });

  it('形状与 main 的 defaultLoadPlugin 期望一致：函数入参 → 插件对象', async () => {
    const factory = defineLlmProviderFactory({
      id: 'p6',
      create: () => new FakeProvider('p6'),
    });
    const plugin = factory({ a: 1 });
    expect(typeof plugin).toBe('object');
    expect(typeof plugin.apply).toBe('function');
    expect(plugin.inject).toEqual({ required: [LLM_SERVICE_KEYS.registry] });
  });
});
