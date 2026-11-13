import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBackend, BackendNotFoundError, BACKEND_EXE_NAME } from '../desktop/src/backend-path';

/**
 * 后端路径解析（D1-5）单测。
 *
 * 用临时目录构造三种真实布局，断言查找顺序与失败时的可读错误。
 * join 采用 node:path 默认实现（测试跑在本机文件系统上）。
 */
function makeTree(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'loopagent-desktop-path-'));
  for (const rel of files) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '');
  }
  return root;
}

describe('resolveBackend：打包布局', () => {
  it('优先命中 resources/loop-agent-core.exe', () => {
    const root = makeTree([`resources/${BACKEND_EXE_NAME}`]);
    try {
      const target = resolveBackend({
        isPackaged: true,
        resourcesPath: join(root, 'resources'),
        exeDir: root,
        repoRoot: root,
      });
      expect(target.kind).toBe('exe');
      expect(target).toMatchObject({ exePath: join(root, 'resources', BACKEND_EXE_NAME) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('便携布局：后端与壳同级的 loop-agent-core.exe 也能命中', () => {
    const root = makeTree([BACKEND_EXE_NAME]);
    try {
      const target = resolveBackend({
        isPackaged: true,
        resourcesPath: join(root, 'resources-does-not-exist'),
        exeDir: root,
        repoRoot: root,
      });
      expect(target).toMatchObject({ kind: 'exe', exePath: join(root, BACKEND_EXE_NAME) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveBackend：开发期布局', () => {
  it('命中 dist-sea/loop-agent.exe', () => {
    const root = makeTree([join('dist-sea', 'loop-agent.exe')]);
    try {
      const target = resolveBackend({
        isPackaged: false,
        resourcesPath: join(root, 'resources'),
        exeDir: root,
        repoRoot: root,
      });
      expect(target).toMatchObject({ kind: 'exe', exePath: join(root, 'dist-sea', 'loop-agent.exe') });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('无 dist-sea 但存在 src/index.ts 时回落 tsx', () => {
    const root = makeTree([join('src', 'index.ts')]);
    try {
      const target = resolveBackend({
        isPackaged: false,
        resourcesPath: join(root, 'resources'),
        exeDir: root,
        repoRoot: root,
      });
      expect(target).toMatchObject({
        kind: 'tsx',
        entryPath: join(root, 'src', 'index.ts'),
        repoRoot: root,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('打包后不回落 tsx（安装环境没有源码）', () => {
    const root = makeTree([join('src', 'index.ts')]);
    try {
      expect(() =>
        resolveBackend({
          isPackaged: true,
          resourcesPath: join(root, 'resources'),
          exeDir: root,
          repoRoot: root,
        }),
      ).toThrow(BackendNotFoundError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveBackend：失败路径', () => {
  it('全都找不到时抛 BackendNotFoundError，并附全部已查找路径', () => {
    const root = mkdtempSync(join(tmpdir(), 'loopagent-desktop-empty-'));
    try {
      let caught: unknown;
      try {
        resolveBackend({
          isPackaged: false,
          resourcesPath: join(root, 'resources'),
          exeDir: join(root, 'exe'),
          repoRoot: root,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BackendNotFoundError);
      const err = caught as BackendNotFoundError;
      // 开发期会依次查：便携同级 → dist-sea → src/index.ts（打包态才查 resources/）
      expect(err.searched).toContain(join(root, 'exe', BACKEND_EXE_NAME));
      expect(err.searched).toContain(join(root, 'dist-sea', 'loop-agent.exe'));
      expect(err.searched).toContain(join(root, 'src', 'index.ts'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
