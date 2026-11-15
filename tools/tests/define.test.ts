/**
 * `defineTools` / `defineToolsFactory` 全链路。
 *
 * 覆盖：两形态、同步校验、options 合并、Fiber 撤销、provider 服务 key、
 * 同 id 重复挂载翻译、批量注册无半挂载、dispose 兜底。
 */

import { createHost, createRootContext, type EventMapBase } from '@loop-agent/core';
import { describe, expect, it } from 'vitest';

import { EchoTool, FakeProvider } from './helpers.js';
import {
  defineTools,
  defineToolsFactory,
  getToolRegistry,
  installTools,
  TOOLS_SERVICE_KEYS,
  providerServiceKey,
  ToolsConfigError,
  ToolsInvalidNameError,
  ToolsProviderExistsError,
  ToolsRegistryMissingError,
  type ToolProviderFacade,
  type ToolRegistry,
} from '../src/index.js';

/** 挂载 installTools 并返回上下文 */
async function setup() {
  const host = createHost<EventMapBase>();
  const ctx = createRootContext<EventMapBase>(host);
  const fiber = ctx.plugin(installTools());
  await fiber.ready();
  return { host, ctx };
}

/** 取目录 */
function registryOf(ctx: ReturnType<typeof createRootContext>): ToolRegistry {
  return getToolRegistry(ctx);
}

describe('定义期同步校验', () => {
  it('id 为空串 → 抛 ToolsConfigError', () => {
    expect(() => defineTools({ id: '', tools: [new EchoTool()] })).toThrow(ToolsConfigError);
  });

  it('id 仅空白 → 抛错', () => {
    expect(() => defineTools({ id: '   ', tools: [new EchoTool()] })).toThrow(/非空字符串/);
  });

  it('id 含冒号 → 抛错（会破坏服务 key 分段）', () => {
    expect(() => defineTools({ id: 'a:b', tools: [new EchoTool()] })).toThrow(/冒号/);
  });

  it('tools 缺失 → 抛错', () => {
    // @ts-expect-error 故意缺 tools 验证运行期兜底
    expect(() => defineTools({ id: 'p' })).toThrow(/tools 缺失/);
  });

  it('tools 类型非法 → 抛错', () => {
    // @ts-expect-error 故意传错类型
    expect(() => defineTools({ id: 'p', tools: 'not-valid' })).toThrow(/必须是/);
  });

  it('校验在工厂阶段同步发生（不是等挂载）', () => {
    expect(() => defineToolsFactory({ id: '', tools: [new EchoTool()] })).toThrow(ToolsConfigError);
  });
});

describe('defineTools 产出的插件对象', () => {
  it('name 为 tools-provider:<id>', () => {
    expect(defineTools({ id: 'p', tools: [new EchoTool()] }).name).toBe('tools-provider:p');
  });

  it('inject 含硬依赖 tools:registry', () => {
    const plugin = defineTools({ id: 'p', tools: [new EchoTool()] });
    expect(plugin.inject).toEqual({ required: [TOOLS_SERVICE_KEYS.registry] });
  });

  it('提供者的额外 inject 与 tools:registry 合并', () => {
    class NeedsLlm extends FakeProvider {
      override readonly inject = { required: ['llm:registry'] };
    }
    const plugin = defineTools({ id: 'p', tools: new NeedsLlm({ id: 'p' }) });
    expect(plugin.inject).toEqual({
      required: expect.arrayContaining([TOOLS_SERVICE_KEYS.registry, 'llm:registry']),
    });
  });

  it('提供者的软依赖保留在 optional', () => {
    class SoftDep extends FakeProvider {
      override readonly inject = { optional: ['llm:provider:openai'] };
    }
    const plugin = defineTools({ id: 'p', tools: new SoftDep({ id: 'p' }) });
    expect(plugin.inject).toMatchObject({
      required: [TOOLS_SERVICE_KEYS.registry],
      optional: ['llm:provider:openai'],
    });
  });
});

