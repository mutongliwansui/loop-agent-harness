/**
 * fileRead 工具单元测试：行号输出（默认开启 / 可关闭）与部分读取行号
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { fileRead } from '../src/tools/fileRead.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const DIR = join(tmpdir(), 'loop-agent-tests', 'test-file-read');
const file = (name: string): string => join(DIR, name);

function seed(name: string, content: string): string {
  const p = file(name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

describe('fileRead 工具', () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it('全文读取默认带行号', async () => {
    const p = seed('a.txt', 'alpha\nbeta\ngamma');
    const r = await fileRead.execute({ path: p });
    expect(r).toBe('1: alpha\n2: beta\n3: gamma');
  });

  it('lineNumbers=false 返回原始内容', async () => {
    const p = seed('b.txt', 'alpha\nbeta');
    const r = await fileRead.execute({ path: p, lineNumbers: false });
    expect(r).toBe('alpha\nbeta');
  });

  it('部分读取使用文件真实行号', async () => {
    const p = seed('c.txt', 'l1\nl2\nl3\nl4\nl5');
    const r = await fileRead.execute({ path: p, startLine: 3, endLine: 4 });
    expect(r).toContain('第 3-4 行（共 5 行）');
    expect(r).toContain('3: l3\n4: l4');
  });

  it('部分读取可关闭行号', async () => {
    const p = seed('d.txt', 'l1\nl2\nl3');
    const r = await fileRead.execute({
      path: p,
      startLine: 1,
      endLine: 2,
      lineNumbers: false,
    });
    expect(r).toBe(`文件 ${p} 第 1-2 行（共 3 行）:\nl1\nl2`);
  });

  it('只传 startLine 时抛错', async () => {
    const p = seed('e.txt', 'x');
    await expect(fileRead.execute({ path: p, startLine: 1 })).rejects.toThrow(
      /必须同时指定/,
    );
  });
});
