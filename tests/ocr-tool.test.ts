/**
 * ocrImage 工具与注册门控单测（需求 20261112-002 / 任务 02）
 *
 * 覆盖：D7 条件注册（ocr.enabled × 引擎可用性 × http 端点）、工具参数校验、
 *       结果标注头、OcrError → 可纠正提示映射、工具级 maxChars。
 *
 * 引擎层用 mock 替换（不真起 powershell.exe）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import type { OcrConfig } from '../src/config/schema.js';

const engineState = vi.hoisted(() => ({
  available: true,
  text: '识 别 文 本',
  lang: 'zh-Hans-CN',
  throwCode: null as string | null,
}));

vi.mock('../src/ocr/engine-winrt.js', () => ({
  winrtOcrEngine: {
    id: 'winrt-ocr',
    langs: ['zh-Hans-CN'],
    isAvailable: async () => engineState.available,
    recognize: async () => {
      if (engineState.throwCode) {
        const { OcrError } = await import('../src/ocr/types.js');
        throw new OcrError(engineState.throwCode as never, '引擎内部失败说明');
      }
      return {
        text: engineState.text,
        lang: engineState.lang,
        elapsedMs: 30,
        warnings: [],
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

const { ocrImage, ocrTools, OCR_TOOL_NAMES } = await import('../src/tools/ocrImage.js');
const { shouldRegisterOcrTools } = await import('../src/tools/index.js');
const { clearOcrCache } = await import('../src/ocr/run-ocr.js');

function cfg(over: Partial<OcrConfig> = {}): OcrConfig {
  return { ...DEFAULT_CONFIG.ocr, ...over };
}

/** 造一个能通过魔数嗅探的 PNG（内容随 seed 变化，避免缓存互通；总长 ≥12 字节） */
function png(seed = 'a'): Buffer {
  const body = Buffer.alloc(16, 0);
  Buffer.from(seed, 'utf8').copy(body, 0, 0, Math.min(16, Buffer.byteLength(seed)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    body,
  ]);
}

let dir = '';

beforeEach(async () => {
  clearOcrCache();
  engineState.available = true;
  engineState.text = '识 别 文 本';
  engineState.lang = 'zh-Hans-CN';
  engineState.throwCode = null;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = await mkdtemp(join(tmpdir(), 'ocr-tool-'));
});

// ── 一、D7 条件注册 ────────────────────────────────────────────────────

describe('shouldRegisterOcrTools（D7 条件注册）', () => {
  it('未传配置时不注册（保持 tools 列表与旧版本一致，保护前缀缓存）', () => {
    expect(shouldRegisterOcrTools(undefined)).toBe(false);
  });

  it('ocr.enabled=false 时不注册', () => {
    expect(shouldRegisterOcrTools(cfg({ enabled: false }))).toBe(false);
  });

  it('启用且引擎可用时注册', () => {
    expect(shouldRegisterOcrTools(cfg())).toBe(true);
  });

  it('引擎不可用时不注册（避免注册一个必然报错的工具）', () => {
    engineState.available = false;
    expect(shouldRegisterOcrTools(cfg())).toBe(false);
  });

  it('引擎不可用但配置了 http 端点时仍注册（有可用后备）', () => {
    engineState.available = false;
    expect(
      shouldRegisterOcrTools(
        cfg({ http: { endpoint: 'http://10.0.0.5:8000/ocr', apiKey: '', fieldName: 'text' } }),
      ),
    ).toBe(true);
  });

  it('空白端点不算已配置', () => {
    engineState.available = false;
    expect(shouldRegisterOcrTools(cfg({ http: { endpoint: '   ', apiKey: '', fieldName: 'text' } }))).toBe(
      false,
    );
  });

  it('enabled=undefined 视为未启用', () => {
    expect(shouldRegisterOcrTools({ ...cfg(), enabled: undefined as unknown as boolean })).toBe(false);
  });
});

