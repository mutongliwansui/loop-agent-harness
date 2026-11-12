// fileRead 文档支持单测（需求 20261112-001 / 任务 01）

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileRead } from '../src/tools/fileRead.js';
import { writeDocx } from './helpers/docx-fixture.js';

let DIR = '';

beforeAll(async () => {
  DIR = await mkdtemp(join(tmpdir(), 'loop-agent-file-read-doc-'));
});

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
});

describe('fileRead 读取 docx', () => {
  it('全文默认带行号，首行声明文档类型与行号口径', async () => {
    const p = writeDocx(DIR, 'basic.docx', ['第一段', 'second paragraph']);
    const r = await fileRead.execute({ path: p });

    expect(r).toContain('[docx 文档，已提取为文本，共 2 行');
    expect(r).toContain('行号为提取文本行号');
    expect(r).toContain('1: 第一段');
    expect(r).toContain('2: second paragraph');
  });

  it('lineNumbers=false 返回无行号正文', async () => {
    const p = writeDocx(DIR, 'no-ln.docx', ['alpha', 'beta']);
    const r = await fileRead.execute({ path: p, lineNumbers: false });
    expect(r).toContain('alpha\nbeta');
    expect(r).not.toContain('1: alpha');
  });

  it('startLine/endLine 使用提取文本行号', async () => {
    const p = writeDocx(DIR, 'range.docx', ['l1', 'l2', 'l3']);
    const r = await fileRead.execute({ path: p, startLine: 2, endLine: 2 });
    expect(r).toContain('第 2-2 行');
    expect(r).toContain('2: l2');
    expect(r).not.toContain('1: l1');
  });

  it('起始行超出文档总行数时报错', async () => {
    const p = writeDocx(DIR, 'short.docx', ['only']);
    await expect(fileRead.execute({ path: p, startLine: 5, endLine: 6 })).rejects.toThrow(
      /超出文档总行数/,
    );
  });

  it('maxBytes 触发截断并提示续读方式', async () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`);
    const p = writeDocx(DIR, 'many.docx', paragraphs);
    const r = await fileRead.execute({ path: p, maxBytes: 30 });

    expect(r).toContain('[已截断]');
    expect(r).toContain('maxBytes');
    expect(r).toContain('startLine/endLine');
  });

  it('encoding 参数对文档无效并在首行说明', async () => {
    const p = writeDocx(DIR, 'enc.docx', ['x']);
    const r = await fileRead.execute({ path: p, encoding: 'gbk' });
    expect(r).toContain('已忽略 encoding=gbk');
  });

  it('损坏的 docx 给出可纠正错误', async () => {
    const p = join(DIR, 'broken.docx');
    await writeFile(p, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('x')]));
    await expect(fileRead.execute({ path: p })).rejects.toThrow(/解析失败/);
  });
});

describe('fileRead 纯文本路径回归', () => {
  it('文本文件仍按原语义输出', async () => {
    const p = join(DIR, 'plain.txt');
    await writeFile(p, 'alpha\nbeta', 'utf-8');
    const r = await fileRead.execute({ path: p });
    expect(r).toBe('1: alpha\n2: beta');
  });

  it('含 NUL 的二进制仍被拒绝', async () => {
    const p = join(DIR, 'bin.dat');
    await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await expect(fileRead.execute({ path: p })).rejects.toThrow(/二进制文件不支持读取/);
  });
});