describe('挂载：数组形态', () => {
  it('挂载后工具进入目录，可 invoke', async () => {
    const { ctx } = await setup();
    const fiber = ctx.plugin(
      defineTools({ id: 'arr', tools: [new EchoTool('t1', () => '结果1')] }),
    );
    await fiber.ready();

    expect(registryOf(ctx).names()).toEqual(['t1']);
    const result = await registryOf(ctx).invoke('t1', {});
    expect(result).toEqual({ text: '结果1', isError: false });
  });

  it('占住 tools:provider:<id> 服务 key 并暴露门面', async () => {
    const { ctx } = await setup();
    const fiber = ctx.plugin(
      defineTools({
        id: 'p1',
        displayName: '我的工具',
        tools: [new EchoTool('a'), new EchoTool('b')],
      }),
    );
    await fiber.ready();

    const facade = ctx.get<ToolProviderFacade>(providerServiceKey('p1'));
    expect(facade).toEqual({
      id: 'p1',
      displayName: '我的工具',
      toolNames: ['a', 'b'],
      isDefault: false,
    });
  });

  it('displayName 缺省回落 id', async () => {
    const { ctx } = await setup();
    const fiber = ctx.plugin(defineTools({ id: 'no-display', tools: [new EchoTool('x')] }));
    await fiber.ready();
    expect(ctx.get<ToolProviderFacade>(providerServiceKey('no-display'))?.displayName).toBe(
      'no-display',
    );
  });

  it('ifDefault 透传到门面', async () => {
    const { ctx } = await setup();
    const fiber = ctx.plugin(
      defineTools({ id: 'dft', isDefault: true, tools: [new EchoTool('x')] }),
    );
    await fiber.ready();
    expect(ctx.get<ToolProviderFacade>(providerServiceKey('dft'))?.isDefault).toBe(true);
  });
});

describe('挂载：提供者形态', () => {
  it('提供者 create() 被调用且产出工具全部登记', async () => {
    const { ctx } = await setup();
    const provider = new FakeProvider({ id: 'prov', count: 3 });
    const fiber = ctx.plugin(defineTools({ id: 'prov', tools: provider }));
    await fiber.ready();

    expect(registryOf(ctx).names()).toEqual(['prov-t0', 'prov-t1', 'prov-t2']);
    expect(provider.seenOptions).toHaveLength(1);
  });

  it('提供者异步 create() 正常工作', async () => {
    const { ctx } = await setup();
    const fiber = ctx.plugin(
      defineTools({ id: 'ap', tools: new FakeProvider({ id: 'ap', count: 2, async: true }) }),
    );
    await fiber.ready();
    expect(registryOf(ctx).count()).toBe(2);
  });

  it('提供者 displayName 作为缺省展示名', async () => {
    const { ctx } = await setup();
    const fiber = ctx.plugin(
      defineTools({
        id: 'pd',
        tools: new FakeProvider({ id: 'pd', displayName: '提供者展示名' }),
      }),
    );
    await fiber.ready();
    expect(ctx.get<ToolProviderFacade>(providerServiceKey('pd'))?.displayName).toBe(
      '提供者展示名',
    );
  });

  it('定义侧 displayName 优先于提供者', async () => {
    const { ctx } = await setup();
    const fiber = ctx.plugin(
      defineTools({
        id: 'pri',
        displayName: '定义侧胜',
        tools: new FakeProvider({ id: 'pri', displayName: '提供者侧' }),
      }),
    );
    await fiber.ready();
    expect(ctx.get<ToolProviderFacade>(providerServiceKey('pri'))?.displayName).toBe('定义侧胜');
  });

  it('create() 返回空数组 → 挂载成功但 0 工具', async () => {
    const { ctx } = await setup();
    const fiber = ctx.plugin(
      defineTools({ id: 'empty', tools: new FakeProvider({ id: 'empty', count: 0 }) }),
    );
    await fiber.ready();

    expect(fiber.state).toBe('ACTIVE');
    expect(ctx.get<ToolProviderFacade>(providerServiceKey('empty'))?.toolNames).toEqual([]);
  });

  it('create() 抛错 → Fiber FAILED 且目录无残留', async () => {
    const { ctx } = await setup();
    class BadProvider extends FakeProvider {
      override create(): never {
        throw new Error('握手失败');
      }
    }
    const fiber = ctx.plugin(defineTools({ id: 'bad', tools: new BadProvider({ id: 'bad' }) }));
    await fiber.ready().catch(() => undefined);

    expect(fiber.state).toBe('FAILED');
    expect(registryOf(ctx).count()).toBe(0);
  });

  it('create() 返回非数组 → Fiber FAILED', async () => {
    const { ctx } = await setup();
    class WrongProvider extends FakeProvider {
      override create(): never {
        return 'not-an-array' as never;
      }
    }
    const fiber = ctx.plugin(defineTools({ id: 'wrong', tools: new WrongProvider({ id: 'wrong' }) }));
    await fiber.ready().catch(() => undefined);
    expect(fiber.state).toBe('FAILED');
  });
});

