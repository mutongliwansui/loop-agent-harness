/**
 * 外部消费视角：从**构建产物**（dist）导入，验证发布出去的东西真能用。
 *
 * 与其它测试的区别：其它测试 import `../src/index.js`（源码，走 vitest 转译），
 * 这里 import 包名，命中 `package.json` 的 exports → `dist/index.js`。
 * 这条链路正是第三方用户会走的那条，能同时验证 tsup 产物与 d.ts 出口。
 *
 * 前提：先 `npm run build -w @loop-agent/tools`（CI 里 test 前会构建）。
 */

import { describe, expect, it } from 'vitest';

import {
  createToolRegistry,
  defineTools,
  failWith,
  okResult,
  ToolBase,
  ToolProvider,
  TOOLS_SERVICE_KEYS,
  ToolsError,
  type JsonSchema,
  type ToolDefView,
  type ToolResult,
  type ToolSpec,
} from '@loop-agent/tools';

/** 第三方最典型的写法：继承基类、只实现 execute() */
class UpperTool extends ToolBase {
  constructor() {
    super({
      name: 'upper',
      description: '把输入转成大写',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      } satisfies JsonSchema,
    });
  }

  protected override execute(args: { text?: string }): string {
    return String(args.text ?? '').toUpperCase();
  }
}

describe('从 dist 导入即可用', () => {
  it('继承 ToolBase 并调用', async () => {
    const tool = new UpperTool();
    expect(await tool.invoke({ text: 'abc' })).toEqual({ text: 'ABC', isError: false });
  });

  it('toSpec() 产出可用规格', () => {
    const spec: ToolSpec = new UpperTool().toSpec();
    expect(spec.name).toBe('upper');
    expect(spec.parameters).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
  });

  it('defineTools 编译出插件形状', () => {
    const plugin = defineTools({ id: 'ext', tools: [new UpperTool()] });
    // inject 是 string[] | { required?, optional? } 联合，取数组形态再判断
    const required = Array.isArray(plugin.inject) ? plugin.inject : plugin.inject?.required;
    expect(required).toContain(TOOLS_SERVICE_KEYS.registry);
  });

  it('目录可以脱离插件系统独立使用', async () => {
    const registry = createToolRegistry();
    registry.register(new UpperTool());

    const defs: ToolDefView[] = registry.toToolDefs();
    expect(defs).toHaveLength(1);

    const result: ToolResult = await registry.invoke('upper', { text: 'hi' });
    expect(result.text).toBe('HI');
  });

  it('辅助函数可用', () => {
    expect(okResult('a').isError).toBe(false);
    expect(failWith(new Error('b')).text).toContain('b');
  });

  it('继承 ToolProvider 并产出工具', async () => {
    class ExtProvider extends ToolProvider {
      readonly id = 'ext-provider';
      override readonly displayName = '外部提供者';
      create(_options: Record<string, unknown>): ToolBase[] {
        return [new UpperTool()];
      }
    }
    // create(options) 的 options 必传（契约要求的「合并后配置」形参）
    const tools = await new ExtProvider().create({});
    expect(tools.map((t) => t.name)).toEqual(['upper']);
  });

  it('错误族可从包外 instanceof 判定', () => {
    const registry = createToolRegistry();
    registry.register(new UpperTool());

    try {
      registry.register(new UpperTool());
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolsError);
    }
  });
});

describe('发布产物完整性', () => {
  it('package.json 的 main/types/exports 均指向 dist', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { main?: string; types?: string; exports?: Record<string, unknown> };

    // ESM 由 type:module + main 表达，不另设 module 字段（与 core/llm 同口径）
    expect(pkg.main).toContain('dist/');
    expect(pkg.types).toContain('dist/');
    expect(pkg.exports).toBeDefined();
    expect(JSON.stringify(pkg.exports)).toContain('dist/');
  });

  it('产物是 ESM（type: module + .js 后缀）', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { type?: string };
    expect(pkg.type).toBe('module');
  });
});
