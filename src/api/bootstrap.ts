// HTTP API 模式（--serve）的组装入口（真实依赖）：
// 建独立 SessionStore（与 CLI 共用同一存储池，但不注入共享 agent）、初始化记忆、起服务、
// 打印服务信息、注册 SIGINT 关停。共享前置（引导/配置/工具/MCP/Skill）由 src/runtime/init.ts 完成。

import { createRequire } from 'node:module';
import { createApiServer, type ApiServer } from './server.js';
import { reconcileInterruptedOnBoot } from './run-journal.js';
import { WorkspaceRegistry } from './workspace-runtime.js';

export async function startApiServer(): Promise<ApiServer> {
  const { configLoader } = await import('../config/index.js');
  const { mcpManager } = await import('../config/mcp-manager.js');
  const { defaultUploadsRoot } = await import('../upload/manager.js');
  const { initAgentMemory } = await import('../runtime/init.js');

  const { config: cfg } = configLoader.load();

  // 工作空间运行时注册表（Task-20261021-010-01）：本阶段只装启动目录一个 runtime，
  // store / configLoader / configWriter / sessions / pool / memory-kit 全部自该 runtime 解构，
  // 对外行为与改造前一致（L1：HandlerContext 字段不变）。
  // 启动目录即初始空间（应用启动参数，非"当前空间"全局态）：process.cwd() 保留语义。
  const registry = new WorkspaceRegistry();
  const rt = await registry.get(process.cwd());
  const store = rt.store;

  // 启动扫描（Task-20261021-002-06）：上个进程遗留的 running journal 标记为 interrupted。
  // fire-and-forget：不阻塞启动；bootId 不匹配即判中断（pid 复用不可靠，见 run-journal.ts D1）
  void reconcileInterruptedOnBoot(store).then((n) => {
    if (n > 0) console.log(`[api] 启动扫描：${n} 个上次运行被标记为 interrupted`);
  });

  // 记忆初始化（serve 时序：起服务之前；initAgentMemory 走 agent.initMemory 自建路径，
  // 仅用于启动期自检与旧目录迁移——池内实例的运行时记忆由 initAgent 钩子注入共享 kit）
  // Task-20261021-010-03：显式传 runtime 根，不再依赖进程 cwd。
  await initAgentMemory(rt.root);

  // Agent 实例池（Task-20261021-002-05）：替代单例 agent，同工作空间多会话并发。
  // D1：容量默认 4（含 busy）；D2：记忆按 workspaceId 共享 kit，禁止每实例自建；
  // D5：attachMemory 注入共享 kit；容量 1 等价回退旧串行语义（经环境变量可调）。
  // Task-20261021-010-01：池由 runtime 持有（每空间一池），容量读 LOOP_AGENT_POOL_CAPACITY。

  // 读取 package.json 版本（/health 返回）
  let version = '';
  try {
    const require = createRequire(import.meta.url);
    version = (require('../../package.json') as { version?: string }).version ?? '';
  } catch {
    // 版本读取失败不影响服务
  }

  const server = createApiServer({
    // D4：每 run 从池租用独立 agent 实例（历史经 options.messages 显式传入，不依赖实例状态）
    // D3：run 全程处于该空间 ALS 上下文（runtime.runAgent 内部已包裹）。
    // 启动空间的 run 走注入的 rt.runAgent；其他空间由 handler 按会话归属路由到各自 runtime。
    runAgent: (sessionId, input, options) => rt.runAgent(sessionId, input, options),
    sessionStore: store,
    // 会话缓存/互斥层由 runtime 持有，server 不再自建（避免两份缓存分叉）
    sessions: rt.sessions,
    getConfig: () => configLoader.load().config,
    version,
    log: (msg) => console.log(msg),
    // D8：命令资源化运行时依赖（真实单例组装；workspace 层一律指向当前 runtime 根）
    runtime: {
      configLoader: rt.configLoader,
      configWriter: rt.configWriter,
      mcpManager,
      // 技能加载器也按 runtime 持有（D14：实例级 Map 隔离，避免两空间 scan 互相覆盖）
      skillLoader: rt.skillLoader,
      uploadsRoot: defaultUploadsRoot(),
      createMemoryKit: () => rt.getMemoryKit(),
    },
    // 工作空间运行时注册表（Task-20261021-010-01）：本任务仅装载启动目录，后续任务据此多空间并存
    registry,
  });

  const { port } = await server.start();
  const api = cfg.api;
  console.log('');
  console.log(`\x1b[1m\x1b[36mHTTP API 服务已启动\x1b[0m`);
  console.log(`  地址:    http://${api.host}:${port}`);
  console.log(`  鉴权:    ${api.token ? 'Bearer Token' : '仅本机（未配置 api.token）'}`);
  console.log(`  端点:    /health · /status · /sessions · /uploads · /config · /tools · /models · /mcp · /skills · /memory`);
  console.log(`  提示:    Ctrl+C 退出；配置变更需重启生效`);
  console.log('');

  // serve 常驻：Ctrl+C 关停服务并断开 MCP，随后退出
  process.on('SIGINT', async () => {
    await server.close().catch(() => {});
    await mcpManager.disconnectAll().catch(() => {});
    process.exit(0);
  });

  return server;
}
