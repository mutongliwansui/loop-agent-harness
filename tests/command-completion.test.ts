/**
 * 命令输入 Tab 补全单元测试（Task-20260930-002 P0/P1/P2）
 * 覆盖：一级补全、内联命令并集、多候选、非斜杠零副作用、二级子命令、边界与幂等、
 *       单词命令补全（P2）、动态参数补全（P2）
 */
import { describe, it, expect } from 'vitest';
import {
  CommandRegistry,
  completeCommandLine,
  completeCommandLineAsync,
  BUILTIN_SLASH_COMMANDS,
  BUILTIN_WORD_COMMANDS,
  type ArgCompletionProvider,
  type CommandHandler,
} from '../src/commands/registry.js';
import { configCommand } from '../src/commands/config-command.js';
import { mcpCommand } from '../src/commands/mcp-command.js';
import { toolsCommand } from '../src/commands/tools-command.js';
import { skillCommand } from '../src/commands/skill-command.js';
import { sessionCommand } from '../src/commands/session-command.js';
import { memoryCommand } from '../src/commands/memory-command.js';
import { setupCommand } from '../src/commands/setup-command.js';
import { doctorCommand } from '../src/commands/doctor-command.js';

function handler(name: string, subcommands?: string[]): CommandHandler {
  return {
    name,
    description: `${name} 描述`,
    match: (input) => input.startsWith(name),
    execute: async () => {},
    ...(subcommands ? { subcommands } : {}),
  };
}

/** 构造一个含常用命令的注册器 */
function makeRegistry(): CommandRegistry {
  const r = new CommandRegistry();
  r.register(handler('/config', ['list', 'get', 'set', 'delete', 'path']));
  r.register(handler('/mcp'));
  r.register(handler('/tools'));
  r.register(handler('/skill'));
  r.register(handler('/session'));
  r.register(handler('/memory'));
  return r;
}

describe('CommandRegistry 补全 API', () => {
  it('listNames 返回全部命令名', () => {
    const r = makeRegistry();
    expect(r.listNames()).toEqual(['/config', '/mcp', '/tools', '/skill', '/session', '/memory']);
  });

  it('completeCommands 按前缀过滤', () => {
    expect(makeRegistry().completeCommands('/s')).toEqual(['/skill', '/session']);
    expect(makeRegistry().completeCommands('/xyz')).toEqual([]);
  });

  it('寄存器无命令时 listNames 为空', () => {
    expect(new CommandRegistry().listNames()).toEqual([]);
  });
});

describe('一级补全：命令名', () => {
  it('/con 补全为 /config（单候选）', () => {
    expect(completeCommandLine('/con', makeRegistry())).toEqual([['/config'], '/con']);
  });

  it('/re 可补出内联命令 /reset', () => {
    expect(completeCommandLine('/re', makeRegistry())).toEqual([['/reset'], '/re']);
  });

  it('/ 列出全部命令（注册 ∪ 内联）', () => {
    const [hits] = completeCommandLine('/', makeRegistry());
    expect(hits).toContain('/config');
    expect(hits).toContain('/mcp');
    for (const b of BUILTIN_SLASH_COMMANDS) expect(hits).toContain(b);
  });

  it('/s 返回多候选（/skill /session /status）', () => {
    const [hits] = completeCommandLine('/s', makeRegistry());
    expect(hits).toEqual(expect.arrayContaining(['/skill', '/session', '/status']));
  });

  it('已完整输入的命令按 Tab 幂等（候选含自身）', () => {
    expect(completeCommandLine('/config', makeRegistry())).toEqual([['/config'], '/config']);
  });

  it('不存在的命令返回空候选', () => {
    expect(completeCommandLine('/xyz', makeRegistry())).toEqual([[], '/xyz']);
  });

  it('内联命令与注册命令同名时不重复', () => {
    const r = new CommandRegistry();
    r.register(handler('/help'));
    const [hits] = completeCommandLine('/help', r);
    expect(hits).toEqual(['/help']);
  });
});

