/**
 * OCR 版面还原与预处理单测（需求 20261112-003 / 任务 01、02）
 *
 * 覆盖：D3 视觉行 y 聚类、D4 x 投影列聚类（含 7 碎簇反例）、三档 layout 渲染与回落、
 *       D6 scale/crop 归一化与入参透传、D7 maxChars 按行截断与默认值语义、
 *       D9 结构化缓存（切 layout 复用同一份缓存）、D10 幂等、D12 无坐标引擎降级。
 *
 * 引擎用 mock 替换（不真起 powershell.exe）：单测只验证纯函数与编排决策，
 * WinRT 脚本的真实行为由真机验证覆盖（见 task-20261112-003-01/02 验收项）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import type { OcrConfig } from '../src/config/schema.js';

// ── 引擎 mock：可指定原始行结构与词坐标，并记录 recognize 入参 ────────────
const engineState = vi.hoisted(() => ({
  available: true,
  text: 'FALLBACK',
  lang: 'zh-Hans-CN',
  elapsedMs: 15,
  warnings: [] as string[],
  lines: undefined as unknown,
  imageSize: undefined as unknown,
  calls: 0,
  lastOpts: undefined as unknown,
}));

vi.mock('../src/ocr/engine-winrt.js', () => ({
  winrtOcrEngine: {
    id: 'winrt-ocr',
    langs: ['zh-Hans-CN'],
    isAvailable: async () => engineState.available,
    recognize: async (_image: Buffer, opts: unknown) => {
      engineState.calls++;
      engineState.lastOpts = opts;
      return {
        text: engineState.text,
        lang: engineState.lang,
        elapsedMs: engineState.elapsedMs,
        warnings: [...engineState.warnings],
        ...(engineState.lines ? { lines: engineState.lines } : {}),
        ...(engineState.imageSize ? { imageSize: engineState.imageSize } : {}),
      };
    },
  },
  probeWinrt: async () => ({ ok: engineState.available, langs: ['zh-Hans-CN'], lang: 'zh-Hans-CN' }),
  resetWinrtProbeCache: () => {},
  winrtOcrLikelyAvailable: () => engineState.available,
  powershellPath: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  WINRT_SCRIPT: '',
  resolveWinrtScriptPath: async () => 'script.ps1',
}));

const { buildVisualLines, clusterColumns, renderLayout, medianWordHeight, describeImageSize } =
  await import('../src/ocr/layout.js');
const { runOcr, clearOcrCache, normalizeLayout, normalizeScale, normalizeCrop, truncateOcrText, buildOcrResultText } =
  await import('../src/ocr/run-ocr.js');
const { OcrResultCache, OCR_CACHE_VERSION } = await import('../src/ocr/cache.js');
const { formatCropArg } = await import('../src/ocr/types.js');
const { postProcessOcrText } = await import('../src/ocr/postprocess.js');

// ── 夹具 ────────────────────────────────────────────────────────────────

/** 造一个能通过魔数嗅探的 PNG（内容随 seed 变化，避免缓存互通） */
function png(seed = 'a'): Buffer {
  const body = Buffer.alloc(16, 0);
  Buffer.from(seed, 'utf8').copy(body, 0, 0, Math.min(16, Buffer.byteLength(seed)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), body]);
}

function cfg(over: Partial<OcrConfig> = {}): OcrConfig {
  return { ...DEFAULT_CONFIG.ocr, cacheEnabled: false, ...over };
}

