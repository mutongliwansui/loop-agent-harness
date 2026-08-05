// ReAct Agent CLI 入口：交互式 REPL
// 运行：npm run dev 或 npm start
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { agent } from './agent/react-agent.js';
import { registerBuiltinTools, registry } from './tools/index.js';
import { config } from './config.js';

// Windows 终端默认代码页为 GBK(936)，切换到 UTF-8(65001) 避免中文乱码
if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch {
    // 忽略 chcp 失败（非 Windows 终端环境）
  }
}

/** ANSI 颜色码 */
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
} as const;

/** 打印启动横幅与使用说明 */
function printBanner(builtTools: string[]): void {
  const mcpCount = registry.list().filter((t) => t.name.includes('__')).length;

  console.log(`${C.bold}${C.yellow}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${C.reset}`);
  console.log(`${C.bold}${C.yellow}┃            ReAct Agent 交互式控制台                     ┃${C.reset}`);
  console.log(`${C.bold}${C.yellow}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${C.reset}`);
  console.log('');
  console.log(`${C.cyan}模型:${C.reset} ${C.bold}${config.modelName}${C.reset}`);
  console.log(`${C.cyan}BaseURL:${C.reset} ${config.openaiBaseUrl}`);
  console.log(`${C.cyan}最大迭代:${C.reset} ${config.maxIterations}`);
  console.log(`${C.cyan}内置工具:${C.reset} [${builtTools.map((n) => `${C.green}${n}${C.reset}`).join(', ')}]`);
  if (mcpCount > 0) {
    console.log(`${C.cyan}MCP 工具:${C.reset} ${mcpCount} 个（${C.magenta}{serverName}__toolName${C.reset}）`);
  }
  console.log('');
  console.log(`${C.gray}使用说明:${C.reset}`);
  console.log(`  ${C.bold}输入问题${C.reset}    → Agent 流式输出 Thought / Action / Observation / Final`);
  console.log(`  ${C.bold}/help${C.reset}         → 查看此帮助`);
  console.log(`  ${C.bold}/reset${C.reset}        → 清空多轮对话历史，重新开始新会话`);
  console.log(`  ${C.bold}/status${C.reset}       → 查看当前会话状态（消息数 / 工具数）`);
  console.log(`  ${C.bold}/tools${C.reset}        → 列出当前所有可用工具`);
  console.log(`  ${C.bold}exit/quit/退出${C.reset} → 退出程序（Ctrl+C 同样有效）`);
  console.log(`${C.gray}──────────────────────────────────────────────────────────${C.reset}`);
  console.log('');
}

/** 打印会话状态 */
function printStatus(): void {
  const msgs = agent.getSessionMessages();
  const allTools = registry.list();
  const builtin = allTools.filter((t) => !t.name.includes('__'));
  const mcp = allTools.filter((t) => t.name.includes('__'));
  console.log('');
  console.log(`  ${C.bold}消息历史:${C.reset} ${msgs.length} 条`);
  console.log(`  ${C.bold}内置工具:${C.reset} ${builtin.length} 个 (${builtin.map((t) => t.name).join(', ')})`);
  if (mcp.length > 0) {
    console.log(`  ${C.bold}MCP 工具:${C.reset} ${mcp.length} 个`);
  } else {
    console.log(`  ${C.bold}MCP 工具:${C.reset} 未加载（可配置 .mcp.json 后重启）`);
  }
  console.log('');
}

/** 列出所有工具 */
function printTools(): void {
  const allTools = registry.list();
  console.log('');
  console.log(`${C.bold}共 ${allTools.length} 个可用工具:${C.reset}`);
  for (const t of allTools) {
    const prefix = t.name.includes('__') ? `${C.magenta}MCP${C.reset}` : `${C.green}内置${C.reset}`;
    console.log(`  [${prefix}] ${C.bold}${t.name}${C.reset} — ${t.description}`);
  }
  console.log('');
}

async function main() {
  // 1. 注册内置工具（幂等，重复调用安全）
  const builtTools = registerBuiltinTools();

  // 2. 启动横幅
  printBanner(builtTools);

  // 3. 创建 readline 接口
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.bold}${C.cyan}Agent>${C.reset} `,
  });

  /** 是否有正在执行的 Agent 任务 */
  let running = false;

  // 4. REPL 主循环
  rl.prompt();

  rl.on('line', async (raw: string) => {
    const input = raw.trim();

    // 4.1 空输入直接继续
    if (!input) {
      rl.prompt();
      return;
    }

    // 4.2 Agent 运行期间忽略新输入（不 pause stdin，避免 Windows 上 resume 失败）
    if (running) {
      console.log(`${C.yellow}⚠️  Agent 正在处理上一个请求，请稍候...${C.reset}`);
      rl.prompt();
      return;
    }

    // 4.3 命令判断
    const lower = input.toLowerCase();

    // 退出
    if (['exit', 'quit', '退出', 'q'].includes(lower)) {
      rl.close();
      return;
    }

    // 帮助
    if (lower === '/help' || lower === 'help') {
      printBanner(builtTools);
      rl.prompt();
      return;
    }

    // 清空会话历史
    if (lower === '/reset' || lower === '/clear') {
      agent.resetSession();
      console.log(`${C.bold}${C.green}✓ 会话历史已清空，开始新对话${C.reset}\n`);
      rl.prompt();
      return;
    }

    // 会话状态
    if (lower === '/status') {
      printStatus();
      rl.prompt();
      return;
    }

    // 列出工具
    if (lower === '/tools') {
      printTools();
      rl.prompt();
      return;
    }

    // 4.4 执行 Agent
    running = true;
    try {
      const result = await agent.run(input, { verbose: true });
      console.log(
        `\n${C.gray}(完成：${result.iterations} 轮迭代 / ${result.steps.length} 步工具 / ${result.messages.length} 条消息历史)${C.reset}\n`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`\n${C.bold}${C.red}[Error]${C.reset} ${C.red}${msg}${C.reset}\n`);
    } finally {
      running = false;
      rl.prompt();
    }
  });

  // 5. Ctrl+C 优雅退出
  rl.on('SIGINT', () => {
    console.log('');
    rl.close();
  });

  // 6. close 事件
  rl.on('close', () => {
    console.log(`\n${C.bold}${C.yellow}再见！感谢使用 ReAct Agent 👋${C.reset}\n`);
    process.exit(0);
  });
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`${C.bold}${C.red}[启动失败]${C.reset} ${msg}`);
  process.exit(1);
});
