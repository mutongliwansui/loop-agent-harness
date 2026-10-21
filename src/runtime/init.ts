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
  // 共享默认值：CLI 不传 root 时以启动目录为唯一空间（D11，CLI 零改动）
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  // 0. 初次启动引导：自动检测必备目录与配置（齐备零打扰；主模型未配置进向导；仅目录/文件缺失静默补建）
  //    引导可能写盘，随后重新加载即为生效值
  await ensureBootstrap({ noSetup: opts.noSetup === true });

  // 0.1 加载合并配置
  const { config } = configLoader.load();

  // 1. 注册内置工具（根据配置的 enabled/disabled 过滤；vision 配置决定视觉工具是否注册）
  registerBuiltinTools(config.tools, config.vision);

  // 2. 加载 MCP 配置
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

  // 3. 扫描 Skill
  if (config.skill.enabled && config.skill.autoLoad) {
    try {
      // 空间资源：缺省为启动目录（CLI 单空间），serve 侧由调用方传 runtime 根
      const skills = skillLoader.scan(workspaceRoot);
      if (skills.length > 0) {
        console.log(`${C.green}Skill 加载成功:${C.reset} ${skills.length} 个`);
        for (const s of skills) console.log(`  ✓ ${s.name} (${s.scope === 'workspace' ? '工作空间' : '全局'})`);
      }
    } catch (e) {
      console.error(`${C.yellow}Skill 扫描异常 (继续启动): ${e instanceof Error ? e.message : String(e)}${C.reset}`);
    }
  }

  return { config };
}

/**
 * 初始化 Agent 记忆系统（L1/L2/L3）。
 * CLI 与 API 各自在合适的时序调用（CLI 在会话恢复之后，API 在起服务之前）。
 */
export async function initAgentMemory(root = process.cwd()): Promise<void> {
  try {
    // 空间资源：缺省为启动目录（CLI 单空间），serve 侧显式传 runtime 根
    await agent.initMemory(root);
    if (agent.memoryEnabled) {
      console.log(`${C.green}✓ 记忆系统已启用:${C.reset} L1(Working) + L2(Episodic) + L3(Curated)`);
    }
  } catch (e) {
    console.error(`${C.yellow}记忆系统初始化失败（继续启动）: ${e instanceof Error ? e.message : String(e)}${C.reset}`);
  }
}
