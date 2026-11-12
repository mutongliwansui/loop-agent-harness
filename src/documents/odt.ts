// odt 文本提取（需求 20261112-001 / 任务 03）
// 读取 content.xml，仅抽取 text:h / text:p 的段落文本，不还原样式与表格布局。

import { DocumentExtractError, type ExtractOptions, type ExtractResult } from './types.js';
import { normalizeText } from './text.js';
import { entryText, readOfficeZip, stripXmlTags } from './zip-text.js';

export async function extractOdt(
  absPath: string,
  _opts: ExtractOptions,
): Promise<ExtractResult> {
  const zip = await readOfficeZip(absPath);
  const xml = entryText(zip, 'content.xml');
  if (!xml) {
    throw new DocumentExtractError('corrupt', 'odt 缺少 content.xml（文件可能已损坏）');
  }

  const blocks: string[] = [];
  const re = /<(text:h|text:p)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const inner = m[2]
      .replace(/<text:tab\b[^>]*\/>/g, '\t')
      .replace(/<text:line-break\b[^>]*\/>/g, '\n')
      .replace(/<text:s\b([^>]*)\/>/g, (_all, attrs: string) => {
        const count = /text:c="(\d+)"/.exec(attrs);
        return ' '.repeat(count ? Math.min(Number(count[1]), 1000) : 1);
      });
    const text = stripXmlTags(inner);
    if (text.trim()) blocks.push(text);
  }

  const text = normalizeText(blocks.join('\n'));
  if (!text) {
    throw new DocumentExtractError('empty', `odt 文档没有可提取的文本: ${absPath}`);
  }
  return { kind: 'odt', text, warnings: [], truncated: false };
}
