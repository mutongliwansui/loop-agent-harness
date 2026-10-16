// 子命令级帮助单测（`/xxx help`）
// 覆盖：buildSubcommandHelp 渲染（含/不含 subcommandHelp、无子命令）、dispatch 统一拦截与别名、普通子命令仍走 execute
import { describe, it, expect, vi } from 'vitest';
import {
  CommandRegistry,
  buildSubcommandHelp,
  subcommandOf,
  type CommandContext,
  type CommandHandler,
} from '../src/commands/registry.js';

/** 去掉 ANSI 颜色码，便于断言纯文本 */
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function makeCtx(): { lines: string[]; ctx: CommandContext } {
  const lines: string[] = [];
  const out = {
    log: (s: string) => lines.push(strip(s)),
    blank: () => lines.push(''),
  };
  return { lines, ctx: { out } as unknown as CommandContext };
}

function makeHandler(over: Partial<CommandHandler> = {}): CommandHandler {
  return {
    name: '/demo',
    description: '演示命令',
    match: (i) => i.toLowerCase().startsWith('/demo'),
    execute: vi.fn(async () => {}),
    subcommands: ['list', 'add', 'help'],
    subcommandHelp: { list: '列出条目', add: '添加条目' },
    ...over,
  };
}

describe('subcommandOf', () => {
  it('取第二个 token 并小写归一', () => {
    expect(subcommandOf('/demo LIST')).toBe('list');
    expect(subcommandOf('  /demo --help  ')).toBe('--help');
    expect(subcommandOf('/demo')).toBe('');
  });
});

describe('buildSubcommandHelp（D1）', () => {
  it('渲染命令名 + 描述 + 子命令说明 + 提示行，且不把 help 自身列为条目', () => {
    const lines = buildSubcommandHelp(makeHandler()).map(strip);
    expect(lines[0]).toContain('/demo');
    expect(lines[0]).toContain('演示命令');
    expect(lines.some((l) => /^\s{2}list\s+列出条目$/.test(l))).toBe(true);
    expect(lines.some((l) => /^\s{2}add\s+添加条目$/.test(l))).toBe(true);
    expect(lines.some((l) => /^\s{2}help\b/.test(l))).toBe(false);
    expect(lines[lines.length - 1]).toContain('提示：');
  });

  it('未提供 subcommandHelp 时仅列子命令名（无说明）', () => {
    const h = makeHandler({ subcommandHelp: undefined });
    const lines = buildSubcommandHelp(h).map(strip);
    expect(lines.some((l) => /^\s{2}list\s*$/.test(l))).toBe(true);
    expect(lines.some((l) => /^\s{2}add\s*$/.test(l))).toBe(true);
  });

  it('无子命令时给出明确占位', () => {
    const h = makeHandler({ subcommands: [], subcommandHelp: undefined });
    const lines = buildSubcommandHelp(h).map(strip);
    expect(lines.some((l) => l.includes('（该命令无子命令）'))).toBe(true);
  });
});

describe('CommandRegistry.dispatch 拦截子命令帮助（D2/D4）', () => {
  it('/demo help 不进入 execute，直接渲染帮助', async () => {
    const h = makeHandler();
    const reg = new CommandRegistry();
    reg.register(h);
    const { ctx, lines } = makeCtx();

    const matched = await reg.dispatch('/demo help', ctx);

    expect(matched).toBe(true);
    expect(h.execute).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('演示命令');
    expect(lines.join('\n')).toContain('列出条目');
  });

  it('-h / --help / 大写 HELP 同样拦截', async () => {
    for (const alias of ['-h', '--help', 'HELP']) {
      const h = makeHandler();
      const reg = new CommandRegistry();
      reg.register(h);
      const { ctx, lines } = makeCtx();
      await reg.dispatch(`/demo ${alias}`, ctx);
      expect(h.execute).not.toHaveBeenCalled();
      expect(lines.join('\n')).toContain('演示命令');
    }
  });

  it('普通子命令仍交给命令自身 execute', async () => {
    const h = makeHandler();
    const reg = new CommandRegistry();
    reg.register(h);
    const { ctx } = makeCtx();

    await reg.dispatch('/demo list', ctx);

    expect(h.execute).toHaveBeenCalledWith('/demo list', ctx);
  });

  it('未匹配到命令时返回 false（不拦截）', async () => {
    const reg = new CommandRegistry();
    reg.register(makeHandler());
    const { ctx } = makeCtx();
    expect(await reg.dispatch('/other help', ctx)).toBe(false);
  });
});
