// 启动引导入口分流单测：noSetup / 齐备 / blocker→向导 / 非TTY→指引 / 仅missing→补建
// （Task-20261011-001 6.8/6.9/6.11）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';
import type { BootstrapReport } from '../src/bootstrap/doctor.js';

const hoisted = vi.hoisted(() => ({
  load: vi.fn(),
  checkBootstrap: vi.fn(),
  ensureScaffold: vi.fn(),
  runWizard: vi.fn(),
}));

vi.mock('../src/config/index.js', () => ({
  configLoader: { load: hoisted.load },
}));

vi.mock('../src/bootstrap/doctor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bootstrap/doctor.js')>();
  return { ...actual, checkBootstrap: hoisted.checkBootstrap };
});

vi.mock('../src/bootstrap/scaffold.js', () => ({
  ensureDirs: vi.fn(async () => []),
  ensureConfigFiles: vi.fn(async () => []),
  ensureScaffold: hoisted.ensureScaffold,
}));

vi.mock('../src/bootstrap/wizard.js', () => ({
  runWizard: hoisted.runWizard,
  defaultCheckConnectivity: vi.fn(),
}));

import { ensureBootstrap } from '../src/bootstrap/index.js';

const blockerIssue = { id: 'model-apiKey', level: 'blocker', message: '主模型 apiKey 未配置' } as const;
const missingIssue = {
  id: 'skills-global',
  level: 'missing',
  message: '全局 skills 目录不存在',
  path: '/fake/skills',
} as const;

function mockReport(issues: BootstrapReport['issues']): void {
  hoisted.checkBootstrap.mockReturnValue({
    ok: !issues.some((i) => i.level === 'blocker'),
    issues,
  });
}

function readyCfg(): AgentConfig {
  return { ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model, apiKey: 'sk-x' } };
}

function setIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

let logSpy: ReturnType<typeof vi.spyOn>;
const originalIsTTY = process.stdin.isTTY;

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.ensureScaffold.mockResolvedValue({ created: ['/fake/skills-global'] });
  hoisted.runWizard.mockResolvedValue(undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  setIsTTY(originalIsTTY);
});

describe('ensureBootstrap（启动引导分流）', () => {
  it('noSetup 为 true 时直接返回，不做任何检测', async () => {
    await ensureBootstrap({ noSetup: true });
    expect(hoisted.load).not.toHaveBeenCalled();
    expect(hoisted.checkBootstrap).not.toHaveBeenCalled();
    expect(logSpy.mock.calls).toHaveLength(0);
  });

  it('配置与目录齐备时零打扰：无输出、不补建、不进向导', async () => {
    hoisted.load.mockReturnValue({ config: readyCfg() });
    mockReport([]);
    setIsTTY(true);

    await ensureBootstrap();

    expect(hoisted.checkBootstrap).toHaveBeenCalledTimes(1);
    expect(hoisted.ensureScaffold).not.toHaveBeenCalled();
    expect(hoisted.runWizard).not.toHaveBeenCalled();
    expect(logSpy.mock.calls).toHaveLength(0);
  });

  it('存在 blocker 且 TTY 时进入向导（不单独补建）', async () => {
    hoisted.load.mockReturnValue({ config: DEFAULT_CONFIG });
    mockReport([blockerIssue, missingIssue]);
    setIsTTY(true);

    await ensureBootstrap();

    expect(hoisted.runWizard).toHaveBeenCalledTimes(1);
    expect(hoisted.runWizard.mock.calls[0][0].issues).toEqual([blockerIssue, missingIssue]);
    expect(hoisted.ensureScaffold).not.toHaveBeenCalled();
  });

  it('非 TTY 且存在 blocker 时：打印手动指引并仅补建，不进向导', async () => {
    hoisted.load.mockReturnValue({ config: DEFAULT_CONFIG });
    mockReport([blockerIssue, missingIssue]);
    setIsTTY(false);

    await ensureBootstrap();

    expect(hoisted.runWizard).not.toHaveBeenCalled();
    expect(hoisted.ensureScaffold).toHaveBeenCalledTimes(1);
    const text = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(text).toContain('非交互终端');
    expect(text).toContain('OPENAI_API_KEY');
    expect(text).toContain('/config set model.apiKey');
    expect(text).toContain('✓ 已创建: /fake/skills-global');
  });

  it('仅 missing 时静默补建并逐项打印 ✓，不进向导', async () => {
    hoisted.load.mockReturnValue({ config: readyCfg() });
    mockReport([missingIssue]);
    setIsTTY(true);

    await ensureBootstrap();

    expect(hoisted.runWizard).not.toHaveBeenCalled();
    expect(hoisted.ensureScaffold).toHaveBeenCalledTimes(1);
    const text = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(text).toContain('✓ 已创建: /fake/skills-global');
  });
});