interface W {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function w(t: string, x: number, y: number, ww = 60, h = 20): W {
  return { t, x, y, w: ww, h };
}

/**
 * 模拟 WinRT 的真实切行：同一视觉行里的「名称」与「日期」被切成**两个 Line**
 * （实测 Lines 45 / Text 无换行，见设计方案 §2.1）。
 */
function gridLines(rows: Array<[string, string]>): Array<{ text: string; words: W[] }> {
  return rows.flatMap(([name, date], i) => {
    const y = 20 + i * 30;
    return [
      { text: name, words: [w(name, 10, y, Math.max(60, name.length * 10))] },
      { text: date, words: [w(date, 400, y, 120)] },
    ];
  });
}

const ROWS: Array<[string, string]> = [
  ['winrt-ocr-probe.ps1', '2026/11/12 17:19'],
  ['调用方案.md', '2026/11/12 16:02'],
  ['小智前后台一问数配方.zip', '2026/11/11 09:30'],
  ['电网业务语义提取方案.docx', '2026/11/10 21:44'],
];

beforeEach(() => {
  clearOcrCache();
  engineState.calls = 0;
  engineState.lines = undefined;
  engineState.imageSize = { width: 1293, height: 1164 };
  engineState.text = 'FALLBACK';
  engineState.lastOpts = undefined;
  engineState.warnings = [];
});

// ── D3 视觉行重建 ───────────────────────────────────────────────────────

describe('buildVisualLines：按 y 中心聚类重建人眼所见行（D3）', () => {
  it('同一视觉行被引擎切成两个 Line 时合并为一行，名称与日期同行', () => {
    const words = gridLines([ROWS[0]]).flatMap((l) => l.words) as W[];
    const lines = buildVisualLines(words);
    expect(lines).toHaveLength(1);
    // 列间空隙大于阈值 → 用 ` | ` 标记列分隔（便于人眼与模型辨认列）
    expect(lines[0].text).toContain('winrt-ocr-probe.ps1');
    expect(lines[0].text).toContain('2026/11/12 17:19');
    expect(lines[0].text).toContain(' | ');
    expect(lines[0].text.indexOf('winrt')).toBeLessThan(lines[0].text.indexOf('2026'));
  });

  it('4 行数据 → 4 个视觉行（不是 8 个引擎行）', () => {
    const words = gridLines(ROWS).flatMap((l) => l.words) as W[];
    const lines = buildVisualLines(words);
    expect(lines).toHaveLength(ROWS.length);
    expect(lines.map((l) => l.text)).toEqual(ROWS.map(([n, d]) => `${n} | ${d}`));
  });

  it('微小 y 抖动（字号内）仍并入同一行', () => {
    const words = [w('名称', 10, 20), w('日期', 400, 23)]; // 中心差 3px，容差内
    expect(buildVisualLines(words)).toHaveLength(1);
  });

  it('跨行间距足够大时分成两行', () => {
    const words = [w('第一行', 10, 20), w('第二行', 10, 80)];
    expect(buildVisualLines(words)).toHaveLength(2);
  });

  it('空词与空输入不影响行数', () => {
    expect(buildVisualLines([])).toHaveLength(0);
    expect(buildVisualLines([w('  ', 10, 20), w('字', 60, 20)])[0].words).toHaveLength(1);
  });

  it('medianWordHeight 用于自动缩放容差（不同 DPI 可迁移）', () => {
    expect(medianWordHeight([w('a', 0, 0, 10, 10), w('b', 0, 0, 10, 30)])).toBe(20);
    expect(medianWordHeight([])).toBe(0);
  });

  it('引擎把日期过度切分时，紧邻字符合并、与时间之间断句（三档分隔）', () => {
    // 真机实测（medH=16）：`2026/11/12 17:19` 被 WinRT 切成
    // `2026` `/` `1` `1` `/` `1` `2` `17` `：` `1` `9`，日期内部字距 1–6px，
    // 日期↔时间交界 7–8px。紧邻阈值 0.4×medH≈6.4 应把它们分开。
    const h = 16;
    // 按实测字距布置：日期内部 1–6px，日期↔时间 8px（medH=16 → 紧邻阈值 6.4）
    const chars: Array<[string, number, number]> = [
      ['2026', 0, 36], ['/', 37, 4], ['1', 43, 9], ['1', 58, 9], ['/', 71, 4], ['1', 77, 9],
      ['2', 91, 9], ['17', 108, 18], ['：', 128, 9], ['1', 140, 9], ['9', 154, 9],
    ];
    const words = chars.map(([t, x, ww]) => w(t, x, 20, ww, h));
    const lines = buildVisualLines(words);
    expect(lines).toHaveLength(1);
    // 日期内部合并成连续串，日期与时间之间保留空格
    expect(lines[0].text).toBe('2026/11/12 17：19');
  });

  it('拉丁单词之间的空格不被紧邻规则吞掉（hello world 不粘连）', () => {
    const h = 16;
    // 两词间隙 5px < 紧邻阈值 6.4，但两侧都是拉丁字母 → 必须保留空格
    const words = [w('hello', 0, 20, 40, h), w('world', 45, 20, 40, h)];
    expect(buildVisualLines(words)[0].text).toBe('hello world');
  });

  it('数字与标点即使间隙小也应合并（0.5 → 0.5，不出现 0 . 5）', () => {
    const h = 16;
    const words = [w('0', 0, 20, 9, h), w('.', 11, 20, 4, h), w('5', 17, 20, 9, h)];
    expect(buildVisualLines(words)[0].text).toBe('0.5');
  });
});

// ── D4 列聚类 ───────────────────────────────────────────────────────────

describe('clusterColumns：x 投影空白带列聚类（D4）', () => {
  it('日期内部的空格不会切出碎列（原型 7 碎簇反例）', () => {
    // 每行日期都按 `2026` `/` `11` `/` `12` 切成 5 个词，词起点各不相同
    const words: W[] = [];
    ROWS.forEach(([name], i) => {
      const y = 20 + i * 30;
      words.push(w(name, 10, y, 200));
      const xs = [700, 720, 740, 760, 780];
      ['2026', '/', '11', '/', '12'].forEach((t, k) => words.push(w(t, xs[k], y, 14)));
    });
    const spans = clusterColumns(words, 30);
    expect(spans).toHaveLength(2); // 名称列 + 日期列（若用词起点聚类会是 7 簇）
  });

  it('单列内容只得到 1 个区间', () => {
    expect(clusterColumns([w('a', 10, 0, 40), w('b', 60, 20, 40)], 30)).toHaveLength(1);
  });

  it('空输入返回空数组', () => {
    expect(clusterColumns([], 30)).toHaveLength(0);
  });
});

// ── 三档渲染与回落 ──────────────────────────────────────────────────────

describe('renderLayout：text / table / words 三档（D4/D5/D13）', () => {
  const lines = gridLines(ROWS) as never;

  it('text：一行一条，列间用 ` | `', () => {
    const r = renderLayout(lines, 'text');
    expect(r.applied).toBe('text');
    expect(r.lineCount).toBe(4);
    expect(r.wordCount).toBe(8);
    expect(r.text.split('\n')).toHaveLength(4);
  });

  it('table：输出 markdown 表格，首行为表头，数据行齐全', () => {
    const r = renderLayout(lines, 'table');
    expect(r.applied).toBe('table');
    expect(r.columns).toBe(2);
    const rows = r.text.split('\n');
    expect(rows[0]).toMatch(/^\| .+ \| .+ \|$/);
    expect(rows[1]).toBe('| --- | --- |');
    expect(rows).toHaveLength(2 + ROWS.length - 1); // 表头 + 分隔 + 数据行
    expect(r.text).toContain('winrt-ocr-probe.ps1');
  });

  it('table 单元格内 CJK 字间空格被合并（否则格内是「调 用 方 案」）', () => {
    const spaced = [
      { text: 'x', words: [w('调 用 方 案', 10, 20, 100), w('2026', 400, 20, 80)] },
      { text: 'y', words: [w('甲', 10, 60, 100), w('2027', 400, 60, 80)] },
      { text: 'z', words: [w('乙', 10, 100, 100), w('2028', 400, 100, 80)] },
    ] as never;
    expect(renderLayout(spaced, 'table').text).toContain('调用方案');
    expect(renderLayout(spaced, 'table').text).not.toContain('调 用 方 案');
  });

  it('行数 <3 时回落 text 并给出告警（宁可不出表格也不出错表格）', () => {
    const two = gridLines(ROWS.slice(0, 2)) as never;
    const r = renderLayout(two, 'table');
    expect(r.applied).toBe('text');
    expect(r.warning).toContain('纯文本');
  });

  it('单列内容回落 text 并给出告警', () => {
    const single = ROWS.map(([name], i) => ({ text: name, words: [w(name, 10, 20 + i * 30, 200)] })) as never;
    const r = renderLayout(single, 'table');
    expect(r.applied).toBe('text');
    expect(r.warning).toContain('纯文本');
  });

  it('words：TSV 五列，行数等于词数，坐标为原图整数', () => {
    const r = renderLayout(lines, 'words');
    expect(r.applied).toBe('words');
    const rows = r.text.split('\n');
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      const cols = row.split('\t');
      expect(cols).toHaveLength(5);
      expect(cols.slice(0, 4).every((c) => /^\d+$/.test(c))).toBe(true);
    }
    expect(rows[0].endsWith('\twinrt-ocr-probe.ps1')).toBe(true);
  });

  it('无坐标（lines 为空）时回落 text 并告警', () => {
    const r = renderLayout([], 'table');
    expect(r.applied).toBe('text');
    expect(r.text).toBe('');
    expect(r.warning).toContain('纯文本');
  });

  it('幂等：重复渲染逐字节一致（D10）', () => {
    for (const layout of ['text', 'table', 'words'] as const) {
      const a = renderLayout(lines, layout).text;
      const b = renderLayout(lines, layout).text;
      expect(b).toBe(a);
    }
    // 后处理对已分行文本幂等（有/无字间空格两种输入都不再变化）
    const once = postProcessOcrText('调用方案 | 2026/11/12');
    expect(postProcessOcrText(once)).toBe(once);
  });
});

