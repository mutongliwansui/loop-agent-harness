// 命令注册器 + 分发器
// 命令处理器通过 CommandContext 访问依赖，不直接 import 单例
import type readline from 'node:readline';
import type { ReActAgent } from '../agent/react-agent.js';
import type { ConfigLoader, ConfigWriter } from '../config/index.js';
import type { MCPManager } from '../config/index.js';
import type { ToolRegistry } from '../tools/index.js';
import type { SkillLoader } from '../skill/index.js';
import type { SessionStore } from '../session/index.js';
import type { OutputChannel } from '../ui/output-channel.js';
import { COLORS } from '../ui/colors.js';

/** 命令处理器的运行上下文 */
export interface CommandContext {
  agent: ReActAgent;
  configLoader: ConfigLoader;
  configWriter: ConfigWriter;
  mcpManager: MCPManager;
  registry: ToolRegistry;
  skillLoader: SkillLoader;
  sessionStore: SessionStore | null;
  rl: readline.Interface;
  out: OutputChannel;
  colors: typeof COLORS;
  /**
   * 统一 y/N 确认（复用主 REPL 的 readline，严禁新建临时 readline）。
   * 背景：临时 readline 与主 REPL 共享 process.stdin，其 close() 会 pause 共享流，
   * 导致主 REPL 永久失聪、TTY 下进程直接退出；且答案行会被主循环重复消费。
   * 返回 true 表示用户明确输入 y，其余（含回车）一律 false。
   */
  askConfirm: (question: string) => Promise<boolean>;
  /**
   * 命令级可中断入口（需求 20261029-002 D7）：
   * 长命令（如 `/model bench`）把 AbortController 交给 REPL，使 Ctrl+C 能打断它；
   * 命令结束务必传 null 释放。未实现时（Web/测试等非 REPL 宿主）可省略。
   */
  setAbortable?: (controller: AbortController | null) => void;
}

/** 命令处理器 */
export interface CommandHandler {
  /** 命令名（如 /config） */
  name: string;
  /** 描述 */
  description: string;
  /** 是否匹配该命令 */
  match: (input: string) => boolean;
  /** 执行命令 */
  execute: (input: string, ctx: CommandContext) => Promise<void>;
  /** 子命令候选（用于二级 Tab 补全，如 /config 的 list/get/set …）；可选 */
  subcommands?: string[];
  /** 子命令一句话说明（键为子命令名），用于 `/xxx help` 渲染；未提供则仅列子命令名 */
  subcommandHelp?: Record<string, string>;
}

/** 子命令 help 的触发词（D4：`/xxx help` / `-h` / `--help` 等价） */
const SUBCOMMAND_HELP_ALIASES = new Set(['help', '-h', '--help']);

/** 取输入行的第二个 token（子命令位），小写归一 */
export function subcommandOf(input: string): string {
  return (input.trim().split(/\s+/)[1] ?? '').toLowerCase();
}

/**
 * 渲染某命令的子命令帮助（纯函数，便于单测，D1/D5）。
 * 返回逐行数组（含颜色标记），由调用方写入输出通道。
 * 不含 `help` 自身（帮助词无需自我说明）。
 */
export function buildSubcommandHelp(handler: CommandHandler): string[] {
  const lines: string[] = [];
  lines.push(
    `${COLORS.bold}${handler.name}${COLORS.reset} ${COLORS.gray}— ${handler.description}${COLORS.reset}`,
  );
  const subs = (handler.subcommands ?? []).filter((s) => !SUBCOMMAND_HELP_ALIASES.has(s.toLowerCase()));
  if (subs.length === 0) {
    lines.push(`  ${COLORS.gray}（该命令无子命令）${COLORS.reset}`);
  } else {
    const width = Math.max(...subs.map((s) => s.length)) + 2;
    for (const s of subs) {
      const pad = ' '.repeat(Math.max(0, width - s.length));
      const desc = handler.subcommandHelp?.[s] ?? '';
      lines.push(
        `  ${COLORS.bold}${s}${COLORS.reset}${pad}${COLORS.gray}${desc}${COLORS.reset}`,
      );
    }
  }
  lines.push(
    `  ${COLORS.gray}提示：输入 ${handler.name} <子命令> 执行；任一命令加 help 查看其子命令用法${COLORS.reset}`,
  );
  return lines;
}

/** 命令注册器：注册与分发 */
export class CommandRegistry {
  private handlers: CommandHandler[] = [];

  register(handler: CommandHandler): void {
    this.handlers.push(handler);
  }

  /**
   * 尝试分发命令，返回是否匹配到命令。
   * 统一拦截子命令级帮助（`/xxx help` / `-h` / `--help`，D2/D4）：
   * 在命令层之外渲染，各命令无需各自实现；其余输入交给命令自身 execute。
   */
  async dispatch(input: string, ctx: CommandContext): Promise<boolean> {
    for (const h of this.handlers) {
      if (h.match(input)) {
        if (SUBCOMMAND_HELP_ALIASES.has(subcommandOf(input))) {
          ctx.out.blank();
          for (const line of buildSubcommandHelp(h)) ctx.out.log(line);
          ctx.out.blank();
          return true;
        }
        await h.execute(input, ctx);
        return true;
      }
    }
    return false;
  }

  /** 列出已注册命令 */
  list(): CommandHandler[] {
    return [...this.handlers];
  }

