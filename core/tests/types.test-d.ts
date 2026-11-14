/**
 * 公开契约的**类型层**断言（任务 04 §3.5）。
 *
 * 本文件不被 vitest 收集（`vitest.config.ts` 的 include 只收 `*.test.ts`），
 * 验证方式是 `npm run typecheck -w @loop-agent/core`——`tsconfig.json` 的
 * include 已覆盖整个 tests 目录，故 `tsc --noEmit` 会把它一并编译。
 *
 * 为什么不用 `vitest typecheck`：那需要额外加 `typecheck.include` 配置；
 * 复用现成的 `tsc --noEmit` 零配置成本，且与源码用同一套 compilerOptions。
 *
 * 断言口径全部为**正向**（`toEqualTypeOf` / `toMatchTypeOf`），
 * 另加少量 `@ts-expect-error` 反向断言——后者若「不再报错」，
 * tsc 会反过来报「未使用 @ts-expect-error」，因此同样能失效报警。
 */

import { describe, expectTypeOf, it } from 'vitest';

import {
  CircularDependencyError,
  CoreError,
  createHost,
  createRootContext,
  FiberDisposedError,
  PluginLoadError,
  ServiceConflictError,
  ServiceNotFoundError,
  ServiceRegistry,
  TypedEventBus,
} from '../src/index.js';
import type {
  Context,
  CoreErrorOptions,
  CoreHost,
  DiagnosticReport,
  Disposer,
  EventMapBase,
  Fiber,
  FiberState,
  Inject,
  IsolationScope,
  ListenerErrorRecord,
  Plugin,
  PluginFunction,
  PluginObject,
  PluginOptions,
  ServiceEntry,
} from '../src/index.js';

/** 业务侧自定义事件表（泛型注入，不用全局声明合并） */
interface DemoEvents extends EventMapBase {
  'demo/ask': (q: string) => string | undefined;
  'demo/notify': (n: number) => void;
}

describe('类型契约：Context', () => {
  const ctx = createRootContext<DemoEvents>();

  it('createRootContext() 返回 Context<E>', () => {
    expectTypeOf(ctx).toEqualTypeOf<Context<DemoEvents>>();
  });

  it('get<T>(key) 推导为 T | undefined（软依赖口径）', () => {
    expectTypeOf(ctx.get<string>('k')).toEqualTypeOf<string | undefined>();
    // 不给 T 时退化为 unknown | undefined
    expectTypeOf(ctx.get('k')).toEqualTypeOf<unknown>();
  });

  it('provide<T>(key, impl) 返回 Disposer', () => {
    expectTypeOf(ctx.provide('k', 1)).toEqualTypeOf<Disposer>();
    expectTypeOf(ctx.provide<number>('k', 1)).toEqualTypeOf<Disposer>();
  });

  it('services() 返回 readonly string[]', () => {
    expectTypeOf(ctx.services()).toEqualTypeOf<readonly string[]>();
  });

  it('effect(body, label?) 返回 Disposer，body 必须返回 Disposer', () => {
    expectTypeOf(ctx.effect(() => () => {})).toEqualTypeOf<Disposer>();
    expectTypeOf(ctx.effect(() => () => {}, 'lbl')).toEqualTypeOf<Disposer>();
    // 异步 disposer 也允许
    expectTypeOf(ctx.effect(() => async () => {})).toEqualTypeOf<Disposer>();
  });

  it('on(event, listener) 按事件表约束监听器签名并返回 Disposer', () => {
    expectTypeOf(ctx.on('demo/ask', (q) => q)).toEqualTypeOf<Disposer>();
    expectTypeOf(ctx.on('demo/notify', (n) => void n)).toEqualTypeOf<Disposer>();
    // 参数类型不匹配 → 报错
    // @ts-expect-error 'demo/notify' 要求 number，传 string 不合法
    ctx.on('demo/notify', (s: string) => void s);
  });

  it('事件名**不受**字面量约束：EventMapBase 的字符串索引签名放行任意名字', () => {
    // 这是一条被实测校正的认知（原计划写的「'demo/unknown' 不在表里 → 报错」
    // 实际不成立，@ts-expect-error 会报 TS2578 未使用）。
    // 根因：E extends EventMapBase，而 EventMapBase 声明了
    //   [event: string]: (...args: any[]) => any
    // 于是 keyof E & string 退化为 string，任意字符串都是合法事件名。
    // 真实收益是「已声明的事件名拿到精确签名」，而非「未声明名字被拒绝」。
    expectTypeOf(ctx.on('demo/unknown', () => {})).toEqualTypeOf<Disposer>();
    // 未声明名字的监听器签名退化为 (...args: any[]) => any
    expectTypeOf(ctx.on('demo/unknown', (a: number, b: string) => void [a, b])).toEqualTypeOf<
      Disposer
    >();
  });

  it('plugin(p, opts?) 返回 Fiber', () => {
    expectTypeOf(ctx.plugin(() => {})).toEqualTypeOf<Fiber>();
    expectTypeOf(ctx.plugin({ apply() {} }, { name: 'n' })).toEqualTypeOf<Fiber>();
  });

  it('isolate(keys) 返回新的 Context<E>（换视角，不换生命周期）', () => {
    expectTypeOf(ctx.isolate(['a'])).toEqualTypeOf<Context<DemoEvents>>();
  });

  it('diagnose() 返回 DiagnosticReport', () => {
    expectTypeOf(ctx.diagnose()).toEqualTypeOf<DiagnosticReport>();
  });

  it('默认泛型参数为 EventMapBase（不传 E 也能用）', () => {
    expectTypeOf(createRootContext()).toEqualTypeOf<Context<EventMapBase>>();
  });
});

