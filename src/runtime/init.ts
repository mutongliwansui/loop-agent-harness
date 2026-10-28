// 共享运行时初始化：CLI 与 HTTP API 两种启动模式共用的前置步骤。
//
// 只做「进程级单例装配」（初次引导 / 配置 / 内置工具 / MCP / Skill），不含任何模式专属逻辑：
// - 会话恢复与 SessionStore 注入 → CLI 专属，见 src/cli/start.ts
// - HTTP 服务组装 → API 专属，见 src/api/bootstrap.ts
//
// 调用方：src/index.ts 分发入口（先 initRuntime，再按 --serve 选择 cli / api 分支）。
import { agent } from '../agent/react-agent.js';
import { ensureBootstrap } from '../bootstrap/index.js';
import { registerBuiltinTools, mcpManager } from '../tools/index.js';
import { backgroundTasks } from '../tools/background-tasks.js';
import { configLoader } from '../config/index.js';
import { skillLoader } from '../skill/index.js';
import { COLORS as C } from '../ui/colors.js';
import type { AgentConfig } from '../config/schema.js';

export interface RuntimeContext {
  /** 合并后的生效配置（初次引导可能写盘，返回值已反映最新配置） */
  config: AgentConfig;
}

/**
 * 执行两种模式共用的启动前置：初次引导 → 配置 → 内置工具 → MCP → Skill。
 *
 * 注意：记忆初始化（initAgentMemory）不在此处——CLI 需先恢复会话再初始化记忆，
 * API 则在起服务前初始化；两者时序不同，故各自在所属分支内调用。
 *
 * @param opts.noSetup 跳过初次启动引导（对应 `--no-setup`）
 * @param opts.workspaceRoot 技能扫描根（缺省为进程 cwd；CLI 单空间即启动目录，serve 侧由 runtime 传入）
 */
export async function initRuntime(opts: { noSetup?: boolean; workspaceRoot?: string } = {}): Promise<RuntimeContext> {
  const startupT0 = Date.now();
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  console.log('[startup] 初始化运行时...');

  // 0. 初次启动引导
  const t0 = Date.now();
  await ensureBootstrap({ noSetup: opts.noSetup === true });
  console.log(`  ├─ 初次引导完成 (+${Date.now() - t0}ms)`);

  // 0.1 加载合并配置
  const t0b = Date.now();
  const { config } = configLoader.load();
  console.log(`  ├─ 配置加载 (${config.model.name}) (+${Date.now() - t0b}ms)`);

  // 1. 注册内置工具
  registerBuiltinTools(config.tools, config.vision);

  // 1.1 后台任务：启动时**不阻塞**扫 runs 目录
  //    历史上这里 await sweepOrphans()，但 runs/ 目录若积几千个旧 JSON，
  //    同步 readFileSync + JSON.parse 在 Windows 上能卡 60s+（2026-10-28 观测 13374 个文件）
  //    孤儿任务修补不是启动关键路径，且孤儿清理改由 pruneStaleRuns 定期处理
  //    pruneStaleRuns 是同步的，用 stat mtime 粗筛，13374 个文件实测 <1s
  try { backgroundTasks.pruneStaleRuns(); } catch { /* ignore */ }

  // 2. 加载 MCP（并发 + 进度日志；单个失败不再阻塞整体启动）
  const t2 = Date.now();
  try {
    const mcp = await mcpManager.loadFromConfig();
    if (mcp.failures.length) {
      console.log(`${C.yellow}  ├─ MCP 加载警告 (+${Date.now() - t2}ms):${C.reset}`);
      for (const f of mcp.failures) console.log(`  │  ${C.red}✗${C.reset} ${f}`);
    }
    if (mcp.successes.length) {
      console.log(`${C.green}  ├─ MCP 加载成功 (+${Date.now() - t2}ms):${C.reset}`);
      for (const s of mcp.successes) console.log(`  │  ✓ ${s}`);
    } else if (!mcp.failures.length) {
      console.log(`  ├─ MCP: 未配置 server (+${Date.now() - t2}ms)`);
    }
  } catch (e) {
    console.error(`${C.yellow}  ├─ MCP 加载异常 (+${Date.now() - t2}ms，继续启动): ${e instanceof Error ? e.message : String(e)}${C.reset}`);
  }

  // 3. 扫描 Skill
  const t3 = Date.now();
  if (config.skill.enabled && config.skill.autoLoad) {
    try {
      const skills = skillLoader.scan(workspaceRoot);
      if (skills.length > 0) {
        console.log(`${C.green}  ├─ Skill 加载成功 (+${Date.now() - t3}ms):${C.reset} ${skills.length} 个`);
        for (const s of skills) console.log(`  │  ✓ ${s.name} (${s.scope === 'workspace' ? '工作空间' : '全局'})`);
      } else {
        console.log(`  ├─ Skill: 未发现可用 skill (+${Date.now() - t3}ms)`);
      }
    } catch (e) {
      console.error(`${C.yellow}  ├─ Skill 扫描异常 (+${Date.now() - t3}ms，继续启动): ${e instanceof Error ? e.message : String(e)}${C.reset}`);
    }
  }

  console.log(`  └─ 运行时就绪，总耗时 ${Date.now() - startupT0}ms`);
  return { config };
}

/**
 * 初始化 Agent 记忆系统（L1/L2/L3）。
 * CLI 与 API 各自在合适的时序调用（CLI 在会话恢复之后，API 在起服务之前）。
 */
export async function initAgentMemory(root = process.cwd()): Promise<void> {
  const t0 = Date.now();
  try {
    await agent.initMemory(root);
    if (agent.memoryEnabled) {
      console.log(`${C.green}✓ 记忆系统已启用 (+${Date.now() - t0}ms):${C.reset} L1(Working) + L2(Episodic) + L3(Curated)`);
    } else {
      console.log(`  ├─ 记忆系统未启用 (+${Date.now() - t0}ms)`);
    }
  } catch (e) {
    console.error(`${C.yellow}记忆系统初始化失败 (+${Date.now() - t0}ms，继续启动): ${e instanceof Error ? e.message : String(e)}${C.reset}`);
  }
}