describe('挂载：工厂形态', () => {
  it('工厂函数收到合并后的 options', async () => {
    const { ctx } = await setup();
    const seen: Array<Record<string, unknown>> = [];
    const fiber = ctx.plugin(
      defineTools({
        id: 'fact',
        options: { a: 1 },
        tools: (opts) => {
          seen.push(opts);
          return [new EchoTool('ft')];
        },
      }),
    );
    await fiber.ready();

    expect(seen).toEqual([{ a: 1 }]);
    expect(registryOf(ctx).names()).toEqual(['ft']);
  });
});

describe('挂载：注册期校验（D8/D11）', () => {
  it('非法工具名 → Fiber FAILED 且错误为 TOOLS_INVALID_NAME', async () => {
    const { ctx } = await setup();
    const fiber = ctx.plugin(
      defineTools({ id: 'badname', tools: [new EchoTool('my.tool')] }),
    );
    await fiber.ready().catch(() => undefined);

    expect(fiber.state).toBe('FAILED');
    const entry = ctx.diagnose().fibers.find((f) => f.id === fiber.id);
    expect(entry?.error?.code).toBe('TOOLS_INVALID_NAME');
    expect(registryOf(ctx).count()).toBe(0);
  });

  it('description 为空 → Fiber FAILED 且 code 为 TOOLS_CONFIG_INVALID', async () => {
    const { ctx } = await setup();
    class NoDesc extends EchoTool {
      constructor() {
        super('nodesc', () => 'ok', { type: 'object', properties: {} });
        (this as unknown as { spec: { description: string } }).spec.description = '';
      }
    }
    const fiber = ctx.plugin(defineTools({ id: 'nd', tools: [new NoDesc()] }));
    await fiber.ready().catch(() => undefined);

    expect(fiber.state).toBe('FAILED');
    expect(ctx.diagnose().fibers.find((f) => f.id === fiber.id)?.error?.code).toBe(
      'TOOLS_CONFIG_INVALID',
    );
  });

  it('整批中有一个非法名 → 全部不登记（无半挂载）', async () => {
    const { ctx } = await setup();
    const fiber = ctx.plugin(
      defineTools({ id: 'batch', tools: [new EchoTool('good1'), new EchoTool('bad.name')] }),
    );
    await fiber.ready().catch(() => undefined);

    expect(fiber.state).toBe('FAILED');
    // good1 也不该进目录
    expect(registryOf(ctx).names()).toEqual([]);
  });

  it('与已注册工具重名 → 抛 TOOLS_DUPLICATE，且原工具保留', async () => {
    const { ctx } = await setup();
    const first = ctx.plugin(defineTools({ id: 'first', tools: [new EchoTool('shared')] }));
    await first.ready();

    const second = ctx.plugin(defineTools({ id: 'second', tools: [new EchoTool('shared')] }));
    await second.ready().catch(() => undefined);

    expect(second.state).toBe('FAILED');
    const entry = ctx.diagnose().fibers.find((f) => f.id === second.id);
    expect(entry?.error?.code).toBe('TOOLS_DUPLICATE');
    expect(registryOf(ctx).names()).toEqual(['shared']);
    expect(registryOf(ctx).listByProvider('first')).toEqual(['shared']);
  });

  it('同 id 提供者重复挂载 → TOOLS_PROVIDER_EXISTS', async () => {
    const { ctx } = await setup();
    const first = ctx.plugin(defineTools({ id: 'same-id', tools: [new EchoTool('a')] }));
    await first.ready();

    const second = ctx.plugin(defineTools({ id: 'same-id', tools: [new EchoTool('b')] }));
    await second.ready().catch(() => undefined);

    expect(second.state).toBe('FAILED');
    const entry = ctx.diagnose().fibers.find((f) => f.id === second.id);
    expect(entry?.error?.code).toBe('TOOLS_PROVIDER_EXISTS');
    // b 未登记（错在 provide 之前就抛出？此处 provide 在注册前，故 b 不会进目录）
    expect(registryOf(ctx).names()).toEqual(['a']);
  });

  it('ToolsProviderExistsError 携带 providerId', () => {
    const err = new ToolsProviderExistsError('dup-id');
    expect(err.code).toBe('TOOLS_PROVIDER_EXISTS');
    expect(err.providerId).toBe('dup-id');
  });

  it('ToolsInvalidNameError 携带名字与原因', () => {
    const err = new ToolsInvalidNameError('bad.name', '含点号');
    expect(err.code).toBe('TOOLS_INVALID_NAME');
    expect(err.toolName).toBe('bad.name');
    expect(err.reason).toBe('含点号');
  });
});

