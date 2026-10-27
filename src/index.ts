// ReAct Agent 入口：解析启动参数并把进程交给对应模式。
// - 默认 / npm run dev / npm start：CLI 交互式 REPL（src/cli/start.ts）
// - --serve / npm run serve：HTTP API 服务常驻（src/api/bootstrap.ts）
//
// 本文件只做「分发」：共享前置（引导/配置/工具/MCP/Skill）由 src/runtime/init.ts 完成，
// 各模式的专属编排与关停分别由 cli / api 模块自持。
import { execSync } from 'node:child_process';
import { initRuntime } from './runtime/init.js';
import { startCli } from './cli/start.js';
import { startApiServer, cwdFallbackValue } from './api/bootstrap.js';
import { setCwdFallback } from './api/recent-workspace.js';
import { mcpManager } from './tools/index.js';
import { COLORS as C } from './ui/colors.js';

// Windows 终端默认代码页为 GBK(936)，切换到 UTF-8(65001) 避免中文乱码
if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch {
    // 忽略 chcp 失败（非 Windows 终端环境）
  }
}

async function main() {
  const serveMode = process.argv.includes('--serve');

  // A4 收口：cwd 兜底由白名单文件读出、入口转交（recent-workspace 自身零 process.cwd()）
  setCwdFallback(cwdFallbackValue());

  // 共享初始化：初次引导 → 配置 → 内置工具 → MCP → Skill
  const { config } = await initRuntime({ noSetup: process.argv.includes('--no-setup') });

  if (serveMode) {
    // HTTP API 模式：起服务常驻，不进 REPL（内部自持记忆初始化与 SIGINT 关停）
    await startApiServer();
    return;
  }

  // CLI REPL 模式
  await startCli({ config });
}

main().catch(async (e) => {
  await mcpManager.disconnectAll().catch(() => {});
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`${C.bold}${C.red}[启动失败]${C.reset} ${msg}`);
  process.exit(1);
});
