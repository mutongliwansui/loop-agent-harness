/**
 * OCR 引擎层单测（需求 20261112-002 / 任务 01）
 *
 * 覆盖：D4 CJK 后处理（含幂等硬约束）、行重建、缓存、图片魔数嗅探、截断、
 *       引擎顺序解析、runOcr / runOcrOnSource 编排与错误分类、结果标注头。
 *
 * 引擎本身用 mock 替换（不真起 powershell.exe）：
 * 单测只验证编排层的决策与后处理，WinRT 脚本行为由真机验证覆盖。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import type { OcrConfig } from '../src/config/schema.js';

// ── 引擎 mock：可开关可用性、可指定原始输出 ─────────────────────────────
const engineState = vi.hoisted(() => ({
  available: true,
  text: '识 别 文 本',
  lang: 'zh-Hans-CN',
  elapsedMs: 12,
  warnings: [] as string[],
  calls: 0,
}));

vi.mock('../src/ocr/engine-winrt.js', () => ({
  winrtOcrEngine: {
    id: 'winrt-ocr',
    langs: ['zh-Hans-CN', 'en-US'],
    isAvailable: async () => engineState.available,
    recognize: async () => {
      engineState.calls++;
      return {
        text: engineState.text,
        lang: engineState.lang,
        elapsedMs: engineState.elapsedMs,
        warnings: [...engineState.warnings],
      };
    },
  },
  probeWinrt: async () => ({
    ok: engineState.available,
    langs: ['zh-Hans-CN'],
    lang: 'zh-Hans-CN',
  }),
  resetWinrtProbeCache: () => {},
  winrtOcrLikelyAvailable: () => engineState.available,
  powershellPath: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  WINRT_SCRIPT: '',
  resolveWinrtScriptPath: async () => 'script.ps1',
}));

const {
  runOcr,
  runOcrOnSource,
  pickOcrEngine,
  resolveEngineOrder,
  truncateOcrText,
  buildOcrResultText,
  describeOcrStatus,
  clearOcrCache,
} = await import('../src/ocr/run-ocr.js');
const { postProcessOcrText, mergeCjkSpaces, normalizeOcrLines, collapseInnerSpaces } = await import(
  '../src/ocr/postprocess.js'
);
const { OcrResultCache } = await import('../src/ocr/cache.js');
const { sniffImageFormat, OcrError } = await import('../src/ocr/types.js');

// ── 测试夹具 ────────────────────────────────────────────────────────────

/** 造一个能通过魔数嗅探的 PNG（内容随 seed 变化，避免缓存互通；总长 ≥12 字节） */
function png(seed = 'a'): Buffer {
  const body = Buffer.alloc(16, 0);
  Buffer.from(seed, 'utf8').copy(body, 0, 0, Math.min(16, Buffer.byteLength(seed)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    body,
  ]);
}

/** 在默认配置基础上覆盖 ocr 段 */
function cfg(over: Partial<OcrConfig> = {}): OcrConfig {
  return { ...DEFAULT_CONFIG.ocr, ...over };
}

/** 断言抛出 OcrError 且 code 匹配 */
async function expectOcrError(fn: () => Promise<unknown>, code: string): Promise<OcrError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(OcrError);
    const oe = err as InstanceType<typeof OcrError>;
    expect(oe.code).toBe(code);
    return oe;
  }
  throw new Error(`期望抛出 OcrError(${code})，实际未抛错`);
}

beforeEach(() => {
  clearOcrCache();
  engineState.available = true;
  engineState.text = '识 别 文 本';
  engineState.lang = 'zh-Hans-CN';
  engineState.elapsedMs = 12;
  engineState.warnings = [];
  engineState.calls = 0;
});

// ── 一、D4 CJK 后处理 ──────────────────────────────────────────────────

