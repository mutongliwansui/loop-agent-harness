/**
 * 边界断言：把内核对「零三方依赖 / 零反向依赖 / 单副本 / 单 ESM 产物 / 无 TLA」
 * 的承诺从人工遵守变成自动红线（任务 04，D19–D21）。
 *
 * 本文件只做**静态**检查（读源码、读 package.json、读目录树），不起子进程，
 * 因此可以在几十毫秒内跑完，适合放进日常 `npm test`。
 * 真实消费视角的验证在 external-consumer.test.ts（那里必须起子进程）。
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
/** core/ 目录 */
const CORE_ROOT = resolve(HERE, '..');
/** 仓库根（core 的上一级） */
const REPO_ROOT = resolve(CORE_ROOT, '..');
const SRC_DIR = join(CORE_ROOT, 'src');
const DIST_DIR = join(CORE_ROOT, 'dist');

/** 递归收集指定目录下所有 .ts 文件（不进入 node_modules / dist） */
function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * 从一行源码里取出所有模块说明符。
 *
 * 支持三种形态：
 *   import x from 'spec'  /  import type { X } from 'spec'
 *   export { x } from 'spec'  /  export * from 'spec'
 *   import 'spec'（副作用导入）
 *
 * 用逐行正则而非 TS AST（D19）：core 源码风格统一，规则简单可读，
 * 且不需要把 typescript 编译器变成测试的运行时依赖。
 */
function specifiersOfLine(line: string): string[] {
  const specs: string[] = [];
  // import ... from 'spec' | export ... from 'spec'
  const fromRe = /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(line)) !== null) specs.push(m[1]);
  // import 'spec'（无 from 的副作用导入）
  const sideRe = /^\s*import\s*['"]([^'"]+)['"]/;
  const side = sideRe.exec(line);
  if (side) specs.push(side[1]);
  return specs;
}

/** 判断说明符是否「纯净」：相对路径或 node: 内置模块 */
function isPureSpecifier(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('node:');
}

