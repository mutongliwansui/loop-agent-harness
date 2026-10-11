/**
 * /setup 命令单测（Task-20261011-001 P1）
 * 覆盖：match 与子命令声明、REPL readline 透传与写盘后工具刷新、--global/--workspace 解析
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Interface as ReadlineInterface } from 'node:readline';
import type { CommandContext } from '../src/commands/registry.js';
import type { AgentConfig } from '../src/config/schema.js';

const { runWizardMock, registerBuiltinToolsMock } = vi.hoisted(() => ({
  runWizardMock: vi.fn(async () => undefined),
  registerBuiltinToolsMock: vi.fn(),
}));
vi.mock('../src/bootstrap/wizard.js', () => ({ runWizard: runWizardMock }));
vi.mock('../src/tools/index.js', () => ({ registerBuiltinTools: registerBuiltinToolsMock }));

import { setupCommand } from '../src/commands/setup-command.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function logsOf(lines: string[]): string {
  return lines.join('\n').replace(ANSI_RE, '');
}

/** initial：向导前加载的生效配置；fresh：向导写盘后重新加载的配置 */
function makeCtx(initial: AgentConfig, fresh: AgentConfig): {
  ctx: CommandContext;
  lines: string[];
  rl: ReadlineInterface;
} {
  const lines: string[] = [];
  const load = vi
    .fn()
    .mockReturnValueOnce({ config: initial, sources: {} })
    .mockReturnValueOnce({ config: fresh, sources: {} });
  const rl = {} as unknown as ReadlineInterface;
  const ctx = {
    configLoader: { load },
    configWriter: { updateScope: vi.fn(async () => undefined) },
    rl,
    out: { log: (s: string) => lines.push(s), blank: () => lines.push('') },
  } as unknown as CommandContext;
  return { ctx, lines, rl };
}

function cfgWith(tools: object, vision: object): AgentConfig {
  return {
    model: { apiKey: 'sk-x', name: 'test-model' },
    tools,
    vision,
  } as unknown as AgentConfig;
}

beforeEach(() => {
  runWizardMock.mockClear();
  registerBuiltinToolsMock.mockClear();
});

describe('/setup match 与声明', () => {
  it('匹配 /setup 前缀（大小写不敏感），不误匹配其他命令', () => {
    expect(setupCommand.match('/setup')).toBe(true);
    expect(setupCommand.match('/SETUP --global')).toBe(true);
    expect(setupCommand.match('/setupx')).toBe(false);
    expect(setupCommand.match('/doctor')).toBe(false);
  });

  it('声明二级子命令 --global/--workspace', () => {
    expect(setupCommand.subcommands).toEqual(['--global', '--workspace']);
  });
});

describe('/setup 执行', () => {
  it('透传 REPL 的 rl 且不关闭；写盘后以 fresh 配置刷新工具注册', async () => {
    const initial = cfgWith({ t: 1 }, { v: 1 });
    const fresh = cfgWith({ t: 2 }, { v: 2 });
    const { ctx, lines, rl } = makeCtx(initial, fresh);

    await setupCommand.execute('/setup', ctx);

    // 向导以当前生效配置为默认值，并复用 REPL 的 readline
    expect(runWizardMock).toHaveBeenCalledTimes(1);
    expect(runWizardMock.mock.calls[0][1]).toBe(initial);
    const opts = runWizardMock.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.rl).toBe(rl);
    expect(opts.preferredScope).toBeUndefined();

    // 写盘后刷新：重新 load 生效值并按需注册工具（幂等）
    expect(registerBuiltinToolsMock).toHaveBeenCalledTimes(1);
    expect(registerBuiltinToolsMock).toHaveBeenCalledWith({ t: 2 }, { v: 2 });

    const logs = logsOf(lines);
    expect(logs).toContain('✓ 模型配置已写入，后续对话即时生效');
  });

  it('--global：向导默认写入全局配置', async () => {
    const { ctx } = makeCtx(cfgWith({ t: 1 }, { v: 1 }), cfgWith({ t: 2 }, { v: 2 }));
    await setupCommand.execute('/setup --global', ctx);
    expect((runWizardMock.mock.calls[0][2] as Record<string, unknown>).preferredScope).toBe(
      'global',
    );
  });

  it('--workspace：向导默认写入工作空间配置', async () => {
    const { ctx } = makeCtx(cfgWith({ t: 1 }, { v: 1 }), cfgWith({ t: 2 }, { v: 2 }));
    await setupCommand.execute('/setup --workspace', ctx);
    expect((runWizardMock.mock.calls[0][2] as Record<string, unknown>).preferredScope).toBe(
      'workspace',
    );
  });
});
