// ReAct Agent CLI 入口：交互式 REPL
// 运行：npm run dev 或 npm start
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agent } from './agent/react-agent.js';
import { buildSystemPrompt } from './agent/prompt.js';
import { registerBuiltinTools, registry, mcpManager } from './tools/index.js';
import { configLoader, configWriter } from './config/index.js';
import { skillLoader } from './skill/index.js';
import { SessionStore, keychain } from './session/index.js';
import { COLORS as C } from './ui/colors.js';
import { Spinner } from './ui/spinner.js';
import { ConsoleOutputChannel } from './ui/output-channel.js';
import {
  printBanner as renderBanner,
  printStatus as renderStatus,
  renderMessages as renderHistory,
} from './ui/renderer.js';
import {
  CommandRegistry,
  completeCommandLineAsync,
  type ArgCompletionProvider,
  type CommandContext,
} from './commands/registry.js';
import { configCommand } from './commands/config-command.js';
import { mcpCommand } from './commands/mcp-command.js';
import { toolsCommand, BUILTIN_TOOL_NAMES } from './commands/tools-command.js';
import { skillCommand } from './commands/skill-command.js';
import { sessionCommand } from './commands/session-command.js';
import { memoryCommand } from './commands/memory-command.js';
import { visionCommand } from './commands/vision-command.js';
import type { ChatMessage } from './types.js';

// Windows 终端默认代码页为 GBK(936)，切换到 UTF-8(65001) 避免中文乱码
if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch {
    // 忽略 chcp 失败（非 Windows 终端环境）
  }
}

/** 打印启动横幅与使用说明 */
function printBanner(): void {
  const { config: cfg, sources } = configLoader.load();
  const builtTools = registry.list().filter((t) => !t.name.includes('__'));
  const mcpCount = registry.list().length - builtTools.length;
  const skills = cfg.skill.enabled ? skillLoader.list() : [];

  renderBanner({
    config: cfg,
    sources,
    builtinToolNames: builtTools.map((t) => t.name),
    mcpToolCount: mcpCount,
    mcpServers: registry.listMCPServers(),
    skills,
  });

  if (cfg.agent.debug) {
    console.log(`${C.yellow}⚠ 调试模式已开启，日志输出到: ${join(homedir(), '.loop-agent', 'logs')}${C.reset}`);
    console.log('');
  }
}

/** 打印会话状态 */
function printStatus(): void {
  const msgs = agent.getSessionMessages();
  const allTools = registry.list();
  const builtin = allTools.filter((t) => !t.name.includes('__'));
  const mcp = allTools.filter((t) => t.name.includes('__'));
  const mcpServers = registry.listMCPServers();
  const { config: cfg } = configLoader.load();
  const skills = cfg.skill.enabled ? skillLoader.list() : [];
  const context = agent.getContextUsage();

  renderStatus({
    messageCount: msgs.length,
    contextTokens: context.contextTokens,
    maxTokens: context.maxTokens,
    threshold: context.threshold,
    builtinToolNames: builtin.map((t) => t.name),
    mcpServers,
    mcpToolCount: mcp.length,
    skills,
  });
}

