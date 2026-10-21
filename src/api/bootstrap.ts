// HTTP API 模式（--serve）的组装入口（真实依赖）：
// 建独立 SessionStore（与 CLI 共用同一存储池，但不注入共享 agent）、初始化记忆、起服务、
// 打印服务信息、注册 SIGINT 关停。共享前置（引导/配置/工具/MCP/Skill）由 src/runtime/init.ts 完成。

import { createRequire } from 'node:module';
import { createApiServer, type ApiServer } from './server.js';
import { reconcileInterruptedOnBoot } from './run-journal.js';

export async function startApiServer(): Promise<ApiServer> {
  const { configLoader } = await import('../config/index.js');
  const { configWriter } = await import('../config/writer.js');
  const { mcpManager } = await import('../config/mcp-manager.js');
  const { skillLoader } = await import('../skill/loader.js');
  const { defaultUploadsRoot } = await import('../upload/manager.js');
  const { getMemoryKit, resetMemoryKitCache } = await import('./memory-kit.js');
  const { AgentPool } = await import('../agent/agent-pool.js');
  const { SessionStore: Store } = await import('../session/index.js');
  const { initAgentMemory } = await import('../runtime/init.js');

  const { config: cfg } = configLoader.load();
  const store = new Store(process.cwd(), cfg.session.encryptionEnabled);
  await store.init();

  // 启动扫描（Task-20261021-002-06）：上个进程遗留的 running journal 标记为 interrupted。
  // fire-and-forget：不阻塞启动；bootId 不匹配即判中断（pid 复用不可靠，见 run-journal.ts D1）
  void reconcileInterruptedOnBoot(store).then((n) => {
    if (n > 0) console.log(`[api] 启动扫描：${n} 个上次运行被标记为 interrupted`);
  });

  // 记忆初始化（serve 时序：起服务之前；initAgentMemory 走 agent.initMemory 自建路径，
  // 仅用于启动期自检与旧目录迁移——池内实例的运行时记忆由 initAgent 钩子注入共享 kit）
  await initAgentMemory();

  // Agent 实例池（Task-20261021-002-05）：替代单例 agent，同工作空间多会话并发。
  // D1：容量默认 4（含 busy）；D2：记忆按 workspaceId 共享 kit，禁止每实例自建；
  // D5：attachMemory 注入共享 kit；容量 1 等价回退旧串行语义（经环境变量可调）。
  const capacity = Number.parseInt(process.env.LOOP_AGENT_POOL_CAPACITY ?? '', 10);
  const pool = new AgentPool(
    { capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : undefined },
    async (a) => a.attachMemory(await getMemoryKit(process.cwd()), process.cwd()),
  );

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
    runAgent: (sessionId, input, options) => pool.withAgent(sessionId, (a) => a.run(input, options)),
    sessionStore: store,
    getConfig: () => configLoader.load().config,
    version,
    log: (msg) => console.log(msg),
    // 切换工作空间：池内实例的记忆绑定旧 workspaceId，整体重建（D6）+ 清共享 kit 缓存
    reinitMemory: async () => {
      resetMemoryKitCache();
      pool.reset();
    },
    // D8：命令资源化运行时依赖（真实单例组装）
    runtime: {
      configLoader,
      configWriter,
      mcpManager,
      skillLoader,
      uploadsRoot: defaultUploadsRoot(),
      createMemoryKit: () => getMemoryKit(process.cwd()),
    },
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
