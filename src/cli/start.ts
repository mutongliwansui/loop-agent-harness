// CLI 启动编排（交互式 REPL 模式）。
//
// 与 src/runtime/init.ts（共享前置）配合：入口 index.ts 完成共享初始化后调用本模块，
// 由本模块负责 CLI 专属流程——会话恢复与 SessionStore 注入 → 记忆初始化 → 横幅/历史渲染
// → 命令注册 → readline/REPL 主循环 → 退出处理（Dreaming）。
import readline from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agent } from '../agent/react-agent.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import { registry, mcpManager } from '../tools/index.js';
import { configLoader, configWriter } from '../config/index.js';
import { skillLoader } from '../skill/index.js';
import { SessionStore, keychain } from '../session/index.js';
import { COLORS as C } from '../ui/colors.js';
import { Spinner } from '../ui/spinner.js';
import { ConsoleOutputChannel } from '../ui/output-channel.js';
import {
  printBanner as renderBanner,
  printStatus as renderStatus,
  renderMessages as renderHistory,
} from '../ui/renderer.js';
import {
  CommandRegistry,
  completeCommandLineAsync,
  type ArgCompletionProvider,
  type CommandContext,
} from '../commands/registry.js';
import { configCommand, flattenConfigKeys } from '../commands/config-command.js';
import { mcpCommand } from '../commands/mcp-command.js';
import { toolsCommand, BUILTIN_TOOL_NAMES } from '../commands/tools-command.js';
import { skillCommand } from '../commands/skill-command.js';
import { sessionCommand } from '../commands/session-command.js';
import { memoryCommand } from '../commands/memory-command.js';
import { visionCommand } from '../commands/vision-command.js';
import { modelCommand } from '../commands/model-command.js';
import { uploadCommand } from '../commands/upload-command.js';
import { setupCommand } from '../commands/setup-command.js';
import { doctorCommand } from '../commands/doctor-command.js';
import { initAgentMemory, type RuntimeContext } from '../runtime/init.js';
import { AgentAbortedError, type ChatMessage } from '../types.js';
import { sealPendingToolCalls } from '../agent/abort-utils.js';
import { decideSigint, resolveExitArm, EXIT_WINDOW_MS } from './interrupt.js';

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

/**
 * 启动 CLI REPL（常驻，直至用户退出）。
 * 前置：入口已通过 initRuntime 完成引导/配置/工具/MCP/Skill 初始化。
 */