describe('boundary：源码零外部 import、零反向依赖', () => {
  const files = collectTsFiles(SRC_DIR);

  it('core/src 下确实有源文件（防止断言空转）', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('所有模块说明符均以 ./ ../ 或 node: 开头（无裸包名、无绝对路径）', () => {
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        for (const spec of specifiersOfLine(line)) {
          if (!isPureSpecifier(spec)) {
            violations.push(`${relative(REPO_ROOT, file)}: ${spec}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('不 import 主工程 src/（零反向依赖）', () => {
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        for (const spec of specifiersOfLine(line)) {
          // 相对路径解析后若落到 core/ 之外，即越界
          const resolved = resolve(dirname(file), spec);
          if (!resolved.startsWith(CORE_ROOT + sep) && resolved !== CORE_ROOT) {
            violations.push(`${relative(REPO_ROOT, file)}: ${spec} → ${resolved}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('core/src 无顶层 await（保证 CJS require 不会撞 ERR_REQUIRE_ASYNC_MODULE）', () => {
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        // 顶层 await 必然顶格书写；函数体内的 await 有缩进，天然排除
        if (/^await\b/.test(lines[i]) || /^export\s+await\b/.test(lines[i])) {
          violations.push(`${relative(REPO_ROOT, file)}:${i + 1}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('boundary：零运行时依赖', () => {
  const pkg = JSON.parse(readFileSync(join(CORE_ROOT, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;

  it('dependencies 为空对象', () => {
    expect(Object.keys((pkg.dependencies as object | undefined) ?? {})).toEqual([]);
  });

  it('peerDependencies 与 optionalDependencies 也为空', () => {
    expect(Object.keys((pkg.peerDependencies as object | undefined) ?? {})).toEqual([]);
    expect(Object.keys((pkg.optionalDependencies as object | undefined) ?? {})).toEqual([]);
  });

  it('devDependencies 里的东西不得出现在 src 的 import 中（仅构建/测试期使用）', () => {
    const devDeps = Object.keys((pkg.devDependencies as object | undefined) ?? {});
    const used: string[] = [];
    for (const file of collectTsFiles(SRC_DIR)) {
      const text = readFileSync(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        for (const spec of specifiersOfLine(line)) {
          // 裸包名或 @scope/name 才可能是 devDep；相对与 node: 已在上组排掉
          const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
          if (devDeps.includes(name)) used.push(`${relative(REPO_ROOT, file)}: ${spec}`);
        }
      }
    }
    expect(used).toEqual([]);
  });
});

describe('boundary：依赖树中只有一份 @loop-agent/core', () => {
  /**
   * 递归找所有名为 @loop-agent/core 的目录，收集其 realpath（D20）。
   *
   * 命中后**不再下钻**：同一个包的嵌套依赖里若还有同名包，那是它自己的事；
   * 我们要数的是「有几个物理副本」，realpath 去重后即答案。
   */
  function findCoreCopies(dir: string, acc: Set<string>): void {
    if (!existsSync(dir)) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name === '.bin' || entry.name === '.cache' || entry.name.startsWith('.vite')) continue;
      const full = join(dir, entry.name);

      // 当前层就是 @loop-agent/core：记录真实路径，停止下钻
      if (entry.name === 'core' && dir.replace(/[\\/]$/, '').endsWith(`${sep}@loop-agent`)) {
        try {
          acc.add(realpathSync(full));
        } catch {
          acc.add(full);
        }
        continue;
      }

      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (isDir) findCoreCopies(full, acc);
    }
  }

  it('realpath 集合大小为 1，且指向仓库的 core/', () => {
    const copies = new Set<string>();
    findCoreCopies(join(REPO_ROOT, 'node_modules'), copies);

    expect([...copies].length).toBe(1);
    expect([...copies][0]).toBe(realpathSync(CORE_ROOT));
  });

  it('core/ 下不存在自有依赖副本（workspaces 提升生效，允许 vitest 缓存目录）', () => {
    const nm = join(CORE_ROOT, 'node_modules');
    if (!existsSync(nm)) return; // 干净状态：完全没有 node_modules，最理想

    // 实测：vitest 4 仍会在 core/node_modules 下建 .vite / .vite-temp 缓存目录，
    // 尽管 vitest.config.ts 已设 cacheDir: 'dist/.vitest'（该字段对缓存根未生效）。
    // 因此断言口径取「无依赖副本」而非「目录不存在」——否则会被工具缓存误伤，
    // 而真正要防的是「@loop-agent/core 被复制进 core/node_modules」这类嵌套副本。
    const CACHE_ONLY = new Set(['.vite', '.vite-temp', '.cache', '.tmp']);
    const offenders = readdirSync(nm, { withFileTypes: true })
      .filter((e) => !CACHE_ONLY.has(e.name))
      .map((e) => e.name);
    expect(offenders).toEqual([]);

    // 再加一道：绝不能有 @loop-agent 作用域目录（那正是嵌套副本的落点）
    expect(existsSync(join(nm, '@loop-agent'))).toBe(false);
  });
});

describe('boundary：单 ESM 产物', () => {
  it('dist 已构建，且恰好包含 3 个文件', () => {
    // 未构建时给出明确指引，而不是让 3 个断言一起莫名失败
    expect(existsSync(join(DIST_DIR, 'index.js')), '请先运行 npm run build -w @loop-agent/core').toBe(
      true,
    );
    const names = readdirSync(DIST_DIR)
      .filter((n) => !n.startsWith('.'))
      .sort();
    expect(names).toEqual(['index.d.ts', 'index.js', 'index.js.map']);
  });

  it('无 CommonJS 产物（.cjs / .d.cts）与额外 wrapper', () => {
    const names = readdirSync(DIST_DIR);
    const cjsLike = names.filter((n) => /\.(cjs|d\.cts|mjs)$/.test(n) || /^wrapper/i.test(n));
    expect(cjsLike).toEqual([]);
  });

  it('package.json 声明 type: module，且 main/types 指向 dist', () => {
    const pkg = JSON.parse(readFileSync(join(CORE_ROOT, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(pkg.type).toBe('module');
    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.types).toBe('./dist/index.d.ts');
  });
});

describe('boundary：exports 声明解析回归（按设计 4.1② 的实测结论，D21）', () => {
  const pkg = JSON.parse(readFileSync(join(CORE_ROOT, 'package.json'), 'utf8')) as {
    exports: Record<string, Record<string, string>>;
  };
  const dot = pkg.exports['.'];

  it('① index.d.ts 与 index.js 同址同名（这是 types 顺序不构成风险的真正前提）', () => {
    const jsPath = resolve(CORE_ROOT, dot.import);
    const dtsPath = resolve(CORE_ROOT, dot.types);
    expect(dirname(jsPath)).toBe(dirname(dtsPath));
    expect(dtsPath.replace(/\.d\.ts$/, '')).toBe(jsPath.replace(/\.js$/, ''));
    expect(existsSync(jsPath)).toBe(true);
    expect(existsSync(dtsPath)).toBe(true);
  });

  it('② 完全无 types 条件时，同址声明仍可被解析（对应实测 F1）', () => {
    // 这里只能断言「前提成立」：同址声明存在。
    // 「无 types 也能解析」的行为本身需要起 tsc 才能观测，见 external-consumer.test.ts。
    const jsPath = resolve(CORE_ROOT, dot.import);
    const inferredDts = jsPath.replace(/\.js$/, '.d.ts');
    expect(existsSync(inferredDts)).toBe(true);
    expect(resolve(CORE_ROOT, dot.types)).toBe(inferredDts);
  });

  it('③ exports["."] 含 types / import / default 三条件，且 fallback 指向同一实现', () => {
    expect(Object.keys(dot).sort()).toEqual(['default', 'import', 'types']);
    expect(dot.default).toBe(dot.import);
    expect(resolve(CORE_ROOT, dot.types)).toBe(join(DIST_DIR, 'index.d.ts'));
  });

  it('④ 未复活已证伪的「去掉 types 必须报 TS7016」断言', () => {
    // 本测试的存在本身即是记录：core 的产物永远有同址声明，
    // 「无 types + 无同址声明」这种组合在 core 布局下不可达，
    // 因此不写「反向必须报错」的断言（见设计 4.1② 的 C5 vs F1）。
    expect(dot.types).toBeDefined();
  });
});
