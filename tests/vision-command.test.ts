/**
 * /vision 命令单测（Task-20261010-001 P1）
 * 覆盖：status 的配置来源/掩码/缓存/会话累计展示，test 的连通性成功与失败输出，子命令路由
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandContext } from '../src/commands/registry.js';
import type { VisionConfig, AgentConfig } from '../src/config/schema.js';

const { chatVisionMock } = vi.hoisted(() => ({ chatVisionMock: vi.fn() }));
vi.mock('../src/llm/client.js', () => ({ llm: { chatVision: chatVisionMock } }));

const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }));
vi.mock('../src/config/index.js', () => ({ configLoader: { load: loadMock } }));

import { visionCommand } from '../src/commands/vision-command.js';
import { visionCache } from '../src/tools/vision/cache.js';
import { visionStats } from '../src/tools/vision/stats.js';

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

function mockConfig(v: VisionConfig, sources: Record<string, string> = {}): void {
  loadMock.mockReturnValue({
    config: {
      model: { name: 'main-model', baseUrl: 'https://main.example.com', apiKey: 'main-key-8888' },
      vision: v,
    } as unknown as AgentConfig,
    sources,
  });
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function logsOf(lines: string[]): string {
  return lines.join('\n').replace(ANSI_RE, '');
}

function makeCtx(): { ctx: CommandContext; lines: string[] } {
  const lines: string[] = [];
  const ctx = {
    configLoader: { load: loadMock },
    out: { log: (s: string) => lines.push(s), blank: () => lines.push('') },
  } as unknown as CommandContext;
  return { ctx, lines };
}

beforeEach(() => {
  chatVisionMock.mockReset();
  loadMock.mockReset();
  visionCache.clear();
  visionStats.reset();
});

describe('/vision match 与路由', () => {
  it('匹配 /vision 前缀，不误匹配其他命令', () => {
    expect(visionCommand.match('/vision status')).toBe(true);
    expect(visionCommand.match('/vision')).toBe(true);
    expect(visionCommand.match('/visionx')).toBe(false);
    expect(visionCommand.match('/help')).toBe(false);
  });

  it('未知子命令给出用法提示', async () => {
    mockConfig(vision());
    const { ctx, lines } = makeCtx();
    await visionCommand.execute('/vision foo', ctx);
    const logs = logsOf(lines);
    expect(logs).toContain('未知子命令: foo');
    expect(logs).toContain('用法: /vision status | /vision test');
  });
});

describe('/vision status', () => {
  it('展示配置值、来源标注与 apiKey 尾 4 位掩码（不泄露完整 key）', async () => {
    mockConfig(vision({ apiKey: 'sk-test-12345678', model: 'v-model' }), {
      'vision.enabled': 'workspace',
      'vision.apiKey': 'env',
    });
    const { ctx, lines } = makeCtx();
    await visionCommand.execute('/vision status', ctx);
    const logs = logsOf(lines);

    expect(logs).toContain('视觉功能状态:');
    expect(logs).toContain('enabled = true (workspace)');
    expect(logs).toContain('v-model');
    expect(logs).toContain('****5678');
    expect(logs).toContain('(env)');
    expect(logs).not.toContain('sk-test-12345678');
  });

  it('未配置时展示回退主模型信息与未配置 Key 提示', async () => {
    mockConfig(vision());
    const { ctx, lines } = makeCtx();
    await visionCommand.execute('/vision status', ctx);
    const logs = logsOf(lines);
    expect(logs).toContain('(回退主模型 main-model)');
    expect(logs).toContain('(回退 https://main.example.com)');
    expect(logs).toContain('(回退主模型 Key ****8888)');
  });

  it('展示缓存条数与会话累计用量', async () => {
    mockConfig(vision());
    visionCache.set('some-key', 'some-value', 600000);
    visionStats.recordSuccess({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, 40);
    visionStats.recordCacheHit();
    visionStats.recordError();

    const { ctx, lines } = makeCtx();
    await visionCommand.execute('/vision status', ctx);
    const logs = logsOf(lines);

    expect(logs).toContain('缓存: 1 条（LRU 上限 20）');
    expect(logs).toContain('调用 1 次（缓存命中 1，失败 1）');
    expect(logs).toContain('prompt 10 + completion 5 = 15 tokens');
    expect(logs).toContain('耗时 40ms');
  });
});

describe('/vision test', () => {
  it('连通成功：输出成功标记、耗时、tokens 与模型答复', async () => {
    mockConfig(vision({ apiKey: 'sk-x', model: 'v-model' }));
    chatVisionMock.mockResolvedValue({
      content: ' 透明图像 ',
      usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
      elapsedMs: 123,
    });
    const { ctx, lines } = makeCtx();
    await visionCommand.execute('/vision test', ctx);
    const logs = logsOf(lines);

    expect(logs).toContain('测试中: v-model @ https://main.example.com …');
    expect(chatVisionMock).toHaveBeenCalledTimes(1);
    expect(logs).toContain('✓ 连通性测试成功');
    expect(logs).toContain('(123ms, tokens 22)');
    expect(logs).toContain('模型答复: 透明图像');
  });

  it('连通失败：输出失败原因与排查提示，不抛错', async () => {
    mockConfig(vision({ apiKey: 'sk-x', model: 'v-model' }));
    chatVisionMock.mockRejectedValue(new Error('401 无效 API Key'));
    const { ctx, lines } = makeCtx();
    await visionCommand.execute('/vision test', ctx);
    const logs = logsOf(lines);

    expect(logs).toContain('✗ 连通性测试失败: 401 无效 API Key');
    expect(logs).toContain('排查: model 是否为视觉模型 / baseUrl 是否正确 / apiKey 是否有效');
  });

  it('apiKey 与主模型 Key 均为空时直接拦截，不发起请求', async () => {
    loadMock.mockReturnValue({
      config: {
        model: { name: 'main-model', baseUrl: 'https://main.example.com', apiKey: '' },
        vision: vision({ apiKey: '' }),
      } as unknown as AgentConfig,
      sources: {},
    });
    const { ctx, lines } = makeCtx();
    await visionCommand.execute('/vision test', ctx);
    const logs = logsOf(lines);

    expect(logs).toContain('✗ 连通性测试失败: 未配置 API Key');
    expect(chatVisionMock).not.toHaveBeenCalled();
  });

  it('未启用时给出提示但仍执行测试', async () => {
    mockConfig(vision({ enabled: false, apiKey: 'sk-x', model: 'v-model' }));
    chatVisionMock.mockResolvedValue({ content: 'ok', elapsedMs: 1 });
    const { ctx, lines } = makeCtx();
    await visionCommand.execute('/vision test', ctx);
    const logs = logsOf(lines);

    expect(logs).toContain('提示: 视觉功能未启用');
    expect(logs).toContain('✓ 连通性测试成功');
  });
});
