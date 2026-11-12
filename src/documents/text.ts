// 文档提取文本规范化（需求 20261112-001）
// 独立成模块，供 Word/PDF 等提取器共用，避免 pdf.ts 与 extract.ts 循环依赖。

/**
 * 1. CRLF/CR → LF；
 * 2. 去行尾空白；
 * 3. 连续 ≥3 个空行折叠为 1 个空行（1–2 个空行保留原样）；
 * 4. 去首尾空行。
 */
export function normalizeText(raw: string): string {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''));

  const out: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line === '') {
      blankRun += 1;
      continue;
    }
    if (out.length > 0) {
      const blanks = blankRun >= 3 ? 1 : blankRun;
      for (let i = 0; i < blanks; i++) out.push('');
    }
    blankRun = 0;
    out.push(line);
  }
  return out.join('\n');
}
