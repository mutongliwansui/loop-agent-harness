/**
 * 视觉工具管道单测（Task-20261010-001）
 * 覆盖：未启用拦截、参数校验、指令构造、三元组回退/覆盖、extract_json 解析容错降级、结果截断、工具元数据
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  describeImage,
  askImage,
  extractJson,
  ocrImage,
  visionTools,
  resolveVisionTargets,
} from '../src/tools/vision/tools.js';
import type { ModelConfig, VisionConfig } from '../src/config/schema.js';
import type { AgentConfig } from '../src/config/schema.js';
import { visionCache } from '../src/tools/vision/cache.js';
import { visionStats } from '../src/tools/vision/stats.js';

const { chatVisionMock } = vi.hoisted(() => ({ chatVisionMock: vi.fn() }));
vi.mock('../src/llm/client.js', () => ({ llm: { chatVision: chatVisionMock } }));

const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }));
vi.mock('../src/config/index.js', () => ({ configLoader: { load: loadMock } }));

const IMG_URL = 'https://example.com/pic.png';

function vision(overrides: Partial<VisionConfig> = {}): VisionConfig {
  return {
    enabled: true,
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0,
    maxTokens: 2048,
    timeoutMs: 60000,
    maxImageBytes: 10 * 1024 * 1024,
    maxResultChars: 8000,
    cacheEnabled: true,
    cacheTtlMs: 600000,
    ...overrides,
  };
}

function mockConfig(v: VisionConfig): void {
  loadMock.mockReturnValue({
    config: {
      model: { name: 'main-model', baseUrl: 'https://main.example.com', apiKey: 'main-key' },
      vision: v,
      // 缓存命中路径会经 debug.log 读取 agent.debug
      agent: { debug: false },
    } as unknown as AgentConfig,
  });
}

function lastCall(): {
  messages: {
    role: string;
    content: unknown;
  }[];
  options: Record<string, unknown>;
} {
  const [messages, options] = chatVisionMock.mock.calls[chatVisionMock.mock.calls.length - 1];
  return { messages, options };
}

beforeEach(() => {
  chatVisionMock.mockReset();
  loadMock.mockReset();
  visionCache.clear();
  visionStats.reset();
});

describe('启用开关与参数校验', () => {
  it('vision.enabled=false 时直接拦截，不调用视觉模型', async () => {
    mockConfig(vision({ enabled: false }));
    await expect(describeImage.execute({ image: IMG_URL })).rejects.toThrow('视觉功能未启用');
    expect(chatVisionMock).not.toHaveBeenCalled();
  });

  it('缺少 image 参数时报错', async () => {
    mockConfig(vision());
    await expect(describeImage.execute({})).rejects.toThrow('缺少必需参数: image');
  });

  it('ask_image 缺少 question 参数时报错', async () => {
    mockConfig(vision());
    await expect(askImage.execute({ image: IMG_URL })).rejects.toThrow('缺少必需参数: question');
  });

  it('extract_json 的 fields 必须是非空字符串数组', async () => {
    mockConfig(vision());
    await expect(extractJson.execute({ image: IMG_URL, fields: [] })).rejects.toThrow(
      '参数 fields 必须是非空字符串数组',
    );
    await expect(extractJson.execute({ image: IMG_URL, fields: ['a', 1] })).rejects.toThrow(
      '参数 fields 必须是非空字符串数组',
    );
  });
});

describe('指令构造与配置回退', () => {
  it('describe_image：system 角色固定 + 描述指令 + 图片 URL，回退主模型三元组', async () => {
    mockConfig(vision());
    chatVisionMock.mockResolvedValue({ content: '一只猫', elapsedMs: 5 });
    const out = await describeImage.execute({ image: IMG_URL });
    expect(out).toBe('一只猫');

    const { messages, options } = lastCall();
    expect(messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('图像分析助手') });
    const parts = messages[1].content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('描述这张图片') });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: IMG_URL } });
    expect(options).toMatchObject({
      baseUrl: 'https://main.example.com',
      apiKey: 'main-key',
      model: 'main-model',
      jsonMode: false,
      temperature: 0,
      maxTokens: 2048,
    });
  });

  it('vision 三元组非空时优先于主模型配置', async () => {
    mockConfig(vision({ baseUrl: 'https://v.example', apiKey: 'v-key', model: 'v-model' }));
    chatVisionMock.mockResolvedValue({ content: 'ok', elapsedMs: 1 });
    await describeImage.execute({ image: IMG_URL });
    expect(lastCall().options).toMatchObject({
      baseUrl: 'https://v.example',
      apiKey: 'v-key',
      model: 'v-model',
    });
  });

  it('ask_image 的 user 指令即问题原文', async () => {
    mockConfig(vision());
    chatVisionMock.mockResolvedValue({ content: '3 个', elapsedMs: 1 });
    await askImage.execute({ image: IMG_URL, question: '图里有几个人？' });
    const parts = lastCall().messages[1].content as { text?: string }[];
    expect(parts[0].text).toBe('图里有几个人？');
  });

  it('ocr_image 使用文字提取指令', async () => {
    mockConfig(vision());
    chatVisionMock.mockResolvedValue({ content: '文字', elapsedMs: 1 });
    await ocrImage.execute({ image: IMG_URL });
    const parts = lastCall().messages[1].content as { text?: string }[];
    expect(parts[0].text).toContain('提取图中全部文字');
  });
});

describe('extract_json 解析容错', () => {
  it('合法 JSON 直接解析并格式化输出，jsonMode=true', async () => {
    mockConfig(vision());
    chatVisionMock.mockResolvedValue({ content: '{"标题":"发票","金额":100}', elapsedMs: 1 });
    const out = await extractJson.execute({ image: IMG_URL, fields: ['标题', '金额'] });
    expect(out).toBe(JSON.stringify({ 标题: '发票', 金额: 100 }, null, 2));
    expect(lastCall().options.jsonMode).toBe(true);
    const parts = lastCall().messages[1].content as { text?: string }[];
    expect(parts[0].text).toContain('- 标题');
    expect(parts[0].text).toContain('- 金额');
  });

  it('带 ```json 围栏的输出能提取并解析', async () => {
    mockConfig(vision());
    chatVisionMock.mockResolvedValue({ content: '```json\n{"a":1}\n```', elapsedMs: 1 });
    const out = await extractJson.execute({ image: IMG_URL, fields: ['a'] });
    expect(out).toBe('{\n  "a": 1\n}');
  });

  it('带前后缀噪声的输出能按花括号边界提取', async () => {
    mockConfig(vision());
    chatVisionMock.mockResolvedValue({ content: '好的，结果：{"a":1}，请查收', elapsedMs: 1 });
    const out = await extractJson.execute({ image: IMG_URL, fields: ['a'] });
    expect(out).toBe('{\n  "a": 1\n}');
  });

  it('数组形式输出同样可提取', async () => {
    mockConfig(vision());
    chatVisionMock.mockResolvedValue({ content: '[1,2]', elapsedMs: 1 });
    const out = await extractJson.execute({ image: IMG_URL, fields: ['a'] });
    expect(out).toBe('[\n  1,\n  2\n]');
  });

  it('彻底解析失败时降级返回原始文本而不抛错', async () => {
    mockConfig(vision());
    chatVisionMock.mockResolvedValue({ content: '抱歉，图片模糊看不清', elapsedMs: 1 });
    const out = await extractJson.execute({ image: IMG_URL, fields: ['a'] });
    expect(out).toContain('注意：视觉模型输出不是合法 JSON');
    expect(out).toContain('抱歉，图片模糊看不清');
  });
});

describe('结果截断（防上下文膨胀）', () => {
  it('超过 maxResultChars 时截断并注明原文长度', async () => {
    mockConfig(vision({ maxResultChars: 10 }));
    chatVisionMock.mockResolvedValue({ content: 'x'.repeat(100), elapsedMs: 1 });
    const out = await describeImage.execute({ image: IMG_URL });
    expect(out).toBe(`x`.repeat(10) + '\n…（已截断，原文共 100 字符）');
  });

  it('未超限时原样返回', async () => {
    mockConfig(vision({ maxResultChars: 100 }));
    chatVisionMock.mockResolvedValue({ content: '短结果', elapsedMs: 1 });
    const out = await describeImage.execute({ image: IMG_URL });
    expect(out).toBe('短结果');
  });
});

describe('工具元数据', () => {
  it('四个工具名称、统一 60s 超时、必填参数正确', () => {
    expect(visionTools.map((t) => t.name)).toEqual(['describe_image', 'ask_image', 'extract_json', 'ocr_image']);
    for (const t of visionTools) {
      expect(t.timeoutMs).toBe(60000);
      expect(t.parameters.required).toContain('image');
    }
    expect(askImage.parameters.required).toContain('question');
    expect(extractJson.parameters.required).toContain('fields');
  });

  it('resolveVisionTargets：空值回退主模型，非空优先', () => {
    const model: ModelConfig = { name: 'main', baseUrl: 'https://m', apiKey: 'mk' } as ModelConfig;
    expect(resolveVisionTargets(vision({ model: 'v-model', apiKey: 'v-key' }), model)).toEqual({
      baseUrl: 'https://m',
      apiKey: 'v-key',
      model: 'v-model',
    });
    expect(resolveVisionTargets(vision(), model)).toEqual({
      baseUrl: 'https://m',
      apiKey: 'mk',
      model: 'main',
    });
  });
});
