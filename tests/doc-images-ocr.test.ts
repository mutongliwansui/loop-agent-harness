// 需求 20261112-002 / 任务 04：文档内图片 OCR 单测
// 覆盖：图片收集（顺序/过滤）、三重预算（张数/字符/失败）、块格式、引擎不可用整体降级、
//       纯图片文档不再抛 empty、fileRead 端到端块拼接、PDF 光栅化命令构造。

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OcrConfig } from '../src/config/schema.js';
import { makeZip } from './helpers/docx-fixture.js';

const { runOcrMock, cfgRef } = vi.hoisted(() => ({
  runOcrMock: vi.fn(),
  cfgRef: { current: null as OcrConfig | null },
}));

vi.mock('../src/ocr/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ocr/index.js')>();
  return {
    ...actual,
    runOcr: (...args: unknown[]) => runOcrMock(...args),
    resolveOcrConfig: () => cfgRef.current,
  };
});

const { collectZipImages, collectDocxImages, ocrDocumentImages } = await import(
  '../src/documents/images.js'
);
const { OcrError } = await import('../src/ocr/types.js');
const { extractDocument } = await import('../src/documents/extract.js');
const { DocumentExtractError } = await import('../src/documents/types.js');
const { fileRead } = await import('../src/tools/fileRead.js');
const { splitCommandTemplate, buildCustomArgs, MAX_RASTER_PAGES } = await import(
  '../src/documents/pdf-raster.js'
);

/** 最小合法 PNG（魔数 + IHDR 头，足以通过 sniffImageFormat） */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
/** EMF 矢量图（不是位图，应被跳过） */
const EMF = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x6c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

/** 基准 OCR 配置（与 schema 默认值一致，便于按需覆盖） */
function baseConfig(patch: Partial<OcrConfig> = {}, docPatch = {}): OcrConfig {
  return {
    enabled: true,
    engine: 'auto',
    enginePriority: ['winrt-ocr'],
    lang: 'auto',
    timeoutMs: 20000,
    maxImageBytes: 10 * 1024 * 1024,
    maxChars: 8000,
    cacheEnabled: false,
    cacheTtlMs: 600000,
    cacheMaxEntries: 64,
    fallbackFromVision: true,
    doc: {
      enabled: true,
      maxImages: 20,
      maxCharsPerImage: 4000,
      timeBudgetMs: 15000,
      pdfScannedPagesOnly: true,
      preferVision: true,
      ...docPatch,
    },
    ...patch,
  } as OcrConfig;
}

function ok(text: string) {
  return { text, engine: 'winrt-ocr', lang: 'zh-Hans-CN', elapsedMs: 10, warnings: [] };
}

