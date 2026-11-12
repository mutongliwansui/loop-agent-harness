// OCR 文本后处理（需求 20261112-002 / D4）
//
// 背景：WinRT OCR 会在汉字之间插入空格（本机实测 12 个空格对，内网机基本没有），
// 直接喂给主模型会把「信息系统」读成「信 息 系 统」。
//
// 三条硬约束：
// 1. 只合并 **CJK ↔ CJK** 之间的空格，绝不碰「中 ↔ 英数」边界（`V1.0`、`OCR 引擎` 不受影响）；
// 2. **幂等**：紧凑输入（本来就没有字间空格）必须逐字节不变，重复调用结果不变；
// 3. 英文单词之间的空格一个都不能丢。
//
// 幂等性靠两点保证：替换只做「删除/压缩」，不插入任何字符；行首缩进单独保护，不参与压缩。

/** CJK 字符集：汉字（含扩展 A）、CJK 标点、全角形式 */
const CJK_CLASS =
  '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff' + // 汉字与兼容表意
  '\\u3001-\\u303f' + // 、。〈〉《》「」【】等 CJK 标点
  '\\uff01-\\uff60\\uffe0-\\uffe6'; // 全角标点/字母数字/货币

/** CJK 之间的空格（含制表符）→ 删除 */
const CJK_GAP = new RegExp(`(?<=[${CJK_CLASS}])[ \\t]+(?=[${CJK_CLASS}])`, 'g');

/** 全角空格与 CJK 相邻时按字间空格处理（U+3000 在 CJK 标点之外，单列一条） */
const CJK_IDEO_GAP = new RegExp(`(?<=[${CJK_CLASS}])\u3000+|[\u3000]+(?=[${CJK_CLASS}])`, 'g');

/**
 * 合并 CJK 之间的空格（D4 主规则）。
 * 幂等：不含 CJK 间隙的文本原样返回。
 */
export function mergeCjkSpaces(input: string): string {
  if (!input) return '';
  let out = input.replace(CJK_IDEO_GAP, '');
  out = out.replace(CJK_GAP, '');
  return out;
}

/**
 * 行/段重建 + 空行收敛：
 * - 每行去尾部空白（行首缩进保留，避免破坏缩进语义）；
 * - 连续 3 个以上换行收敛为 1 个空行（即最多 2 个 \n）；
 * - 去首尾空行；
 * - 统一 LF 换行。
 */
export function normalizeOcrLines(input: string): string {
  if (!input) return '';
  const lines = input.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  const out: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line === '') {
      blankRun++;
      // 最多保留 1 个空行
      if (blankRun > 1) continue;
    } else {
      blankRun = 0;
    }
    out.push(line);
  }
  while (out.length > 0 && out[0] === '') out.shift();
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/**
 * 行内多空格压缩：仅压缩**行中**（非行首缩进）的连续空白为单个空格。
 * 幂等：单空格与行首缩进不受影响。
 */
export function collapseInnerSpaces(input: string): string {
  if (!input) return '';
  return input
    .split('\n')
    .map((line) => {
      const m = /^([ \t]*)([\s\S]*)$/.exec(line);
      const indent = m?.[1] ?? '';
      const body = (m?.[2] ?? '').replace(/[ \t]{2,}/g, ' ');
      return indent + body;
    })
    .join('\n');
}

/**
 * 完整后处理管道（引擎输出 → 可回填文本）。
 * 顺序固定：先合并 CJK 间隙，再压缩行内空白，最后重建行/空行。
 */
export function postProcessOcrText(input: string): string {
  if (!input) return '';
  let out = mergeCjkSpaces(input);
  out = collapseInnerSpaces(out);
  out = normalizeOcrLines(out);
  return out;
}
