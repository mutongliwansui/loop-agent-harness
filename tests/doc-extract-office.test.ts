// xlsx/pptx/rtf/odt 提取单测（需求 20261112-001 / 任务 03）

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractDocument } from '../src/documents/extract.js';
import { DocumentExtractError } from '../src/documents/types.js';
import { makeOdt, makePptx, makeXlsx } from './helpers/office-fixture.js';

let DIR = '';

beforeAll(async () => {
  DIR = await mkdtemp(join(tmpdir(), 'loop-agent-office-'));
});

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
});

const baseOpts = { maxBytes: 50 * 1024 * 1024, timeBudgetMs: 15000 };

async function write(name: string, data: Buffer | string): Promise<string> {
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

describe('extractXlsx', () => {
  it('多 sheet 按名称输出，共享字符串与内联字符串都正确', async () => {
    const p = await write(
      'basic.xlsx',
      makeXlsx(
        [
          { name: '销售', rows: [['产品', '一月'], ['A', '100']] },
          { name: '汇总', rows: [['合计', { inline: '200' }]] },
        ],
        { useSharedStrings: true },
      ),
    );
    const r = await extractDocument(p, 'xlsx', baseOpts);

    expect(r.kind).toBe('xlsx');
    expect(r.text).toContain('=== Sheet: 销售 ===');
    expect(r.text).toContain('产品\t一月');
    expect(r.text).toContain('=== Sheet: 汇总 ===');
    expect(r.text).toContain('合计\t200');
    expect(r.pageCount).toBe(2);
    expect(r.pages?.map((x) => x.page)).toEqual([1, 2]);
  });

  it('布尔单元格输出 TRUE/FALSE，空行跳过', async () => {
    const p = await write(
      'bool.xlsx',
      makeXlsx([{ name: 'S', rows: [['flag'], [{ b: true }], [{ b: false }], []] }]),
    );
    const r = await extractDocument(p, 'xlsx', baseOpts);
    expect(r.text).toContain('TRUE');
    expect(r.text).toContain('FALSE');
  });

  it('缺 workbook.xml → corrupt', async () => {
    const p = await write('bad.xlsx', 'not a zip');
    await expectCode(extractDocument(p, 'xlsx', baseOpts), 'corrupt');
  });

  it('无单元格文本 → empty', async () => {
    const p = await write('empty.xlsx', makeXlsx([{ name: 'S', rows: [] }]));
    await expectCode(extractDocument(p, 'xlsx', baseOpts), 'empty');
  });
});

describe('extractPptx', () => {
  it('按 slide 数字序输出，slide10 排在 slide2 之后', async () => {
    const slides = Array.from({ length: 10 }, (_, i) => [`slide-${i + 1}`]);
    const p = await write('multi.pptx', makePptx(slides));
    const r = await extractDocument(p, 'pptx', baseOpts);

    expect(r.pageCount).toBe(10);
    expect(r.text).toContain('=== 第 1 页 ===');
    expect(r.text).toContain('=== 第 10 页 ===');
    const idx2 = r.text.indexOf('slide-2');
    const idx10 = r.text.indexOf('slide-10');
    expect(idx2).toBeGreaterThan(0);
    expect(idx10).toBeGreaterThan(idx2);
  });

  it('每页多段落按行输出', async () => {
    const p = await write('paras.pptx', makePptx([['标题', '第一点', '第二点']]));
    const r = await extractDocument(p, 'pptx', baseOpts);
    expect(r.text).toContain('标题\n第一点\n第二点');
  });

  it('无幻灯片 → corrupt', async () => {
    const p = await write('noslides.pptx', makePptx([]));
    await expectCode(extractDocument(p, 'pptx', baseOpts), 'corrupt');
  });
});

describe('extractRtf', () => {
  it('段落、制表符与转义字符正确还原', async () => {
    const rtf = '{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0 Arial;}}Hello\\par World\\tab End\\par}';
    const p = await write('basic.rtf', rtf);
    const r = await extractDocument(p, 'rtf', baseOpts);

    expect(r.text).toBe('Hello\nWorld\tEnd');
  });

  it('\\uN 与 \\\'hh 转义解码', async () => {
    const rtf = "{\\rtf1\\ansi\\ansicpg1252 caf\\'e9 \\u20013?\\u25991?}";
    const p = await write('escape.rtf', rtf);
    const r = await extractDocument(p, 'rtf', baseOpts);

    expect(r.text).toContain('café');
    expect(r.text).toContain('中文');
  });

  it('跳过 fonttbl/info 等目标组', async () => {
    const rtf =
      '{\\rtf1\\ansi{\\fonttbl{\\f0 Times;}}{\\info{\\title hidden title}}Visible text\\par}';
    const p = await write('skip.rtf', rtf);
    const r = await extractDocument(p, 'rtf', baseOpts);

    expect(r.text).toBe('Visible text');
  });
});

describe('extractOdt', () => {
  it('段落与标题按顺序输出，XML 实体与制表符正确', async () => {
    const content =
      '<text:h text:outline-level="1">标题</text:h>' +
      '<text:p>第一段 &amp; 实体</text:p>' +
      '<text:p>前<text:tab/>后</text:p>';
    const p = await write('basic.odt', makeOdt(content));
    const r = await extractDocument(p, 'odt', baseOpts);

    expect(r.text).toBe('标题\n第一段 & 实体\n前\t后');
  });

  it('缺 content.xml → corrupt', async () => {
    const p = await write('bad.odt', 'not a zip');
    await expectCode(extractDocument(p, 'odt', baseOpts), 'corrupt');
  });
});

describe('旧版格式提示', () => {
  it('.xls / .ppt 提示另存为并列出支持范围', async () => {
    const p = await write('a.xls', 'dummy');
    await expect(extractDocument(p, 'xls', baseOpts)).rejects.toThrow(/另存为 .xlsx/);
    await expect(extractDocument(p, 'ppt', baseOpts)).rejects.toThrow(/当前已支持/);
  });
});