export async function startCli({ config: cfg }: RuntimeContext): Promise<void> {
  // 1. 初始化会话系统
  let sessionStore: SessionStore | null = null;
  let restoredMessages: ChatMessage[] | null = null;
  const sessionEnabled = cfg.session.autoSave || cfg.session.autoRestore;
  try {
    if (sessionEnabled) {
      sessionStore = new SessionStore(
        process.cwd(),
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
          try {
            const data = await sessionStore.loadSession(latest.id);

            // 构建 system prompt
            const skills = cfg.skill.enabled ? skillLoader.scan(process.cwd()) : [];
            const systemPrompt = cfg.agent.systemPrompt ?? buildSystemPrompt(skills);

            // 使用 restoreSession 方法（支持分层存储）
            agent.restoreSession(data, systemPrompt);

            // 展示层：取全量历史中 is_show!==false 的消息（system 与压缩总结消息不展示）
            restoredMessages = SessionStore.getAllAvailableMessages(data).filter(
              (m) => m.role !== 'system' && m.is_show !== false,
            );
          } catch (e) {
            // 最近会话数据缺失/损坏：跳过恢复继续启动，不整体放弃会话系统
            console.log(
              `${C.yellow}最近会话恢复失败（已跳过）: ${e instanceof Error ? e.message : String(e)}${C.reset}`,
            );
          }
        }
      }

      // 注入 SessionStore 到 Agent
      agent.setSessionStore(sessionStore);
    }
  } catch (e) {
    console.error(`${C.yellow}会话系统初始化失败（继续启动）: ${e instanceof Error ? e.message : String(e)}${C.reset}\n`);
    sessionStore = null;
  }

  // 5. 初始化记忆系统（CLI 时序：会话恢复之后）
  await initAgentMemory();

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
  commandRegistry.register(modelCommand);
  commandRegistry.register(uploadCommand);
  commandRegistry.register(setupCommand);
  commandRegistry.register(doctorCommand);

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
        if (command === '/skill' && (subcommand === 'show' || subcommand === 'remove')) {
          return skillLoader.list().map((s) => s.name).filter((n) => n.startsWith(prefix));
        }
        if (
          command === '/mcp' &&
          (subcommand === 'test' || subcommand === 'remove' || subcommand === 'view')
        ) {
          const { config: c } = configLoader.load();
          return Object.keys(c.tools.mcpServers).filter((n) => n.startsWith(prefix));
        }
        if (
          command === '/config' &&
          (subcommand === 'get' || subcommand === 'set' || subcommand === 'delete')
        ) {
          const { config: c } = configLoader.load();
          return flattenConfigKeys(c).filter((k) => k.startsWith(prefix));
        }
        if (
          command === '/model' &&
          (subcommand === 'use' || subcommand === 'remove' || subcommand === 'test')
        ) {
          const { config: c } = configLoader.load();
          return Object.keys(c.models.profiles).filter((n) => n.startsWith(prefix));
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
  /**
   * 是否处于 y/N 确认中（bugfix：替代临时 readline 方案）。
   * 历史问题：命令内新建临时 readline 与主 REPL 共享 process.stdin，其 close() 会 pause
   * 共享流导致主 REPL 永久失聪、TTY 下进程直接退出；且答案行被主循环重复消费。
   * 现统一用主 rl.question 实现确认，确认期间主 'line' 处理器直接忽略输入。
   */
  let confirming = false;
  const askConfirm = (question: string): Promise<boolean> =>
    new Promise((resolve) => {
      confirming = true;
      rl.question(question, (answer) => {
        // 答案行与 'line' 事件的派发顺序随 Node 版本可能不同，延迟一拍复位，
        // 确保无论谁先谁后，答案行都不会落入主循环被当作新输入
        setImmediate(() => {
          confirming = false;
        });
        resolve(answer.trim().toLowerCase() === 'y');
      });
    });

  /**
   * 取消进行中的 y/N 确认（Task-20261029-001 D6）：Ctrl+C 时等价于回答 n。
   * 走 rl.write('n\n') 而不是自己 resolve——question 期间 readline 会把该行交给
   * question 回调（不 emit 'line'），监听自然解除，不留悬挂回调。
   */
  const cancelPendingConfirm = (): void => {
    rl.write('n\n');
  };

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
    askConfirm,
  };

  /** 是否有正在执行的 Agent 任务 */
  let running = false;
  /** readline 是否已关闭 */
  let rlClosed = false;
  /**
   * 本轮提问的取消句柄（Task-20261029-001）：仅普通提问设置，斜杠命令为 null
   * ——命令没有取消语义，Ctrl+C 在命令执行期只提示稍候。
   */
  let currentRun: AbortController | null = null;
  /** 已发出 abort、等待 run 返回（收尾中）：此阶段的 Ctrl+C 一律忽略，绝不退出 */
  let aborting = false;
  /** 空闲态退出确认窗口的开启时间戳（0 表示窗口未开启） */
  let exitArmedAt = 0;

  // loading 指示器：受 agent.loading 开关控制，且非 TTY（管道/重定向/CI）自动禁用
  // 显式传入 enabled 会覆盖 Spinner 内部 isTTY 默认值，故此处显式与 isTTY 相与
  const spinner = new Spinner({
    enabled: cfg.agent.loading && process.stdout.isTTY === true,
  });

  const safePrompt = (): void => {
    if (!rlClosed) rl.prompt();
  };

  /**
   * 中断收尾（Task-20261029-001 D4-B / D5）：封口 → 落盘 → 回写内存基线 → 打印摘要。
   *
   * 与 API 侧 `/stop` 收尾同一套语义（handlers/messages.ts:231-246）：
   * 1. sealPendingToolCalls 给未响应的 tool_call 补合成 tool 消息——不封口就落盘，
   *    下一轮会因"孤立 tool_calls"被 OpenAI 协议判定 400；
   * 2. 有会话则 updateSession，首轮则 createSession，用 store 归一化结果作基线；
   * 3. agent.adoptHistory 把同一份内容回写内存，避免内存与磁盘分叉；
   * 4. 落盘失败只提示灰字 warning，不阻塞回到提示符。
   */
  const handleAborted = async (originalInput: string, err: AgentAbortedError): Promise<void> => {
    const partial = err.partial;
    spinner.stop();
    // 流式中断时 Thought 未换行，补一个换行避免中断提示与半截输出粘在同一行
    console.log('');

    const sealed = sealPendingToolCalls(partial.messages);
    let stored = sealed;
    if (sessionStore && cfg.session.autoSave) {
      try {
        if (agent.currentSessionId) {
          stored = await sessionStore.updateSession(agent.currentSessionId, sealed, originalInput, {
            transcript: partial.transcript,
          });
        } else {
          // 本轮才建会话：同样落盘，会话标题用本轮原始输入
          const meta = await sessionStore.createSession(originalInput, sealed, {
            transcript: partial.transcript,
          });
          agent.setCurrentSessionId(meta.id);
          stored = (await sessionStore.loadSession(meta.id)).messages;
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.log(`${C.gray}（会话保存失败，已生成内容仅存内存：${reason}）${C.reset}`);
      }
    }
    // 内存基线与磁盘对齐：否则下一轮 run 仍从中断前的旧基线出发，
    // 用户已看到的半截回答与合成 tool 消息都不会被模型看到
    agent.adoptHistory(stored);

    console.log(
      `${C.gray}⏹ 已中断（已完成 ${partial.iterations} 轮迭代 / ${partial.steps.length} 步工具）；已生成内容已保留，可继续追问${C.reset}\n`,
    );
  };

  /**
   * 执行退出链路（Ctrl+C 空闲态确认退出、exit 命令共用）：
   * 断开 MCP → 关闭 readline（'close' 处理器负责 Dreaming 与 process.exit）。
   */
  const shutdown = async (): Promise<void> => {
    await mcpManager.disconnectAll().catch(() => {});
    rl.close();
  };

  // 12. REPL 主循环
  safePrompt();

  rl.on('line', async (raw: string) => {
    // y/N 确认期间：答案行由 rl.question 回调处理，主循环忽略
    if (confirming) return;

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
      await shutdown();
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
        // 未匹配到命令，执行 Agent。
        // Task-20261029-001：为本次提问挂 AbortController，Ctrl+C 只中断本轮而不是退出进程。
        const controller = new AbortController();
        currentRun = controller;
        try {
          const result = await agent.run(input, {
            verbose: cfg.agent.verbose,
            spinner,
            signal: controller.signal,
          });
          spinner.stop();
          console.log(
            `\n${C.gray}(完成：${result.iterations} 轮迭代 / ${result.steps.length} 步工具 / ${result.messages.length} 条消息历史)${C.reset}\n`,
          );
        } catch (e) {
          // 取消不是失败：走中断收尾（保留部分输出），不打印 [Error]
          if ((e as { aborted?: boolean }).aborted === true && e instanceof AgentAbortedError) {
            await handleAborted(input, e);
          } else {
            throw e;
          }
        } finally {
          currentRun = null;
          aborting = false;
        }
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

  // ===== Ctrl+C 分派（Task-20261029-001）=====
  // 两态语义：回答中 = 只中断本次回答；空闲 = 连按两次退出。
  // 分派逻辑在 interrupt.ts 的纯函数里（可单测），这里只负责执行副作用。
  rl.on('SIGINT', async () => {
    const action = decideSigint({
      running,
      aborting,
      confirming,
      exiting: rlClosed,
      abortable: currentRun !== null,
      exitArmed: resolveExitArm(exitArmedAt, Date.now()),
    });

    switch (action) {
      case 'force-exit': {
        // rl 已关闭＝正在跑 Dreaming：不再有正常退出路径，立即强退
        // （与 api/bootstrap.ts 的二次信号强退语义对齐）
        console.log(`\n${C.gray}已跳过记忆整理，立即退出${C.reset}`);
        process.exit(0);
        return;
      }
      case 'cancel-confirm': {
        // 确认中：等价回答 n，不中断任务、不退出进程
        console.log(`${C.gray}（已取消确认）${C.reset}`);
        cancelPendingConfirm();
        return;
      }
      case 'ignore-busy': {
        spinner.stop();
        console.log(
          aborting
            ? `\n${C.yellow}⚠️  正在停止本次回答，请稍候…${C.reset}`
            : `\n${C.yellow}⚠️  当前命令执行中，暂不支持中断，请稍候…${C.reset}`,
        );
        if (!confirming) safePrompt();
        return;
      }
      case 'abort-run': {
        // 只中断本次回答：abort 之后由 agent.run 抛 AgentAbortedError，
        // 收尾（封口/落盘/提示/回到提示符）由 handleAborted + finally 负责
        exitArmedAt = 0;
        aborting = true;
        currentRun?.abort();
        spinner.stop();
        console.log(`\n${C.gray}⏹ 正在停止本次回答…${C.reset}`);
        return;
      }
      case 'arm-exit': {
        // 空闲第一次：开 3s 窗口并提示，防止"中断时连按两下"把进程送走
        exitArmedAt = Date.now();
        console.log(`\n${C.yellow}再按一次 Ctrl+C 退出（${EXIT_WINDOW_MS / 1000}s 内有效）${C.reset}`);
        safePrompt();
        return;
      }
      case 'exit': {
        exitArmedAt = 0;
        console.log('');
        await shutdown();
        return;
      }
    }
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