describe('类型契约：Plugin 三种写法都被接受', () => {
  const ctx = createRootContext<DemoEvents>();

  it('函数形态', () => {
    const fn: PluginFunction<DemoEvents> = (c) => {
      expectTypeOf(c).toEqualTypeOf<Context<DemoEvents>>();
    };
    expectTypeOf(fn).toMatchTypeOf<Plugin<DemoEvents>>();
    ctx.plugin(fn);
  });

  it('对象形态 + inject 为 string[]（全部硬依赖）', () => {
    const obj: PluginObject<DemoEvents> = {
      name: 'obj',
      inject: ['a', 'b'],
      apply(c) {
        expectTypeOf(c).toEqualTypeOf<Context<DemoEvents>>();
      },
    };
    expectTypeOf(obj).toMatchTypeOf<Plugin<DemoEvents>>();
    ctx.plugin(obj);
  });

  it('对象形态 + inject 为 { required, optional }（区分硬软依赖）', () => {
    const obj: PluginObject<DemoEvents> = {
      inject: { required: ['a'], optional: ['b'] },
      apply() {},
    };
    ctx.plugin(obj);
    expectTypeOf<Inject>().toEqualTypeOf<
      string[] | { required?: string[]; optional?: string[] }
    >();
  });

  it('name 可缺省，apply 可返回 Promise', () => {
    const obj: PluginObject<DemoEvents> = { apply: async () => {} };
    ctx.plugin(obj);
    expectTypeOf<PluginOptions>().toEqualTypeOf<{ name?: string }>();
  });

  it('apply 返回非 void 的值 → 报错（契约是「无返回值」）', () => {
    // @ts-expect-error apply 必须返回 void | Promise<void>
    const bad: PluginObject<DemoEvents> = { apply: () => 42 };
    void bad;
  });
});

describe('类型契约：TypedEventBus 四模式', () => {
  const bus = new TypedEventBus<DemoEvents>();

  it('emit 返回 void（纯通知）', () => {
    expectTypeOf(bus.emit('demo/notify', 1)).toEqualTypeOf<void>();
  });

  it('serial 返回 Promise<返回值 | undefined>（首个非 undefined 胜出）', () => {
    expectTypeOf(bus.serial('demo/ask', 'q')).toEqualTypeOf<
      Promise<string | undefined>
    >();
  });

  it('parallel 返回 Promise<void>（扇出，不关心返回值）', () => {
    expectTypeOf(bus.parallel('demo/notify', 1)).toEqualTypeOf<Promise<void>>();
  });

  it('waterfall 的返回类型由 fallback 决定', () => {
    expectTypeOf(
      bus.waterfall('demo/ask', () => 'fb', 'q'),
    ).toEqualTypeOf<Promise<string>>();
    expectTypeOf(
      bus.waterfall('demo/ask', () => 7, 'q'),
    ).toEqualTypeOf<Promise<number>>();
  });

  it('on 返回 Disposer；listenerCount 为 number；listenerErrors 为只读数组', () => {
    expectTypeOf(bus.on('demo/ask', (q) => q)).toEqualTypeOf<Disposer>();
    expectTypeOf(bus.listenerCount('demo/ask')).toEqualTypeOf<number>();
    expectTypeOf(bus.listenerErrors()).toEqualTypeOf<readonly ListenerErrorRecord[]>();
  });

  it('ListenerErrorRecord 三字段形状', () => {
    expectTypeOf<ListenerErrorRecord>().toEqualTypeOf<{
      event: string;
      ownerFiberId: string;
      error: unknown;
    }>();
  });
});

describe('类型契约：错误族 6 类的 code 与专属字段', () => {
  it('CoreError.code 为 string（不是字面量联合，跨进程边界也可靠）', () => {
    expectTypeOf(new CoreError('m').code).toEqualTypeOf<string>();
  });

  it('6 类均继承 CoreError', () => {
    expectTypeOf(new CircularDependencyError('m')).toMatchTypeOf<CoreError>();
    expectTypeOf(new ServiceNotFoundError('k')).toMatchTypeOf<CoreError>();
    expectTypeOf(new ServiceConflictError('k')).toMatchTypeOf<CoreError>();
    expectTypeOf(new PluginLoadError('m')).toMatchTypeOf<CoreError>();
    expectTypeOf(new FiberDisposedError()).toMatchTypeOf<CoreError>();
  });

  it('两个带 key 的错误的 key 为 string', () => {
    expectTypeOf(new ServiceNotFoundError('k').key).toEqualTypeOf<string>();
    expectTypeOf(new ServiceConflictError('k').key).toEqualTypeOf<string>();
  });

  it('子类构造参数不接受 code（code 由类自身固定）', () => {
    // @ts-expect-error 子类的 opts 是 Omit<CoreErrorOptions,'code'>
    new CircularDependencyError('m', { code: 'X' });
  });

  it('CoreErrorOptions 允许 code / pluginName / fiberId / cause', () => {
    expectTypeOf<CoreErrorOptions>().toEqualTypeOf<{
      code?: string;
      pluginName?: string;
      fiberId?: string;
      cause?: unknown;
    }>();
    // 基类接受 code
    expectTypeOf(new CoreError('m', { code: 'X' }).code).toEqualTypeOf<string>();
  });
});

