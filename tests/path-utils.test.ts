/**
 * 工作空间路径规范化测试（Task-20261021-010-01 验收 6.1.1 ~ 6.1.4）
 *
 * 覆盖：
 * - 6.1.1 同一目录的不同书写形式（尾斜杠 / 大小写 / 分隔符）收敛为同一字符串
 * - 6.1.2 'D:' → 'D:\'；不存在目录不抛错
 * - 6.1.3 isSameWorkspace：win32 大小写/分隔符不敏感，POSIX 严格
 * - 6.1.4 workspaceId() 公式未被修改（sha256 前 16 位，D2 存量零迁移前提）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  canonicalWorkspacePath,
  isSameWorkspace,
  lexicalWorkspacePath,
} from '../src/session/path-utils.js';
import { workspaceId } from '../src/session/index.js';

const isWin = process.platform === 'win32';
const ROOT = join(tmpdir(), 'loop-agent-tests', 'test-path-utils');
const DIR = join(ROOT, 'proj');

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // Windows 目录句柄释放有延迟：残留临时目录不影响测试结果
  }
});

describe('canonicalWorkspacePath', () => {
  it('6.1.1 同一目录的不同书写形式收敛为同一字符串', async () => {
    const base = await canonicalWorkspacePath(DIR);
    expect(await canonicalWorkspacePath(`${DIR}${sep}`)).toBe(base);
    expect(await canonicalWorkspacePath(`  ${DIR}  `)).toBe(base);

    if (isWin) {
      // 磁盘真实大小写（realpath）与分隔符差异
      expect(await canonicalWorkspacePath(DIR.toUpperCase())).toBe(base);
      expect(await canonicalWorkspacePath(DIR.replace(/\\/g, '/'))).toBe(base);
    }
  });

  it('6.1.2 盘符特例：D: / d:\\ → D:\\（win32）', async () => {
    if (!isWin) {
      // POSIX 无盘符概念：'/' 保持自身
      expect(await canonicalWorkspacePath('/')).toBe('/');
      return;
    }
    expect(await canonicalWorkspacePath('D:')).toBe('D:\\');
    expect(await canonicalWorkspacePath('d:\\')).toBe('D:\\');
    expect(await canonicalWorkspacePath(' D: ')).toBe('D:\\');
  });

  it('6.1.2 不存在目录不抛错（回退词法绝对路径）', async () => {
    const ghost = join(DIR, 'not-exist', 'deeper');
    await expect(canonicalWorkspacePath(ghost)).resolves.toBe(lexicalWorkspacePath(ghost));
  });

  it('相对路径基于服务端 cwd 绝对化', async () => {
    const rel = 'some-relative-dir-for-path-utils-test';
    const got = await canonicalWorkspacePath(rel);
    expect(got).toBe(lexicalWorkspacePath(rel));
    expect(got.startsWith(sep) || /^[A-Za-z]:/.test(got)).toBe(true);
  });

  it('不做大小写折叠（大小写不同 → 词法结果不同；D2）', () => {
    if (!isWin) return;
    // canonical 依赖 realpath 取真实大小写，但 lexical 层不做折叠：不存在目录时保留原始大小写
    const a = lexicalWorkspacePath('D:\\GhostDir\\X');
    const b = lexicalWorkspacePath('d:\\ghostdir\\x');
    expect(a).not.toBe(b);
  });
});

describe('isSameWorkspace', () => {
  it('6.1.3 win32 忽略大小写/分隔符，POSIX 严格相等', () => {
    if (isWin) {
      expect(isSameWorkspace('D:\\proj', 'd:/PROJ')).toBe(true);
      expect(isSameWorkspace('D:\\proj\\', 'D:\\proj')).toBe(true);
      expect(isSameWorkspace('D:\\proj', 'D:\\proj2')).toBe(false);
    } else {
      expect(isSameWorkspace('/tmp/a', '/tmp/a')).toBe(true);
      expect(isSameWorkspace('/tmp/a', '/tmp/A')).toBe(false);
      expect(isSameWorkspace('/tmp/a', '/tmp/a/')).toBe(false);
    }
  });
});

describe('workspaceId', () => {
  it('6.1.4 公式未变：sha256(原始串) 前 16 位', () => {
    const raws = ['D:\\demo\\path', '/tmp/demo', ''];
    for (const raw of raws) {
      expect(workspaceId(raw)).toBe(createHash('sha256').update(raw).digest('hex').slice(0, 16));
    }
  });
});