describe('卸载：成组撤销', () => {
  it('卸载后工具与提供者 key 同时撤销', async () => {
    const { ctx } = await setup();
    const fiber = ctx.plugin(
      defineTools({ id: 'gone', tools: [new EchoTool('g1'), new EchoTool('g2')] }),
    );
    await fiber.ready();
    expect(registryOf(ctx).count()).toBe(2);

    await fiber.dispose();

    expect(registryOf(ctx).count()).toBe(0);
    expect(ctx.get(providerServiceKey('gone'))).toBeUndefined();
  });

  it('卸载后 diagnose() 无残留', async () => {
    const { ctx } = await setup();
    const fiber = ctx.plugin(defineTools({ id: 'clean', tools: [new EchoTool('c1')] }));
    await fiber.ready();
    const fiberId = fiber.id;

    await fiber.dispose();

    const report = ctx.diagnose();
    // 该 Fiber 已撤销，不应再作为 owner 出现
    const owned = report.services?.filter((s) => s.ownerFiberId === fiberId) ?? [];
    expect(owned).toEqual([]);
  });

  it('卸载提供者时 dispose() 被调用一次', async () => {
    const { ctx } = await setup();
    const provider = new FakeProvider({ id: 'dp', count: 1 });
    const fiber = ctx.plugin(defineTools({ id: 'dp', tools: provider }));
    await fiber.ready();

    await fiber.dispose();
    // dispose 是 fire-and-forget（void Promise），给一个 tick
    await new Promise((r) => setTimeout(r, 0));
    expect(provider.disposeCount).toBe(1);
  });

  it('dispose() 抛错不阻断撤销链（工具仍被撤销）', async () => {
    const { ctx } = await setup();
    class ExplodingDispose extends FakeProvider {
      protected override async onDispose(): Promise<void> {
        throw new Error('释放爆炸');
      }
    }
    const fiber = ctx.plugin(
      defineTools({ id: 'ex', tools: new ExplodingDispose({ id: 'ex', count: 1 }) }),
    );
    await fiber.ready();

    await expect(fiber.dispose()).resolves.toBeUndefined();
    expect(registryOf(ctx).count()).toBe(0);
  });

  it('多个提供者独立卸载，互不影响', async () => {
    const { ctx } = await setup();
    const f1 = ctx.plugin(defineTools({ id: 'p1', tools: [new EchoTool('x1')] }));
    const f2 = ctx.plugin(defineTools({ id: 'p2', tools: [new EchoTool('x2')] }));
    await f1.ready();
    await f2.ready();

    await f1.dispose();

    expect(registryOf(ctx).names()).toEqual(['x2']);
    expect(ctx.get(providerServiceKey('p1'))).toBeUndefined();
    expect(ctx.get(providerServiceKey('p2'))).toBeDefined();
  });
});

