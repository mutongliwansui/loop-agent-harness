/**
 * Task-20261023-001：editFile 行尾归一化测试
 * 覆盖：CRLF/混合行尾匹配与写回、偏移映射写回字节级保留、replaceAll 索引、
 * 行范围/正则模式行尾适配、失配诊断（mtime/首个差异行/近似候选）。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { editFile } from '../src/tools/editFile.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';

const DIR = join(tmpdir(), 'loop-agent-tests', 'test-edit-file-lineendings');
const file = (name: string): string => join(DIR, name);

function seed(name: string, content: string): string {
  const p = file(name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

/** 读原始内容（不做任何行尾转换） */
function raw(p: string): string {
  return readFileSync(p, 'utf-8');
}

describe('line-endings 基础函数', () => {
  it('detectEol：CRLF 占优返回 CRLF，LF 占优返回 LF，无换行返回 LF', async () => {
    const m = await import('../src/tools/line-endings.js');
    expect(m.detectEol('a\r\nb\r\nc')).toBe('\r\n');
    expect(m.detectEol('a\nb\nc')).toBe('\n');
    expect(m.detectEol('a\r\nb\nc\r\nd')).toBe('\r\n'); // 2 CRLF vs 1 LF
    expect(m.detectEol('no newline')).toBe('\n');
  });

  it('adaptEol：把 \\n 统一为 CRLF；裸 \\r 不动', async () => {
    const m = await import('../src/tools/line-endings.js');
    expect(m.adaptEol('a\nb', '\r\n')).toBe('a\r\nb');
    expect(m.adaptEol('a\r\nb', '\n')).toBe('a\nb');
    expect(m.adaptEol('a\rb', '\r\n')).toBe('a\rb'); // 裸 \r 保留
    expect(m.adaptEol('no newline', '\r\n')).toBe('no newline');
  });

  it('firstDiffLine：定位首个差异行并给出期望/实际', async () => {
    const m = await import('../src/tools/line-endings.js');
    const d = m.firstDiffLine('line1\nline2\nline3', 'line1\nLINE2\nline3');
    expect(d).not.toBeNull();
    expect(d?.line).toBe(2);
    expect(d?.expected).toBe('LINE2');
    expect(d?.actual).toBe('line2');
    expect(m.firstDiffLine('same', 'same')).toBeNull();
  });

  it('anchoredLineDiff：多行块个别行写错，锚定窗口内精确报出不一致行', async () => {
    const m = await import('../src/tools/line-endings.js');
    // 复现会话案例 5：9 行 oldText 第 5 行「以支持」误写为「以 Pairwise」，其余 8 行一致
    const content = 'intro\n# 标题\n\n## 八、验收\n\n5. 配置页原型走查与截图对照说明。\n6. b\n7. c\n8. d\n'
      + '9. 以支持 `openai-fast` 同包多档案。\n10. x\n11. y\n12. z\n13. w\n\n尾巴';
    const oldText = '5. 配置页原型走查与截图对照说明。\n6. b\n7. c\n8. d\n9. 以 Pairwise `openai-fast` 同包多档案。\n10. x\n11. y\n12. z\n13. w';
    const r = m.anchoredLineDiff(content, oldText);
    expect(r).not.toBeNull();
    expect(r?.anchor).toBe(6); // oldText 首行在文件第 6 行
    expect(r?.totalLines).toBe(9);
    expect(r?.exactLines).toBe(8);
    expect(r?.diffs).toHaveLength(1);
    expect(r?.diffs[0].line).toBe(5);
    expect(r?.diffs[0].whitespaceOnly).toBe(false);
    expect(r?.diffs[0].expected).toContain('Pairwise');
    expect(r?.diffs[0].actual).toContain('以支持');
  });

  it('anchoredLineDiff：纯空白差异行标记 whitespaceOnly', async () => {
    const m = await import('../src/tools/line-endings.js');
    const content = 'head\n    const value = 1;\n    const other = 2;\ntail';
    const oldText = 'const value = 1;\n\tconst other = 2;'; // 两行缩进与文件不同（tab vs 4 空格）
    const r = m.anchoredLineDiff(content, oldText);
    expect(r).not.toBeNull();
    expect(r?.diffs).toHaveLength(2);
    expect(r?.diffs.every((d) => d.whitespaceOnly)).toBe(true);
  });

  it('anchoredLineDiff：首行过短或无锚点返回 null（回退 firstDiffLine）', async () => {
    const m = await import('../src/tools/line-endings.js');
    expect(m.anchoredLineDiff('abcdef\nghij', 'ab\ncd')).toBeNull(); // 首行 <8 字符
    expect(m.anchoredLineDiff('one\ntwo', '完全不相干的内容行\n另一行')).toBeNull();
  });

  it('anchoredLineDiff：多个锚点取不一致行最少者', async () => {
    const m = await import('../src/tools/line-endings.js');
    const content = 'x\n5. 第一个候选窗口（一致）。\n6. b\ny\n5. 第二个候选窗口（不一致）。\n6. B';
    const r = m.anchoredLineDiff(content, '5. 第一个候选窗口（一致）。\n6. b');
    expect(r).not.toBeNull();
    expect(r?.anchor).toBe(2);
    expect(r?.diffs).toHaveLength(0);
  });

  it('multilineAnchorHint：^/$ 锚点缺 m 标志给提示，其余返回 null', async () => {
    const m = await import('../src/tools/line-endings.js');
    expect(m.multilineAnchorHint('^\\| row \\|.*$', 'g')).not.toBeNull();
    expect(m.multilineAnchorHint('^row', '')).not.toBeNull();
    expect(m.multilineAnchorHint('end$', 'g')).not.toBeNull();
    expect(m.multilineAnchorHint('^\\| row \\|.*$', 'gm')).toBeNull(); // 已含 m
    expect(m.multilineAnchorHint('plain\\d+', 'g')).toBeNull(); // 无锚点
  });

  it('similarCandidates：首行 ≥8 字符才给候选，最多 3 处 ±2 行', async () => {
    const m = await import('../src/tools/line-endings.js');
    const content = 'x\nconst value = 1;\ny\nconst value = 1;\nz\nconst value = 1;\nw';
    const c = m.similarCandidates(content, 'const value = 2;\nother line');
    expect(c.length).toBe(3);
    expect(c[0]).toContain('第 2 行附近');
    expect(m.similarCandidates('abc\nshort', 'ab\ncd')).toEqual([]);
  });
});

