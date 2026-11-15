/**
 * `ToolBase.invoke()` 模板方法的 6 类边界（方案 3.3 表）+ 归一语义。
 *
 * 这张表是契约的核心承诺：**任何环节失败都返回 `isError:true` 的 ToolResult，
 * 不向上抛**——除了取消（`AbortError` 冒泡）这一条特例。
 */

import { describe, expect, it } from 'vitest';

import { EchoTool, ThrowingTool } from './helpers.js';
import { failWith, okResult, ToolBase, type ToolResult } from '../src/index.js';

describe('invoke()：参数形状检查', () => {
  it('null 参数 → isError，且不调用 execute()', async () => {
    const tool = new EchoTool();
    const result = await tool.invoke(null);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('参数必须是对象');
    expect(result.text).toContain('null');
    expect(tool.callCount).toBe(0);
  });

  it('数组参数 → isError，且不调用 execute()', async () => {
    const tool = new EchoTool();
    const result = await tool.invoke([1, 2]);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('array');
    expect(tool.callCount).toBe(0);
  });

  it('原始值参数 → isError，且不调用 execute()', async () => {
    const tool = new EchoTool();
    expect((await tool.invoke('x')).isError).toBe(true);
    expect((await tool.invoke(1)).isError).toBe(true);
    expect((await tool.invoke(true)).isError).toBe(true);
    expect((await tool.invoke(undefined)).isError).toBe(true);
    expect(tool.callCount).toBe(0);
  });
});

describe('invoke()：schema 校验', () => {
  const tool = () =>
    new EchoTool('strict', undefined, {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });

  it('必填缺失 → isError，且不调用 execute()', async () => {
    const t = tool();
    const result = await t.invoke({});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('参数不符合 schema');
    expect(result.text).toContain('path');
    expect(t.callCount).toBe(0);
  });

  it('类型不符 → isError，且不调用 execute()', async () => {
    const t = tool();
    const result = await t.invoke({ path: 42 });
    expect(result.isError).toBe(true);
    expect(t.callCount).toBe(0);
  });

  it('通过校验后才调用 execute()', async () => {
    const t = tool();
    const result = await t.invoke({ path: '/a' });
    expect(result.isError).toBe(false);
    expect(t.callCount).toBe(1);
    expect(t.calls[0]).toEqual({ path: '/a' });
  });

  it('问题超过 10 条时文本列出省略提示', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [`k${i}`, { type: 'string' }]),
    );
    const t = new EchoTool('many', undefined, {
      type: 'object',
      properties: many,
      required: Object.keys(many),
    });
    const result = await t.invoke({});
    expect(result.text).toContain('另有 5 处问题');
  });
});

describe('invoke()：取消语义', () => {
  it('signal 已 abort → 返回「工具已取消」，且不调用 execute()', async () => {
    const tool = new EchoTool();
    const controller = new AbortController();
    controller.abort();

    const result = await tool.invoke({ text: 'x' }, { signal: controller.signal });
    expect(result.isError).toBe(true);
    expect(result.text).toBe('工具已取消');
    expect(tool.callCount).toBe(0);
  });

  it('signal 未 abort → 正常执行', async () => {
    const tool = new EchoTool();
    const controller = new AbortController();
    const result = await tool.invoke({ text: 'x' }, { signal: controller.signal });
    expect(result.isError).toBe(false);
    expect(tool.callCount).toBe(1);
  });

  it('execute() 内抛出的 abort 错误向上冒泡（不归一为工具失败）', async () => {
    // 宿主用可中止实现时，"取消" 不应被当成 "工具失败" 混入上下文
    class AbortTool extends ToolBase {
      constructor() {
        super({ name: 'aborting', description: '抛 abort', parameters: { type: 'object', properties: {} } });
      }
      protected override execute(): string {
        const err = new Error('aborted') as Error & { aborted: boolean };
        err.aborted = true;
        throw err;
      }
    }
    await expect(new AbortTool().invoke({})).rejects.toThrow('aborted');
  });
});

