// PDF 外部 pdftotext 兜底单测（需求 20261112-001 / 任务 03）

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePdf } from './helpers/pdf-fixture.js';

const state = vi.hoisted(() => ({ available: true, output: null as string | null }));

vi.mock('../src/documents/external.js', () => ({
  pdftotextAvailable: () => state.available,
  runPdftotext: async () => state.output,
}));

import { extractDocument } from '../src/documents/extract.js';
import { DocumentExtractError } from '../src/documents/types.js';

let DIR = '';

beforeAll(async () => {
  DIR = await mkdtemp(join(tmpdir(), 'loop-agent-pdf-fallback-'));
});

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
});

beforeEach(() => {
  state.available = true;
  state.output = null;
});

const baseOpts = { maxBytes: 50 * 1024 * 1024, timeBudgetMs: 15000 };

async function scannedPdf(): Promise<string> {
  const p = join(DIR, 'scanned.pdf');
  await writeFile(p, makePdf([{ content: 'BT ET' }]));
  return p;
}

describe('PDF pdftotext 兜底', () => {
  it('内置判定扫描件且 pdftotext 可用时，用外部结果替换', async () => {
    state.output = 'Page one text\fPage two text';
    const p = await scannedPdf();
    const r = await extractDocument(p, 'pdf', baseOpts);

    expect(r.text).toContain('=== 第 1 页 ===');
    expect(r.text).toContain('Page one text');
    expect(r.text).toContain('=== 第 2 页 ===');
    expect(r.text).toContain('Page two text');
    expect(r.pageCount).toBe(2);
    expect(r.warnings.join('\n')).toContain('pdftotext');
  });

  it('pdftotext 不可用时保持 scanned 提示', async () => {
    state.available = false;
    const p = await scannedPdf();
    let caught: unknown;
    try {
      await extractDocument(p, 'pdf', baseOpts);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DocumentExtractError);
    expect((caught as DocumentExtractError).code).toBe('scanned');
  });

  it('pdftotext 无输出时仍保持 scanned 提示', async () => {
    state.output = null;
    const p = await scannedPdf();
    let caught: unknown;
    try {
      await extractDocument(p, 'pdf', baseOpts);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DocumentExtractError);
    expect((caught as DocumentExtractError).code).toBe('scanned');
  });
});
