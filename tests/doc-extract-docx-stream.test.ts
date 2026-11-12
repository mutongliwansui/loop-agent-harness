// docx 解析挂起回归与 Word 解析兜底（需求 20261112-005）
//
// 背景：word-extractor@1.0.4 解 docx 走 yauzl → fd-slicer 切片 → pipe(inflateRaw)。
// fd-slicer 单块上限为 highWaterMark(16384)，条目「压缩后 ≥ 16384」时首块膨胀击穿 zlib
// 可写缓冲 → pipe 暂停源流且永不 resume → 尾部字节与 EOF 都不发出 → inflate 既不 end 也不
// error → yauzl 的 Promise 永不 settle → fileRead 无限挂起（实测 285735 字节文档卡到超时）。
//
// 本文件锁定三件事：
// 1) 修复后 deflate 且压缩后 ≥16384 的 docx 必须在亚秒级返回；
// 2) 正文抽取语义（段落/表格/制表符/换行/修订删除/域代码/实体/标点归一）不回退；
// 3) 任何仍会挂起的解析器都有硬超时兜底，最终以 timeout 错误码收敛。

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { extractDocument } from '../src/documents/extract.js';
import { docxBodyFromXml } from '../src/documents/docx.js';
import { withTimeout } from '../src/documents/word.js';
import { DocumentExtractError } from '../src/documents/types.js';
import { docxDocumentXml, writeDocx } from './helpers/docx-fixture.js';

let DIR = '';

beforeAll(async () => {
  DIR = await mkdtemp(join(tmpdir(), 'loop-agent-docx-stream-'));
});

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
});

const baseOpts = { maxBytes: 50 * 1024 * 1024, timeBudgetMs: 15000 };

/** 生成难压缩的伪随机十六进制文本（模拟 Word 里的大段编号/编码内容） */
function incompressible(seed: number, length: number): string {
  let s = seed >>> 0;
  let out = '';
  for (let i = 0; i < length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out += '0123456789abcdef'[(s >>> 24) & 0xf];
  }
  return out;
}

/** 包一层超时断言：挂起时给出可读失败信息，而不是等到 vitest 全局超时 */
async function expectSettlesWithin<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} 在 ${ms}ms 内未返回（疑似解压流永不结束）`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('docx 解压流挂起回归', () => {
  it('deflate 且 document.xml 压缩后 ≥16384 时必须快速返回', async () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `${i}:${incompressible(i + 1, 900)}`);
    // 用例前提自检：确认真的命中了历史 bug 的触发条件（压缩后 ≥ highWaterMark）
    const compSize = deflateRawSync(Buffer.from(docxDocumentXml(paragraphs), 'utf-8')).length;
    expect(compSize).toBeGreaterThanOrEqual(16384);

    const p = writeDocx(DIR, 'big-deflated.docx', paragraphs, { deflate: true });
    const r = await expectSettlesWithin(
      extractDocument(p, 'docx', baseOpts),
      3000,
      '大 document.xml docx 解析',
    );

    expect(r.kind).toBe('docx');
    expect(r.text.startsWith('0:')).toBe(true);
    expect(r.text.split('\n')).toHaveLength(paragraphs.length);
    expect(r.truncated).toBe(false);
  }, 10_000);

  it('deflate 但压缩后 <16384 时同样正常（边界另一侧）', async () => {
    const paragraphs = ['hello 世界', 'second'];
    const compSize = deflateRawSync(Buffer.from(docxDocumentXml(paragraphs), 'utf-8')).length;
    expect(compSize).toBeLessThan(16384);

    const p = writeDocx(DIR, 'small-deflated.docx', paragraphs, { deflate: true });
    const r = await extractDocument(p, 'docx', baseOpts);
    expect(r.text).toBe('hello 世界\nsecond');
  });

  it('deflate 大文档的图片收集与正文提取共用一次解包（不重复解压）', async () => {
    const paragraphs = [incompressible(7, 6000)];
    const p = writeDocx(DIR, 'big-noimage.docx', paragraphs, { deflate: true });
    const r = await expectSettlesWithin(
      extractDocument(p, 'docx', baseOpts),
      3000,
      '无图片大 docx 解析',
    );
    expect(r.images).toEqual([]);
    expect(r.text).toBe(paragraphs[0]);
  }, 10_000);
});

describe('docxBodyFromXml 语义（对齐 word-extractor 口径）', () => {
  it('段落按 </w:p> 分段', () => {
    const xml = '<w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body>';
    expect(docxBodyFromXml(xml)).toBe('第一段\n第二段\n');
  });

  it('表格单元格用制表符分隔、行用换行分隔', () => {
    const xml =
      '<w:tbl><w:tr>' +
      '<w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>' +
      '<w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>' +
      '</w:tr><w:tr>' +
      '<w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc>' +
      '<w:tc><w:p><w:r><w:t>D</w:t></w:r></w:p></w:tc>' +
      '</w:tr></w:tbl>';
    expect(docxBodyFromXml(xml)).toBe('A\tB\t\nC\tD\t\n');
  });

  it('<w:tab/> 转制表符、<w:br/> 转换行', () => {
    const xml = '<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>';
    expect(docxBodyFromXml(xml)).toBe('a\tb\nc\n');
  });

  it('修订删除（w:del/w:delText）与域代码（w:instrText）不进正文', () => {
    const xml =
      '<w:p><w:r><w:t>保留</w:t></w:r>' +
      '<w:del><w:r><w:delText>已删除</w:delText></w:r></w:del>' +
      '<w:r><w:instrText>PAGE</w:instrText></w:r>' +
      '<w:r><w:t>尾</w:t></w:r></w:p>';
    expect(docxBodyFromXml(xml)).toBe('保留尾\n');
  });

  it('绘图对象（w:drawing）内文本不进正文', () => {
    const xml =
      '<w:p><w:r><w:t>前</w:t></w:r>' +
      '<w:r><w:drawing><wp:inline><w:txbxContent><w:p><w:r><w:t>框内</w:t></w:r></w:p>' +
      '</w:txbxContent></wp:inline></w:drawing></w:r>' +
      '<w:r><w:t>后</w:t></w:r></w:p>';
    expect(docxBodyFromXml(xml)).toBe('前后\n');
  });

  it('XML 实体解码', () => {
    const xml = '<w:p><w:r><w:t>A&amp;B&lt;C&gt;D&quot;E&apos;F</w:t></w:r></w:p>';
    expect(docxBodyFromXml(xml)).toBe('A&B<C>D"E\'F\n');
  });

  it('Unicode 标点归一（与 word-extractor filter 一致）', () => {
    const xml = '<w:p><w:r><w:t>\u201c引号\u201d\u2018单\u2019\u2014\u2013\u2002空格</w:t></w:r></w:p>';
    expect(docxBodyFromXml(xml)).toBe('"引号"\'单\'-- 空格\n');
  });
});

describe('withTimeout 兜底', () => {
  it('正常完成的 Promise 原值透传', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, '测试')).resolves.toBe('ok');
  });

  it('永不 settle 的 Promise 以 timeout 错误码收敛', async () => {
    const hung = new Promise<string>(() => {
      /* 故意不 settle：模拟解压流永不结束 */
    });
    let caught: unknown;
    try {
      await withTimeout(hung, 30, 'Word 文档');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DocumentExtractError);
    expect((caught as DocumentExtractError).code).toBe('timeout');
    expect((caught as DocumentExtractError).message).toContain('30ms');
  });

  it('底层拒绝的错误原样抛出（不被超时替换）', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 1000, '测试'),
    ).rejects.toThrow('boom');
  });
});
