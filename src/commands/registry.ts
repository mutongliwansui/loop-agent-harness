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
}

/** 命令注册器：注册与分发 */
export class CommandRegistry {
  private handlers: CommandHandler[] = [];

  register(handler: CommandHandler): void {
    this.handlers.push(handler);
  }

  /** 尝试分发命令，返回是否匹配到命令 */
  async dispatch(input: string, ctx: CommandContext): Promise<boolean> {
    for (const h of this.handlers) {
      if (h.match(input)) {
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
}