describe('postprocess / mergeCjkSpaces', () => {
  it('合并汉字之间的空格（本机型：单字被切成独立 word）', () => {
    expect(mergeCjkSpaces('信 息 系 统 部 署 方 案')).toBe('信息系统部署方案');
  });

  it('紧凑输入逐字节不变（内网型：汉字间本无空格，幂等硬约束）', () => {
    const compact = '信息系统部署方案';
    expect(mergeCjkSpaces(compact)).toBe(compact);
    // 幂等：重复调用结果一致
    expect(mergeCjkSpaces(mergeCjkSpaces(compact))).toBe(compact);
  });

  it('混合型输入：只删 CJK 间空格，其余保持不变', () => {
    expect(mergeCjkSpaces('信 息 load rate 系 统')).toBe('信息 load rate 系统');
  });

  it('英文单词内部空格一个都不能丢（D4 被否决方案的回归防线）', () => {
    const s = 'select cust_name from tab where load rate > 0';
    expect(mergeCjkSpaces(s)).toBe(s);
  });

  it('CJK 与 ASCII 交界保留一个空格（CJK-CJK 之间仍合并）', () => {
    expect(mergeCjkSpaces('OCR 引擎 版本 V1.0')).toBe('OCR 引擎版本 V1.0');
    expect(mergeCjkSpaces('引 擎 winrt-ocr')).toBe('引擎 winrt-ocr');
    expect(mergeCjkSpaces('第 1 条')).toBe('第 1 条');
  });

  it('CJK 标点两侧的空格一并合并', () => {
    expect(mergeCjkSpaces('第 一 条 ， 总 则')).toBe('第一条，总则');
  });

  it('全角空格按字间空格处理', () => {
    expect(mergeCjkSpaces('信\u3000息')).toBe('信息');
  });

  it('空字符串与纯 ASCII 输入原样返回', () => {
    expect(mergeCjkSpaces('')).toBe('');
    expect(mergeCjkSpaces('hello world  ')).toBe('hello world  ');
  });
});

describe('postprocess / normalizeOcrLines', () => {
  it('统一 LF 并去掉行尾空白', () => {
    expect(normalizeOcrLines('a  \r\nb\t\r\n')).toBe('a\nb');
  });

  it('连续空行收敛为最多一个空行', () => {
    expect(normalizeOcrLines('a\n\n\n\nb')).toBe('a\n\nb');
    expect(normalizeOcrLines('a\n\nb')).toBe('a\n\nb');
  });

  it('去掉首尾空行', () => {
    expect(normalizeOcrLines('\n\na\nb\n\n\n')).toBe('a\nb');
  });

  it('全空输入返回空串', () => {
    expect(normalizeOcrLines('   \n\n  ')).toBe('');
    expect(normalizeOcrLines('')).toBe('');
  });
});

describe('postprocess / collapseInnerSpaces', () => {
  it('压缩行内多空格为单个', () => {
    expect(collapseInnerSpaces('a   b    c')).toBe('a b c');
  });

  it('保留行首缩进（不破坏缩进语义）', () => {
    expect(collapseInnerSpaces('    a   b')).toBe('    a b');
  });

  it('幂等：已规范化的文本不变', () => {
    const s = '    a b\nc d';
    expect(collapseInnerSpaces(collapseInnerSpaces(s))).toBe(s);
  });
});

describe('postprocess / postProcessOcrText 组合与幂等', () => {
  it('三种输入形态都收敛到同一结果', () => {
    const spaced = '信 息 系 统\n\n\n\n第 一 条';
    const compact = '信息系统\n\n第一条';
    const mixed = '信 息系 统\n\n\n第一条';
    expect(postProcessOcrText(spaced)).toBe('信息系统\n\n第一条');
    expect(postProcessOcrText(compact)).toBe(compact);
    expect(postProcessOcrText(mixed)).toBe('信息系统\n\n第一条');
  });

  it('对紧凑中文文本逐字节不变（内网真机场景）', () => {
    const conv = '苏智问答系统在2024年9月12日通过南京评审，组长杜之铭。';
    expect(postProcessOcrText(conv)).toBe(conv);
  });

  it('整体管道幂等（重复调用结果不变）', () => {
    const input = '第 一 条  load rate  测 试\n\n\n\n末 行';
    const once = postProcessOcrText(input);
    expect(postProcessOcrText(once)).toBe(once);
  });
});

// ── 二、缓存 ────────────────────────────────────────────────────────────