async function main() {
  // 0. 加载合并配置
  const { config: cfg } = configLoader.load();

  // 1. 初始化会话系统
  let sessionStore: SessionStore | null = null;
  let restoredMessages: ChatMessage[] | null = null;
  const sessionEnabled = cfg.session.autoSave || cfg.session.autoRestore;
  try {
    if (sessionEnabled) {
      sessionStore = new SessionStore(
        process.cwd(),
        3,
        cfg.session.encryptionEnabled,
      );
      await sessionStore.init();

      if (cfg.session.encryptionEnabled) {
        const isNewKey = !keychain.exists();
        if (isNewKey) {
          console.log(`${C.green}✓ 加密密钥已自动生成，会话数据将加密存储${C.reset}`);
        }
      } else {
        console.log(`${C.gray}会话系统已启用（明文存储，未加密）${C.reset}`);
      }

      // 自动恢复最近会话（仅加载数据，渲染延后到 Banner 之后）
      if (cfg.session.autoRestore) {
        const latest = await sessionStore.getLatestSession();
        if (latest) {
          const data = await sessionStore.loadSession(latest.id);

          // 构建 system prompt
          const skills = cfg.skill.enabled ? skillLoader.scan(process.cwd()) : [];
          const systemPrompt = cfg.agent.systemPrompt ?? buildSystemPrompt(skills);

          // 使用 restoreSession 方法（支持分层存储）
          agent.restoreSession(data, systemPrompt);

          // 获取恢复消息用于后续渲染
          restoredMessages = SessionStore.getRestoreMessages(data);
        }
      }

      // 注入 SessionStore 到 Agent
      agent.setSessionStore(sessionStore);
    }
  } catch (e) {
    console.error(`${C.yellow}会话系统初始化失败（继续启动）: ${e instanceof Error ? e.message : String(e)}${C.reset}\n`);
    sessionStore = null;
  }

  // 2. 注册内置工具（根据配置的 enabled/disabled 过滤；vision 配置决定视觉工具是否注册）
  registerBuiltinTools(cfg.tools, cfg.vision);

  // 3. 加载 MCP 配置
  try {
    const mcp = await mcpManager.loadFromConfig();
    if (mcp.failures.length) {
      console.log(`${C.yellow}MCP 加载警告:${C.reset}`);
      for (const f of mcp.failures) console.log(`  ${C.red}✗${C.reset} ${f}`);
    }
    if (mcp.successes.length) {
      console.log(`${C.green}MCP 加载成功:${C.reset}`);
      for (const s of mcp.successes) console.log(`  ✓ ${s}`);
    }
  } catch (e) {
    console.error(`${C.yellow}MCP 加载异常 (继续启动): ${e instanceof Error ? e.message : String(e)}${C.reset}`);
  }

  // 4. 扫描 Skill
  if (cfg.skill.enabled && cfg.skill.autoLoad) {
    try {
      const skills = skillLoader.scan(process.cwd());
      if (skills.length > 0) {
        console.log(`${C.green}Skill 加载成功:${C.reset} ${skills.length} 个`);
        for (const s of skills) console.log(`  ✓ ${s.name} (${s.scope === 'workspace' ? '工作空间' : '全局'})`);
      }
    } catch (e) {
      console.error(`${C.yellow}Skill 扫描异常 (继续启动): ${e instanceof Error ? e.message : String(e)}${C.reset}`);
    }
  }

  // 5. 初始化记忆系统
  try {
    await agent.initMemory(process.cwd());
    if (agent.memoryEnabled) {
      console.log(`${C.green}✓ 记忆系统已启用:${C.reset} L1(Working) + L2(Episodic) + L3(Curated)`);
    }
  } catch (e) {
    console.error(`${C.yellow}记忆系统初始化失败（继续启动）: ${e instanceof Error ? e.message : String(e)}${C.reset}`);
  }

  // 6. 启动横幅
  printBanner();

  // 7. 渲染恢复的会话历史（在 Banner 之后显示）
  if (restoredMessages && restoredMessages.length > 0) {
    renderHistory(restoredMessages as Parameters<typeof renderHistory>[0]);
  }

  // 8. 构建命令注册器（须先于 readline：Tab 补全需要读取命令清单）
  const commandRegistry = new CommandRegistry();
  commandRegistry.register(configCommand);
  commandRegistry.register(mcpCommand);
  commandRegistry.register(toolsCommand);
  commandRegistry.register(skillCommand);
  commandRegistry.register(sessionCommand);
  commandRegistry.register(memoryCommand);
  commandRegistry.register(visionCommand);

  // 9. 动态参数候选提供器（P2）：为三级补全供给真实数据（会话 id / 工具名 / 技能名 / MCP server 名）
  const argProvider: ArgCompletionProvider = {
    async completeArgs(command, subcommand, prefix) {
      try {
        if (command === '/session' && (subcommand === 'load' || subcommand === 'delete')) {
          if (!sessionStore) return [];
          const sessions = await sessionStore.listSessions();
          return sessions.map((s) => s.id).filter((id) => id.startsWith(prefix));
        }
        if (command === '/tools' && (subcommand === 'enable' || subcommand === 'disable')) {
          return BUILTIN_TOOL_NAMES.filter((n) => n.startsWith(prefix));
        }
        if (command === '/skill' && subcommand === 'show') {
          return skillLoader.list().map((s) => s.name).filter((n) => n.startsWith(prefix));
        }
        if (command === '/mcp' && (subcommand === 'test' || subcommand === 'remove')) {
          const { config: c } = configLoader.load();
          return Object.keys(c.tools.mcpServers).filter((n) => n.startsWith(prefix));
        }
      } catch {
        return [];
      }
      return [];
    },
  };

  // 10. 创建 readline 接口（注册异步 completer：静态命令/子命令 + 单词命令 + 动态参数）
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.bold}${C.cyan}Agent>${C.reset} `,
    // 双参数形式被 readline 识别为异步 completer
    completer: (line: string, cb: (err: Error | null, result: [string[], string]) => void) => {
      completeCommandLineAsync(line, commandRegistry, argProvider)
        .then((res) => cb(null, res))
        .catch((e: unknown) => cb(e instanceof Error ? e : new Error(String(e)), [[], line]));
    },
  });

  // 11. 构建 CommandContext
  const ctx: CommandContext = {
    agent,
    configLoader,
    configWriter,
    mcpManager,
    registry,
    skillLoader,
    sessionStore,
    rl,
    out: new ConsoleOutputChannel(),
    colors: C,
  };

  /** 是否有正在执行的 Agent 任务 */
  let running = false;
  /** readline 是否已关闭 */
  let rlClosed = false;

  // loading 指示器：受 agent.loading 开关控制，且非 TTY（管道/重定向/CI）自动禁用
  // 显式传入 enabled 会覆盖 Spinner 内部 isTTY 默认值，故此处显式与 isTTY 相与
  const spinner = new Spinner({
    enabled: cfg.agent.loading && process.stdout.isTTY === true,
  });

  const safePrompt = (): void => {
    if (!rlClosed) rl.prompt();
  };

  // 12. REPL 主循环
  safePrompt();

  rl.on('line', async (raw: string) => {
    const input = raw.trim();

    if (!input) {
      safePrompt();
      return;
    }

    if (running) {
      spinner.stop();
      console.log(`${C.yellow}⚠️  Agent 正在处理上一个请求，请稍候...${C.reset}`);
      safePrompt();
      return;
    }

    const lower = input.toLowerCase();

    // 退出
    if (['exit', 'quit', '退出', 'q'].includes(lower)) {
      await mcpManager.disconnectAll().catch(() => {});
      rl.close();
      return;
    }

    // 帮助
    if (lower === '/help' || lower === 'help') {
      printBanner();
      safePrompt();
      return;
    }

    if (lower === '/reset' || lower === '/clear') {
      agent.resetSession();
      console.log(`${C.bold}${C.green}✓ 会话历史已清空，开始新对话${C.reset}\n`);
      safePrompt();
      return;
    }

    if (lower === '/status') {
      printStatus();
      safePrompt();
      return;
    }

    // 命令分发：通过 CommandRegistry
    running = true;
    try {
      // P1：非斜杠命令即普通提问，提前启动指示器，覆盖 dispatch / 配置载入 / skill 扫描 / toOpenAITools 等前置耗时
      if (!input.startsWith('/')) spinner.start('思考中…');
      const matched = await commandRegistry.dispatch(input, ctx);
      if (matched) {
        spinner.stop();
      } else {
        // 未匹配到命令，执行 Agent
        const result = await agent.run(input, { verbose: cfg.agent.verbose, spinner });
        spinner.stop();
        console.log(
          `\n${C.gray}(完成：${result.iterations} 轮迭代 / ${result.steps.length} 步工具 / ${result.messages.length} 条消息历史)${C.reset}\n`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      spinner.stop();
      console.error(`\n${C.bold}${C.red}[Error]${C.reset} ${C.red}${msg}${C.reset}\n`);
    } finally {
      running = false;
      safePrompt();
    }
  });

  rl.on('SIGINT', async () => {
    await mcpManager.disconnectAll().catch(() => {});
    console.log('');
    rl.close();
  });

  rl.on('close', async () => {
    rlClosed = true;
    // 会话结束：自动触发 Dreaming（等待完成后再退出）
    const { config: exitCfg } = configLoader.load();
    if (exitCfg.memory.enabled && exitCfg.memory.dreaming.enabled && exitCfg.memory.dreaming.onExit) {
      console.log(`${C.gray}正在整理记忆（Dreaming）…${C.reset}`);
      try {
        const result = await agent.runDreaming(undefined, (msg) => {
          console.log(`  ${C.gray}↳ ${msg}${C.reset}`);
        });
        if (result && result.promoted.length > 0) {
          console.log(`\n[Dreaming] 晋升 ${result.promoted.length} 条事实到 L3`);
        }
      } catch {
        // Dreaming 失败不影响退出
      }
    }
    console.log(`\n${C.bold}${C.yellow}再见！感谢使用 ReAct Agent 👋${C.reset}\n`);
    process.exit(0);
  });
}

main().catch(async (e) => {
  await mcpManager.disconnectAll().catch(() => {});
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`${C.bold}${C.red}[启动失败]${C.reset} ${msg}`);
  process.exit(1);
});
