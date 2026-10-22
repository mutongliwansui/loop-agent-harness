/**
 * 视觉工具注册单测（Task-20261010-001）
 * 覆盖：vision.enabled 条件注册（默认关闭不注册，保护前缀缓存）、enabled 白名单与 disabled 排除交互、幂等注册
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registerBuiltinTools, registry } from '../src/tools/index.js';
import { BUILTIN_TOOL_NAMES } from '../src/commands/tools-command.js';
import { VISION_TOOL_NAMES } from '../src/tools/vision/tools.js';
import type { ToolsConfig, VisionConfig } from '../src/config/schema.js';

const BUILTIN_SIX = ['commandRun', 'fileRead', 'fileWrite', 'editFile', 'grep', 'activate_skill'];
// Task-20261022-002：内置工具新增 commandStatus/commandLogs/commandStop（后台任务三件套）
const BACKGROUND_THREE = ['commandStatus', 'commandLogs', 'commandStop'];
const BUILTIN_ALL = [...BUILTIN_SIX, ...BACKGROUND_THREE];

function toolsConfig(enabled: string[] = [], disabled: string[] = []): ToolsConfig {
  return { enabled, disabled };
}

function visionConfig(enabled: boolean): VisionConfig {
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

const visionNames = VISION_TOOL_NAMES as readonly string[];

beforeEach(() => {
  registry.clear();
});

afterEach(() => {
  registry.clear();
});

describe('vision.enabled 条件注册', () => {
  it('不传 vision 配置时只注册内置工具（含后台任务三件套，共 9 个）', () => {
    const names = registerBuiltinTools();
    expect(names).toHaveLength(9);
    expect(names).toEqual(expect.arrayContaining(BUILTIN_ALL));
    expect(names.some((n) => visionNames.includes(n))).toBe(false);
    for (const n of visionNames) expect(registry.has(n)).toBe(false);
  });

  it('vision.enabled=false 时不注册视觉工具（tools 列表与未启用时完全一致）', () => {
    const base = registerBuiltinTools();
    registry.clear();
    const names = registerBuiltinTools(toolsConfig(), visionConfig(false));
    expect(names).toEqual(base);
  });

  it('vision.enabled=true 时注册 4 个视觉工具且入全局 registry', () => {
    const names = registerBuiltinTools(toolsConfig(), visionConfig(true));
    expect(names).toHaveLength(13);
    expect(names).toEqual(expect.arrayContaining([...BUILTIN_ALL, ...visionNames]));
    for (const n of visionNames) {
      expect(registry.has(n)).toBe(true);
      expect(registry.get(n).timeoutMs).toBe(60000);
    }
  });

  it('enabled 白名单模式下视觉工具同样受白名单约束', () => {
    const names = registerBuiltinTools(toolsConfig(['fileRead']), visionConfig(true));
    expect(names).toEqual(['fileRead']);
  });

  it('disabled 列表可排除单个视觉工具', () => {
    const names = registerBuiltinTools(toolsConfig([], ['describe_image']), visionConfig(true));
    expect(names).toHaveLength(12);
    expect(names).not.toContain('describe_image');
    expect(names).toContain('ask_image');
  });

  it('重复注册幂等，不抛错不重复', () => {
    registerBuiltinTools(toolsConfig(), visionConfig(true));
    const names = registerBuiltinTools(toolsConfig(), visionConfig(true));
    expect(names).toHaveLength(13);
    expect(registry.list()).toHaveLength(13);
  });
});

describe('BUILTIN_TOOL_NAMES（/tools 命令校验与 Tab 补全复用）', () => {
  it('包含 6 个内置工具与 4 个视觉工具', () => {
    // 只比对集合内容（tools-command.ts 中三件套排在 commandRun 之后，顺序与 BUILTIN_ALL 定义不同）
    expect([...BUILTIN_TOOL_NAMES].sort()).toEqual([...BUILTIN_ALL, ...visionNames].sort());
  });
});
