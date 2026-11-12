// PDF 提取单测（需求 20261112-001 / 任务 02）

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractDocument } from '../src/documents/extract.js';
import { DocumentExtractError } from '../src/documents/types.js';
import { makePdf, makePdfWithObjectStream } from './helpers/pdf-fixture.js';

let DIR = '';

beforeAll(async () => {
  DIR = await mkdtemp(join(tmpdir(), 'loop-agent-pdf-extract-'));
});

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
});

const baseOpts = { maxBytes: 50 * 1024 * 1024, timeBudgetMs: 15000 };

async function write(name: string, data: Buffer): Promise<string> {
  const p = join(DIR, name);
  await writeFile(p, data);
  return p;
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(DocumentExtractError);
  expect((caught as DocumentExtractError).code).toBe(code);
}

describe('extractPdf', () => {
  it('单页简单字体：提取文本并生成页映射', async () => {
    const p = await write(
      'basic.pdf',
      makePdf([{ content: 'BT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET' }]),
    );
    const r = await extractDocument(p, 'pdf', baseOpts);

    expect(r.kind).toBe('pdf');
    expect(r.text).toContain('=== 第 1 页 ===');
    expect(r.text).toContain('Hello PDF');
    expect(r.pageCount).toBe(1);
    expect(r.pages).toEqual([{ page: 1, startLine: 1, endLine: 2 }]);
    expect(r.truncated).toBe(false);
  });

  it('多页文档：页标记与页行区间正确', async () => {
    const p = await write(
      'multi.pdf',
      makePdf([
        { content: 'BT /F1 12 Tf 72 720 Td (First page) Tj ET' },
        { content: 'BT /F1 12 Tf 72 720 Td (Second page) Tj ET' },
      ]),
    );
    const r = await extractDocument(p, 'pdf', baseOpts);

    expect(r.pageCount).toBe(2);
    expect(r.text).toContain('First page');
    expect(r.text).toContain('Second page');
    expect(r.pages).toEqual([
      { page: 1, startLine: 1, endLine: 2 },
      { page: 2, startLine: 3, endLine: 4 },
    ]);
  });

  it('Td 垂直位移产生换行', async () => {
    const p = await write(
      'lines.pdf',
      makePdf([
        {
          content: 'BT /F1 12 Tf 72 720 Td (line one) Tj 0 -18 Td (line two) Tj ET',
        },
      ]),
    );
    const r = await extractDocument(p, 'pdf', baseOpts);
    expect(r.text).toContain('line one\nline two');
  });

  it('Type0 + ToUnicode：中文可读', async () => {
    const p = await write(
      'cjk.pdf',
      makePdf([
        { content: 'BT /F2 12 Tf 72 720 Td <4E2D65874E2D65874E2D6587> Tj ET' },
      ]),
    );
    const r = await extractDocument(p, 'pdf', baseOpts);
    expect(r.text).toContain('中文中文中文');
  });

  it('FlateDecode 内容流可解压', async () => {
    const p = await write(
      'flate.pdf',
      makePdf([
        { content: 'BT /F1 12 Tf 72 720 Td (Compressed text) Tj ET', compress: true },
      ]),
    );
    const r = await extractDocument(p, 'pdf', baseOpts);
    expect(r.text).toContain('Compressed text');
  });

  it('对象流（ObjStm）中的页对象可解析', async () => {
    const p = await write('objstm.pdf', makePdfWithObjectStream());
    const r = await extractDocument(p, 'pdf', baseOpts);
    expect(r.text).toContain('ObjStm works');
  });

  it('加密 PDF → encrypted', async () => {
    const p = await write(
      'encrypted.pdf',
      makePdf([{ content: 'BT /F1 12 Tf 72 720 Td (secret) Tj ET' }], { encrypted: true }),
    );
    await expectCode(extractDocument(p, 'pdf', baseOpts), 'encrypted');
  });

  it('无可提取文本（扫描件）→ scanned', async () => {
    const p = await write('scanned.pdf', makePdf([{ content: 'BT ET' }]));
    await expectCode(extractDocument(p, 'pdf', baseOpts), 'scanned');
  });

  it('超过大小上限 → too_large', async () => {
    const p = await write(
      'big.pdf',
      makePdf([{ content: 'BT /F1 12 Tf 72 720 Td (Hello) Tj ET' }]),
    );
    await expectCode(extractDocument(p, 'pdf', { ...baseOpts, maxBytes: 10 }), 'too_large');
  });

  it('无有效对象 → corrupt', async () => {
    const p = await write('broken.pdf', Buffer.from('%PDF-1.4\n'));
    await expectCode(extractDocument(p, 'pdf', baseOpts), 'corrupt');
  });
});
