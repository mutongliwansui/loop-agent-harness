/**
 * main 的依赖边界回归（任务 04 / 需求 20261114-004 P2）。
 *
 * 照抄 core/tests/boundary.test.ts 的范式：直接扫源码说明符与 package.json，
 * 静态把「main 只能依赖 core、不能回头依赖主工程 src/」这条分层判据钉死。
 *
 * 为什么需要它：分层一旦被破坏（比如为了复用某个工具函数 `from '../../src/...'`），
 * 类型检查与单测都不会报错，只有靠这种静态扫描才能拦住。
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(MAIN_ROOT, '..');
const SRC_DIR = join(MAIN_ROOT, 'src');

function collectTsFiles(dir: string): string[] {
  const acc: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) acc.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

/** 提取源码里所有模块说明符（import / export from / 副作用 import） */
function specifiersOf(text: string): string[] {
  const specs: string[] = [];
  const fromRe = /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(text)) !== null) specs.push(m[1]);
  const sideRe = /^\s*import\s*['"]([^'"]+)['"]/gm;
  while ((m = sideRe.exec(text)) !== null) specs.push(m[1]);
  return specs;
}

const files = collectTsFiles(SRC_DIR);

describe('boundary：main 的依赖边界', () => {
  it('src 下有源文件（防止断言空转）', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('说明符只允许 ./ ../ node: 与 @loop-agent/core', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        const allowed =
          spec.startsWith('./') ||
          spec.startsWith('../') ||
          spec.startsWith('node:') ||
          spec === '@loop-agent/core';
        if (!allowed) violations.push(`${relative(REPO_ROOT, file)}: ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('零 import 主工程 src/（零反向依赖）', () => {
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const spec of specifiersOf(text)) {
        const resolved = spec.startsWith('.') ? resolve(dirname(file), spec) : '';
        // 相对路径解析结果不得落在 main/ 之外
        if (resolved && !resolved.startsWith(MAIN_ROOT)) {
          violations.push(`${relative(REPO_ROOT, file)}: ${spec} → ${resolved}`);
        }
      }
      // 显式禁止跨包引用主工程
      if (/from\s+['"][^'"]*\bsrc\//.test(text)) {
        violations.push(`${relative(REPO_ROOT, file)}: 引用了主工程 src/`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('不引用 webui / desktop（同属主工程，后续迁移再谈）', () => {
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (/(?:from|import)\s*['"][^'"]*\b(?:webui|desktop)\//.test(text)) {
        violations.push(relative(REPO_ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it('package.json 的 dependencies 只有 @loop-agent/core', () => {
    const pkg = JSON.parse(readFileSync(join(MAIN_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@loop-agent/core']);
  });

  it('tsup 配置了 external: @loop-agent/core（防双副本）', () => {
    const text = readFileSync(join(MAIN_ROOT, 'tsup.config.ts'), 'utf8');
    expect(text).toMatch(/external/);
    expect(text).toMatch(/@loop-agent\/core/);
  });

  it('node_modules/@loop-agent/core 是链接（单副本）', () => {
    const linked = join(REPO_ROOT, 'node_modules', '@loop-agent', 'core');
    expect(existsSync(linked)).toBe(true);
    const stat = lstatSync(linked);
    // Windows Junction 在 lstat 里表现为 symlink
    expect(stat.isSymbolicLink() || stat.isDirectory()).toBe(true);
  });

  it('main 下没有 @loop-agent 依赖副本（双副本会让 instanceof 静默失效）', () => {
    // 注意不能断言「main/node_modules 不存在」：vitest 跑过之后会在里面留
    // .vite / .vite-temp 缓存目录，那是工具缓存、与依赖副本无关。
    expect(existsSync(join(MAIN_ROOT, 'node_modules', '@loop-agent'))).toBe(false);
  });

  it('源码里没有对 core 内部路径的深层 import（只允许包根）', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('@loop-agent/core/')) {
          violations.push(`${relative(REPO_ROOT, file)}: ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
