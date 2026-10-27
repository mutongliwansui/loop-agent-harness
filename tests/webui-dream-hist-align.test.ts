/**
 * 记忆页「最近触发记录」表数值列对齐回归测试（缺陷修复 20261028-001）
 *
 * 背景：表头用 `th.num`、数值单元格用 `td.nums`（多一个 s），
 * 旧 CSS 只写了 `.dtable thead th.num, .dtable tbody td.num { text-align: right }`，
 * 导致表头右对齐、数值左对齐，视觉上「列错位」（实测表头文本右边界 1009px、数值 881px，差 128px）。
 *
 * 不变量（本测试固化）：
 * 1. DreamHistoryList.vue 中所有 `num` 系（num / nums / num dur）数值单元格类名，
 *    都必须在 style.css 里命中「右对齐」声明，与 `th.num` 同侧；
 * 2. 该对齐规则必须同时覆盖表头 th.num 与数据 td.nums / td.num，避免再次单边。
 * 渲染几何（headless Chrome Range 实测边界）列入任务文档人工验证清单。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS_FILE = fileURLToPath(new URL('../webui/src/style.css', import.meta.url));
const VUE_FILE = fileURLToPath(new URL('../webui/src/components/DreamHistoryList.vue', import.meta.url));

/** 拆出 CSS 里的扁平规则（选择器 + 声明块）；注释先剔除，避免伪规则干扰 */
function cssRules(css: string): { selectors: string[]; body: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { selectors: string[]; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare)) !== null) {
    const selectors = m[1]
      .split(',')
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    out.push({ selectors, body: m[2].trim() });
  }
  return out;
}

/** 取 DreamHistoryList.vue 里 <td class="..."> 中的 num 系类名（num / nums / num dur…） */
function numericCellClasses(vue: string): string[] {
  const found = new Set<string>();
  const re = /<td[^>]*\bclass="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(vue)) !== null) {
    for (const token of m[1].split(/\s+/)) {
      if (/^num/.test(token)) found.add(token);
    }
  }
  return [...found].sort();
}

/** 取 style.css 中「.dtable tbody td.<cls>」被右对齐的类名集合 */
function rightAlignedCells(rules: { selectors: string[]; body: string }[]): Set<string> {
  const set = new Set<string>();
  for (const { selectors, body } of rules) {
    if (!/text-align:\s*right/.test(body)) continue;
    for (const sel of selectors) {
      const m = sel.match(/\.dtable tbody td\.([\w-]+)$/);
      if (m) set.add(m[1]);
    }
  }
  return set;
}

const css = readFileSync(CSS_FILE, 'utf-8');
const vue = readFileSync(VUE_FILE, 'utf-8');
const rules = cssRules(css);

describe('触发记录表数值列对齐', () => {
  it('组件确实使用 nums 数值单元格类（防止本测试失效）', () => {
    expect(numericCellClasses(vue)).toContain('nums');
  });

  it('所有 num 系数值单元格都被右对齐（与表头同侧）', () => {
    const aligned = rightAlignedCells(rules);
    for (const cls of numericCellClasses(vue)) {
      expect(aligned.has(cls), `td.${cls} 缺少 text-align: right`).toBe(true);
    }
  });

  it('同一条对齐规则同时覆盖表头 th.num 与数据 td.num / td.nums（避免单边对齐）', () => {
    const rule = rules.find((r) => /text-align:\s*right/.test(r.body) && r.selectors.some((s) => s.endsWith('thead th.num')));
    expect(rule, '未找到表头 th.num 的右对齐规则').toBeTruthy();
    const joined = rule!.selectors.join(', ');
    expect(joined).toContain('tbody td.num');
    expect(joined).toContain('tbody td.nums');
  });
});
