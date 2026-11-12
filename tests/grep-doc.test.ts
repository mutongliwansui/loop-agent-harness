// grep 文档支持单测（需求 20261112-001 / 任务 01）

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grep } from '../src/tools/grep.js';
import { writeDocx } from './helpers/docx-fixture.js';
import { makePdf } from './helpers/pdf-fixture.js';

let DIR = '';

beforeAll(async () => {
  DIR = await mkdtemp(join(tmpdir(), 'loop-agent-grep-doc-'));
});

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
});

async function sub(name: string): Promise<string> {
  const dir = join(DIR, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('grep 检索 docx', () => {
  it('单文档命中，行号为提取文本行号', async () => {
    const dir = await sub('single');
    const p = writeDocx(dir, 'a.docx', ['first line', 'second needle line']);
    const out = await grep.execute({ pattern: 'needle', path: p });

    expect(out).toContain('a.docx:2: second needle line');
    expect(out).toContain('找到 1 处匹配');
  });

  it('目录混合文本与文档，两类结果都返回', async () => {
    const dir = await sub('mixed');
    await writeFile(join(dir, 'note.txt'), 'alpha needle\nbeta\n', 'utf-8');
    writeDocx(dir, 'doc.docx', ['doc needle here', 'tail']);
    const out = await grep.execute({ pattern: 'needle', path: dir });

    expect(out).toContain('note.txt:1: alpha needle');
    expect(out).toContain('doc.docx:1: doc needle here');
    expect(out).toContain('找到 2 处匹配');
  });

  it('损坏的 docx 不中断检索，并在末尾汇总', async () => {
    const dir = await sub('broken');
    await writeFile(join(dir, 'good.txt'), 'needle in text', 'utf-8');
    await writeFile(join(dir, 'bad.docx'), Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('x')]));
    const out = await grep.execute({ pattern: 'needle', path: dir });

    expect(out).toContain('good.txt:1: needle in text');
    expect(out).toContain('[跳过 1 个文档]');
    expect(out).toContain('bad.docx');
    expect(out).toContain('解析失败');
  });

  it('损坏的 PDF 记入跳过汇总，而不是静默忽略', async () => {
    const dir = await sub('pdf-broken');
    await writeFile(join(dir, 'a.pdf'), '%PDF-1.4\n');
    const out = await grep.execute({ pattern: 'needle', path: dir });

    expect(out).toContain('未在');
    expect(out).toContain('[跳过 1 个文档]');
    expect(out).toContain('PDF');
  });

  it('PDF 命中带页码标注', async () => {
    const dir = await sub('pdf-pages');
    await writeFile(
      join(dir, 'doc.pdf'),
      makePdf([
        { content: 'BT /F1 12 Tf 72 720 Td (page one no match) Tj ET' },
        { content: 'BT /F1 12 Tf 72 720 Td (page two needle) Tj ET' },
      ]),
    );
    const out = await grep.execute({ pattern: 'needle', path: dir });

    expect(out).toContain('doc.pdf:4: [p.2] page two needle');
    expect(out).not.toContain('[p.1] page two');
  });
});

describe('grep 文本路径回归', () => {
  it('文本文件仍按原格式输出且无文档汇总', async () => {
    const dir = await sub('text');
    await writeFile(join(dir, 'a.log'), 'line1\nline2 needle\n', 'utf-8');
    const out = await grep.execute({ pattern: 'needle', path: dir });

    expect(out).toContain('a.log:2: line2 needle');
    expect(out).not.toContain('[跳过');
  });

  it('含 NUL 的二进制仍静默跳过', async () => {
    const dir = await sub('binary');
    await writeFile(join(dir, 'bin.dat'), Buffer.concat([Buffer.from('needle '), Buffer.alloc(64)]));
    const out = await grep.execute({ pattern: 'needle', path: dir });

    expect(out).toContain('未在');
    expect(out).not.toContain('[跳过');
  });
});