// ── 参数归一化 ──────────────────────────────────────────────────────────

describe('layout / scale / crop 归一化（D6）', () => {
  it('layout 非法值回落默认', () => {
    expect(normalizeLayout('table')).toBe('table');
    expect(normalizeLayout('TABLE')).toBe('table');
    expect(normalizeLayout('grid')).toBe('text');
    expect(normalizeLayout(undefined)).toBe('text');
    expect(normalizeLayout('grid', 'table')).toBe('table');
  });

  it('scale 钳制到 1–4 整数', () => {
    expect(normalizeScale(1)).toBe(1);
    expect(normalizeScale(2.4)).toBe(2);
    expect(normalizeScale(0)).toBe(1);
    expect(normalizeScale(-3)).toBe(1);
    expect(normalizeScale(9)).toBe(4);
    expect(normalizeScale('3')).toBe(3);
    expect(normalizeScale('abc')).toBe(1);
    expect(normalizeScale(undefined)).toBe(1);
  });

  it('crop 必须是 4 个有限数且宽高为正', () => {
    expect(normalizeCrop([0, 0, 100, 50])).toEqual([0, 0, 100, 50]);
    expect(normalizeCrop([1.4, 2.6, 10, 10])).toEqual([1, 3, 10, 10]);
    expect(normalizeCrop([0, 0, 0, 50])).toBeUndefined();
    expect(normalizeCrop([-1, 0, 10, 10])).toBeUndefined();
    expect(normalizeCrop([0, 0, 10])).toBeUndefined();
    expect(normalizeCrop('0,0,10,10')).toBeUndefined();
  });

  it('formatCropArg 生成脚本参数串，整图为空串', () => {
    expect(formatCropArg()).toBe('');
    expect(formatCropArg([10, 20, 30, 40])).toBe('10,20,30,40');
  });
});

