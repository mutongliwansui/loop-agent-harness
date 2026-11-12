// Word 文本提取（需求 20261112-001 / 任务 01）
// 复用已有 word-extractor@1.x：同时支持 OLE 的 .doc 与 OOXML 的 .docx，纯 JS、跨平台、无需 Office。

import WordExtractor from 'word-extractor';

/**
 * 提取 Word 正文文本（doc/docx 自适应）。
 * 失败时抛出底层错误，由 extract.ts 统一映射为 DocumentExtractError('corrupt')。
 */
export async function extractWordBody(absPath: string): Promise<string> {
  const doc = await new WordExtractor().extract(absPath);
  return doc.getBody();
}
