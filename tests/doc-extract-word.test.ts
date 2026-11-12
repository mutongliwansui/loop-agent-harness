// 文档提取单测（需求 20261112-001 / 任务 01）：docx 提取、规范化与错误映射

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractDocument, normalizeText } from '../src/documents/extract.js';
import { DocumentExtractError } from '../src/documents/types.js';
import { writeDocx } from './helpers/docx-fixture.js';

let DIR = '';

beforeAll(async () => {
  DIR = await mkdtemp(join(tmpdir(), 'loop-agent-doc-extract-'));
});

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
});

const baseOpts = { maxBytes: 50 * 1024 * 1024, timeBudgetMs: 15000 };

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

describe('normalizeText', () => {
  it('CRLF/CR 统一为 LF 并去行尾空白', () => {
    expect(normalizeText('a  \r\nb\t\r\nc')).toBe('a\nb\nc');
  });

  it('连续 3 个以上空行折叠为 1 个，1–2 个保留', () => {
    expect(normalizeText('a\n\n\n\nb')).toBe('a\n\nb');
    expect(normalizeText('a\n\n\nb')).toBe('a\n\n\nb');
  });

  it('去首尾空行', () => {
    expect(normalizeText('\n\na\n\n\n')).toBe('a');
  });
});

describe('extractDocument（docx）', () => {
  it('提取段落文本，行尾换行被规范化', async () => {
    const p = writeDocx(DIR, 'basic.docx', ['第一段', 'second paragraph']);
    const r = await extractDocument(p, 'docx', baseOpts);
    expect(r.kind).toBe('docx');
    expect(r.text).toBe('第一段\nsecond paragraph');
    expect(r.truncated).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('连续空段落折叠为单个空行', async () => {
    const p = writeDocx(DIR, 'blanks.docx', ['a', '', '', '', 'b']);
    const r = await extractDocument(p, 'docx', baseOpts);
    expect(r.text).toBe('a\n\nb');
  });

  it('源文件超过上限 → too_large', async () => {
    const p = writeDocx(DIR, 'big.docx', ['x']);
    await expectCode(extractDocument(p, 'docx', { ...baseOpts, maxBytes: 10 }), 'too_large');
  });

  it('损坏的 docx → corrupt', async () => {
    const p = join(DIR, 'broken.docx');
    await writeFile(p, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('bad')]));
    await expectCode(extractDocument(p, 'docx', baseOpts), 'corrupt');
  });

  it('空文档 → empty', async () => {
    const p = writeDocx(DIR, 'empty.docx', []);
    await expectCode(extractDocument(p, 'docx', baseOpts), 'empty');
  });

  it('损坏的 doc（OLE）→ corrupt', async () => {
    const p = join(DIR, 'broken.doc');
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(1024),
    ]);
    await writeFile(p, ole);
    await expectCode(extractDocument(p, 'doc', baseOpts), 'corrupt');
  });
});

describe('extractDocument（格式边界）', () => {
  it('PDF 已启用：损坏文件返回 corrupt', async () => {
    const p = join(DIR, 'a.pdf');
    await writeFile(p, Buffer.from('%PDF-1.4\n'));
    await expectCode(extractDocument(p, 'pdf', baseOpts), 'corrupt');
  });

  it('旧版 xls/ppt 提示另存为', async () => {
    const p = join(DIR, 'a.xls');
    await writeFile(p, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    await expect(extractDocument(p, 'xls', baseOpts)).rejects.toThrow(/另存为 .xlsx/);
    await expect(extractDocument(p, 'ppt', baseOpts)).rejects.toThrow(/另存为 .pptx/);
  });

  it('损坏的 xlsx → corrupt', async () => {
    const p = join(DIR, 'a.xlsx');
    await writeFile(p, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    await expectCode(extractDocument(p, 'xlsx', baseOpts), 'corrupt');
  });

  it('文件不存在 → corrupt', async () => {
    await expectCode(extractDocument(join(DIR, 'nope.docx'), 'docx', baseOpts), 'corrupt');
  });
});
