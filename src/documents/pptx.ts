// pptx 文本提取（需求 20261112-001 / 任务 03）
// 按 slide 数字序提取 <a:t> 文本；每页一个 === 第 N 页 === 分段，供 fileRead.pages 回读。

import { DocumentExtractError, type ExtractOptions, type ExtractResult, type PageRange } from './types.js';
import { normalizeText } from './text.js';
import { readOfficeZip, stripXmlTags } from './zip-text.js';
import { collectZipImages } from './images.js';

/** 提取单页文本：按 <a:p> 段落分组，段内 <a:t> 运行拼接 */
function parseSlide(xml: string): string {
  const paragraphs: string[] = [];
  for (const p of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const runs = [...p[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => stripXmlTags(m[1]));
    const text = runs.join('').trim();
    if (text) paragraphs.push(text);
  }
  return normalizeText(paragraphs.join('\n'));
}

export async function extractPptx(
  absPath: string,
  _opts: ExtractOptions,
): Promise<ExtractResult> {
  const zip = await readOfficeZip(absPath);

  const slides: Array<{ num: number; path: string }> = [];
  for (const name of zip.keys()) {
    const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
    if (m) slides.push({ num: Number(m[1]), path: name });
  }
  slides.sort((a, b) => a.num - b.num);

  if (slides.length === 0) {
    throw new DocumentExtractError('corrupt', 'pptx 中没有可读取的幻灯片');
  }

  const lines: string[] = [];
  const ranges: PageRange[] = [];
  let hasText = false;

  for (let i = 0; i < slides.length; i++) {
    const xml = zip.get(slides[i].path)?.toString('utf-8') ?? '';
    const body = parseSlide(xml);
    if (body) hasText = true;

    const startLine = lines.length + 1;
    lines.push(`=== 第 ${i + 1} 页 ===`);
    if (body) lines.push(...body.split('\n'));
    ranges.push({ page: i + 1, startLine, endLine: lines.length });
  }

  if (!hasText) {
    const images = collectZipImages(zip);
    if (images.length === 0) {
      throw new DocumentExtractError('empty', `pptx 没有可提取的幻灯片文本: ${absPath}`);
    }
    // 纯图片幻灯片：正文为空，图片交回工具层决定是否 OCR
    return {
      kind: 'pptx',
      text: lines.join('\n'),
      pages: ranges,
      pageCount: slides.length,
      images,
      warnings: [`幻灯片没有可提取的文本，仅收集到 ${images.length} 张图片`],
      truncated: false,
    };
  }

  return {
    kind: 'pptx',
    text: lines.join('\n'),
    pages: ranges,
    pageCount: slides.length,
    images: collectZipImages(zip),
    warnings: [],
    truncated: false,
  };
}