describe('类型契约：Fiber / Host / 服务表', () => {
  it('Fiber 六态为字面量联合', () => {
    expectTypeOf<FiberState>().toEqualTypeOf<
      'PENDING' | 'LOADING' | 'ACTIVE' | 'FAILED' | 'UNLOADING' | 'DISPOSED'
    >();
  });

  it('Fiber 的方法与只读字段', () => {
    const f = createRootContext().plugin(() => {});
    expectTypeOf(f.id).toEqualTypeOf<string>();
    expectTypeOf(f.name).toEqualTypeOf<string>();
    expectTypeOf(f.state).toEqualTypeOf<FiberState>();
    expectTypeOf(f.dispose()).toEqualTypeOf<Promise<void>>();
    expectTypeOf(f.reload()).toEqualTypeOf<Promise<void>>();
    expectTypeOf(f.ready()).toEqualTypeOf<Promise<void>>();
    // 只读字段不可赋值
    // @ts-expect-error id 为 readonly
    f.id = 'x';
  });

  it('createHost() 返回 CoreHost，settle/scheduleReconcile 均为 Promise<void>', () => {
    const host = createHost<DemoEvents>();
    expectTypeOf(host).toEqualTypeOf<CoreHost<DemoEvents>>();
    expectTypeOf(host.settle()).toEqualTypeOf<Promise<void>>();
    expectTypeOf(host.scheduleReconcile()).toEqualTypeOf<Promise<void>>();
    expectTypeOf(host.nextId()).toEqualTypeOf<string>();
    expectTypeOf(host.scopes).toEqualTypeOf<IsolationScope[]>();
  });

  it('IsolationScope 的 keys 只读、store 为 ServiceRegistry', () => {
    expectTypeOf<IsolationScope['keys']>().toEqualTypeOf<ReadonlySet<string>>();
    expectTypeOf<IsolationScope['store']>().toEqualTypeOf<ServiceRegistry>();
  });

  it('ServiceRegistry 的方法签名', () => {
    const s = new ServiceRegistry();
    expectTypeOf(s.get<number>('k')).toEqualTypeOf<number | undefined>();
    expectTypeOf(s.has('k')).toEqualTypeOf<boolean>();
    expectTypeOf(s.keys()).toEqualTypeOf<readonly string[]>();
    expectTypeOf(s.provide('k', 1, '') as unknown).toEqualTypeOf<unknown>();
    expectTypeOf(s.remove('k')).toEqualTypeOf<boolean>();
    expectTypeOf(s.entriesSnapshot()).toEqualTypeOf<readonly ServiceEntry[]>();
    expectTypeOf(s.clear()).toEqualTypeOf<void>();
  });
});

describe('类型契约：DiagnosticReport 的可选字段', () => {
  it('fibers[].error 与 disposeErrors 均为可选', () => {
    type FiberReport = DiagnosticReport['fibers'][number];
    expectTypeOf<FiberReport['error']>().toEqualTypeOf<
      { code: string; message: string } | undefined
    >();
    expectTypeOf<FiberReport['disposeErrors']>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<FiberReport['missing']>().toEqualTypeOf<string[]>();
    expectTypeOf<FiberReport['state']>().toEqualTypeOf<FiberState>();
  });

  it('services[] 的三字段形状', () => {
    type ServiceReport = DiagnosticReport['services'][number];
    expectTypeOf<ServiceReport>().toEqualTypeOf<{
      key: string;
      ownerFiberId: string;
      isolated: boolean;
    }>();
  });

  it('整个 DiagnosticReport 为对象（不是数组、不是可选）', () => {
    expectTypeOf<DiagnosticReport>().toHaveProperty('fibers');
    expectTypeOf<DiagnosticReport>().toHaveProperty('services');
  });
});

describe('类型契约：Disposer', () => {
  it('允许同步与异步两种清理函数', () => {
    expectTypeOf<() => void>().toMatchTypeOf<Disposer>();
    expectTypeOf<() => Promise<void>>().toMatchTypeOf<Disposer>();
    // 返回值不是 void/Promise<void> → 报错
    // @ts-expect-error 返回 number 不满足 Disposer
    expectTypeOf<() => number>().toMatchTypeOf<Disposer>();
  });
});
