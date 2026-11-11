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

  // ===== 20261021-007：默认读取上限 / 截断 / 二进制探测 =====

  it('超过 2000 行只返回前 2000 行并附截断提示', async () => {
    const content = Array.from({ length: 100000 }, (_, i) => `line-${i + 1}`).join('\n');
    const p = seed('big.txt', content);
    const r = await fileRead.execute({ path: p });

    const body = r.split('\n\n')[0];
    const lines = body.split('\n');
    expect(lines).toHaveLength(2000);
    expect(lines[0]).toBe('1: line-1');
    expect(lines[1999]).toBe('2000: line-2000');
    expect(r).toContain('共 100000 行');
    expect(r).toContain('[已截断]');
    expect(r).toContain('startLine/endLine');
  });

  it('超过 256KB 时按字节截断（未到 2000 行）', async () => {
    const content = Array.from({ length: 3000 }, () => 'x'.repeat(200)).join('\n');
    const p = seed('bytes.txt', content);
    const r = await fileRead.execute({ path: p });

    expect(r).toContain('[已截断]');
    expect(r).toContain('256.0 KB');
    expect(r).toContain('共 3000 行');
    const body = r.split('\n\n')[0];
    const returned = body.split('\n').length;
    expect(returned).toBeGreaterThan(1000);
    expect(returned).toBeLessThan(2000);
  });

  it('二进制文件（含 NUL）拒绝读取', async () => {
    const p = file('bin.dat');
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    await expect(fileRead.execute({ path: p })).rejects.toThrow(/二进制文件不支持读取/);
  });

  // ===== 20261111-003（C 档）：删除 offset/limit 别名参数，行范围只保留 startLine/endLine =====

  it('参数 schema 不再暴露 offset/limit', () => {
    const props = Object.keys(
      (fileRead.parameters as { properties: Record<string, unknown> }).properties,
    );
    expect(props).toEqual(['path', 'startLine', 'endLine', 'maxBytes', 'encoding', 'lineNumbers']);
  });

  it('传 offset/limit 不再生效（不参与解析，按全文读取）', async () => {
    const content = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n');
    const p = seed('alias.txt', content);
    const r = await fileRead.execute({ path: p, offset: 3, limit: 2 });
    expect(r).toBe(Array.from({ length: 10 }, (_, i) => `${i + 1}: l${i + 1}`).join('\n'));
  });

  it('显式行范围 + maxBytes 截断并提示继续 startLine', async () => {
    const content = Array.from(
      { length: 100 },
      (_, i) => `row-${i + 1}-${'y'.repeat(80)}`,
    ).join('\n');
    const p = seed('range-bytes.txt', content);
    const r = await fileRead.execute({ path: p, startLine: 1, endLine: 100, maxBytes: 500 });

    expect(r).toContain('[已截断]');
    expect(r).toMatch(/startLine=\d+/);
    const body = r.split('\n\n')[0];
    expect(body.split('\n').length).toBeLessThan(20);
  });

  it('单行超长按 8192 字符截断', async () => {
    const p = seed('min.js', 'a'.repeat(20000));
    const r = await fileRead.execute({ path: p, lineNumbers: false });
    expect(r.length).toBeLessThan(8500);
    expect(r).toContain('本行过长已截断');
  });
});
