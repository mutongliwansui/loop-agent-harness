/**
 * 职责边界：本包**不**做的事，用测试把边界钉住。
 *
 * 这类测试的价值在于「以后有人顺手加功能」时先撞墙：
 * 前缀、去重、排序、权限、超时执行、上下文拼装，都有明确归属。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EchoTool, FakeProvider } from './helpers.js';
import {
  createToolRegistry,
  defineTools,
  DEFAULT_TOOL_TIMEOUT_MS,
  getToolRegistry,
  installTools,
  ToolBase,
  TOOLS_SERVICE_KEYS,
  type JsonSchema,
  type ToolSpec,
} from '../src/index.js';
import { createHost, createRootContext, type EventMapBase } from '@loop-agent/core';

/** 包根目录（本文件在 tests/ 下） */
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function setup() {
  const host = createHost<EventMapBase>();
  const ctx = createRootContext<EventMapBase>(host);
  const fiber = ctx.plugin(installTools());
  await fiber.ready();
  return { host, ctx };
}

describe('不做命名空间前缀（归 MCP 适配器）', () => {
  it('工具名原样保留，不自动拼接提供者 id', async () => {
    const { ctx } = await setup();
    const fiber = ctx.plugin(defineTools({ id: 'mcp-fs', tools: [new EchoTool('readFile')] }));
    await fiber.ready();
    expect(getToolRegistry(ctx).names()).toEqual(['readFile']);
  });
});

describe('不做参数自动补全（模型必须给全）', () => {
  it('缺可选参数时 execute 收到的是原样对象，不注入默认值', async () => {
    const tool = new EchoTool('opts', undefined, {
      type: 'object',
      properties: { a: { type: 'string', default: 'x' } },
    });
    await tool.invoke({});
    expect(tool.calls[0]).toEqual({});
  });
});

describe('不做输出治理（归实现层）', () => {
  it('超长输出原样返回，不截断', async () => {
    const huge = 'x'.repeat(200_000);
    const tool = new EchoTool('huge', () => huge);
    const result = await tool.invoke({});
    expect(result.text).toHaveLength(200_000);
  });
});

describe('不执行权限门禁（归实现层）', () => {
  it('坏注解只是声明，不阻止调用', async () => {
    class Danger extends ToolBase {
      constructor() {
        super({
          name: 'danger',
          description: '危险工具',
          parameters: { type: 'object', properties: {} },
          annotations: { destructiveHint: true, readOnlyHint: false },
        });
      }
      protected override execute(): string {
        return '执行了';
      }
    }
    // 契约层不拦截：是否询问用户由上层（权限门禁）决定
    expect((await new Danger().invoke({})).text).toBe('执行了');
  });
});

describe('不做超时执行（归实现层/宿主）', () => {
  it('DEFAULT_TOOL_TIMEOUT_MS 只是建议值常量', () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('慢工具不会被契约层中断', async () => {
    const tool = new EchoTool('slow', async () => {
      await new Promise((r) => setTimeout(r, 30));
      return 'done';
    });
    expect((await tool.invoke({})).text).toBe('done');
  });
});

describe('不做上下文拼装（归 agent 层）', () => {
  it('ToolInvokeContext 只承载调用方给的信息', async () => {
    const tool = new EchoTool();
    const controller = new AbortController();
    await tool.invoke({}, { signal: controller.signal, metadata: { sessionId: 's1' } });

    const ctx = tool.contexts[0]!;
    expect(ctx.signal).toBe(controller.signal);
    expect(ctx.metadata).toEqual({ sessionId: 's1' });
  });

  it('缺省调用时上下文为空对象（不塞隐藏字段）', async () => {
    const tool = new EchoTool();
    await tool.invoke({});
    expect(tool.contexts[0]).toEqual({});
  });
});

describe('不做工具选择（归模型）', () => {
  it('目录只提供定义，不做任何排序偏好或推荐', async () => {
    const { ctx } = await setup();
    const fiber = ctx.plugin(
      defineTools({ id: 'p', tools: [new EchoTool('zzz'), new EchoTool('aaa')] }),
    );
    await fiber.ready();

    // 输出稳定升序，但这是"确定性"而非"推荐"
    expect(getToolRegistry(ctx).toToolDefs().map((d) => d.name)).toEqual(['aaa', 'zzz']);
  });
});

describe('不持久化（归 main）', () => {
  it('registry 是纯内存，卸载即消失', async () => {
    const { ctx } = await setup();
    const fiber = ctx.plugin(defineTools({ id: 'p', tools: [new EchoTool('mem')] }));
    await fiber.ready();
    await fiber.dispose();

    // 不写文件：重建目录后没有任何遗留
    expect(createToolRegistry().count()).toBe(0);
  });
});

describe('不依赖 llm 包（D2 方向约束）', () => {
  it('JsonSchema 与 ToolSpec 由本包自持', () => {
    const schema: JsonSchema = { type: 'object', properties: {} };
    const spec: ToolSpec = { name: 'x', description: 'd', parameters: schema };
    expect(spec.parameters).toBe(schema);
  });

  it('包的依赖只有 @loop-agent/core', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@loop-agent/core']);
  });
});

describe('服务 key 命名空间', () => {
  it('registry key 与 provider key 前缀不重叠', () => {
    expect(TOOLS_SERVICE_KEYS.registry).toBe('tools:registry');
    expect(TOOLS_SERVICE_KEYS.registry.startsWith('tools:provider:')).toBe(false);
  });
});