// ── runOcr 编排 ─────────────────────────────────────────────────────────

describe('runOcr 编排：版面渲染、缓存复用、截断（D7/D9/D12）', () => {
  it('默认 layout=text，结果带行数/词数/布局', async () => {
    engineState.lines = gridLines(ROWS);
    const r = await runOcr(png('a'), { config: cfg() });
    expect(r.layout).toBe('text');
    expect(r.lineCount).toBe(4);
    expect(r.wordCount).toBe(8);
    expect(r.text.split('\n')).toHaveLength(4);
    expect(r.text).not.toContain('FALLBACK');
  });

  it('layout=table 出表格', async () => {
    engineState.lines = gridLines(ROWS);
    const r = await runOcr(png('b'), { config: cfg(), layout: 'table' });
    expect(r.layout).toBe('table');
    expect(r.text).toContain('| --- | --- |');
  });

  it('同一张图切 text → table 命中同一缓存，不重复 OCR（D9）', async () => {
    engineState.lines = gridLines(ROWS);
    const c = cfg({ cacheEnabled: true });
    const first = await runOcr(png('c'), { config: c, layout: 'text' });
    const second = await runOcr(png('c'), { config: c, layout: 'table' });
    expect(engineState.calls).toBe(1);
    expect(first.layout).toBe('text');
    expect(second.layout).toBe('table');
    expect(second.warnings).toContain('缓存命中');
    expect(second.elapsedMs).toBe(0);
    expect(second.text).toContain('| --- | --- |');
  });

  it('scale / crop 变化会使缓存失效（避免放大前后串味）', async () => {
    engineState.lines = gridLines(ROWS);
    const c = cfg({ cacheEnabled: true });
    await runOcr(png('d'), { config: c });
    await runOcr(png('d'), { config: c, scale: 2 });
    await runOcr(png('d'), { config: c, scale: 2, crop: [0, 0, 100, 100] });
    expect(engineState.calls).toBe(3);
  });

  it('scale / crop / layout 透传到引擎', async () => {
    engineState.lines = gridLines(ROWS);
    await runOcr(png('e'), { config: cfg(), layout: 'words', scale: 3, crop: [5, 6, 70, 80] });
    expect(engineState.lastOpts).toMatchObject({
      layout: 'words',
      scale: 3,
      crop: [5, 6, 70, 80],
    });
  });

  it('无坐标引擎（无 lines）时 layout=table 降级为文本并告警，不抛错（D12）', async () => {
    engineState.text = '纯 文 本';
    const r = await runOcr(png('f'), { config: cfg(), layout: 'table' });
    expect(r.layout).toBe('text');
    expect(r.text).toBe('纯文本');
    expect(r.warnings.join('；')).toContain('不提供坐标');
  });

  it('maxChars 是默认值：入参可上调到硬上限以内（D7）', async () => {
    engineState.lines = gridLines(ROWS);
    const c = cfg({ maxChars: 10, maxCharsHardLimit: 200000 });
    const r = await runOcr(png('g'), { config: c, maxChars: 500 });
    expect(r.text.length).toBeGreaterThan(10);
    expect(r.text).toContain('电网业务语义提取方案.docx');
  });

  it('maxChars 不得超过硬上限', async () => {
    engineState.lines = gridLines(ROWS);
    const c = cfg({ maxChars: 8000, maxCharsHardLimit: 30 });
    const r = await runOcr(png('h'), { config: c, maxChars: 5000 });
    expect(r.text.length).toBeLessThanOrEqual(30);
    expect(r.warnings.join('；')).toContain('已截断');
  });

  it('截断按整行进行，不把一行切成两半，并说明丢弃行数（D7）', async () => {
    engineState.lines = gridLines(ROWS);
    const r = await runOcr(png('i'), { config: cfg({ maxChars: 40 }) });
    const kept = r.text.split('\n');
    expect(kept.length).toBeGreaterThan(0);
    for (const line of kept) expect(r.text).toContain(line);
    expect(r.text).not.toMatch(/winrt-ocr-probe\.ps1 \| 2026\/11\/12 17:19\n调用/);
    // 首行被完整保留（而不是被判成超限后返回空串）
    expect(kept[0]).toBe('winrt-ocr-probe.ps1 | 2026/11/12 17:19');
    expect(r.warnings.join('；')).toMatch(/丢弃 \d+ 行/);
  });

  it('缓存版本已升到 v2（旧 postprocess 结果不得复用）', () => {
    expect(OCR_CACHE_VERSION).toBe('v2');
  });

  it('缓存 key 含 scale/crop，同一引擎不同预处理不共用条目', () => {
    const cache = new OcrResultCache(10, 1000);
    const img = png('j');
    const a = cache.buildKey('winrt-ocr', 'zh-Hans-CN', img);
    const b = cache.buildKey('winrt-ocr', 'zh-Hans-CN', img, { scale: 2 });
    const c2 = cache.buildKey('winrt-ocr', 'zh-Hans-CN', img, { crop: '0,0,10,10' });
    expect(new Set([a, b, c2]).size).toBe(3);
    expect(cache.buildKey('winrt-ocr', 'zh-Hans-CN', img, { scale: 1, crop: '' })).toBe(a);
  });
});