  /** 全部已注册命令名（含前导 /），用于 Tab 补全候选 */
  listNames(): string[] {
    return this.handlers.map((h) => h.name);
  }

  /** 按前缀过滤一级命令候选 */
  completeCommands(prefix: string): string[] {
    return this.listNames().filter((n) => n.startsWith(prefix));
  }
}

/** 未走注册器的内联斜杠命令（见 index.ts 的 rl.on('line') 分支），参与一级补全 */
export const BUILTIN_SLASH_COMMANDS = ['/help', '/reset', '/clear', '/status'];

/** 未走注册器的单词命令（非斜杠，见 index.ts 的 rl.on('line') 分支），参与单词补全（P2） */
export const BUILTIN_WORD_COMMANDS = ['help', 'exit', 'quit', 'q'];

/**
 * 动态参数候选提供器（P2）：按「命令 + 子命令 + 已输入前缀」返回候选值（不含命令名）。
 * 例如 `/session load <id>` 返回真实会话 id 列表；可异步（如读取会话目录）。
 */
export interface ArgCompletionProvider {
  completeArgs: (
    command: string,
    subcommand: string,
    prefix: string,
  ) => Promise<string[]> | string[];
}

/**
 * 计算输入行的 Tab 补全候选（纯函数，便于单测，不依赖 TTY）。
 *
 * 仅覆盖**静态候选**（斜杠命令的一级/二级）。单词命令与动态参数补全见 `completeCommandLineAsync`。
 *
 * 返回语义与 readline 的 completer 一致：`[候选列表, completeOn]`。
 * 候选项为「整行替换串」，`completeOn` 恒为原始 line，从而使 readline 直接整体替换当前行：
 * - 一级：`/con` → `['/config']`
 * - 二级：`/config l` → `['/config list']`
 * - 非 `/` 开头（普通提问）或更深层：返回空候选，readline 不做任何改动。
 */
export function completeCommandLine(
  line: string,
  registry: CommandRegistry,
  builtinSlashCommands: string[] = BUILTIN_SLASH_COMMANDS,
): [string[], string] {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('/')) return [[], line];

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  // 末尾是否已有空白：如 "/config " 表示用户已进入下一段输入阶段
  const endsWithSpace = /\s$/.test(trimmed);

  // 一级：补命令名（注册命令 ∪ 内联命令）
  if (tokens.length <= 1 && !endsWithSpace) {
    const names = [...new Set([...registry.listNames(), ...builtinSlashCommands])];
    return [names.filter((n) => n.startsWith(trimmed)), line];
  }

  // 二级：补子命令。「/config l」补第二段；「/config 」开始第二段。
  // 「/config list 」（两段且末尾有空格）表示已进入参数阶段，交由三级处理，此处不补。
  if ((tokens.length === 2 && !endsWithSpace) || (tokens.length === 1 && endsWithSpace)) {
    const handler = registry.list().find((h) => h.name === tokens[0]);
    const subs = handler?.subcommands ?? [];
    const prefix = tokens[1] ?? '';
    return [subs.filter((s) => s.startsWith(prefix)).map((s) => `${tokens[0]} ${s}`), line];
  }

  return [[], line];
}

/**
 * 完整补全（异步，P2）：在静态补全（`completeCommandLine`）基础上，追加
 * - 单词命令补全（`hel` → `help`，仅整行无空格，避免干扰自然语言提问）；
 * - 动态参数补全（`/session load <id>`、`/tools enable <name>` 等，依赖 provider）。
 *
 * 与 readline 的异步 completer 协作用于 `completer(line, cb)`。
 */
export async function completeCommandLineAsync(
  line: string,
  registry: CommandRegistry,
  provider?: ArgCompletionProvider,
  builtinSlashCommands: string[] = BUILTIN_SLASH_COMMANDS,
  builtinWordCommands: string[] = BUILTIN_WORD_COMMANDS,
): Promise<[string[], string]> {
  const trimmed = line.trimStart();

  // 非斜杠：仅当整行无空白时按单词命令补全（"help"/"exit"/"quit"/"q"），其余保持零副作用
  if (!trimmed.startsWith('/')) {
    if (trimmed.length > 0 && !/\s/.test(trimmed)) {
      return [builtinWordCommands.filter((c) => c.startsWith(trimmed)), line];
    }
    return [[], line];
  }

  // 一级 / 二级：复用同步纯函数，有结果直接返回
  const staticResult = completeCommandLine(line, registry, builtinSlashCommands);
  if (staticResult[0].length > 0 || !provider) return staticResult;

  // 三级：动态参数补全。两段且末尾有空格 → 开始第一段参数；三段且无末尾空格 → 补第一段参数
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const endsWithSpace = /\s$/.test(trimmed);
  if (tokens.length === 2 && endsWithSpace) {
    const [cmd, sub] = tokens;
    const vals = await provider.completeArgs(cmd, sub, '');
    return [vals.map((v) => `${cmd} ${sub} ${v}`), line];
  }
  if (tokens.length === 3 && !endsWithSpace) {
    const [cmd, sub, prefix] = tokens;
    const vals = await provider.completeArgs(cmd, sub, prefix);
    return [vals.map((v) => `${cmd} ${sub} ${v}`), line];
  }

  return [[], line];
}