let dir = '';
beforeEach(async () => {
  runOcrMock.mockReset();
  cfgRef.current = baseConfig();
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'loop-agent-docimg-'));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('collectZipImages：OOXML 内嵌图片收集', () => {
  it('只取 */media/* 下的位图，按自然序编号（image2 在 image10 之前）', () => {
    const zip = new Map<string, Buffer>([
      ['word/media/image10.png', PNG],
      ['word/media/image2.png', PNG],
      ['word/media/image1.jpeg', JPEG],
      ['word/media/vector1.emf', EMF],
      ['word/document.xml', Buffer.from('<w:document/>')],
      ['docProps/thumbnail.png', PNG],
    ]);
    const images = collectZipImages(zip);
    expect(images.map((i) => i.name)).toEqual([
      'word/media/image1.jpeg',
      'word/media/image2.png',
      'word/media/image10.png',
    ]);
    expect(images.map((i) => i.index)).toEqual([1, 2, 3]);
    expect(images.every((i) => i.source === 'embedded')).toBe(true);
  });

  it('魔数不符的条目（EMF/空壳）不产生噪声', () => {
    const zip = new Map<string, Buffer>([
      ['ppt/media/logo.png', EMF],
      ['ppt/media/ok.png', PNG],
    ]);
    expect(collectZipImages(zip).map((i) => i.name)).toEqual(['ppt/media/ok.png']);
  });

  it('collectDocxImages 读包失败时静默返回空数组', async () => {
    const p = join(dir, 'broken.docx');
    await writeFile(p, Buffer.from('not a zip at all'));
    await expect(collectDocxImages(p)).resolves.toEqual([]);
  });

  it('collectDocxImages 能从真实 zip 文件中取到 word/media', async () => {
    const p = join(dir, 'withimg.docx');
    await writeFile(
      p,
      makeZip([
        { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
        { name: 'word/media/image1.png', data: PNG },
      ]),
    );
    const images = await collectDocxImages(p);
    expect(images).toHaveLength(1);
    expect(images[0].name).toBe('word/media/image1.png');
  });
});

describe('ocrDocumentImages：块格式与三重预算', () => {
  const img = (index: number, name = `word/media/image${index}.png`) => ({
    name,
    data: PNG,
    index,
    source: 'embedded' as const,
  });

  it('成功时按 §5 块格式输出，并给出汇总告警', async () => {
    runOcrMock.mockResolvedValue(ok('发票号码 A123'));
    const out = await ocrDocumentImages([img(1)], baseConfig());
    expect(out.text).toContain('[图片 1（word/media/image1.png）：OCR 文本]');
    expect(out.text).toContain('发票号码 A123');
    expect(out.text).toContain('[/图片 1]');
    expect(out.ocrDone).toBe(1);
    expect(out.warnings.join()).toContain('已 OCR 1 张');
  });

  it('超过 maxImages 的图片只留一行未 OCR 提示，且不调用引擎', async () => {
    runOcrMock.mockResolvedValue(ok('x'));
    const out = await ocrDocumentImages(
      [img(1), img(2), img(3)],
      baseConfig({}, { maxImages: 1 }),
    );
    expect(out.ocrDone).toBe(1);
    expect(out.skipped).toBe(2);
    expect(out.text).toContain('未 OCR（超过单文档 1 张上限）');
    expect(runOcrMock).toHaveBeenCalledTimes(1);
    expect(out.warnings.join()).toContain('2 张图片超过单文档 1 张上限');
  });

  it('单张失败不阻断其余图片，失败原因写进块内', async () => {
    runOcrMock
      .mockRejectedValueOnce(new OcrError('timeout', '引擎超时'))
      .mockResolvedValueOnce(ok('第二张'));
    const out = await ocrDocumentImages([img(1), img(2)], baseConfig());
    expect(out.text).toContain('OCR 失败（timeout）：引擎超时');
    expect(out.text).toContain('第二张');
    expect(out.ocrDone).toBe(1);
    expect(out.warnings.join()).toContain('1 张图片 OCR 失败');
  });

  it('字符超限按 maxCharsPerImage 截断并标注', async () => {
    runOcrMock.mockResolvedValue(ok('甲'.repeat(50)));
    const out = await ocrDocumentImages([img(1)], baseConfig({}, { maxCharsPerImage: 10 }));
    expect(out.text).toContain('甲'.repeat(10));
    expect(out.text).not.toContain('甲'.repeat(11));
    expect(out.text).toContain('已截断至 10 字符');
  });

  it('引擎不可用（platform_unsupported）时整块降级为空串', async () => {
    runOcrMock.mockRejectedValue(new OcrError('platform_unsupported', '非 Windows 平台'));
    const out = await ocrDocumentImages([img(1), img(2)], baseConfig());
    expect(out.text).toBe('');
    expect(out.engineUnavailable).toBe(true);
    expect(out.warnings.join()).toContain('文档内图片 OCR 不可用');
    expect(runOcrMock).toHaveBeenCalledTimes(1); // 首个失败即短路
  });

  it('ocr.doc.enabled=false 时完全不调用引擎', async () => {
    const out = await ocrDocumentImages([img(1)], baseConfig({}, { enabled: false }));
    expect(out.text).toBe('');
    expect(runOcrMock).not.toHaveBeenCalled();
  });

  it('PDF 扫描页用页号做块标签', async () => {
    runOcrMock.mockResolvedValue(ok('第三页文字'));
    const out = await ocrDocumentImages(
      [{ name: 'pdf-page-3', data: PNG, index: 1, source: 'pdf-page', page: 3 }],
      baseConfig(),
    );
    expect(out.text).toContain('[图片 1（第 3 页）：OCR 文本]');
  });

  it('时间预算耗尽后剩余图片只给未 OCR 提示', async () => {
    // 第一张故意慢 5ms，使 1ms 的文档级预算被击穿；第二张必须被判超预算
    runOcrMock.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return ok('慢');
    });
    const out = await ocrDocumentImages(
      [img(1), img(2)],
      baseConfig({ timeoutMs: 20000 }, { timeBudgetMs: 1 }),
    );
    expect(out.text).toContain('未 OCR（超过 1ms 时间预算）');
    expect(out.skipped).toBe(1);
    expect(runOcrMock).toHaveBeenCalledTimes(1);
  });
});