// ── 截断细节与结果头 ────────────────────────────────────────────────────

describe('truncateOcrText 按行截断（D7）', () => {
  it('未超限时原样返回', () => {
    expect(truncateOcrText('abc', 10)).toEqual({ text: 'abc', truncated: false });
  });

  it('首行即超限时退化为字符截断（不返回空串）', () => {
    const r = truncateOcrText('abcdef', 3);
    expect(r.text).toBe('abc');
    expect(r.truncated).toBe(true);
  });

  it('多行时整行保留并给出丢弃行数', () => {
    const r = truncateOcrText('aaaa\nbbbb\ncccc', 10);
    expect(r.text).toBe('aaaa\nbbbb');
    expect(r.droppedLines).toBe(1);
  });

  it('maxChars 非正数视为不限制', () => {
    expect(truncateOcrText('abc', 0).truncated).toBe(false);
  });
});

describe('结果标注头补充布局/行数/词数/尺寸（D6/D8）', () => {
  it('describeImageSize 无尺寸时返回空串', () => {
    expect(describeImageSize()).toBe('');
    expect(describeImageSize({ width: 0, height: 0 })).toBe('');
    expect(describeImageSize({ width: 1293, height: 1164 })).toBe('1293×1164');
  });

  it('耗时拆分为「识别 + 进程与解码」，体感与显示不再冲突（D8）', () => {
    const header = buildOcrResultText({
      text: '正文',
      engine: 'winrt-ocr',
      lang: 'zh-Hans-CN',
      elapsedMs: 1100,
      recognizeMs: 300,
      warnings: [],
    }).split('\n')[0];
    expect(header).toBe('[OCR 引擎: winrt-ocr | 语言: zh-Hans-CN | 耗时: 1.1s（识别 0.3s + 进程与解码 0.8s）]');
  });

  it('开销很小（<100ms）或无识别耗时时只显示总耗时', () => {
    const bare = buildOcrResultText({ text: 'x', engine: 'http', lang: 'zh-Hans-CN', elapsedMs: 900, warnings: [] });
    expect(bare.split('\n')[0]).toBe('[OCR 引擎: http | 语言: zh-Hans-CN | 耗时: 0.9s]');
    const tight = buildOcrResultText({
      text: 'x',
      engine: 'winrt-ocr',
      lang: 'zh-Hans-CN',
      elapsedMs: 900,
      recognizeMs: 850,
      warnings: [],
    });
    expect(tight.split('\n')[0]).toBe('[OCR 引擎: winrt-ocr | 语言: zh-Hans-CN | 耗时: 0.9s]');
  });

  it('缓存命中显示 0s（缓存），仍保留布局与行数', async () => {
    engineState.lines = gridLines(ROWS);
    const c = cfg({ cacheEnabled: true });
    await runOcr(png('k'), { config: c });
    const hit = await runOcr(png('k'), { config: c, layout: 'table' });
    const header = buildOcrResultText(hit).split('\n')[0];
    expect(header).toContain('耗时: 0s（缓存）');
    expect(header).toContain('布局: table');
    expect(header).toContain('行数: 4');
  });
});
