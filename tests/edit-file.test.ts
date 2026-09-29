/**
 * editFile 工具单元测试：字面替换 / 唯一匹配保护 / replaceAll / 边界与健壮性
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { editFile } from '../src/tools/editFile.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';

const DIR = join(tmpdir(), 'loop-agent-tests', 'test-edit-file');
const file = (name: string): string => join(DIR, name);

function seed(name: string, content: string): string {
  const p = file(name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

describe('editFile 工具', () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it('唯一匹配时成功替换', async () => {
    const p = seed('a.txt', 'hello world');
    const r = await editFile.execute({ path: p, oldText: 'world', newText: 'there' });
    expect(readFileSync(p, 'utf-8')).toBe('hello there');
    expect(r).toContain('已编辑');
    expect(r).toContain('替换 1 处');
  });

  it('未找到匹配文本时报错', async () => {
    const p = seed('b.txt', 'abc');
    await expect(
      editFile.execute({ path: p, oldText: 'xyz', newText: 'q' }),
    ).rejects.toThrow(/未在/);
  });

  it('多处匹配且未开启 replaceAll 时报错，且不改动文件', async () => {
    const p = seed('c.txt', 'a a a');
    await expect(
      editFile.execute({ path: p, oldText: 'a', newText: 'b' }),
    ).rejects.toThrow(/3 处/);
    expect(readFileSync(p, 'utf-8')).toBe('a a a');
  });

  it('replaceAll=true 时替换全部匹配', async () => {
    const p = seed('d.txt', 'a a a');
    const r = await editFile.execute({
      path: p,
      oldText: 'a',
      newText: 'b',
      replaceAll: true,
    });
    expect(readFileSync(p, 'utf-8')).toBe('b b b');
    expect(r).toContain('替换 3 处');
  });

  it('支持跨行文本替换', async () => {
    const p = seed('e.txt', 'line1\nline2\nline3');
    await editFile.execute({ path: p, oldText: 'line1\nline2', newText: 'X' });
    expect(readFileSync(p, 'utf-8')).toBe('X\nline3');
  });

  it('newText 中的 $ 特殊字符按字面写入（不被当作替换模式）', async () => {
    const p = seed('f.txt', 'price=100');
    await editFile.execute({ path: p, oldText: '100', newText: '$&$1' });
    expect(readFileSync(p, 'utf-8')).toBe('price=$&$1');
  });

  it('支持中文文本替换', async () => {
    const p = seed('g.txt', '模型名称：gpt-4o-mini');
    await editFile.execute({
      path: p,
      oldText: 'gpt-4o-mini',
      newText: 'deepseek-chat',
    });
    expect(readFileSync(p, 'utf-8')).toBe('模型名称：deepseek-chat');
  });

  it('oldText 为空时报错', async () => {
    const p = seed('h.txt', 'abc');
    await expect(
      editFile.execute({ path: p, oldText: '', newText: 'x' }),
    ).rejects.toThrow(/oldText 不能为空/);
  });

  it('文件不存在时报错', async () => {
    await expect(
      editFile.execute({ path: file('nope.txt'), oldText: 'a', newText: 'b' }),
    ).rejects.toThrow(/无法读取文件/);
  });
});

describe('editFile 工具 - 正则模式（regex=true）', () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it('按正则替换匹配内容', async () => {
    const p = seed('r1.txt', 'port=8080');
    const r = await editFile.execute({
      path: p,
      oldText: '\\d+',
      newText: '9090',
      regex: true,
    });
    expect(readFileSync(p, 'utf-8')).toBe('port=9090');
    expect(r).toContain('正则替换 1 处');
  });

  it('支持 $1 捕获组引用', async () => {
    const p = seed('r2.txt', '联系 alice@example.com');
    await editFile.execute({
      path: p,
      oldText: '(\\w+)@example\\.com',
      newText: '$1@corp.com',
      regex: true,
    });
    expect(readFileSync(p, 'utf-8')).toBe('联系 alice@corp.com');
  });

  it('flags="i" 时忽略大小写', async () => {
    const p = seed('r3.txt', 'Hello HELLO hello');
    const r = await editFile.execute({
      path: p,
      oldText: 'hello',
      newText: 'hi',
      regex: true,
      flags: 'i',
      replaceAll: true,
    });
    expect(readFileSync(p, 'utf-8')).toBe('hi hi hi');
    expect(r).toContain('flags: ig');
  });

  it('正则多处匹配且未开 replaceAll 时报错，且不改动文件', async () => {
    const p = seed('r4.txt', '1 2 3');
    await expect(
      editFile.execute({ path: p, oldText: '\\d', newText: 'x', regex: true }),
    ).rejects.toThrow(/匹配 3 处/);
    expect(readFileSync(p, 'utf-8')).toBe('1 2 3');
  });

  it('正则 + replaceAll=true 替换全部匹配', async () => {
    const p = seed('r5.txt', 'a1 b2 c3');
    const r = await editFile.execute({
      path: p,
      oldText: '\\d',
      newText: '#',
      regex: true,
      replaceAll: true,
    });
    expect(readFileSync(p, 'utf-8')).toBe('a# b# c#');
    expect(r).toContain('正则替换 3 处');
  });

  it('正则未匹配时报错', async () => {
    const p = seed('r6.txt', 'abc');
    await expect(
      editFile.execute({ path: p, oldText: '\\d+', newText: 'x', regex: true }),
    ).rejects.toThrow(/未在/);
  });

  it('非法正则时报错', async () => {
    const p = seed('r7.txt', 'abc');
    await expect(
      editFile.execute({ path: p, oldText: '(', newText: 'x', regex: true }),
    ).rejects.toThrow(/正则表达式或 flags 非法/);
  });

  it('regex=false（默认）时 $ 仍按字面写入', async () => {
    const p = seed('r8.txt', 'value');
    await editFile.execute({ path: p, oldText: 'value', newText: '$1$&' });
    expect(readFileSync(p, 'utf-8')).toBe('$1$&');
  });
});

describe('editFile 工具 - 行范围整段替换（startLine/endLine）', () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it('把指定行整段替换为 newText（无需 oldText）', async () => {
    const p = seed('l1.txt', 'l1\nl2\nl3');
    const r = await editFile.execute({
      path: p,
      startLine: 2,
      endLine: 2,
      newText: 'X',
    });
    expect(readFileSync(p, 'utf-8')).toBe('l1\nX\nl3');
    expect(r).toContain('整段替换第 2-2 行');
  });

  it('多行区间替换为单行', async () => {
    const p = seed('l2.txt', 'l1\nl2\nl3\nl4');
    await editFile.execute({
      path: p,
      startLine: 2,
      endLine: 3,
      newText: 'X',
    });
    expect(readFileSync(p, 'utf-8')).toBe('l1\nX\nl4');
  });

  it('单行替换为多行', async () => {
    const p = seed('l3.txt', 'a\nb\nc');
    await editFile.execute({
      path: p,
      startLine: 2,
      endLine: 2,
      newText: 'x\ny\nz',
    });
    expect(readFileSync(p, 'utf-8')).toBe('a\nx\ny\nz\nc');
  });

  it('newText 为空字符串时删除这些行', async () => {
    const p = seed('l4.txt', 'a\nb\nc');
    const r = await editFile.execute({
      path: p,
      startLine: 2,
      endLine: 2,
      newText: '',
    });
    expect(readFileSync(p, 'utf-8')).toBe('a\nc');
    expect(r).toContain('1 行 → 0 行');
  });

  it('提供 oldText 且范围内匹配时校验通过', async () => {
    const p = seed('l5.txt', 'l1\nl2\nl3');
    await editFile.execute({
      path: p,
      startLine: 2,
      endLine: 2,
      oldText: 'l2',
      newText: 'X',
    });
    expect(readFileSync(p, 'utf-8')).toBe('l1\nX\nl3');
  });

  it('提供 oldText 但范围内不匹配时报错，且不改动文件', async () => {
    const p = seed('l6.txt', 'l1\nl2\nl3');
    await expect(
      editFile.execute({
        path: p,
        startLine: 2,
        endLine: 2,
        oldText: 'zzz',
        newText: 'X',
      }),
    ).rejects.toThrow(/不匹配/);
    expect(readFileSync(p, 'utf-8')).toBe('l1\nl2\nl3');
  });

  it('行号超出文件范围时报错', async () => {
    const p = seed('l7.txt', 'a\nb\nc');
    await expect(
      editFile.execute({ path: p, startLine: 5, endLine: 6, newText: 'X' }),
    ).rejects.toThrow(/超出文件范围/);
  });

  it('只传 startLine 不传 endLine 时报错', async () => {
    const p = seed('l8.txt', 'a\nb\nc');
    await expect(
      editFile.execute({ path: p, startLine: 1, newText: 'X' }),
    ).rejects.toThrow(/必须同时指定/);
  });

  it('未指定行范围且缺少 oldText 时报错', async () => {
    const p = seed('l9.txt', 'abc');
    await expect(
      editFile.execute({ path: p, newText: 'X' }),
    ).rejects.toThrow(/oldText 不能为空/);
  });
});