describe('依赖缺失与重复安装', () => {
  it('tools:registry 未安装 → 提供者停在 PENDING，apply 不执行', async () => {
    const host = createHost<EventMapBase>();
    const ctx = createRootContext<EventMapBase>(host);
    let created = false;

    const fiber = ctx.plugin(
      defineTools({
        id: 'pending',
        tools: () => {
          created = true;
          return [new EchoTool('p')];
        },
      }),
    );
    await fiber.ready().catch(() => undefined);

    expect(fiber.state).toBe('PENDING');
    expect(created).toBe(false);
    const entry = ctx.diagnose().fibers.find((f) => f.id === fiber.id);
    expect(entry?.missing).toContain(TOOLS_SERVICE_KEYS.registry);
  });

  it('重复 installTools() → Fiber FAILED，code 为 TOOLS_REGISTRY_EXISTS', async () => {
    const { ctx } = await setup();
    const dup = ctx.plugin(installTools());
    await dup.ready().catch(() => undefined);

    expect(dup.state).toBe('FAILED');
    expect(ctx.diagnose().fibers.find((f) => f.id === dup.id)?.error?.code).toBe(
      'TOOLS_REGISTRY_EXISTS',
    );
  });

  it('未安装时 getToolRegistry 抛 TOOLS_REGISTRY_MISSING', () => {
    const host = createHost<EventMapBase>();
    const ctx = createRootContext<EventMapBase>(host);
    expect(() => getToolRegistry(ctx)).toThrow(ToolsRegistryMissingError);
  });
});

describe('defineToolsFactory 的 options 通道', () => {
  it('工厂接收清单侧 options 并传给 create()', async () => {
    const { ctx } = await setup();
    const provider = new FakeProvider({ id: 'f1', count: 1 });
    const factory = defineToolsFactory({ id: 'f1', tools: provider });

    const fiber = ctx.plugin(factory({ apiKey: 'from-manifest' }));
    await fiber.ready();

    expect(provider.seenOptions[0]).toEqual({ apiKey: 'from-manifest' });
  });

  it('清单侧同名键覆盖代码侧默认值（浅合并）', async () => {
    const { ctx } = await setup();
    const provider = new FakeProvider({ id: 'f2', count: 1 });
    const factory = defineToolsFactory({
      id: 'f2',
      options: { apiKey: 'code-default', baseUrl: 'https://a', model: 'm1' },
      tools: provider,
    });

    const fiber = ctx.plugin(factory({ apiKey: 'from-manifest' }));
    await fiber.ready();

    expect(provider.seenOptions[0]).toEqual({
      apiKey: 'from-manifest',
      baseUrl: 'https://a',
      model: 'm1',
    });
  });

  it('不传 options 时用代码侧默认值', async () => {
    const { ctx } = await setup();
    const provider = new FakeProvider({ id: 'f3', count: 1 });
    const factory = defineToolsFactory({
      id: 'f3',
      options: { apiKey: 'code-default' },
      tools: provider,
    });

    const fiber = ctx.plugin(factory());
    await fiber.ready();

    expect(provider.seenOptions[0]).toEqual({ apiKey: 'code-default' });
  });

  it('传入 undefined 不炸', async () => {
    const { ctx } = await setup();
    const factory = defineToolsFactory({ id: 'f4', tools: [new EchoTool('f4t')] });
    const fiber = ctx.plugin(factory(undefined));
    await fiber.ready();
    expect(registryOf(ctx).names()).toEqual(['f4t']);
  });

  it('形状与 main 的 defaultLoadPlugin 期望一致：函数入参 → 插件对象', () => {
    const factory = defineToolsFactory({ id: 'f5', tools: [new EchoTool()] });
    const plugin = factory({ a: 1 });
    expect(typeof plugin).toBe('object');
    expect(typeof plugin.apply).toBe('function');
    expect(plugin.inject).toEqual({ required: [TOOLS_SERVICE_KEYS.registry] });
  });
});

describe('端到端：extends → 挂载 → invoke → 模型侧定义', () => {
  it('第三方只靠 extends 即可落地的完整链路', async () => {
    const { ctx } = await setup();

    // ① 用户自定义工具：只实现 execute()
    class UpperCaseTool extends EchoTool {
      constructor() {
        super(
          'upperCase',
          (args) => String(args.text ?? '').toUpperCase(),
          {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        );
      }
    }

    // ② 编译成插件并挂载
    const fiber = ctx.plugin(
      defineTools({ id: 'user-tools', displayName: '用户工具', tools: [new UpperCaseTool()] }),
    );
    await fiber.ready();

    // ③ 调用
    const result = await registryOf(ctx).invoke('upperCase', { text: 'abc' });
    expect(result).toEqual({ text: 'ABC', isError: false });

    // ④ 模型侧定义
    expect(registryOf(ctx).toToolDefs()).toEqual([
      {
        name: 'upperCase',
        description: 'upperCase 的测试用说明',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ]);
  });
});