describe('editFile 字面量模式行尾归一化（P0/P1）', () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
  });

  afterAll(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it('LF 多行 oldText 匹配 CRLF 文件，替换段写回 CRLF', async () => {
    const p = seed('crlf.ts', 'function a() {\r\n  return 1;\r\n}\r\n');
    const r = await editFile.execute({
      path: p,
      oldText: 'function a() {\n  return 1;\n}',
      newText: 'function b() {\n  return 2;\n}',
    });
    expect(r).toContain('已编辑');
    expect(raw(p)).toBe('function b() {\r\n  return 2;\r\n}\r\n');
  });

  it('CRLF oldText 匹配 LF 文件（反向归一化）', async () => {
    const p = seed('lf.ts', 'a\nb\nc');
    const r = await editFile.execute({ path: p, oldText: 'a\r\nb', newText: 'X' });
    expect(r).toContain('已编辑');
    expect(raw(p)).toBe('X\nc');
  });

  it('混合行尾文件：未触及区域字节级保留，替换段用主导行尾', async () => {
    const p = seed('mixed.ts', 'a\r\nKEEP\r\nb\nreplace me\nc\r\nTAIL\r\n');
    const r = await editFile.execute({
      path: p,
      oldText: 'replace me',
      newText: 'NEW\nLINE',
    });
    expect(r).toContain('已编辑');
    // 未触及的 \r\n 与 \n 全部原样；替换段（2 行 → 1 处 CRLF 分隔）用主导行尾 CRLF
    expect(raw(p)).toBe('a\r\nKEEP\r\nb\nNEW\r\nLINE\nc\r\nTAIL\r\n');
  });

  it('replaceAll 多处替换：偏移映射索引正确', async () => {
    const p = seed('multi.ts', 'v=1;\r\nv=2;\r\nv=1;\r\n');
    const r = await editFile.execute({
      path: p,
      oldText: 'v=1;',
      newText: 'w=9;',
      replaceAll: true,
    });
    expect(r).toContain('替换 2 处');
    expect(raw(p)).toBe('w=9;\r\nv=2;\r\nw=9;\r\n');
  });

  it('多处匹配且未开 replaceAll 仍报错，且不改动文件', async () => {
    const p = seed('dup.ts', 'a\r\nb\r\na\r\n');
    await expect(
      editFile.execute({ path: p, oldText: 'a', newText: 'z' }),
    ).rejects.toThrow(/出现 2 处/);
    expect(raw(p)).toBe('a\r\nb\r\na\r\n');
  });

  it('行范围模式：CRLF 文件整段替换保持 CRLF、newText 多行适配', async () => {
    const p = seed('range.ts', 'l1\r\nl2\r\nl3\r\n');
    const r = await editFile.execute({
      path: p,
      startLine: 2,
      endLine: 2,
      newText: 'n2a\nn2b',
    });
    expect(r).toContain('整段替换');
    expect(raw(p)).toBe('l1\r\nn2a\r\nn2b\r\nl3\r\n');
  });

  it('行范围模式：CRLF 文件提供 LF 多行 oldText 校验通过', async () => {
    const p = seed('range-check.ts', 'l1\r\nl2\r\nl3\r\n');
    const r = await editFile.execute({
      path: p,
      startLine: 1,
      endLine: 2,
      oldText: 'l1\nl2',
      newText: 'x',
    });
    expect(r).toContain('已编辑');
    expect(raw(p)).toBe('x\r\nl3\r\n');
  });

  it('正则模式：匹配语义不变，newText 行尾适配主导行尾', async () => {
    const p = seed('regex.ts', 'v=1\r\nv=2\r\n');
    const r = await editFile.execute({
      path: p,
      oldText: 'v=\\d',
      newText: 'v=X\nY',
      regex: true,
      replaceAll: true,
    });
    expect(r).toContain('正则替换 2 处');
    expect(raw(p)).toBe('v=X\r\nY\r\nv=X\r\nY\r\n');
  });

  it('归一化仍失配：报未找到 + 锚定式逐行诊断（oldText 锚定文件头时与旧首个差异行等价）', async () => {
    const p = seed('miss.ts', 'alpha one\r\nbeta two\r\ngamma three\r\n');
    const err = await editFile
      .execute({ path: p, oldText: 'alpha onx\nbeta two', newText: 'z' })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('未在');
    expect(msg).toContain('要替换的文本');
    expect(msg).not.toContain('未找到');
    expect(msg).toContain('首行在第 1 行附近命中');
    expect(msg).toContain('2 行中 1 行一致、1 行不一致');
    expect(msg).toContain('期望: alpha onx');
    expect(msg).toContain('实际: alpha one');
    expect(msg).toContain('近似候选');
    expect(msg).not.toContain('并发修改');
    // 文件未被改动
    expect(raw(p)).toBe('alpha one\r\nbeta two\r\ngamma three\r\n');
  });

  it('无锚点命中时回退首个差异行诊断', async () => {
    const p = seed('noanchor.ts', 'alpha one\r\nbeta two\r\ngamma three\r\n');
    const err = await editFile
      .execute({ path: p, oldText: 'completely different text\n另一行', newText: 'z' })
      .catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).toContain('首个差异在第 1 行'); // 回退路径保留
    expect(msg).toContain('期望: completely different text');
  });

  it('多行块个别行写错：诊断锚定 oldText 所在窗口并逐行比对（会话案例 5 回归）', async () => {
    // oldText 首行不在文件头：旧诊断会从文件头锚定报「首个差异在第 1 行」（噪音），
    // 新诊断按首行锚定到第 235 行附近窗口，精确指出第 5 行不一致
    const p = seed(
      'table.md',
      '# 任务 01：core 收敛为纯定义层\n\n前言若干行\n\n## 五、文件清单\n\n'
        + '| 文件 | 改动 | 阶段 |\n|---|---|---|\n| `core/src/registry.ts` | **删除** | P0 |\n'
        + '| `core/README.md` | 更新示例 | P0 |\n| `core/CHANGELOG.md` | 新增段落 | P1 |\n',
    );
    const err = await editFile
      .execute({
        path: p,
        oldText: '| 文件 | 改动 |\n|---|---|\n| `core/src/registry.ts` | **删除** | P0 |\n| `core/README.md` | 删除 §3.8 | P0 |',
        newText: 'z',
      })
      .catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).toContain('首行在第 7 行附近命中');
    expect(msg).toContain('4 行中 1 行一致、3 行不一致');
    expect(msg).toContain('期望: | 文件 | 改动 |');
    expect(msg).toContain('实际: | 文件 | 改动 | 阶段 |');
    expect(msg).toContain('期望: |---|---|');
    expect(msg).toContain('实际: |---|---|---|');
    expect(msg).toContain('期望: | `core/README.md` | 删除 §3.8 | P0 |');
    expect(msg).toContain('实际: | `core/README.md` | 更新示例 | P0 |');
    expect(msg).not.toContain('首个差异在第 1 行'); // 不再从文件头锚定产生噪音
    expect(raw(p)).not.toContain('z'); // 文件未被改动
  });

  it('多行块全部行仅空白差异：空白容错直接命中成功（tab 缩进 oldText vs 空格文件）', async () => {
    const p = seed('indent.ts', 'function a() {\r\n    return 1; // 4 空格缩进\r\n}\r\n');
    const r = await editFile
      .execute({
        path: p,
        oldText: 'function a() {\n\treturn 1; // 4 空格缩进\n}', // 模型用 tab 重构缩进
        newText: 'function a() {\n\treturn 2;\n}',
      })
      .then((v) => v)
      .catch((e: Error) => e);
    const msg = (r as Error).message ?? String(r);
    expect(msg).toContain('空白容错匹配');
    // tab 行在文件侧落为 4 空格主导缩进的邻域（tab 宽度按字符数钳制），仅空白差异
    expect(raw(p)).toContain('return 2;');
    expect(raw(p)).toContain('function a() {');
  });

  it('正则 ^ 锚点缺 m 标志失败：附跨行锚定提示（会话案例 1 回归）', async () => {
    const p = seed('rows.md', '| 20261114-003 | 某需求 |\n| 20261114-004 | 另一需求 |\n');
    const err = await editFile
      .execute({
        path: p,
        oldText: '^\\| 20261114-003 \\|.*$',
        newText: '$&\nnew row',
        regex: true,
        flags: 'g', // 缺 m
      })
      .catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).toContain('未在');
    expect(msg).toContain('未启用 m 标志');
    expect(msg).toContain('flags: "gm"');
  });

  it('正则含 m 标志不触发锚定提示', async () => {
    const p = seed('rows-m.md', '| 20261114-003 | 某需求 |\n');
    const err = await editFile
      .execute({
        path: p,
        oldText: '^\\| 20261115 \\|.*$',
        newText: 'x',
        regex: true,
        flags: 'gm',
      })
      .catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).not.toContain('m 标志');
  });

  it('真实踩坑回归：oldText 首行多一个前导空格 → 空白容错直接命中成功', async () => {
    // fix/0.1.1 实施会话中，Agent 编辑 editFile.ts 时 oldText 首行误带一个前导空格（" import {"），
    // 旧版报「首个差异在第 1 行：期望 ` import {` / 实际文件头注释」的跨区域噪音；
    // 空白容错（第二级匹配）后：同样输入第一次调用即成功，缩进按文件实际对齐
    const p = seed(
      'leading-space.ts',
      "// 头部注释一\n// 头部注释二\nimport { readFile } from 'node:fs/promises';\n"
        + "import { resolveToolPath } from './workspace-fs.js';\nimport {\n  detectEol,\n  normalizeEol,\n  adaptEol,\n  firstDiffLine,\n  similarCandidates,\n  replaceNormalized,\n  recordWriteMtime,\n  isMtimeChanged,\n} from './line-endings.js';\n",
    );
    const r = await editFile.execute({
      path: p,
      oldText:
        ' import {\n  detectEol,\n  normalizeEol,\n  adaptEol,\n  firstDiffLine,\n  similarCandidates,\n  replaceNormalized,\n  recordWriteMtime,\n  isMtimeChanged,\n} from \'./line-endings.js\';',
      newText: 'import {\n  detectEol,\n} from \'./line-endings.js\';',
    });
    expect(r).toContain('已编辑');
    expect(r).toContain('空白容错匹配');
    expect(r).toContain('第 1 行空白差异已按文件实际缩进对齐');
    // newText 首行无缩进（与 oldText 首行同为零缩进）→ 文件侧也是零缩进
    expect(raw(p)).toContain("import {\n  detectEol,\n} from './line-endings.js';");
    expect(raw(p)).not.toContain('__EDIT_SHOULD_NOT_LAND__');
  });

  it('空白容错：newText 相对缩进传导（oldText 整体多缩进时 newText 按文件缩进落盘）', async () => {
    const m = await import('../src/tools/line-endings.js');
    // 文件用 2 空格缩进；oldText 误用 6 空格重构；newText 按 oldText 的错误缩进写
    const content = 'function a() {\n  return 1;\n}\n';
    const oldText = '      return 1;'; // 6 空格 vs 文件 2 空格
    const newText = '      return 2; // 新注释'; // 相对 oldText 缩进一致
    const r = m.tolerateReplace(content, oldText, newText, false);
    expect(r).not.toBeNull();
    expect(r?.toleratedRows).toEqual([{ hit: 1, absorbed: [1] }]);
    expect(r?.updated).toBe('function a() {\n  return 2; // 新注释\n}\n'); // 文件 2 空格缩进
  });

  it('空白容错：newText 缩进多出（新增行）按 oldText 末行缩进差映射', async () => {
    const m = await import('../src/tools/line-endings.js');
    const content = 'loop:\n    doX();\nend\n';
    const oldText = '  doX();'; // 2 空格 vs 文件 4 空格
    const newText = '  doX();\n  doY();'; // 新增行同缩进
    const r = m.tolerateReplace(content, oldText, newText, false);
    expect(r).not.toBeNull();
    expect(r?.updated).toBe('loop:\n    doX();\n    doY();\nend\n');
  });

  it('空白容错：tab↔空格结构冲突（newText 前导空白无法映射）整体放弃', async () => {
    const m = await import('../src/tools/line-endings.js');
    const content = 'loop:\n    doX();\nend\n';
    // oldText 带 2 空格缩进（trim 后与文件行同内容），newText 首行改用 tab 缩进：
    // wsOld('  ') 与 wsNew('\t') 前导空白结构不同，无法映射 → 整体放弃容错
    const r = m.tolerateReplace(content, '  doX();', '\tdoY();', false);
    expect(r).toBeNull();
  });

  it('空白容错：内容级差异不容错（一字符不同即不命中）', async () => {
    const m = await import('../src/tools/line-endings.js');
    const r = m.tolerateReplace('alpha one\nbeta two\n', 'alpha onx\nbeta two', 'z', false);
    expect(r).toBeNull();
  });

  it('空白容错：多处命中未开 replaceAll 报 multiple', async () => {
    const m = await import('../src/tools/line-endings.js');
    const content = 'a\n    x=1;\nb\n    x=1;\n';
    const r = m.tolerateReplace(content, '  x=1;', '  x=2;', false);
    expect(r).not.toBeNull();
    expect(r?.multiple).toBe(true);
    expect(r?.count).toBe(2);
  });

  it('空白容错：CRLF 文件 + 行尾空格差异照常命中，写回 CRLF', async () => {
    const m = await import('../src/tools/line-endings.js');
    const content = 'a\r\nkeep  \r\nb\r\n'; // 文件行「keep  」带行尾空格
    const r = m.tolerateReplace(content, 'keep', 'REPLACED', false);
    expect(r).not.toBeNull();
    expect(r?.updated).toBe('a\r\nREPLACED\r\nb\r\n');
  });

  it('空白容错：重叠窗口只取不重叠命中', async () => {
    const m = await import('../src/tools/line-endings.js');
    // 「x x」中单行 x 只命中 2 处（重叠的第 2 个 x 被跳过）
    const r = m.tolerateReplace('x\nx\n', 'x', 'y', true);
    expect(r).not.toBeNull();
    expect(r?.count).toBe(2);
    expect(r?.updated).toBe('y\ny\n');
  });
});