describe('零副作用：非斜杠输入', () => {
  it('普通提问返回空候选且 completeOn 为原行', () => {
    const line = '帮我读取 package.json';
    expect(completeCommandLine(line, makeRegistry())).toEqual([[], line]);
  });

  it('空行返回空候选', () => {
    expect(completeCommandLine('', makeRegistry())).toEqual([[], '']);
  });

  it('前导空格后以 / 开头仍可补全，completeOn 保留原行', () => {
    const line = '  /con';
    expect(completeCommandLine(line, makeRegistry())).toEqual([['/config'], line]);
  });

  it('同步静态补全不含单词命令（help 交由异步补全处理）', () => {
    expect(completeCommandLine('help', makeRegistry())).toEqual([[], 'help']);
  });
});

describe('二级补全：子命令', () => {
  it('/config l 补全为 /config list', () => {
    expect(completeCommandLine('/config l', makeRegistry())).toEqual([['/config list'], '/config l']);
  });

  it('/config 后跟空格列出全部子命令（整行替换串）', () => {
    const [hits] = completeCommandLine('/config ', makeRegistry());
    expect(hits).toEqual([
      '/config list',
      '/config get',
      '/config set',
      '/config delete',
      '/config path',
    ]);
  });

  it('无 subcommands 的命令二级返回空候选', () => {
    expect(completeCommandLine('/mcp l', makeRegistry())).toEqual([[], '/mcp l']);
  });

  it('更深层（第三段）不补全', () => {
    expect(completeCommandLine('/config list x', makeRegistry())).toEqual([[], '/config list x']);
  });

  it('子命令后跟空格（进入参数阶段）二级不补全', () => {
    expect(completeCommandLine('/config list ', makeRegistry())).toEqual([[], '/config list ']);
  });
});

describe('真实命令的 subcommands 声明与二级补全', () => {
  const REAL_COMMANDS: CommandHandler[] = [
    configCommand,
    mcpCommand,
    toolsCommand,
    skillCommand,
    sessionCommand,
    memoryCommand,
    setupCommand,
  ];

  /** 提取 description 中括号内的子命令（如「配置管理（list/get））」→ ['list','get']） */
  function descriptionSubs(desc: string): string[] {
    const m = desc.match(/（([^）]+)）/);
    return m ? m[1].split('/') : [];
  }

  for (const c of REAL_COMMANDS) {
    it(`${c.name} 已声明 subcommands`, () => {
      expect(c.subcommands?.length ?? 0).toBeGreaterThan(0);
    });
  }

  it('每个命令的 subcommands 与 description 括号内容一致', () => {
    for (const c of REAL_COMMANDS) {
      expect([...(c.subcommands ?? [])].sort()).toEqual(descriptionSubs(c.description).sort());
    }
  });

  it('真实注册器下一级补全可用', () => {
    const r = new CommandRegistry();
    for (const c of REAL_COMMANDS) r.register(c);
    expect(completeCommandLine('/con', r)).toEqual([['/config'], '/con']);
    expect(completeCommandLine('/sk', r)).toEqual([['/skill'], '/sk']);
  });

  it('真实注册器下二级补全可用', () => {
    const r = new CommandRegistry();
    for (const c of REAL_COMMANDS) r.register(c);
    expect(completeCommandLine('/config l', r)).toEqual([['/config list'], '/config l']);
    expect(completeCommandLine('/memory g', r)).toEqual([['/memory gate'], '/memory g']);
    expect(completeCommandLine('/session ', r)[0]).toContain('/session delete-all');
    expect(completeCommandLine('/tools d', r)).toEqual([['/tools disable'], '/tools d']);
  });

  it('P1 引导命令：/doc 一级补全为 /doctor（Task-20261011-001）', () => {
    const r = new CommandRegistry();
    for (const c of REAL_COMMANDS) r.register(c);
    r.register(doctorCommand);
    expect(completeCommandLine('/doc', r)).toEqual([['/doctor'], '/doc']);
    // /doctor 只读检测，无二级子命令
    expect(completeCommandLine('/doctor l', r)).toEqual([[], '/doctor l']);
  });

  it('P1 引导命令：/se 候选含 /setup，二级列出 --global/--workspace', () => {
    const r = new CommandRegistry();
    for (const c of REAL_COMMANDS) r.register(c);
    expect(completeCommandLine('/se', r)[0]).toContain('/setup');
    expect(completeCommandLine('/setup ', r)[0]).toEqual([
      '/setup --global',
      '/setup --workspace',
    ]);
    expect(completeCommandLine('/setup --g', r)).toEqual([['/setup --global'], '/setup --g']);
  });
});

