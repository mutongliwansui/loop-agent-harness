// fileRead 对 xlsx/pptx/rtf/odt 的读取与页语义单测（需求 20261112-001 / 任务 03）

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileRead } from '../src/tools/fileRead.js';
import { makeOdt, makePptx, makeXlsx } from './helpers/office-fixture.js';

let DIR = '';

beforeAll(async () => {
  DIR = await mkdtemp(join(tmpdir(), 'loop-agent-file-read-office-'));
});

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
});

describe('fileRead 读取 xlsx', () => {
  it('全文读取包含 sheet 标记与表格文本', async () => {
    const p = join(DIR, 'a.xlsx');
    await writeFile(
      p,
      makeXlsx([
        { name: '销售', rows: [['产品', '一月'], ['A', '100']] },
        { name: '汇总', rows: [['合计', '100']] },
      ]),
    );
    const r = await fileRead.execute({ path: p });

    expect(r).toContain('xlsx 文档，已提取为文本');
    expect(r).toContain('（2 个工作表）');
    expect(r).toContain('=== Sheet: 销售 ===');
    expect(r).toContain('产品\t一月');
  });

  it('pages 参数按工作表序号读取', async () => {
    const p = join(DIR, 'pages.xlsx');
    await writeFile(
      p,
      makeXlsx([
        { name: '第一表', rows: [['one']] },
        { name: '第二表', rows: [['two']] },
      ]),
    );
    const r = await fileRead.execute({ path: p, pages: '2' });

    expect(r).toContain('本次返回第 2 个工作表');
    expect(r).toContain('=== Sheet: 第二表 ===');
    expect(r).toContain('two');
    expect(r).not.toContain('=== Sheet: 第一表 ===');
  });
});

describe('fileRead 读取 pptx', () => {
  it('pages 参数按幻灯片序号读取', async () => {
    const p = join(DIR, 'a.pptx');
    await writeFile(
      p,
      makePptx([
        ['第一页标题', '第一页正文'],
        ['第二页标题', '第二页正文'],
      ]),
    );
    const r = await fileRead.execute({ path: p, pages: '2' });

    expect(r).toContain('本次返回第 2 页');
    expect(r).toContain('第二页标题');
    expect(r).not.toContain('第一页标题');
  });
});

describe('fileRead 读取 rtf / odt', () => {
  it('rtf 文本按段落读取', async () => {
    const p = join(DIR, 'a.rtf');
    await writeFile(p, '{\\rtf1\\ansi First line\\par Second line\\par}');
    const r = await fileRead.execute({ path: p });

    expect(r).toContain('rtf 文档，已提取为文本');
    expect(r).toContain('First line');
    expect(r).toContain('Second line');
  });

  it('odt 段落读取', async () => {
    const p = join(DIR, 'a.odt');
    await writeFile(p, makeOdt('<text:p>第一段</text:p><text:p>第二段</text:p>'));
    const r = await fileRead.execute({ path: p });

    expect(r).toContain('odt 文档，已提取为文本');
    expect(r).toContain('第一段');
    expect(r).toContain('第二段');
  });
});
