// HTTP API 模式（--serve）的组装入口（真实依赖）：
// 建独立 SessionStore（与 CLI 共用同一存储池，但不注入共享 agent）、初始化记忆、起服务、
// 打印服务信息、注册 SIGINT 关停。共享前置（引导/配置/工具/MCP/Skill）由 src/runtime/init.ts 完成。

import pkg from '../../package.json';
import { createApiServer, type ApiServer } from './server.js';
import { DreamScheduler } from './dream-scheduler.js';
import { reconcileInterruptedOnBoot } from './run-journal.js';
import { WorkspaceRegistry } from './workspace-runtime.js';
import { markWorkspaceUsed, resolveRecentRoot } from './recent-workspace.js';

export interface StartApiServerOptions {
  /** 会话/记忆/自愈扫描根目录覆盖（默认 ~/.loop-agent；单测注入临时目录） */
  userDir?: string;
}

/** 启动选项（需求 20261027-004：userDir 供单测隔离冷启动推导与全盘自愈） */
export async function startApiServer(opts?: StartApiServerOptions): Promise<ApiServer> {
  const bootT0 = Date.now();
  console.log('[startup] 组装 HTTP API 服务...');
  // 需求 20261112-008：配置与 skill 一律进程级单例（不再随空间构造）
  const { configLoader } = await import('../config/index.js');
  const { configWriter } = await import('../config/writer.js');
  const { skillLoader } = await import('../skill/index.js');
  const { mcpManager } = await import('../config/mcp-manager.js');
  const { McpMonitor, setActiveMcpMonitor } = await import('../config/mcp-monitor.js');
  const { defaultUploadsRoot } = await import('../upload/manager.js');
  const { initAgentMemory } = await import('../runtime/init.js');

  // MCP 后台监测器（2026-10-29）：启动不等待 MCP 连接，首轮在后台发起；
  // 之后定期 ping 探活、掉线指数退避重连、配置变更热更新（新增/删除/修改自动生效）。
  // 放在最前面是为了让连接与后续 runtime/服务组装并行。
  const mcpMonitor = new McpMonitor(mcpManager, configLoader, {
    log: (msg) => console.log(msg),
  });
  setActiveMcpMonitor(mcpMonitor);
  mcpMonitor.start();

  const { config: cfg } = configLoader.load();

  // 需求 20261113-001 D9：原「cwd 兜底注入」整条退场（注入函数与缺省空间同步读取函数一并删除，
  // resolveRecentRoot 无会话时回落 os.homedir()）。

  // 工作空间运行时注册表（Task-20261021-010-01）。
  // 需求 20261027-004：不再以 process.cwd() 为「启动空间」——缺省空间语义改为
  // 「最近使用空间」：冷启动扫 sessions/*/ 推导最近会话所在空间（canonical），无会话兜底 homedir。
  // 仍预装这 1 个 runtime（L1：HandlerContext 字段与既有单测零破坏），
  // 但身份从 cwd 换成 recentRoot；后续空间仍由 handler 按 ws 参数/会话归属懒装载。
  const registry = new WorkspaceRegistry({ userDir: opts?.userDir });

  const t1 = Date.now();
  const recentRoot = await resolveRecentRoot(opts?.userDir);
  markWorkspaceUsed(recentRoot);
  console.log(`  ├─ 最近使用空间解析 (+${Date.now() - t1}ms): ${recentRoot}`);

  const t2 = Date.now();
  const rt = await registry.get(recentRoot);
  const store = rt.store;
  console.log(`  ├─ 工作空间 runtime 装载 (+${Date.now() - t2}ms): ${rt.id}`);

  // 启动扫描（Task-20261021-002-06）：上个进程遗留的 running journal 标记为 interrupted。
  // fire-and-forget：不阻塞启动；bootId 不匹配即判中断（pid 复用不可靠，见 run-journal.ts D1）
  void reconcileInterruptedOnBoot(store).then((n) => {
    if (n > 0) console.log(`  ├─ 启动扫描：${n} 个上次运行被标记为 interrupted`);
  });

  // 记忆初始化（serve 时序：起服务之前；initAgentMemory 走 agent.initMemory 自建路径，
  // 仅用于启动期自检与旧目录迁移——池内实例的运行时记忆由 initAgent 钩子注入共享 kit）
  //
  // 需求 20261113-002 D3：改为「已有记忆才初始化」——全新空间启动不再凭空生成
  // memory/<wsId>/ 与 index.sqlite（原实现每次启动必落盘，与 D1 同类问题）。
  // 已有记忆的空间行为完全不变（自检、旧目录迁移照旧）；运行时记忆仍按需
  // （rt.getMemoryKit() 首次调用才建目录）。探测口径与 createMemoryKit 共享 memoryDirFor。
  const t3 = Date.now();
  const { existsSync } = await import('node:fs');
  const { memoryDirFor } = await import('./memory-kit.js');
  const hasMemory = existsSync(memoryDirFor(rt.root, {}, cfg.memory.episodic.dir));
  if (hasMemory) {
    await initAgentMemory(rt.root);
    console.log(`  ├─ 记忆系统初始化 (+${Date.now() - t3}ms)`);
  } else {
    console.log(`  ├─ 记忆系统跳过：本空间尚无记忆，按需创建 (+${Date.now() - t3}ms)`);
  }

  // Agent 实例池（Task-20261021-002-05）：替代单例 agent，同工作空间多会话并发。
  // D1：容量默认 4（含 busy）；D2：记忆按 workspaceId 共享 kit，禁止每实例自建；
  // D5：attachMemory 注入共享 kit；容量 1 等价回退旧串行语义（经环境变量可调）。
  // Task-20261021-010-01：池由 runtime 持有（每空间一池），容量读 LOOP_AGENT_POOL_CAPACITY。

  // 记忆晋升调度器（Task-20261026-002）：定时轮为主力，关停兜底补最后一轮。
  // getConfig 读进程级配置（节奏/预算/onExit/记忆开关；需求 20261112-008 起记忆配置也一律读全局）。
  // 需求 20261027-004 D4：全空间参与——定时轮/关停兜底磁盘枚举候选空间 + 预判 + 懒装载。
  const dreamScheduler = new DreamScheduler({
    registry,
    getConfig: () => configLoader.load().config,
    log: (msg) => console.log(msg),
    enumerateAllSpaces: true,
    userDir: opts?.userDir,
  });

  // 版本取自 package.json：tsup 打包时内联进产物（build:sea 的 SEA 单文件同样可用），
  // 不依赖运行时文件读取与 import.meta，避免 CJS 产物中版本恒为空
  const version = pkg.version;

  const t4 = Date.now();
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
    // D8：命令资源化运行时依赖（真实单例组装；需求 20261112-008：配置/skill 一律进程级单例）
    runtime: {
      configLoader,
      configWriter,
      mcpManager,
      skillLoader,
      uploadsRoot: defaultUploadsRoot(),
      createMemoryKit: () => rt.getMemoryKit(),
    },
    // 工作空间运行时注册表（Task-20261021-010-01）：本任务仅装载启动目录一个实例，行为与改造前一致；
    // 后续任务据此让多个空间并存。
    registry,
    // 记忆晋升调度器（Task-20261026-002 D11）：手动端点与定时/关停共用同一把进程内锁
    dreamScheduler,
  });
  console.log(`  ├─ API Server 组装 (+${Date.now() - t4}ms)`);

  const t5 = Date.now();
  const { port } = await server.start();
  console.log(`  ├─ HTTP 监听启动 (+${Date.now() - t5}ms)`);

  const api = cfg.api;
  console.log('');
  console.log(`\x1b[1m\x1b[36mHTTP API 服务已启动\x1b[0m (总耗时 ${Date.now() - bootT0}ms)`);
  console.log(`  地址:    http://${api.host}:${port}`);
  console.log(`  鉴权:    ${api.token ? 'Bearer Token' : '仅本机（未配置 api.token）'}`);
  console.log(`  缺省空间: ${recentRoot}（最近使用；新会话未指定空间时落此处）`);
  console.log(`  端点:    /health · /status · /sessions · /uploads · /config · /tools · /models · /mcp · /skills · /memory`);
  console.log(`  提示:    Ctrl+C 退出；MCP 配置由后台监测器热更新，其他配置变更需重启生效`);
  console.log('');

  // serve 常驻：收到关停信号时先补一轮 Dreaming，再关服务、断开 MCP 后退出（Task-20261026-002 D5/D6）
  // - 顺序：停调度器 → 跑晋升（受 shutdownBudgetMs 约束）→ server.close() → 断 MCP → exit
  //   （不能先 server.close()：等待存量连接关闭可能被 SSE 长连接挂住，晋升就永远排不上）
  // - 信号面：SIGINT（Ctrl+C，全平台）+ SIGTERM（Linux/macOS 主路径）+ SIGBREAK（Windows）
  // - 二次信号：立即强退，给用户「别等了」的出口
  dreamScheduler.start();
  let shuttingDown = false;
  const onSignal = async (sig: string): Promise<void> => {
    if (shuttingDown) {
      console.log(`\n[api] 再次收到 ${sig}，立即退出（未完成的晋升会被丢弃）`);
      process.exit(0);
    }
    shuttingDown = true;
    dreamScheduler.stop();
    const budget = configLoader.load().config.memory.dreaming.shutdownBudgetMs;
    console.log('');
    console.log(`[api] 收到 ${sig}，正在整理记忆（Dreaming），最多等待 ${Math.round(budget / 1000)}s；再按一次 Ctrl+C 立即退出`);
    await dreamScheduler.runAllForShutdown(budget).catch(() => []);
    await server.close().catch(() => {});
    mcpMonitor.stop();
    setActiveMcpMonitor(undefined);
    await mcpManager.disconnectAll().catch(() => {});
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(sig, () => void onSignal(sig));
  }

  return server;
}
