/**
 * 边界回归：把「llm 只依赖 core、只出单 ESM、零三方运行时依赖」这三条
 * 硬约束变成可执行断言，防止后续改动悄悄破坏分层。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

/** llm 包根目录（本文件在 tests/ 下） */
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('产物边界', () => {
  it('dist 恰好 3 个文件：index.js / index.d.ts / index.js.map', () => {
    const dist = join(PKG_ROOT, 'dist');
    expect(existsSync(dist), 'dist 不存在，请先 npm run build -w @loop-agent/llm').toBe(true);

    const files = readdirSync(dist, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort();

    expect(files).toEqual(['index.d.ts', 'index.js', 'index.js.map']);
  });

  it('无 CJS 产物（只收 ESM）', () => {
    const dist = join(PKG_ROOT, 'dist');
    const files = readdirSync(dist).filter((f) => f.endsWith('.cjs') || f.endsWith('.d.cts'));
    expect(files).toEqual([]);
  });

  it('@loop-agent/core 保持 external（不打包进产物）', () => {
    const code = readFileSync(join(PKG_ROOT, 'dist', 'index.js'), 'utf8');
    // external 的表现：产物里保留对 core 的 import 语句
    expect(code).toMatch(/from\s+["']@loop-agent\/core["']/);
    // 且没有把 CoreError 等类的实现内联进来（内联会出现 class CoreError）
    expect(code).not.toMatch(/class CoreError/);
  });
});

describe('package.json 契约', () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
    name: string;
    type: string;
    exports: Record<string, Record<string, string>>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it('包名与类型', () => {
    expect(pkg.name).toBe('@loop-agent/llm');
    expect(pkg.type).toBe('module');
  });

  it('exports 三个键齐备且都指向 ESM 产物', () => {
    const entry = pkg.exports['.'];
    expect(entry).toBeDefined();
    expect(Object.keys(entry!).sort()).toEqual(['default', 'import', 'types']);
    expect(entry!.types).toBe('./dist/index.d.ts');
    expect(entry!.import).toBe('./dist/index.js');
    expect(entry!.default).toBe('./dist/index.js');
  });

  it('运行时依赖只有 @loop-agent/core（零三方依赖）', () => {
    expect(Object.keys(pkg.dependencies)).toEqual(['@loop-agent/core']);
  });

  it('devDependencies 不含运行时泄漏（只允许构建/测试工具）', () => {
    const allowed = new Set(['tsup', 'typescript', 'vitest']);
    for (const dep of Object.keys(pkg.devDependencies)) {
      expect(allowed.has(dep), `未预期的 devDependency: ${dep}`).toBe(true);
    }
  });
});

describe('零反向依赖', () => {
  it('src/** 不 import 主工程或上层包', () => {
    const srcDir = join(PKG_ROOT, 'src');
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    const forbidden = [
      '@loop-agent/main', // 只能依赖 core
      '../../src/', // 主工程源码
      '../../webui/',
      '../../desktop/',
      'src/', // 裸相对主工程
      'webui/',
      'desktop/',
    ];

    for (const file of files) {
      const content = readFileSync(join(srcDir, file), 'utf8');
      // 只检查 import/export ... from 的目标串
      const specifiers = [...content.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const spec of specifiers) {
        for (const bad of forbidden) {
          if (spec === bad || spec.startsWith(bad)) {
            throw new Error(`${file} 出现被禁依赖: ${spec}`);
          }
        }
      }
    }
  });

  it('src/** 只从 @loop-agent/core 与 node: 或相对路径取依赖', () => {
    const srcDir = join(PKG_ROOT, 'src');
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));

    for (const file of files) {
      const content = readFileSync(join(srcDir, file), 'utf8');
      const specifiers = [...content.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const spec of specifiers) {
        const ok =
          spec === '@loop-agent/core' ||
          spec.startsWith('node:') ||
          spec.startsWith('./') ||
          spec.startsWith('../');
        expect(ok, `${file} 出现未授权的依赖来源: ${spec}`).toBe(true);
      }
    }
  });
});

describe('根 workspaces 链接', () => {
  it('llm 已加入根 workspaces', () => {
    const rootPkg = JSON.parse(
      readFileSync(resolve(PKG_ROOT, '..', 'package.json'), 'utf8'),
    ) as { workspaces: string[] };
    expect(rootPkg.workspaces).toContain('llm');
  });

  it('core 为单副本（llm 下无嵌套 @loop-agent 副本）', () => {
    // 注意：不能断言 llm/node_modules 整体不存在 —— vitest 会在这里建
    // .vite / .vite-temp 缓存目录（与依赖副本无关）。真正要防的是
    // 「npm 在子包下装了第二份 @loop-agent/core」，那会让 instanceof 分裂。
    expect(existsSync(join(PKG_ROOT, 'node_modules', '@loop-agent'))).toBe(false);
  });
});

describe('产物可被 Node 直接导入', () => {
  it('ESM 产物能 import 出核心符号', () => {
    // 用子进程验证，避免污染当前测试进程的模块缓存。
    // 注意：Windows 下绝对路径必须转成 file:// URL，否则 Node 的 ESM 加载器
    // 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME（收到 protocol 'd:'）。
    const entryUrl = pathToFileURL(join(PKG_ROOT, 'dist', 'index.js')).href;
    const script = `
      const m = await import(${JSON.stringify(entryUrl)});
      const need = ['LlmProvider','defineLlmProvider','defineLlmProviderFactory','installLlm','createLlmRegistry','LlmError','LLM_SERVICE_KEYS'];
      const missing = need.filter((k) => m[k] === undefined);
      if (missing.length) { console.error('missing: ' + missing.join(',')); process.exit(1); }
      console.log('ok');
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('ok');
  });
});