describe('提供者与工具的数量关系不受限', () => {
  it('一个提供者可产出大量工具', async () => {
    const { ctx } = await setup();
    const fiber = ctx.plugin(
      defineTools({ id: 'many', tools: new FakeProvider({ id: 'many', count: 50 }) }),
    );
    await fiber.ready();
    expect(getToolRegistry(ctx).count()).toBe(50);
  });

  it('多个提供者可共用一个目录', async () => {
    const { ctx } = await setup();
    const fibers = ['a', 'b', 'c'].map((id) =>
      ctx.plugin(defineTools({ id, tools: [new EchoTool(`${id}-tool`)] })),
    );
    await Promise.all(fibers.map((f) => f.ready()));
    expect(getToolRegistry(ctx).count()).toBe(3);
  });
});

// ─────────────────────────── 源码纯净性与产物契约 ───────────────────────────
// 以下四个 describe 对应方案 6.2/6.3 的硬约束：
// 纯净性、零反向依赖、单 ESM 产物、依赖单副本。与运行期行为无关，纯静态断言。

describe('源码纯净性（零反向依赖）', () => {
  /** 取 src/ 下全部 .ts 文件名 */
  function srcFiles(): string[] {
    return readdirSync(join(PKG_ROOT, 'src')).filter((f) => f.endsWith('.ts'));
  }

  /** 抽取文件内所有 import/export ... from 的来源串 */
  function specifiersOf(file: string): string[] {
    const content = readFileSync(join(PKG_ROOT, 'src', file), 'utf8');
    return [...content.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
  }

  it('src/ 下确有源文件（避免断言对空集合恒真）', () => {
    expect(srcFiles().length).toBeGreaterThan(0);
  });

  it('不引用主工程 src/、webui/、desktop/、main/、llm/', () => {
    const forbidden = ['../../src/', '../../webui/', '../../desktop/', 'src/', 'webui/', 'desktop/', '@loop-agent/main', '@loop-agent/llm'];

    for (const file of srcFiles()) {
      for (const spec of specifiersOf(file)) {
        for (const bad of forbidden) {
          if (spec === bad || spec.startsWith(bad)) {
            throw new Error(`${file} 出现被禁依赖: ${spec}`);
          }
        }
      }
    }
  });

  it('依赖来源只允许 @loop-agent/core、node: 与包内相对路径', () => {
    for (const file of srcFiles()) {
      for (const spec of specifiersOf(file)) {
        const ok =
          spec === '@loop-agent/core' ||
          spec.startsWith('node:') ||
          spec.startsWith('./') ||
          spec.startsWith('../');
        expect(ok, `${file} 出现未授权的依赖来源: ${spec}`).toBe(true);
      }
    }
  });

  it('不从 llm 包导入任何符号（D2：类型自持）', () => {
    // 只检查 import 子句里的真实导入符号：注释中提到 LlmProvider 做口径对比是允许的
    for (const file of srcFiles()) {
      const content = readFileSync(join(PKG_ROOT, 'src', file), 'utf8');
      const named = [
        ...content.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g),
      ];
      for (const [, names, source] of named) {
        expect(source, `${file} 从 llm 包导入了符号`).not.toBe('@loop-agent/llm');
        expect(names ?? '', `${file} 导入了 llm 的 Llm* 符号`).not.toMatch(/\bLlm[A-Z]\w*/);
      }
    }
  });
});

describe('单 ESM 产物契约', () => {
  const distDir = join(PKG_ROOT, 'dist');

  it('dist 恰好 3 个文件（index.js / index.js.map / index.d.ts）', () => {
    expect(existsSync(distDir), 'dist 不存在，请先 npm run build -w @loop-agent/tools').toBe(true);

    const files = readdirSync(distDir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort();

    expect(files).toEqual(['index.d.ts', 'index.js', 'index.js.map']);
  });

  it('无 CJS 产物（不收 .cjs / .d.cts）', () => {
    const cjs = readdirSync(distDir).filter((f) => f.endsWith('.cjs') || f.endsWith('.d.cts'));
    expect(cjs).toEqual([]);
  });

  it('@loop-agent/core 保持 external（不被打包进产物）', () => {
    const code = readFileSync(join(distDir, 'index.js'), 'utf8');
    // external 的表现：产物里保留对 core 的 import
    expect(code).toMatch(/from\s*["']@loop-agent\/core["']/);
    // 且没有把 core 的错误基类实体内联进来
    expect(code).not.toMatch(/class CoreError/);
  });

  it('package.json 契约：exports 指向 dist、type=module、运行时依赖仅 core', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
      name: string;
      type: string;
      exports: Record<string, Record<string, string>>;
      dependencies: Record<string, string>;
    };

    expect(pkg.name).toBe('@loop-agent/tools');
    expect(pkg.type).toBe('module');
    expect(pkg.exports['.']!.types).toBe('./dist/index.d.ts');
    expect(pkg.exports['.']!.import).toBe('./dist/index.js');
    expect(Object.keys(pkg.dependencies)).toEqual(['@loop-agent/core']);
  });
});

describe('依赖单副本', () => {
  it('tools 下无嵌套 @loop-agent 副本（避免 instanceof 分裂）', () => {
    // 注意不能断言 tools/node_modules 整体不存在：vitest 会在此建 .vite 缓存目录。
    // 真正要防的是「npm 在子包下装了第二份 @loop-agent/core」。
    expect(existsSync(join(PKG_ROOT, 'node_modules', '@loop-agent'))).toBe(false);
  });

  it('已加入根 workspaces', () => {
    const rootPkg = JSON.parse(
      readFileSync(resolve(PKG_ROOT, '..', 'package.json'), 'utf8'),
    ) as { workspaces: string[] };
    expect(rootPkg.workspaces).toContain('tools');
  });
});