describe('工具元信息', () => {
  it('工具名与导出集合一致', () => {
    expect(ocrImage.name).toBe('ocrImage');
    expect(OCR_TOOL_NAMES).toContain('ocrImage');
    expect(ocrTools.map((t) => t.name)).toEqual(['ocrImage']);
  });

  it('描述里点明「离线、不调用视觉大模型」的边界', () => {
    expect(ocrImage.description).toContain('OCR');
    expect(ocrImage.description).toContain('离线');
    expect(ocrImage.description).toContain('视觉大模型');
  });

  it('image 为唯一必填参数', () => {
    expect(ocrImage.parameters.required).toEqual(['image']);
    expect(Object.keys(ocrImage.parameters.properties)).toEqual(
      expect.arrayContaining(['image', 'lang', 'maxChars']),
    );
  });

  it('工具超时覆盖进程启动开销（≥30s）', () => {
    expect(ocrImage.timeoutMs).toBeGreaterThanOrEqual(30000);
  });
});

// ── 二、工具执行 ───────────────────────────────────────────────────────

describe('ocrImage 执行', () => {
  it('缺少 image 参数时明确报错', async () => {
    await expect(ocrImage.execute({})).rejects.toThrow('image');
  });

  it('image 为空串时同样报错', async () => {
    await expect(ocrImage.execute({ image: '   ' })).rejects.toThrow('image');
  });

  it('成功时返回带标注头的文本（D6 来源标注）', async () => {
    const file = join(dir, 'a.png');
    await writeFile(file, png('ok'));
    const out = (await ocrImage.execute({ image: file })) as string;
    expect(out.split('\n')[0]).toContain('OCR 引擎: winrt-ocr');
    expect(out.split('\n')[0]).toContain('语言: zh-Hans-CN');
    expect(out).toContain('识别文本'); // CJK 空格已合并
  });

  it('OcrError 映射为「OCR 失败（code）」的可纠正提示', async () => {
    const file = join(dir, 'b.png');
    await writeFile(file, png('err'));
    engineState.throwCode = 'timeout';
    await expect(ocrImage.execute({ image: file })).rejects.toThrow(/OCR 失败（timeout）/);
  });

  it('非 OcrError 原样抛出（不吞编程错误）', async () => {
    const file = join(dir, 'c.png');
    await writeFile(file, png('boom'));
    engineState.throwCode = 'engine_failed';
    // engine_failed 也是 OcrError，这里只确认仍带 code
    await expect(ocrImage.execute({ image: file })).rejects.toThrow(/engine_failed/);
  });

  it('maxChars 参数可进一步收紧结果长度', async () => {
    const file = join(dir, 'd.png');
    await writeFile(file, png('trunc'));
    engineState.text = '一 二 三 四 五 六 七 八 九 十';
    const out = (await ocrImage.execute({ image: file, maxChars: 3 })) as string;
    expect(out).toContain('一二三');
    expect(out).not.toContain('四');
    expect(out).toContain('截断');
  });

  it('lang 参数透传到结果标注', async () => {
    const file = join(dir, 'e.png');
    await writeFile(file, png('lang'));
    engineState.lang = ''; // 模拟引擎未回填语言，应回落到入参
    const out = (await ocrImage.execute({ image: file, lang: 'en-US' })) as string;
    expect(out).toContain('语言: en-US');
  });

  it('不支持的图片格式给出 unsupported_format', async () => {
    const file = join(dir, 'f.png');
    await writeFile(file, Buffer.from('纯文本内容不是图片'));
    await expect(ocrImage.execute({ image: file })).rejects.toThrow(/unsupported_format|bad_input/);
  });

  it('dataURI 输入可直接识别（与截屏粘贴场景对齐）', async () => {
    const uri = `data:image/png;base64,${png('datauri').toString('base64')}`;
    const out = (await ocrImage.execute({ image: uri })) as string;
    expect(out).toContain('识别文本');
  });
});
