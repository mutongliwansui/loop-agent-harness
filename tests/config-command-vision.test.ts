/**
 * /config set|delete vision.enabled 自动同步视觉工具注册单测
 * 覆盖：开启即注册、关闭即注销、重复开启不重复注册、删除回退即注销、其他键不触碰注册表、写入失败不同步
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandContext } from '../src/commands/registry.js';
import type { AgentConfig, ToolsConfig, VisionConfig } from '../src/config/schema.js';

const { loadMock, updateScopeMock, deleteScopeKeyMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  updateScopeMock: vi.fn(),
  deleteScopeKeyMock: vi.fn(),
}));

vi.mock('../src/config/index.js', () => ({
  configLoader: { load: loadMock },
  ConfigWriter: {
    setByKey: (obj: Record<string, unknown>, key: string, value: unknown) => {
      const parts = key.split('.');
      let cur = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        cur[parts[i]] = (cur[parts[i]] as Record<string, unknown>) ?? {};
        cur = cur[parts[i]] as Record<string, unknown>;
      }
      cur[parts[parts.length - 1]] = value;
    },
    parseKey: (key: string) => key.split('.'),
  },
}));

import { configCommand } from '../src/commands/config-command.js';
import { registry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/index.js';
import { VISION_TOOL_NAMES } from '../src/tools/vision/tools.js';

function vision(enabled: boolean): VisionConfig {
  return {
    enabled,
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
  };
}

function toolsCfg(): ToolsConfig {
  return { enabled: [], disabled: [], mcpServers: {} };
}

function mockConfig(enabled: boolean): void {
  loadMock.mockReturnValue({
    config: { tools: toolsCfg(), vision: vision(enabled) } as unknown as AgentConfig,
    sources: {},
  });
}

function makeCtx(): { ctx: CommandContext; lines: string[] } {
  const lines: string[] = [];
  const ctx = {
    configLoader: { load: loadMock },
    configWriter: { updateScope: updateScopeMock, deleteScopeKey: deleteScopeKeyMock },
    registry,
    out: {
      log: (s: string) => lines.push(s),
      blank: () => lines.push(''),
      error: (s: string) => lines.push(s),
    },
  } as unknown as CommandContext;
  return { ctx, lines };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function logsOf(lines: string[]): string {
  return lines.join('\n').replace(ANSI_RE, '');
}

beforeEach(() => {
  registry.clear();
  loadMock.mockReset();
  updateScopeMock.mockReset();
  updateScopeMock.mockResolvedValue(undefined);
  deleteScopeKeyMock.mockReset();
  deleteScopeKeyMock.mockResolvedValue(undefined);
});

describe('/config set vision.enabled 自动同步注册', () => {
  it('true：立即注册视觉工具并输出提示', async () => {
    mockConfig(false);
    registerBuiltinTools(toolsCfg(), vision(false));
    expect(VISION_TOOL_NAMES.every((n) => !registry.has(n))).toBe(true);

    mockConfig(true);
    const { ctx, lines } = makeCtx();
    await configCommand.execute('/config set vision.enabled true', ctx);

    expect(updateScopeMock).toHaveBeenCalledTimes(1);
    expect(VISION_TOOL_NAMES.every((n) => registry.has(n))).toBe(true);
    expect(logsOf(lines)).toContain('已自动注册视觉工具: analyzeImage');
  });

  it('false：立即注销视觉工具，其余内置工具保留', async () => {
    mockConfig(true);
    registerBuiltinTools(toolsCfg(), vision(true));
    expect(VISION_TOOL_NAMES.every((n) => registry.has(n))).toBe(true);

    mockConfig(false);
    const { ctx, lines } = makeCtx();
    await configCommand.execute('/config set vision.enabled false', ctx);

    expect(VISION_TOOL_NAMES.every((n) => !registry.has(n))).toBe(true);
    expect(registry.has('fileRead')).toBe(true);
    expect(registry.has('grep')).toBe(true);
    expect(logsOf(lines)).toContain('已自动注销视觉工具');
  });

  it('已注册时再次 set true：不重复注册、无重复提示', async () => {
    mockConfig(true);
    registerBuiltinTools(toolsCfg(), vision(true));
    const countBefore = registry.list().length;

    const { ctx, lines } = makeCtx();
    await configCommand.execute('/config set vision.enabled true', ctx);

    expect(registry.list().length).toBe(countBefore);
    expect(logsOf(lines)).not.toContain('已自动注册视觉工具');
  });
});

describe('/config delete vision.enabled 自动同步注册', () => {
  it('删除后生效值回退 false：立即注销视觉工具', async () => {
    mockConfig(true);
    registerBuiltinTools(toolsCfg(), vision(true));

    mockConfig(false);
    const { ctx, lines } = makeCtx();
    await configCommand.execute('/config delete vision.enabled', ctx);

    expect(deleteScopeKeyMock).toHaveBeenCalledTimes(1);
    expect(VISION_TOOL_NAMES.every((n) => !registry.has(n))).toBe(true);
    expect(logsOf(lines)).toContain('已自动注销视觉工具');
  });
});

describe('不相关操作不触碰注册表', () => {
  it('set 其他键不改变注册表', async () => {
    mockConfig(false);
    registerBuiltinTools(toolsCfg(), vision(false));
    const namesBefore = registry.list().map((t) => t.name).sort();

    const { ctx } = makeCtx();
    await configCommand.execute('/config set model.temperature 0.5', ctx);

    expect(registry.list().map((t) => t.name).sort()).toEqual(namesBefore);
  });

  it('写入失败（updateScope 抛错）时不同步注册表', async () => {
    mockConfig(true);
    registerBuiltinTools(toolsCfg(), vision(false));

    updateScopeMock.mockRejectedValueOnce(new Error('磁盘写入失败'));
    const { ctx } = makeCtx();
    await configCommand.execute('/config set vision.enabled true', ctx);

    expect(VISION_TOOL_NAMES.every((n) => !registry.has(n))).toBe(true);
  });
});