describe('纯图片文档不再一律抛 empty', () => {
  function pptxWith(slideXml: string, images: string[]): Buffer {
    return makeZip([
      { name: 'ppt/slides/slide1.xml', data: Buffer.from(slideXml) },
      ...images.map((n) => ({ name: `ppt/media/${n}`, data: PNG })),
    ]);
  }

  it('无文本但收集到图片 → 返回 images 而非 empty', async () => {
    const p = join(dir, 'slides-only-images.pptx');
    await writeFile(p, pptxWith('<p:sld><p:cSld><p:spTree/></p:cSld></p:sld>', ['image1.png']));
    const r = await extractDocument(p, 'pptx', { maxBytes: 50 * 1024 * 1024 });
    expect(r.images).toHaveLength(1);
    expect(r.text).toContain('=== 第 1 页 ===');
    expect(r.warnings.join()).toContain('仅收集到 1 张图片');
  });

  it('无文本也无图片 → 仍抛 empty', async () => {
    const p = join(dir, 'slides-empty.pptx');
    await writeFile(p, pptxWith('<p:sld><p:cSld><p:spTree/></p:cSld></p:sld>', []));
    await expect(extractDocument(p, 'pptx', { maxBytes: 50 * 1024 * 1024 })).rejects.toThrow(
      DocumentExtractError,
    );
  });

  it('有文本的 pptx 也带上 images（供 OCR）', async () => {
    const p = join(dir, 'slides-both.pptx');
    await writeFile(
      p,
      pptxWith(
        '<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>标题文字</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
        ['image1.png'],
      ),
    );
    const r = await extractDocument(p, 'pptx', { maxBytes: 50 * 1024 * 1024 });
    expect(r.text).toContain('标题文字');
    expect(r.images).toHaveLength(1);
  });
});

describe('fileRead：图片块并入提取文本尾部的端到端表现', () => {
  async function readPptx(): Promise<string> {
    const p = join(dir, 'end-to-end.pptx');
    await writeFile(
      p,
      makeZip([
        {
          name: 'ppt/slides/slide1.xml',
          data: Buffer.from(
            '<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>正文标题</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
          ),
        },
        { name: 'ppt/media/image1.png', data: PNG },
      ]),
    );
    return p;
  }

  it('输出含块头与图片块，行号连续', async () => {
    runOcrMock.mockResolvedValue(ok('图里的字'));
    const p = await readPptx();
    const out = (await fileRead.execute({ path: p }, { workspaceRoot: dir })) as string;
    expect(out).toContain('=== 文档内图片文本 ===');
    expect(out).toContain('[图片 1（ppt/media/image1.png）：OCR 文本]');
    expect(out).toContain('图里的字');
    expect(out).toContain('末尾附 1 张文档内图片的取文结果');
    // 行号模式：块内容也带行号，说明走的是同一套行号管线
    expect(out).toMatch(/^\d+: === 文档内图片文本 ===$/m);
  });

  it('ocr.doc.enabled=false 时不出现块头，正文照常返回', async () => {
    cfgRef.current = baseConfig({}, { enabled: false });
    const p = await readPptx();
    const out = (await fileRead.execute({ path: p }, { workspaceRoot: dir })) as string;
    expect(out).toContain('正文标题');
    expect(out).not.toContain('=== 文档内图片文本 ===');
    expect(runOcrMock).not.toHaveBeenCalled();
  });
});

describe('pdf-raster：命令构造与上限', () => {
  it('splitCommandTemplate 支持双引号参数，不做 shell 解释', () => {
    expect(splitCommandTemplate('magick -density 150 input.pdf[0] out.png')).toEqual([
      'magick',
      '-density',
      '150',
      'input.pdf[0]',
      'out.png',
    ]);
    expect(splitCommandTemplate('tool "a b" c')).toEqual(['tool', 'a b', 'c']);
    // 分号不会被当作命令分隔符，只会成为普通参数
    expect(splitCommandTemplate('tool a;b')).toEqual(['tool', 'a;b']);
  });

  it('buildCustomArgs 替换 {input}/{page}/{page0}/{output}', () => {
    const args = buildCustomArgs('myrast -r 150 -f {page} -i {input} -o {output} --idx {page0}', {
      input: '/tmp/a.pdf',
      page: 7,
      output: '/tmp/o.png',
    });
    expect(args).toEqual(['myrast', '-r', '150', '-f', '7', '-i', '/tmp/a.pdf', '-o', '/tmp/o.png', '--idx', '6']);
  });

  it('单次光栅化页数上限为 5 页（防扫描件 500 页打满磁盘）', () => {
    expect(MAX_RASTER_PAGES).toBe(5);
  });
});