describe('OcrResultCache', () => {
  it('set/get/size/clear 基本行为', () => {
    const c = new OcrResultCache();
    const key = c.buildKey('winrt-ocr', 'zh-Hans-CN', png());
    c.set(key, '文本', 60000);
    expect(c.get(key)).toBe('文本');
    expect(c.size()).toBe(1);
    c.clear();
    expect(c.get(key)).toBeNull();
    expect(c.size()).toBe(0);
  });

  it('未命中返回 null', () => {
    const c = new OcrResultCache();
    expect(c.get('missing')).toBeNull();
  });

  it('TTL 过期后返回 null 并清除条目', () => {
    vi.useFakeTimers();
    try {
      const c = new OcrResultCache();
      const key = c.buildKey('winrt-ocr', 'zh-Hans-CN', png());
      c.set(key, 'v', 100);
      expect(c.get(key)).toBe('v');
      vi.advanceTimersByTime(101);
      expect(c.get(key)).toBeNull();
      expect(c.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('超过 maxEntries 时淘汰最旧条目（LRU）', () => {
    const c = new OcrResultCache();
    for (let i = 0; i < 3; i++) c.set(`k${i}`, `v${i}`, 60000, 2);
    expect(c.size()).toBe(2);
    expect(c.get('k0')).toBeNull();
    expect(c.get('k1')).toBe('v1');
    expect(c.get('k2')).toBe('v2');
  });

  it('命中后重新置入队尾，淘汰时先丢真正最旧的', () => {
    const c = new OcrResultCache();
    c.set('k0', 'v0', 60000, 2);
    c.set('k1', 'v1', 60000, 2);
    expect(c.get('k0')).toBe('v0'); // k0 变最新
    c.set('k2', 'v2', 60000, 2); // 应淘汰 k1
    expect(c.get('k1')).toBeNull();
    expect(c.get('k0')).toBe('v0');
    expect(c.get('k2')).toBe('v2');
  });

  it('key 随引擎、语言、图片内容变化而不同', () => {
    const c = new OcrResultCache();
    const img = png();
    const base = c.buildKey('winrt-ocr', 'zh-Hans-CN', img);
    expect(c.buildKey('http', 'zh-Hans-CN', img)).not.toBe(base);
    expect(c.buildKey('winrt-ocr', 'en-US', img)).not.toBe(base);
    expect(c.buildKey('winrt-ocr', 'zh-Hans-CN', png('b'))).not.toBe(base);
    expect(c.buildKey('winrt-ocr', 'zh-Hans-CN', png())).toBe(base);
  });
});

// ── 三、图片魔数嗅探 ────────────────────────────────────────────────────

describe('sniffImageFormat', () => {
  it('按魔数识别常见格式（不信任扩展名）', () => {
    expect(sniffImageFormat(png())).toBe('png');
    expect(sniffImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('jpeg');
    expect(sniffImageFormat(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]))).toBe('gif');
    expect(sniffImageFormat(Buffer.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('bmp');
    expect(
      sniffImageFormat(
        Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe('webp');
    expect(sniffImageFormat(Buffer.from([0x49, 0x49, 0x2a, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('tiff');
    expect(sniffImageFormat(Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('tiff');
  });

  it('非图片与过短输入返回 null', () => {
    expect(sniffImageFormat(Buffer.from('plain text content'))).toBeNull();
    expect(sniffImageFormat(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(sniffImageFormat(Buffer.alloc(0))).toBeNull();
  });
});

// ── 四、截断 ────────────────────────────────────────────────────────────

describe('truncateOcrText', () => {
  it('未超上限原样返回', () => {
    expect(truncateOcrText('abc', 10)).toEqual({ text: 'abc', truncated: false });
    expect(truncateOcrText('abc', 3)).toEqual({ text: 'abc', truncated: false });
  });

  it('超出上限截断并标记', () => {
    expect(truncateOcrText('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
  });

  it('非正数上限视为不限制', () => {
    expect(truncateOcrText('abcdef', 0)).toEqual({ text: 'abcdef', truncated: false });
    expect(truncateOcrText('abcdef', -1)).toEqual({ text: 'abcdef', truncated: false });
    expect(truncateOcrText('abcdef', Number.NaN)).toEqual({ text: 'abcdef', truncated: false });
  });
});

// ── 五、引擎选择顺序 ────────────────────────────────────────────────────

describe('resolveEngineOrder', () => {
  it('默认 auto 走 winrt-ocr', () => {
    expect(resolveEngineOrder(cfg())).toEqual(['winrt-ocr']);
  });

  it('配置了 http 端点时自动追加 http 兜底', () => {
    const c = cfg({ http: { endpoint: 'http://10.0.0.5:8000/ocr', apiKey: '', fieldName: 'text' } });
    expect(resolveEngineOrder(c)).toEqual(['winrt-ocr', 'http']);
  });

  it('显式指定引擎时忽略 enginePriority', () => {
    expect(resolveEngineOrder(cfg({ engine: 'http' }))).toEqual(['http']);
  });

  it('enginePriority 为空数组时回落到 winrt-ocr', () => {
    expect(resolveEngineOrder(cfg({ enginePriority: [] }))).toEqual(['winrt-ocr']);
  });
});

describe('pickOcrEngine', () => {
  it('引擎可用时返回该引擎实例', async () => {
    const engine = await pickOcrEngine(cfg());
    expect(engine.id).toBe('winrt-ocr');
  });

  it('未知引擎 id 被跳过并给出引擎缺失错误', async () => {
    const err = await expectOcrError(() => pickOcrEngine(cfg({ engine: 'nope' })), 'engine_missing');
    expect(err.message).toContain('nope');
  });
});

// ── 六、runOcr 编排 ────────────────────────────────────────────────────

describe('runOcr', () => {
  it('成功路径：后处理生效并带上引擎/语言/耗时', async () => {
    const r = await runOcr(png(), { config: cfg() });
    expect(r.text).toBe('识别文本'); // '识 别 文 本' 已被合并
    expect(r.engine).toBe('winrt-ocr');
    expect(r.lang).toBe('zh-Hans-CN');
    expect(r.elapsedMs).toBe(12);
    expect(engineState.calls).toBe(1);
  });

  it('ocr.enabled=false 时直接报 engine_missing，不调用引擎', async () => {
    const err = await expectOcrError(() => runOcr(png(), { config: cfg({ enabled: false }) }), 'engine_missing');
    expect(err.message).toContain('ocr.enabled');
    expect(engineState.calls).toBe(0);
  });

  it('空图片字节报 bad_input', async () => {
    await expectOcrError(() => runOcr(Buffer.alloc(0), { config: cfg() }), 'bad_input');
  });

  it('超过大小上限报 image_too_large', async () => {
    await expectOcrError(() => runOcr(png(), { config: cfg({ maxImageBytes: 4 }) }), 'image_too_large');
    expect(engineState.calls).toBe(0);
  });

  it('非图片内容报 unsupported_format', async () => {
    await expectOcrError(
      () => runOcr(Buffer.from('这不是图片，只是一段文本内容'), { config: cfg() }),
      'unsupported_format',
    );
    expect(engineState.calls).toBe(0);
  });

  it('第二次相同输入命中缓存：不重复识别、耗时归零并标注', async () => {
    const c = cfg();
    const img = png('cache-me');
    await runOcr(img, { config: c });
    const second = await runOcr(img, { config: c });
    expect(engineState.calls).toBe(1);
    expect(second.text).toBe('识别文本');
    expect(second.elapsedMs).toBe(0);
    expect(second.warnings).toContain('缓存命中');
  });

  it('noCache=true 时不读写缓存', async () => {
    const c = cfg();
    const img = png('no-cache');
    await runOcr(img, { config: c, noCache: true });
    await runOcr(img, { config: c, noCache: true });
    expect(engineState.calls).toBe(2);
  });

  it('cacheEnabled=false 时不缓存', async () => {
    const c = cfg({ cacheEnabled: false });
    const img = png('cache-off');
    await runOcr(img, { config: c });
    await runOcr(img, { config: c });
    expect(engineState.calls).toBe(2);
  });

  it('不同语言参数不共用缓存', async () => {
    const c = cfg();
    const img = png('lang-diff');
    await runOcr(img, { config: c, lang: 'zh-Hans-CN' });
    await runOcr(img, { config: c, lang: 'en-US' });
    expect(engineState.calls).toBe(2);
  });

  it('结果超 maxChars 时截断并给出提示', async () => {
    engineState.text = '一 二 三 四 五 六 七 八';
    const r = await runOcr(png('trunc'), { config: cfg({ maxChars: 4 }) });
    expect(r.text).toBe('一二三四');
    expect(r.warnings.some((w) => w.includes('截断'))).toBe(true);
  });

  it('识别为空时给出提示但不抛错', async () => {
    engineState.text = '   ';
    const r = await runOcr(png('blank'), { config: cfg() });
    expect(r.text.trim()).toBe('');
    expect(r.warnings.some((w) => w.includes('未识别到文字'))).toBe(true);
  });

  it('空结果不写入缓存（避免把失败固化）', async () => {
    const c = cfg();
    const img = png('empty-cache');
    engineState.text = '  ';
    await runOcr(img, { config: c });
    engineState.text = '有 字';
    const second = await runOcr(img, { config: c });
    expect(second.text).toBe('有字');
    expect(engineState.calls).toBe(2);
  });

  it('引擎不可用且平台为 Windows 时报 engine_missing 并给语言包指引', async () => {
    engineState.available = false;
    const err = await expectOcrError(() => runOcr(png('no-engine'), { config: cfg() }), 'engine_missing');
    expect(err.message).toContain('语言包');
  });
});

describe('runOcr / 非 Windows 平台', () => {
  const original = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: original });
  });

  it('非 Windows 且未配 http 端点：platform_unsupported，文案点明演进项', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    engineState.available = false;
    const err = await expectOcrError(
      () => runOcr(png('linux'), { config: cfg() }),
      'platform_unsupported',
    );
    expect(err.message).toContain('仅支持 Windows');
    expect(err.message).toContain('演进项');
  });
});

// ── 七、runOcrOnSource 来源解析 ────────────────────────────────────────

describe('runOcrOnSource', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ocr-src-'));
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('空参数报 bad_input', async () => {
    await expectOcrError(() => runOcrOnSource('', { config: cfg() }), 'bad_input');
    await expectOcrError(() => runOcrOnSource('   ', { config: cfg() }), 'bad_input');
  });

  it('dataURI(base64) 可识别', async () => {
    const uri = `data:image/png;base64,${png('datauri').toString('base64')}`;
    const r = await runOcrOnSource(uri, { config: cfg() });
    expect(r.engine).toBe('winrt-ocr');
  });

  it('dataURI(非 base64) 可识别', async () => {
    const payload = encodeURIComponent(png('uri-plain').toString('binary'));
    const r = await runOcrOnSource(`data:image/png,${payload}`, { config: cfg() });
    expect(r.engine).toBe('winrt-ocr');
  });

  it('损坏的 dataURI 报 bad_input', async () => {
    await expectOcrError(() => runOcrOnSource('data:image/png;base64', { config: cfg() }), 'bad_input');
  });

  it('http(s) 地址显式拒绝（避免 SSRF 与不可控耗时）', async () => {
    const err = await expectOcrError(
      () => runOcrOnSource('https://example.com/a.png', { config: cfg() }),
      'bad_input',
    );
    expect(err.message).toContain('演进项');
  });

  it('本地文件路径与 file:// 前缀均可识别', async () => {
    const file = join(dir, 'shot.png');
    await writeFile(file, png('from-file'));
    expect((await runOcrOnSource(file, { config: cfg() })).engine).toBe('winrt-ocr');
    const uri = `file:///${file.replace(/\\/g, '/')}`;
    expect((await runOcrOnSource(uri, { config: cfg() })).engine).toBe('winrt-ocr');
  });

  it('文件不存在报 bad_input 并回显路径', async () => {
    const missing = join(dir, 'nope.png');
    const err = await expectOcrError(() => runOcrOnSource(missing, { config: cfg() }), 'bad_input');
    expect(err.message).toContain('nope.png');
  });

  it('路径指向目录时报 bad_input', async () => {
    await expectOcrError(() => runOcrOnSource(dir, { config: cfg() }), 'bad_input');
  });

  it('文件超过大小上限时不读取内容直接报错', async () => {
    const file = join(dir, 'big.png');
    await writeFile(file, Buffer.alloc(64, 0x89));
    await expectOcrError(() => runOcrOnSource(file, { config: cfg({ maxImageBytes: 8 }) }), 'image_too_large');
  });
});

// ── 八、结果标注头（D6） ──────────────────────────────────────────────

describe('buildOcrResultText', () => {
  const base = { text: '正文内容', engine: 'winrt-ocr', lang: 'zh-Hans-CN', elapsedMs: 1234, warnings: [] };

  it('首行固定标注引擎/语言/耗时', () => {
    const out = buildOcrResultText(base);
    expect(out.split('\n')[0]).toBe('[OCR 引擎: winrt-ocr | 语言: zh-Hans-CN | 耗时: 1.2s]');
    expect(out).toContain('正文内容');
  });

  it('有置信度时追加，无则臆造字段不出现', () => {
    expect(buildOcrResultText({ ...base, confidence: 0.992 })).toContain('置信度: 0.992');
    expect(buildOcrResultText(base)).not.toContain('置信度');
  });

  it('缓存命中与额外说明进入标注头', () => {
    const out = buildOcrResultText(base, { cached: true, note: '已降级' });
    expect(out).toContain('缓存命中');
    expect(out).toContain('已降级');
  });

  it('空文本给出占位说明', () => {
    expect(buildOcrResultText({ ...base, text: '   ' })).toContain('（未识别到文字）');
  });

  it('非致命告警作为提示尾巴（缓存命中不重复提示）', () => {
    const out = buildOcrResultText({ ...base, warnings: ['缓存命中', '结果已截断'] });
    expect(out).toContain('提示：结果已截断');
    expect(out).not.toContain('提示：缓存命中');
  });
});

// ── 九、诊断摘要 ───────────────────────────────────────────────────────

describe('describeOcrStatus', () => {
  it('Windows 引擎可用时报告就绪与语言', async () => {
    engineState.available = true;
    const s = await describeOcrStatus(cfg());
    expect(s.available).toBe(true);
    if (process.platform === 'win32') {
      expect(s.platform).toBe('win32');
      expect(s.detail).toContain('已就绪');
    }
  });

  it('引擎不可用时报告不可用原因', async () => {
    engineState.available = false;
    const s = await describeOcrStatus(cfg());
    expect(s.available).toBe(false);
  });
});
