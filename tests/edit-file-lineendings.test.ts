/**
 * Task-20261023-001：editFile 行尾归一化测试
 * 覆盖：CRLF/混合行尾匹配与写回、偏移映射写回字节级保留、replaceAll 索引、
 * 行范围/正则模式行尾适配、失配诊断（mtime/首个差异行/近似候选）。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { editFile } from '../src/tools/editFile.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';

const DIR = join(tmpdir(), 'loop-agent-tests', 'test-edit-file-lineendings');
const file = (name: string): string => join(DIR, name);

function seed(name: string, content: string): string {
  const p = file(name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

/** 读原始内容（不做任何行尾转换） */
function raw(p: string): string {
  return readFileSync(p, 'utf-8');
}

describe('line-endings 基础函数', () => {
  it('detectEol：CRLF 占优返回 CRLF，LF 占优返回 LF，无换行返回 LF', async () => {
    const m = await import('../src/tools/line-endings.js');
    expect(m.detectEol('a\r\nb\r\nc')).toBe('\r\n');
    expect(m.detectEol('a\nb\nc')).toBe('\n');
    expect(m.detectEol('a\r\nb\nc\r\nd')).toBe('\r\n'); // 2 CRLF vs 1 LF
    expect(m.detectEol('no newline')).toBe('\n');
  });

  it('adaptEol：把 \\n 统一为 CRLF；裸 \\r 不动', async () => {
    const m = await import('../src/tools/line-endings.js');
    expect(m.adaptEol('a\nb', '\r\n')).toBe('a\r\nb');
    expect(m.adaptEol('a\r\nb', '\n')).toBe('a\nb');
    expect(m.adaptEol('a\rb', '\r\n')).toBe('a\rb'); // 裸 \r 保留
    expect(m.adaptEol('no newline', '\r\n')).toBe('no newline');
  });

  it('firstDiffLine：定位首个差异行并给出期望/实际', async () => {
    const m = await import('../src/tools/line-endings.js');
    const d = m.firstDiffLine('line1\nline2\nline3', 'line1\nLINE2\nline3');
    expect(d).not.toBeNull();
    expect(d?.line).toBe(2);
    expect(d?.expected).toBe('LINE2');
    expect(d?.actual).toBe('line2');
    expect(m.firstDiffLine('same', 'same')).toBeNull();
  });

  it('similarCandidates：首行 ≥8 字符才给候选，最多 3 处 ±2 行', async () => {
    const m = await import('../src/tools/line-endings.js');
    const content = 'x\nconst value = 1;\ny\nconst value = 1;\nz\nconst value = 1;\nw';
    const c = m.similarCandidates(content, 'const value = 2;\nother line');
    expect(c.length).toBe(3);
    expect(c[0]).toContain('第 2 行附近');
    expect(m.similarCandidates('abc\nshort', 'ab\ncd')).toEqual([]);
  });
});

describe('editFile 字面量模式行尾归一化（P0/P1）', () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it('LF 多行 oldText 匹配 CRLF 文件，替换段写回 CRLF', async () => {
    const p = seed('crlf.ts', 'function a() {\r\n  return 1;\r\n}\r\n');
    const r = await editFile.execute({
      path: p,
      oldText: 'function a() {\n  return 1;\n}',
      newText: 'function b() {\n  return 2;\n}',
    });
    expect(r).toContain('已编辑');
    expect(raw(p)).toBe('function b() {\r\n  return 2;\r\n}\r\n');
  });

  it('CRLF oldText 匹配 LF 文件（反向归一化）', async () => {
    const p = seed('lf.ts', 'a\nb\nc');
    const r = await editFile.execute({ path: p, oldText: 'a\r\nb', newText: 'X' });
    expect(r).toContain('已编辑');
    expect(raw(p)).toBe('X\nc');
  });

  it('混合行尾文件：未触及区域字节级保留，替换段用主导行尾', async () => {
    const p = seed('mixed.ts', 'a\r\nKEEP\r\nb\nreplace me\nc\r\nTAIL\r\n');
    const r = await editFile.execute({
      path: p,
      oldText: 'replace me',
      newText: 'NEW\nLINE',
    });
    expect(r).toContain('已编辑');
    // 未触及的 \r\n 与 \n 全部原样；替换段（2 行 → 1 处 CRLF 分隔）用主导行尾 CRLF
    expect(raw(p)).toBe('a\r\nKEEP\r\nb\nNEW\r\nLINE\nc\r\nTAIL\r\n');
  });

  it('replaceAll 多处替换：偏移映射索引正确', async () => {
    const p = seed('multi.ts', 'v=1;\r\nv=2;\r\nv=1;\r\n');
    const r = await editFile.execute({
      path: p,
      oldText: 'v=1;',
      newText: 'w=9;',
      replaceAll: true,
    });
    expect(r).toContain('替换 2 处');
    expect(raw(p)).toBe('w=9;\r\nv=2;\r\nw=9;\r\n');
  });

  it('多处匹配且未开 replaceAll 仍报错，且不改动文件', async () => {
    const p = seed('dup.ts', 'a\r\nb\r\na\r\n');
    await expect(
      editFile.execute({ path: p, oldText: 'a', newText: 'z' }),
    ).rejects.toThrow(/出现 2 处/);
    expect(raw(p)).toBe('a\r\nb\r\na\r\n');
  });

  it('行范围模式：CRLF 文件整段替换保持 CRLF、newText 多行适配', async () => {
    const p = seed('range.ts', 'l1\r\nl2\r\nl3\r\n');
    const r = await editFile.execute({
      path: p,
      startLine: 2,
      endLine: 2,
      newText: 'n2a\nn2b',
    });
    expect(r).toContain('整段替换');
    expect(raw(p)).toBe('l1\r\nn2a\r\nn2b\r\nl3\r\n');
  });

  it('行范围模式：CRLF 文件提供 LF 多行 oldText 校验通过', async () => {
    const p = seed('range-check.ts', 'l1\r\nl2\r\nl3\r\n');
    const r = await editFile.execute({
      path: p,
      startLine: 1,
      endLine: 2,
      oldText: 'l1\nl2',
      newText: 'x',
    });
    expect(r).toContain('已编辑');
    expect(raw(p)).toBe('x\r\nl3\r\n');
  });

  it('正则模式：匹配语义不变，newText 行尾适配主导行尾', async () => {
    const p = seed('regex.ts', 'v=1\r\nv=2\r\n');
    const r = await editFile.execute({
      path: p,
      oldText: 'v=\\d',
      newText: 'v=X\nY',
      regex: true,
      replaceAll: true,
    });
    expect(r).toContain('正则替换 2 处');
    expect(raw(p)).toBe('v=X\r\nY\r\nv=X\r\nY\r\n');
  });

  it('归一化仍失配 + 文件未被本进程改过：报未找到 + 首个差异行 + 近似候选', async () => {
    const p = seed('miss.ts', 'alpha one\r\nbeta two\r\ngamma three\r\n');
    const err = await editFile
      .execute({ path: p, oldText: 'alpha onx\nbeta two', newText: 'z' })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('未在');
    expect(msg).toContain('要替换的文本');
    expect(msg).not.toContain('未找到');
    expect(msg).toContain('首个差异在第 1 行');
    expect(msg).toContain('期望: alpha onx');
    expect(msg).toContain('实际: alpha one');
    expect(msg).toContain('近似候选');
    expect(msg).not.toContain('并发修改');
    // 文件未被改动
    expect(raw(p)).toBe('alpha one\r\nbeta two\r\ngamma three\r\n');
  });
});
