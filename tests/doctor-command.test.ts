/**
 * /doctor 命令单测（Task-20261011-001 P1）
 * 覆盖：match 与声明、缺失阻断项报告（含修复提示）、配置齐备时只读检测（不写盘）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommandContext } from '../src/commands/registry.js';
import type { AgentConfig } from '../src/config/schema.js';

import { doctorCommand } from '../src/commands/doctor-command.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
/** 剥离 ANSI 转义后拼接输出（COLORS 会把 ✓/✗ 包进转义序列） */
function logsOf(lines: string[]): string {
  return lines.join('\n').replace(ANSI_RE, '');
}

function makeCtx(cfg: Partial<AgentConfig>): {
  ctx: CommandContext;
  lines: string[];
  updateScope: ReturnType<typeof vi.fn>;
} {
  const lines: string[] = [];
  const updateScope = vi.fn(async () => undefined);
  const load = vi.fn().mockReturnValue({ config: cfg as unknown as AgentConfig, sources: {} });
  const ctx = {
    configLoader: { load },
    configWriter: { updateScope },
    out: { log: (s: string) => lines.push(s), blank: () => lines.push('') },
  } as unknown as CommandContext;
  return { ctx, lines, updateScope };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/doctor match 与声明', () => {
  it('匹配 /doctor 前缀（大小写不敏感），不误匹配其他命令', () => {
    expect(doctorCommand.match('/doctor')).toBe(true);
    expect(doctorCommand.match('/Doctor')).toBe(true);
    expect(doctorCommand.match('/doctors')).toBe(false);
    expect(doctorCommand.match('/doc')).toBe(false);
    expect(doctorCommand.match('/help')).toBe(false);
  });

  it('未声明 subcommands（只读检测无子命令）', () => {
    expect(doctorCommand.subcommands).toBeUndefined();
  });
});

describe('/doctor 检测报告', () => {
  it('apiKey/name 缺失：逐项报告阻断项并给出 /setup 修复提示', async () => {
    const { ctx, lines, updateScope } = makeCtx({
      model: { apiKey: '', name: '' },
    } as Partial<AgentConfig>);
    await doctorCommand.execute('/doctor', ctx);
    const logs = logsOf(lines);

    expect(logs).toContain('启动体检报告');
    expect(logs).toContain('✗ 主模型 apiKey');
    expect(logs).toContain('主模型 apiKey 未配置');
    expect(logs).toContain('✗ 主模型名称');
    expect(logs).toContain('运行 /setup 重新配置');
    expect(logs).toContain('存在阻断项，请运行 /setup 修复');
    expect(logs).toContain('本命令只读，不修改任何文件');
    // 全程只读：绝不触发任何写盘操作
    expect(updateScope).not.toHaveBeenCalled();
  });

  it('三元组齐备：主模型项打勾，结论为阻断项 0 个', async () => {
    const { ctx, lines, updateScope } = makeCtx({
      model: { apiKey: 'sk-default', name: 'test-model' },
    } as Partial<AgentConfig>);
    await doctorCommand.execute('/doctor', ctx);
    const logs = logsOf(lines);

    expect(logs).toContain('✓ 主模型 apiKey');
    expect(logs).toContain('✓ 主模型名称');
    expect(logs).toContain('阻断项 0 个，主模型配置齐备，可正常对话');
    expect(logs).not.toContain('存在阻断项');
    expect(updateScope).not.toHaveBeenCalled();
  });
});
