// fileRead 的 PDF 页语义单测（需求 20261112-001 / 任务 02）

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileRead } from '../src/tools/fileRead.js';
import { makePdf } from './helpers/pdf-fixture.js';
import { writeDocx } from './helpers/docx-fixture.js';

let DIR = '';

beforeAll(async () => {
  DIR = await mkdtemp(join(tmpdir(), 'loop-agent-file-read-pdf-'));
});

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
});

function pdfPath(name: string): string {
  return join(DIR, name);
}

describe('fileRead 读取 PDF', () => {
  it('全文读取：首行声明页数，页标记与正文带行号', async () => {
    const p = pdfPath('basic.pdf');
    await writeFile(
      p,
      makePdf([
        { content: 'BT /F1 12 Tf 72 720 Td (Alpha page one) Tj ET' },
        { content: 'BT /F1 12 Tf 72 720 Td (Beta page two) Tj ET' },
      ]),
    );
    const r = await fileRead.execute({ path: p });

    expect(r).toContain('pdf 文档，已提取为文本');
    expect(r).toContain('（2 页）');
    expect(r).toContain('1: === 第 1 页 ===');
    expect(r).toContain('2: Alpha page one');
    expect(r).toContain('3: === 第 2 页 ===');
    expect(r).toContain('4: Beta page two');
  });

  it('pages 参数只返回指定页，行号保持全局', async () => {
    const p = pdfPath('pages.pdf');
    await writeFile(
      p,
      makePdf([
        { content: 'BT /F1 12 Tf 72 720 Td (Alpha page one) Tj ET' },
        { content: 'BT /F1 12 Tf 72 720 Td (Beta page two) Tj ET' },
      ]),
    );
    const r = await fileRead.execute({ path: p, pages: '2' });

    expect(r).toContain('本次返回第 2 页');
    expect(r).toContain('3: === 第 2 页 ===');
    expect(r).toContain('4: Beta page two');
    expect(r).not.toContain('Alpha page one');
  });

  it('pages 支持开放区间（2-）与离散页（1,2）', async () => {
    const p = pdfPath('ranges.pdf');
    await writeFile(
      p,
      makePdf([
        { content: 'BT /F1 12 Tf 72 720 Td (Alpha page one) Tj ET' },
        { content: 'BT /F1 12 Tf 72 720 Td (Beta page two) Tj ET' },
      ]),
    );
    const open = await fileRead.execute({ path: p, pages: '2-' });
    expect(open).toContain('Beta page two');
    expect(open).not.toContain('Alpha page one');

    const discrete = await fileRead.execute({ path: p, pages: '1,2' });
    expect(discrete).toContain('Alpha page one');
    expect(discrete).toContain('Beta page two');
  });

  it('pages 与 startLine/endLine 互斥', async () => {
    const p = pdfPath('conflict.pdf');
    await writeFile(p, makePdf([{ content: 'BT /F1 12 Tf 72 720 Td (Hello) Tj ET' }]));
    await expect(
      fileRead.execute({ path: p, pages: '1', startLine: 1, endLine: 2 }),
    ).rejects.toThrow(/互斥/);
  });

  it('页码越界与格式非法有明确提示', async () => {
    const p = pdfPath('invalid.pdf');
    await writeFile(p, makePdf([{ content: 'BT /F1 12 Tf 72 720 Td (Hello) Tj ET' }]));

    await expect(fileRead.execute({ path: p, pages: '3' })).rejects.toThrow(
      /超出文档总页数 1/,
    );
    await expect(fileRead.execute({ path: p, pages: 'abc' })).rejects.toThrow(
      /页码格式非法/,
    );
  });

  it('pages 仅对 PDF 生效（docx 传入时报错）', async () => {
    const p = writeDocx(DIR, 'a.docx', ['hello']);
    await expect(fileRead.execute({ path: p, pages: '1' })).rejects.toThrow(/仅对 PDF/);
  });

  it('超限截断时落盘完整提取文本并说明非原始文档', async () => {
    const p = pdfPath('truncate.pdf');
    const paragraphs = Array.from({ length: 40 }, (_, i) => `row-${i + 1}`);
    const content = `BT /F1 12 Tf 72 720 Td (${paragraphs.join(') Tj 0 -12 Td (')}) Tj ET`;
    await writeFile(p, makePdf([{ content }]));

    const r = await fileRead.execute({ path: p, maxBytes: 80 });
    expect(r).toContain('[已截断]');
    expect(r).toContain('完整输出已保存');
    expect(r).toContain('非原始二进制文档');
  });
});
