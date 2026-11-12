// docx 正文提取（零依赖，需求 20261112-005）
//
// 为什么不再用 word-extractor 解 docx：
// word-extractor 的 docx 路径是 yauzl → fd-slicer 切片流 → pipe(zlib.inflateRaw)。
// fd-slicer 的 `_read` 单块上限取 highWaterMark（默认 16384），一旦某条目「压缩后大小 ≥ 16384」，
// 首块 16384 字节膨胀出的数据就会击穿 zlib 可写缓冲 → pipe 暂停源流；源流此后既不补发
// 'data' 也不再 resume，滞留的尾块与 EOF 永不发出 → inflate 既不 'end' 也不 'error' →
// yauzl 的 Promise 永不 settle → extract() 无限挂起。
// 该判据只与「条目压缩后大小 ≥ 16384」有关，与文档实际大小、文字量无关
// （实例：document.xml 压缩后 16453 / 原始 285735 必挂；压缩后 11864 / 原始 20202 12ms 正常）。
//
// 本项目 xlsx/pptx/odt 与 docx 图片收集早已走 `skill/zip.ts` 的同步零依赖解析
// （readFile + inflateRawSync），不存在流控问题；本文件让 docx 正文也走同一条路，
// 顺带获得条目数与解压总量上限（压缩炸弹防护），且不新增依赖。

import { DocumentExtractError } from './types.js';
import { decodeXmlEntities, readOfficeZip } from './zip-text.js';

/** docx 正文所在条目（Word 的正文主文档部件） */
const DOCUMENT_ENTRY = 'word/document.xml';

/** 不参与取文的上下文：修订删除、域代码、制表位定义、绘图对象（对齐 word-extractor 语义） */
const SKIP_CONTEXT = new Set(['w:del', 'w:instrText', 'w:delText', 'w:tabs', 'w:drawing']);

/**
 * 常见 Unicode 标点归一（与 word-extractor/lib/filters.js 的 filter() 逐项一致）。
 * 复刻而非放宽：解析器换实现但输出口径必须保持不变，否则同一文档的提取结果会漂移。
 */
const PUNCT_MAP: Record<string, string> = {
  '\u2002': ' ',
  '\u2003': ' ',
  '\u2012': '-',
  '\u2013': '-',
  '\u2014': '-',
  '\u2018': "'",
  '\u2019': "'",
  '\u201c': '"',
  '\u201d': '"',
};
const PUNCT_RE = /[\u2002\u2003\u2012\u2013\u2014\u2018\u2019\u201c\u201d]/g;

/** 标点归一（对齐 word-extractor 的 filterUnicode=true 默认行为） */
function filterPunct(s: string): string {
  return s.replace(PUNCT_RE, (m) => PUNCT_MAP[m]);
}

/**
 * 从 word/document.xml 抽取正文文本（轻量标签扫描，不做完整 XML 解析）。
 *
 * 分段口径与 word-extractor 对齐：
 * - `</w:p>` → 换行；`</w:tr>` → 换行；`</w:tc>` → 制表符（单元格分隔，先吃掉段末换行）；
 * - `<w:tab/>` → 制表符；`<w:br/>`/`<w:cr/>` → 换行；
 * - 修订删除（w:del）、域代码（w:instrText）、制表位定义（w:tabs）、绘图对象（w:drawing）内的文本不取。
 */
export function docxBodyFromXml(xml: string): string {
  const pieces: string[] = [];
  /** 跳过上下文栈（只对良构 XML 的配对闭合出栈） */
  const skip: string[] = [];
  // 依次识别：XML 声明/处理指令、注释、CDATA、元素标签、文本节点。
  // 处理指令与注释必须先于「文本节点」分支被吃掉，否则 `<?xml ...?>` 会退化成正文
  // （正则引擎在 `<` 处不匹配标签后前移一位，`?xml ...?>` 就成了普通文本）。
  const token =
    /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<!(?:[^>\[]|\[[\s\S]*?\])*>|<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;

  let m: RegExpExecArray | null;
  while ((m = token.exec(xml)) !== null) {
    const [, cdata, closing, name, , selfClosing, text] = m;

    // CDATA：内容即文本（不参与实体解码）
    if (cdata !== undefined) {
      if (skip.length === 0 && cdata.length > 0) pieces.push(cdata);
      continue;
    }

    // 文本节点：仅在非跳过上下文内取值
    if (text !== undefined) {
      if (skip.length === 0 && text.length > 0) pieces.push(decodeXmlEntities(text));
      continue;
    }

    if (name === undefined) continue; // 处理指令 / 注释 / DOCTYPE

    if (selfClosing === '/') {
      if (skip.length > 0) continue;
      if (name === 'w:tab') pieces.push('\t');
      else if (name === 'w:br' || name === 'w:cr') pieces.push('\n');
      continue;
    }

    if (closing === '/') {
      if (skip.length > 0) {
        if (skip[skip.length - 1] === name) skip.pop();
        continue;
      }
      if (name === 'w:p') {
        pieces.push('\n');
      } else if (name === 'w:tc') {
        // 单元格结束：把段末换行换成制表符，保持「一行一条表格记录」
        if (pieces[pieces.length - 1] === '\n') pieces.pop();
        pieces.push('\t');
      } else if (name === 'w:tr') {
        pieces.push('\n');
      }
      continue;
    }

    if (SKIP_CONTEXT.has(name)) skip.push(name);
  }

  return filterPunct(pieces.join(''));
}

/**
 * 提取 docx 正文文本。
 * 解压失败/结构非法 → DocumentExtractError('corrupt')；缺正文部件 → corrupt。
 */
export async function extractDocxBody(absPath: string): Promise<string> {
  return docxBodyFromZip(await readOfficeZip(absPath));
}

/**
 * 从已解压的 docx 压缩包取正文文本（供调用方与图片收集共用一次解包）。
 * 缺正文部件 → DocumentExtractError('corrupt')。
 */
export function docxBodyFromZip(zip: Map<string, Buffer>): string {
  const buf = zip.get(DOCUMENT_ENTRY);
  if (!buf) {
    throw new DocumentExtractError('corrupt', `docx 中缺少正文部件 ${DOCUMENT_ENTRY}`);
  }
  return docxBodyFromXml(buf.toString('utf-8'));
}
