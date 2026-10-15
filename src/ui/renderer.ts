// 终端渲染函数集中管理
// 从 index.ts 搬迁，接收数据参数，不直接访问 agent/config

import { COLORS as C, sourceColor } from './colors.js';
import { detectDrift } from '../config/schema.js';
import type { AgentConfig, ConfigSource } from '../config/index.js';

/** printBanner 所需的数据 */
export interface BannerOptions {
  config: AgentConfig;
  sources: Record<string, ConfigSource>;
  builtinToolNames: string[];
  mcpToolCount: number;
  mcpServers: string[];
  skills: { name: string }[];
}

/** printStatus 所需的数据 */
export interface StatusOptions {
  messageCount: number;
  contextTokens: number;
  maxTokens: number;
  threshold: number;
  builtinToolNames: string[];
  mcpServers: string[];
  mcpToolCount: number;
  skills: { name: string }[];
}

/** printTools 所需的数据 */
export interface ToolInfo {
  name: string;
  description: string;
  isMCP: boolean;
}

/** renderMessages 所需的消息结构 */
export interface RenderMessage {
  role: string;
  content: string | null;
  tool_calls?: { function?: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/** 打印启动横幅与使用说明 */
export function printBanner(opts: BannerOptions): void {
  const { config: cfg, sources } = opts;
  console.log(`${C.bold}${C.yellow}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${C.reset}`);
  console.log(`${C.bold}${C.yellow}┃            ReAct Agent 交互式控制台                     ┃${C.reset}`);
  console.log(`${C.bold}${C.yellow}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${C.reset}`);
  console.log('');
  const tag = sources['model.name'] ?? 'default';
  // 多模型管理标注（Task-20261011-002 P1）：激活 profile 非空时标注归属，漂移时追加「未同步」
  let profileNote = '';
  if (cfg.models.active) {
    profileNote = detectDrift(cfg)
      ? ` ${C.gray}(profile: ${cfg.models.active}·未同步)${C.reset}`
      : ` ${C.gray}(profile: ${cfg.models.active})${C.reset}`;
  }
  console.log(`${C.cyan}模型:${C.reset} ${C.bold}${cfg.model.name}${C.reset}${profileNote} ${C.gray}(${sourceColor(tag)}${tag}${C.reset}${C.gray})${C.reset}`);
  const urlTag = sources['model.baseUrl'] ?? 'default';
  console.log(`${C.cyan}BaseURL:${C.reset} ${cfg.model.baseUrl} ${C.gray}(${sourceColor(urlTag)}${urlTag}${C.reset}${C.gray})${C.reset}`);
  console.log(`${C.cyan}最大迭代:${C.reset} ${cfg.model.maxIterations}`);
  console.log(`${C.cyan}内置工具:${C.reset} [${opts.builtinToolNames.map((n) => `${C.green}${n}${C.reset}`).join(', ')}]`);
  if (opts.mcpToolCount > 0) {
    console.log(`${C.cyan}MCP 工具:${C.reset} ${opts.mcpToolCount} 个, Servers: ${opts.mcpServers.join(', ')} (${C.magenta}{serverName}__toolName${C.reset})`);
  }
  if (cfg.skill.enabled && opts.skills.length > 0) {
    console.log(`${C.cyan}Skills:${C.reset} ${opts.skills.length} 个 (${opts.skills.map((s) => s.name).join(', ')})`);
  }
  if (cfg.agent.debug) {
    // debug 标志由调用方通过 config 判断，日志路径信息也由调用方提供更合适
    // 但为保持与原行为一致，这里仍从 config 读取
  }
  console.log('');
  console.log(`${C.gray}使用说明:${C.reset}`);
  console.log(`  ${C.bold}输入问题${C.reset}    → Agent 流式输出 Thought / Action / Observation / Final`);
  console.log(`  ${C.bold}/help${C.reset}         → 查看此帮助`);
  console.log(`  ${C.bold}/config${C.reset}       → 配置管理（get/set/delete/list/path）`);
  console.log(`  ${C.bold}/model${C.reset}        → 多模型管理（list/use/add/remove/test）`);
  console.log(`  ${C.bold}/vision${C.reset}       → 视觉模型管理（status/test）`);
  console.log(`  ${C.bold}/upload${C.reset}       → 文件上传（复制到会话隔离上传目录并注入上下文）`);
  console.log(`  ${C.bold}/mcp${C.reset}          → MCP 管理（list/add/remove/reload/test）`);
  console.log(`  ${C.bold}/tools${C.reset}        → 工具管理（enable/disable/reload/list）`);
  console.log(`  ${C.bold}/skill${C.reset}        → Skill 管理（list/reload/show/upload）`);
  console.log(`  ${C.bold}/session${C.reset}      → 会话管理（list/load/save/new/delete）`);
  console.log(`  ${C.bold}/memory${C.reset}       → 记忆管理（curated/episodic/status/search/dream/gate/init）`);
  console.log(`  ${C.bold}/setup${C.reset}        → 重新运行初始化配置向导`);
  console.log(`  ${C.bold}/doctor${C.reset}       → 配置与依赖体检`);
  console.log(`  ${C.bold}/reset${C.reset}        → 清空多轮对话历史，重新开始新会话`);
  console.log(`  ${C.bold}/status${C.reset}       → 查看当前会话状态（消息数 / 工具数）`);
  console.log(`  ${C.bold}exit/quit/退出${C.reset} → 退出程序（Ctrl+C 同样有效）`);
  console.log(`  ${C.bold}Tab${C.reset}          → 命令自动补全（输入 /con 按 Tab 补全为 /config，/config 后可补子命令）`);
  console.log(`${C.gray}──────────────────────────────────────────────────────────${C.reset}`);
  console.log('');
}

/** 打印会话状态 */
export function printStatus(opts: StatusOptions): void {
  console.log('');
  console.log(`  ${C.bold}消息历史:${C.reset} ${opts.messageCount} 条`);
  if (opts.maxTokens > 0) {
    const pct = Math.round((opts.contextTokens / opts.maxTokens) * 100);
    const warn = opts.contextTokens >= opts.threshold ? `${C.yellow} ⚠ 接近压缩阈值${C.reset}` : '';
    console.log(`  ${C.bold}上下文消耗:${C.reset} ${opts.contextTokens} / ${opts.maxTokens} tokens (${pct}%)${warn}`);
  } else {
    console.log(`  ${C.bold}上下文消耗:${C.reset} ${opts.contextTokens} tokens（记忆未启用，仅估算）`);
  }
  console.log(`  ${C.bold}内置工具:${C.reset} ${opts.builtinToolNames.length} 个 (${opts.builtinToolNames.join(', ')})`);
  if (opts.mcpToolCount > 0) {
    console.log(`  ${C.bold}MCP Server:${C.reset} ${opts.mcpServers.join(', ') || '无'}`);
    console.log(`  ${C.bold}MCP 工具:${C.reset} ${opts.mcpToolCount} 个`);
  } else {
    console.log(`  ${C.bold}MCP 工具:${C.reset} 未加载（可用 /mcp add 或写入配置后 /mcp reload）`);
  }
  if (opts.skills.length > 0) {
    console.log(`  ${C.bold}Skills:${C.reset} ${opts.skills.length} 个 (${opts.skills.map((s) => s.name).join(', ')})`);
  }
  console.log('');
}

/** 列出所有工具 */
export function printTools(tools: ToolInfo[]): void {
  console.log('');
  console.log(`${C.bold}共 ${tools.length} 个可用工具:${C.reset}`);
  for (const t of tools) {
    const prefix = t.isMCP ? `${C.magenta}MCP${C.reset}` : `${C.green}内置${C.reset}`;
    console.log(`  [${prefix}] ${C.bold}${t.name}${C.reset} — ${t.description}`);
  }
  console.log('');
}

/** 渲染会话历史消息 */
export function renderMessages(messages: RenderMessage[]): void {
  console.log('');
  console.log(`${C.cyan}╔════════ 会话历史 ${'═'.repeat(42)}╗${C.reset}`);
  for (const msg of messages) {
    switch (msg.role) {
      case 'user':
        console.log(`${C.cyan}║${C.reset} ${C.bold}${C.cyan}🧑 用户${C.reset}`);
        console.log(`${C.cyan}║${C.reset} ${msg.content}`);
        break;
      case 'assistant':
        if (msg.content) {
          console.log(`${C.cyan}║${C.reset} ${C.bold}${C.green}🤖 助手${C.reset}`);
          console.log(`${C.cyan}║${C.reset} ${msg.content}`);
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            const fn = tc.function;
            if (fn) {
              console.log(`${C.cyan}║${C.reset} ${C.gray}🔧 调用工具: ${fn.name}(${fn.arguments})${C.reset}`);
            }
          }
        }
        break;
      case 'tool':
        console.log(`${C.cyan}║${C.reset} ${C.gray}📋 工具结果: ${(msg.tool_call_id ?? '').slice(-8)}${C.reset}`);
        console.log(`${C.cyan}║${C.reset} ${C.gray}${String(msg.content).slice(0, 200)}${C.reset}`);
        break;
      case 'system':
        break;
    }
  }
  console.log(`${C.cyan}╚════════ 历史结束，继续对话 ${'═'.repeat(32)}╝${C.reset}\n`);
}