describe('invoke()：结果归一', () => {
  it('execute() 返回字符串 → 包成 { text, isError:false }', async () => {
    const tool = new EchoTool('s', () => '纯文本');
    const result = await tool.invoke({});
    expect(result).toEqual({ text: '纯文本', isError: false });
  });

  it('execute() 返回 ToolResult → 原样透传', async () => {
    const tool = new EchoTool('r', () => ({ text: '结构化', isError: true }));
    const result = await tool.invoke({});
    expect(result.text).toBe('结构化');
    expect(result.isError).toBe(true);
  });

  it('ToolResult.isError 缺省补 false', async () => {
    const tool = new EchoTool('r2', () => ({ text: 'x' }));
    expect((await tool.invoke({})).isError).toBe(false);
  });

  it('ToolResult.structured 透传', async () => {
    const tool = new EchoTool('r3', () => ({ text: 'x', structured: { n: 1 } }));
    expect((await tool.invoke({})).structured).toEqual({ n: 1 });
  });

  it('execute() 返回 Promise<string> 也正确等待', async () => {
    const tool = new EchoTool('async', async () => '异步结果');
    expect((await tool.invoke({})).text).toBe('异步结果');
  });
});

describe('invoke()：异常归一', () => {
  it('execute() 抛 Error → 归一为 { text: "工具执行失败: …", isError:true }', async () => {
    const tool = new ThrowingTool('boom', '文件不存在');
    const result = await tool.invoke({});
    expect(result.isError).toBe(true);
    expect(result.text).toBe('工具执行失败: 文件不存在');
  });

  it('抛非 Error 值也能归一', async () => {
    class StrThrow extends ToolBase {
      constructor() {
        super({ name: 'strThrow', description: '抛字符串', parameters: { type: 'object', properties: {} } });
      }
      protected override execute(): string {
        throw '裸字符串异常';
      }
    }
    const result = await new StrThrow().invoke({});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('裸字符串异常');
  });

  it('异常不向上抛（不打断 ReAct 循环）', async () => {
    const tool = new ThrowingTool();
    await expect(tool.invoke({})).resolves.toBeDefined();
  });

  it('execute() 违约返回 undefined → 归一为可诊断失败', async () => {
    // 故意违反返回类型契约（用 as never 绕过编译期检查），验证运行期兜底
    class BadReturn extends ToolBase {
      constructor() {
        super({ name: 'badReturn', description: '返回非法值', parameters: { type: 'object', properties: {} } });
      }
      protected override execute(): string {
        return undefined as never;
      }
    }
    const result = await new BadReturn().invoke({});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('非法值');
  });
});

describe('invoke()：观测钩子', () => {
  it('每个出口都触发 onResult 且带 elapsedMs', async () => {
    const seen: Array<{ name: string; result: ToolResult; elapsedMs: number }> = [];
    const tool = new EchoTool('hooked');

    await tool.invoke({}, {}, { onResult: (name, result, elapsedMs) => seen.push({ name, result, elapsedMs }) });
    await tool.invoke(null, {}, { onResult: (name, result, elapsedMs) => seen.push({ name, result, elapsedMs }) });

    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.name === 'hooked')).toBe(true);
    expect(seen.every((s) => typeof s.elapsedMs === 'number' && s.elapsedMs >= 0)).toBe(true);
    expect(seen[0]!.result.isError).toBe(false);
    expect(seen[1]!.result.isError).toBe(true);
  });
});

describe('规格只读性', () => {
  it('toSpec() 返回拷贝，改动不回写工具', () => {
    const tool = new EchoTool('immutable');
    const spec = tool.toSpec();
    spec.description = '被改了';
    expect(tool.description).not.toBe('被改了');
  });

  it('toSpec() 的 annotations 已补全悲观默认', () => {
    const spec = new EchoTool('ann').toSpec();
    expect(spec.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it('构造期 parameters 非 object schema → 立即抛错', () => {
    expect(
      () => new EchoTool('bad', undefined, { type: 'string' }),
    ).toThrow(/type/);
  });
});

describe('辅助函数', () => {
  it('failWith 统一失败文案', () => {
    expect(failWith(new Error('炸了'))).toEqual({ text: '工具执行失败: 炸了', isError: true });
    expect(failWith('炸了')).toEqual({ text: '工具执行失败: 炸了', isError: true });
  });

  it('okResult 构造成功结果', () => {
    expect(okResult('ok')).toEqual({ text: 'ok', isError: false });
    expect(okResult('ok', { n: 1 })).toEqual({ text: 'ok', isError: false, structured: { n: 1 } });
  });
});
