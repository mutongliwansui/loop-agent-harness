// xlsx 文本提取（需求 20261112-001 / 任务 03）
// 读取 workbook.xml + rels + sharedStrings + 各 sheet XML，按行输出单元格文本。
// 边界：日期/百分比等格式化值输出缓存值（可能是序列号）；不保留样式与图表。

import { DocumentExtractError, type ExtractOptions, type ExtractResult, type PageRange } from './types.js';
import { normalizeText } from './text.js';
import { decodeXmlEntities, entryText, readOfficeZip, xmlAttr } from './zip-text.js';

/** rels 中的 Target 归一化为 zip 内路径 */
function normalizeTarget(target: string): string {
  const p = target.replace(/\\/g, '/');
  if (p.startsWith('/')) return p.slice(1);
  if (p.startsWith('xl/')) return p;
  return `xl/${p}`;
}

/** 解析 sharedStrings.xml → 字符串数组 */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const texts = [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) =>
      decodeXmlEntities(x[1]),
    );
    out.push(texts.join(''));
  }
  return out;
}

/** 解析单个 sheet XML → 行文本数组（单元格以制表符分隔） */
function parseSheet(xml: string, shared: string[]): string[] {
  const lines: string[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cell of row[1].matchAll(/<c\b[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const openTagEnd = cell[0].indexOf('>');
      const tag = cell[0].slice(0, openTagEnd + 1);
      const type = xmlAttr(tag, 't');
      const inner = cell[1] ?? '';
      let value = '';

      if (type === 'inlineStr') {
        value = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
          .map((x) => decodeXmlEntities(x[1]))
          .join('');
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const raw = v ? decodeXmlEntities(v[1]) : '';
        if (type === 's') value = shared[Number(raw)] ?? '';
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else value = raw;
      }
      cells.push(value);
    }
    if (cells.some((v) => v.trim() !== '')) lines.push(cells.join('\t'));
  }
  return lines;
}

export async function extractXlsx(
  absPath: string,
  _opts: ExtractOptions,
): Promise<ExtractResult> {
  const zip = await readOfficeZip(absPath);

  const workbook = entryText(zip, 'xl/workbook.xml');
  if (!workbook) {
    throw new DocumentExtractError('corrupt', 'xlsx 缺少 xl/workbook.xml（文件可能已损坏）');
  }

  const rels = entryText(zip, 'xl/_rels/workbook.xml.rels') ?? '';
  const relMap = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = xmlAttr(m[0], 'Id');
    const target = xmlAttr(m[0], 'Target');
    if (id && target) relMap.set(id, normalizeTarget(target));
  }

  const sheets: Array<{ name: string; path: string }> = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = xmlAttr(m[0], 'name') ?? `Sheet${sheets.length + 1}`;
    const rid = xmlAttr(m[0], 'r:id');
    const target = rid ? relMap.get(rid) : null;
    if (target) sheets.push({ name, path: target });
  }
  if (sheets.length === 0) {
    throw new DocumentExtractError('corrupt', 'xlsx 工作簿中没有可读取的工作表');
  }

  const shared = parseSharedStrings(entryText(zip, 'xl/sharedStrings.xml') ?? '');
  const lines: string[] = [];
  const ranges: PageRange[] = [];
  let hasText = false;

  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i];
    const xml = entryText(zip, sheet.path);
    const body = xml ? normalizeText(parseSheet(xml, shared).join('\n')) : '';
    if (body) hasText = true;

    const startLine = lines.length + 1;
    lines.push(`=== Sheet: ${sheet.name} ===`);
    if (body) lines.push(...body.split('\n'));
    ranges.push({ page: i + 1, startLine, endLine: lines.length });
  }

  if (!hasText) {
    throw new DocumentExtractError('empty', `xlsx 没有可提取的单元格文本: ${absPath}`);
  }

  return {
    kind: 'xlsx',
    text: lines.join('\n'),
    pages: ranges,
    pageCount: sheets.length,
    warnings: [],
    truncated: false,
  };
}
