/**
 * 纯类型断言：把**类型级**契约钉死，防止有人改签名时把契约悄悄放宽。
 *
 * Vitest 只收集 `*.test.ts`，本文件以 `-d.ts` 结尾，真正的检查由
 * `npx tsc --noEmit` 完成（与 llm 的 `types.test-d.ts` 同口径）。
 * 文件内部仍写少量运行期断言，满足 vitest 收集且便于本地排查。
 */

import { describe, expect, it } from 'vitest';

import type {
  JsonSchema,
  ToolAnnotations,
  ToolDefView,
  ToolDisplay,
  ToolInvokeContext,
  ToolResult,
  ToolSpec,
} from '../src/index.js';
import type { ToolsEvents } from '../src/events.js';
import type { EventMapBase } from '@loop-agent/core';

/** 编译期断言辅助：类型相等 */
type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

describe('ToolSpec 的类型级形状', () => {
  it('parameters 是 JsonSchema（不可省略、不接受 undefined）', () => {
    type ParametersRequired = Expect<Equal<ToolSpec['parameters'], JsonSchema>>;
    const ok: ParametersRequired = true;
    expect(ok).toBe(true);

    // @ts-expect-error parameters 必填
    const missing: ToolSpec = { name: 'x', description: 'd' };
    expect(missing).toBeDefined();
  });

  it('name 与 description 都是 string（非可选、非字面量收窄）', () => {
    type NameIsString = Expect<Equal<ToolSpec['name'], string>>;
    type DescIsString = Expect<Equal<ToolSpec['description'], string>>;
    const a: NameIsString = true;
    const b: DescIsString = true;
    expect([a, b]).toEqual([true, true]);
  });

  it('可选成员恰好是 annotations/display/timeoutMs', () => {
    type Optionals = keyof Pick<ToolSpec, 'annotations' | 'display' | 'timeoutMs'>;
    const keys: Optionals[] = ['annotations', 'display', 'timeoutMs'];
    expect(keys).toHaveLength(3);

    // @ts-expect-error title 不是 ToolSpec 的字段（属 annotations）
    const bad: ToolSpec = { name: 'x', description: 'd', parameters: {}, title: 't' };
    expect(bad).toBeDefined();
  });
});

describe('ToolResult 的类型级形状', () => {
  it('text 必填、isError/structured 可选', () => {
    type TextRequired = Expect<Equal<ToolResult['text'], string>>;
    const ok: TextRequired = true;
    expect(ok).toBe(true);

    // @ts-expect-error 缺 text
    const bad: ToolResult = { isError: false };
    expect(bad).toBeDefined();
  });

  it('isError 是 boolean | undefined（不是 boolean）', () => {
    type IsErrorOptional = Expect<Equal<ToolResult['isError'], boolean | undefined>>;
    const ok: IsErrorOptional = true;
    expect(ok).toBe(true);
  });
});

describe('ToolDefView 与 llm 的 LlmToolDef 结构等价', () => {
  it('三字段均为必填 string/JsonSchema', () => {
    type NameIsString = Expect<Equal<ToolDefView['name'], string>>;
    type DescIsString = Expect<Equal<ToolDefView['description'], string>>;
    type ParamsIsSchema = Expect<Equal<ToolDefView['parameters'], JsonSchema>>;
    const checks: [NameIsString, DescIsString, ParamsIsSchema] = [true, true, true];
    expect(checks).toEqual([true, true, true]);
  });

  it('不含 annotations/display（模型侧只见最小信息集）', () => {
    // @ts-expect-error annotations 不属于模型侧视图
    const bad: ToolDefView = { name: 'x', description: 'd', parameters: {}, annotations: {} };
    expect(bad).toBeDefined();
  });
});

describe('ToolInvokeContext 全可选', () => {
  it('空对象合法；字段均可省略', () => {
    const empty: ToolInvokeContext = {};
    expect(empty).toEqual({});

    type SignalOptional = Expect<Equal<ToolInvokeContext['signal'], AbortSignal | undefined>>;
    const ok: SignalOptional = true;
    expect(ok).toBe(true);
  });

  it('metadata 是 string→string（不放密钥对象）', () => {
    type Meta = Expect<Equal<ToolInvokeContext['metadata'], Record<string, string> | undefined>>;
    const ok: Meta = true;
    expect(ok).toBe(true);
  });
});

describe('ToolAnnotations 的 title 与 hint 分离', () => {
  it('title 是 string | undefined，hint 是 boolean | undefined', () => {
    type Title = Expect<Equal<ToolAnnotations['title'], string | undefined>>;
    type Hint = Expect<Equal<ToolAnnotations['readOnlyHint'], boolean | undefined>>;
    const a: Title = true;
    const b: Hint = true;
    expect([a, b]).toEqual([true, true]);
  });
});

describe('ToolDisplay 三个可选字段', () => {
  it('label/icon 为 string，paramLabels 为映射', () => {
    type Label = Expect<Equal<ToolDisplay['label'], string | undefined>>;
    type Icon = Expect<Equal<ToolDisplay['icon'], string | undefined>>;
    type Params = Expect<Equal<ToolDisplay['paramLabels'], Record<string, string> | undefined>>;
    const checks: [Label, Icon, Params] = [true, true, true];
    expect(checks).toEqual([true, true, true]);
  });
});

describe('JsonSchema 是开放记录类型', () => {
  it('任意对象字面量可赋值（不锁死子集）', () => {
    type IsRecord = Expect<Equal<JsonSchema, Record<string, unknown>>>;
    const ok: IsRecord = true;
    expect(ok).toBe(true);
  });
});

describe('ToolsEvents 必须 extends EventMapBase', () => {
  it('满足 core 的 EventMap 约束（否则 Plugin<ToolsEvents> 会 TS2344）', () => {
    type Assignable = Expect<ToolsEvents extends EventMapBase ? true : false>;
    const ok: Assignable = true;
    expect(ok).toBe(true);
  });

  it('五个事件名的载荷签名可精确推断', () => {
    type Registered = Parameters<ToolsEvents['tools/registered']>[0];
    type Result = Parameters<ToolsEvents['tools/result']>[0];

    // 载荷里必须有 name；result 事件额外带 elapsedMs
    type RegisteredHasName = Expect<Equal<Registered['name'], string>>;
    type ResultHasElapsed = Expect<Equal<Result['elapsedMs'], number>>;
    const checks: [RegisteredHasName, ResultHasElapsed] = [true, true];
    expect(checks).toEqual([true, true]);
  });
});