describe('P2：单词命令补全', () => {
  it('hel 补全为 help', async () => {
    expect(await completeCommandLineAsync('hel', makeRegistry())).toEqual([['help'], 'hel']);
  });

  it('ex 补全为 exit', async () => {
    expect(await completeCommandLineAsync('ex', makeRegistry())).toEqual([['exit'], 'ex']);
  });

  it('单词命令常量含 help/exit/quit/q', () => {
    expect(BUILTIN_WORD_COMMANDS).toEqual(expect.arrayContaining(['help', 'exit', 'quit', 'q']));
  });

  it('含空格的普通提问不补全（零副作用）', async () => {
    expect(await completeCommandLineAsync('hello world', makeRegistry())).toEqual([[], 'hello world']);
  });

  it('中文提问不补全（零副作用）', async () => {
    const line = '帮我看一下';
    expect(await completeCommandLineAsync(line, makeRegistry())).toEqual([[], line]);
  });

  it('无匹配前缀的单词不补全', async () => {
    expect(await completeCommandLineAsync('hello', makeRegistry())).toEqual([[], 'hello']);
  });

  it('异步补全下斜杠一级/二级行为与同步一致', async () => {
    const r = makeRegistry();
    expect(await completeCommandLineAsync('/con', r)).toEqual([['/config'], '/con']);
    expect(await completeCommandLineAsync('/config l', r)).toEqual([['/config list'], '/config l']);
  });
});

describe('P2：动态参数补全', () => {
  // 需要目标命令声明 subcommands（makeRegistry 的 /session 未声明），故单独构造
  const r: CommandRegistry = (() => {
    const reg = new CommandRegistry();
    reg.register(handler('/session', ['list', 'load', 'delete']));
    reg.register(handler('/tools', ['list', 'enable', 'disable']));
    reg.register(handler('/config', ['list', 'get']));
    return reg;
  })();

  /** 桩 provider：仅处理 /session load 与 /tools enable */
  const provider: ArgCompletionProvider = {
    completeArgs(command, subcommand, prefix) {
      if (command === '/session' && subcommand === 'load') {
        return ['abc123', 'abc999', 'xyz'].filter((x) => x.startsWith(prefix));
      }
      if (command === '/tools' && subcommand === 'enable') {
        return ['fileRead', 'fileWrite'].filter((x) => x.startsWith(prefix));
      }
      return [];
    },
  };

  it('/session load 后跟空格补出会话 id', async () => {
    expect(await completeCommandLineAsync('/session load ', r, provider)).toEqual([
      ['/session load abc123', '/session load abc999', '/session load xyz'],
      '/session load ',
    ]);
  });

  it('/session load abc 按前缀过滤会话 id', async () => {
    expect(await completeCommandLineAsync('/session load abc', r, provider)).toEqual([
      ['/session load abc123', '/session load abc999'],
      '/session load abc',
    ]);
  });

  it('/tools enable 补出内置工具名', async () => {
    expect(await completeCommandLineAsync('/tools enable file', r, provider)).toEqual([
      ['/tools enable fileRead', '/tools enable fileWrite'],
      '/tools enable file',
    ]);
  });

  it('未接 provider 时三级不补全', async () => {
    expect(await completeCommandLineAsync('/session load ', r)).toEqual([[], '/session load ']);
  });

  it('provider 不匹配的命令三级返回空候选', async () => {
    expect(await completeCommandLineAsync('/config list ', r, provider)).toEqual([[], '/config list ']);
  });

  it('更深层（第四个 token）不补全', async () => {
    const line = '/session load abc extra';
    expect(await completeCommandLineAsync(line, r, provider)).toEqual([[], line]);
  });

  it('三级补全不影响一级/二级优先级', async () => {
    expect(await completeCommandLineAsync('/session lo', r, provider)).toEqual([['/session load'], '/session lo']);
    expect(await completeCommandLineAsync('/session l', r, provider)).toEqual([
      ['/session list', '/session load'],
      '/session l',
    ]);
  });
});
