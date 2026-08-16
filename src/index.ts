// ReAct Agent CLI 入口：交互式 REPL
// 运行：npm run dev 或 npm start
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agent } from './agent/react-agent.js';
import { buildSystemPrompt } from './agent/prompt.js';
import {
  registerBuiltinTools,
  registry,
  mcpManager,
  commandRun,
  fileRead,
  fileWrite,
  grep,
  activateSkill,
} from './tools/index.js';
import {
  configLoader,
  configWriter,
  ConfigWriter,
  type ConfigScope,
  type PartialAgentConfig,
  type AgentConfig,
  type ConfigSource,
  type ToolsConfig,
} from './config/index.js';
import { skillLoader, formatSkillList } from './skill/index.js';
import { type MCPServerConfig } from './tools/mcp/client.js';
import { SessionStore, keychain, type SessionMeta } from './session/index.js';
import { EpisodicMemory, CuratedMemory, type CuratedFileKey } from './memory/index.js';
import type { ChatMessage } from './types.js';

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
  white: '\x1b[37m',
} as const;

/** 来源着色 */
function sourceColor(s: ConfigSource): string {
  switch (s) {
    case 'cli': return C.red;
    case 'workspace': return C.green;
    case 'global': return C.magenta;
    case 'env': return C.yellow;
    default: return C.gray;
  }
}

/** 解析命令行 flag：--workspace / --global */
function parseScope(args: string[]): { scope: ConfigScope; rest: string[] } {
  let scope: ConfigScope = 'workspace';
  const rest: string[] = [];
  for (const a of args) {
    if (a === '--workspace') scope = 'workspace';
    else if (a === '--global') scope = 'global';
    else rest.push(a);
  }
  return { scope, rest };
}

/** 从字符串解析配置值（支持 JSON / number / boolean） */
function parseValue(raw: string): unknown {
  // 布尔
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  // 数字
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  // JSON
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  // 字符串
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** 打印启动横幅与使用说明 */
function printBanner(): void {
  const { config: cfg, sources } = configLoader.load();
  const builtTools = registry.list().filter((t) => !t.name.includes('__'));
  const mcpCount = registry.list().length - builtTools.length;
  const skills = cfg.skill.enabled ? skillLoader.list() : [];

  console.log(`${C.bold}${C.yellow}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${C.reset}`);
  console.log(`${C.bold}${C.yellow}┃            ReAct Agent 交互式控制台                     ┃${C.reset}`);
  console.log(`${C.bold}${C.yellow}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${C.reset}`);
  console.log('');
  const tag = sources['model.name'] ?? 'default';
  console.log(`${C.cyan}模型:${C.reset} ${C.bold}${cfg.model.name}${C.reset} ${C.gray}(${sourceColor(tag)}${tag}${C.reset}${C.gray})${C.reset}`);
  const urlTag = sources['model.baseUrl'] ?? 'default';
  console.log(`${C.cyan}BaseURL:${C.reset} ${cfg.model.baseUrl} ${C.gray}(${sourceColor(urlTag)}${urlTag}${C.reset}${C.gray})${C.reset}`);
  console.log(`${C.cyan}最大迭代:${C.reset} ${cfg.model.maxIterations}`);
  console.log(`${C.cyan}内置工具:${C.reset} [${builtTools.map((n) => `${C.green}${n.name}${C.reset}`).join(', ')}]`);
  if (mcpCount > 0) {
    console.log(`${C.cyan}MCP 工具:${C.reset} ${mcpCount} 个, Servers: ${registry.listMCPServers().join(', ')} (${C.magenta}{serverName}__toolName${C.reset})`);
  }
  if (cfg.skill.enabled && skills.length > 0) {
    console.log(`${C.cyan}Skills:${C.reset} ${skills.length} 个 (${skills.map((s) => s.name).join(', ')})`);
  }
  if (cfg.agent.debug) {
    console.log(`${C.yellow}⚠ 调试模式已开启，日志输出到: ${join(homedir(), '.loop-agent', 'logs')}${C.reset}`);
  }
  console.log('');
  console.log(`${C.gray}使用说明:${C.reset}`);
  console.log(`  ${C.bold}输入问题${C.reset}    → Agent 流式输出 Thought / Action / Observation / Final`);
  console.log(`  ${C.bold}/help${C.reset}         → 查看此帮助`);
  console.log(`  ${C.bold}/config${C.reset}       → 配置管理（get/set/delete/list/path）`);
  console.log(`  ${C.bold}/mcp${C.reset}          → MCP 管理（list/add/remove/reload/test）`);
  console.log(`  ${C.bold}/tools${C.reset}        → 工具管理（enable/disable/reload/list）`);
  console.log(`  ${C.bold}/skill${C.reset}        → Skill 管理（list/reload/show）`);
  console.log(`  ${C.bold}/session${C.reset}      → 会话管理（list/load/save/new/delete）`);
  console.log(`  ${C.bold}/memory${C.reset}       → 记忆管理（curated/episodic/status/search/dream/gate/init）`);
  console.log(`  ${C.bold}/reset${C.reset}        → 清空多轮对话历史，重新开始新会话`);
  console.log(`  ${C.bold}/status${C.reset}       → 查看当前会话状态（消息数 / 工具数）`);
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
  const mcpServers = registry.listMCPServers();
  const { config: cfg } = configLoader.load();
  const skills = cfg.skill.enabled ? skillLoader.list() : [];
  const context = agent.getContextUsage();
  console.log('');
  console.log(`  ${C.bold}消息历史:${C.reset} ${msgs.length} 条`);
  if (context.maxTokens > 0) {
    const pct = Math.round((context.contextTokens / context.maxTokens) * 100);
    const warn = context.contextTokens >= context.threshold ? `${C.yellow} ⚠ 接近压缩阈值${C.reset}` : '';
    console.log(`  ${C.bold}上下文消耗:${C.reset} ${context.contextTokens} / ${context.maxTokens} tokens (${pct}%)${warn}`);
  } else {
    console.log(`  ${C.bold}上下文消耗:${C.reset} ${context.contextTokens} tokens（记忆未启用，仅估算）`);
  }
  console.log(`  ${C.bold}内置工具:${C.reset} ${builtin.length} 个 (${builtin.map((t) => t.name).join(', ')})`);
  if (mcp.length > 0) {
    console.log(`  ${C.bold}MCP Server:${C.reset} ${mcpServers.join(', ') || '无'}`);
    console.log(`  ${C.bold}MCP 工具:${C.reset} ${mcp.length} 个`);
  } else {
    console.log(`  ${C.bold}MCP 工具:${C.reset} 未加载（可用 /mcp add 或写入配置后 /mcp reload）`);
  }
  if (skills.length > 0) {
    console.log(`  ${C.bold}Skills:${C.reset} ${skills.length} 个 (${skills.map((s) => s.name).join(', ')})`);
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

/**
 * /config 命令处理器
 * 支持: /config list, /config get <key>, /config set <key> <value> [--workspace|--global],
 *       /config delete <key> [--workspace|--global], /config path
 */
async function handleConfig(input: string, rl: readline.Interface): Promise<void> {
  const parts = input.split(/\s+/);
  const sub = parts[1] ?? 'list';
  const args = parts.slice(2);

  if (sub === 'list') {
    const { config: cfg, sources } = configLoader.load();
    console.log('');
    console.log(`${C.bold}当前生效配置 (含来源标注):${C.reset}`);
    printConfigLayer(cfg as unknown as Record<string, unknown>, sources, '');
    console.log('');
    return;
  }

  if (sub === 'get') {
    if (args.length === 0) {
      console.log(`${C.red}用法: /config get <key>（如 model.name）${C.reset}\n`);
      return;
    }
    const key = args[0];
    const { config: cfg, sources } = configLoader.load();
    const val = ConfigWriter.getByKey(cfg as unknown as Record<string, unknown>, key);
    const source = sources[key];
    console.log('');
    console.log(`  ${C.bold}${key}${C.reset} = ${JSON.stringify(val, null, 2)}`);
    if (source) console.log(`  ${C.gray}来源: ${sourceColor(source)}${source}${C.reset}`);
    console.log('');
    return;
  }

  if (sub === 'set') {
    if (args.length < 2) {
      console.log(`${C.red}用法: /config set <key> <value> [--workspace|--global]${C.reset}\n`);
      return;
    }
    const { scope, rest } = parseScope(args);
    const key = rest[0];
    const valueRaw = rest.slice(1).join(' ');
    const value = parseValue(valueRaw);

    // 写入
    const partial: PartialAgentConfig = {};
    ConfigWriter.setByKey(partial as Record<string, unknown>, key, value);
    try {
      await configWriter.updateScope(scope, partial);
      console.log(`${C.bold}${C.green}✓ 已写入${C.reset} ${C.bold}${scope === 'workspace' ? '工作空间' : '全局'}${C.reset} 配置: ${key} = ${JSON.stringify(value)}\n`);
    } catch (e) {
      console.error(`${C.bold}${C.red}[Error]${C.reset} 写入失败: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    return;
  }

  if (sub === 'delete') {
    if (args.length === 0) {
      console.log(`${C.red}用法: /config delete <key> [--workspace|--global]${C.reset}\n`);
      return;
    }
    const { scope, rest } = parseScope(args);
    const key = rest[0];
    try {
      await configWriter.deleteScopeKey(scope, ConfigWriter.parseKey(key));
      console.log(`${C.bold}${C.green}✓ 已从 ${scope === 'workspace' ? '工作空间' : '全局'} 配置删除: ${key}${C.reset}\n`);
    } catch (e) {
      console.error(`${C.bold}${C.red}[Error]${C.reset} 删除失败: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    return;
  }

  if (sub === 'path') {
    console.log('');
    const wp = configLoader.workspaceConfigPath;
    const gp = configLoader.globalConfigPath;
    console.log(`  ${C.bold}工作空间:${C.reset} ${wp} ${existsSync(wp) ? `${C.green}[存在]${C.reset}` : `${C.gray}[不存在]${C.reset}`}`);
    console.log(`  ${C.bold}全局:${C.reset}     ${gp} ${existsSync(gp) ? `${C.green}[存在]${C.reset}` : `${C.gray}[不存在]${C.reset}`}`);
    console.log('');
    return;
  }

  // 不认识的子命令
  console.log(`${C.red}未知 /config 子命令: ${sub}。支持 list / get / set / delete / path${C.reset}\n`);
  void rl; // 消除未使用参数告警
}

/** 递归打印配置层（带来源着色） */
function printConfigLayer(obj: Record<string, unknown>, sources: Record<string, ConfigSource>, prefix: string): void {
  const keys = Object.keys(obj).sort();
  for (const k of keys) {
    const flat = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    const src = sources[flat];
    const tag = src ? ` ${C.gray}(${sourceColor(src)}${src}${C.reset}${C.gray})${C.reset}` : '';
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      console.log(`  ${C.cyan}${flat}${C.reset}:${tag}`);
      printConfigLayer(v as Record<string, unknown>, sources, flat);
    } else {
      const pretty = Array.isArray(v) || typeof v === 'object'
        ? JSON.stringify(v)
        : JSON.stringify(v);
      console.log(`  ${C.white}${flat}${C.reset} = ${pretty}${tag}`);
    }
  }
}

/**
 * /mcp 命令处理器
 * 支持: list, add <name>, remove <name> [--workspace|--global], reload, test <name>
 * 注: /mcp add 走交互式输入，因为参数较复杂
 */
async function handleMcp(input: string, rl: readline.Interface): Promise<void> {
  const parts = input.split(/\s+/);
  const sub = parts[1] ?? 'list';
  const args = parts.slice(2);

  if (sub === 'list') {
    const { config: cfg } = configLoader.load();
    const servers = cfg.tools.mcpServers;
    const connected = mcpManager.listConnected();
    console.log('');
    console.log(`${C.bold}MCP Server 配置:${C.reset}`);
    if (Object.keys(servers).length === 0) {
      console.log(`  ${C.gray}（暂无，可用 /mcp add 添加）${C.reset}`);
    }
    for (const [name, s] of Object.entries(servers)) {
      const conn = connected.includes(name) ? `${C.green}[已连接]${C.reset}` : `${C.red}[未连接]${C.reset}`;
      const detail = s.type === 'stdio'
        ? `${s.type}: ${s.command} ${(s.args ?? []).join(' ')}`
        : `${s.type}: ${s.url}`;
      console.log(`  - ${C.bold}${name}${C.reset} ${conn} ${C.gray}(${detail})${C.reset}`);
    }
    console.log('');
    return;
  }

  if (sub === 'reload') {
    console.log('');
    console.log(`${C.gray}重新加载 MCP 配置...${C.reset}`);
    const res = await mcpManager.reload();
    for (const s of res.successes) console.log(`  ${C.green}✓${C.reset} ${s}`);
    for (const s of res.failures) console.log(`  ${C.red}✗${C.reset} ${s}`);
    console.log('');
    return;
  }

  if (sub === 'remove') {
    if (args.length === 0) {
      console.log(`${C.red}用法: /mcp remove <name> [--workspace|--global]${C.reset}\n`);
      return;
    }
    const { scope, rest } = parseScope(args);
    const name = rest[0];
    // 从配置移除
    const key = `tools.mcpServers.${name}`;
    try {
      await configWriter.deleteScopeKey(scope, ConfigWriter.parseKey(key));
      // 立即卸载
      await mcpManager.unloadServer(name);
      console.log(`${C.bold}${C.green}✓${C.reset} 已从 ${scope} 配置删除并卸载 MCP Server: ${name}\n`);
    } catch (e) {
      console.error(`${C.bold}${C.red}[Error]${C.reset} 删除失败: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    return;
  }

  if (sub === 'test') {
    if (args.length === 0) {
      console.log(`${C.red}用法: /mcp test <name>${C.reset}\n`);
      return;
    }
    const name = args[0];
    const { config: cfg } = configLoader.load();
    const s = cfg.tools.mcpServers[name];
    if (!s) {
      console.log(`${C.red}MCP Server ${name} 未在配置中找到，请先 /mcp add 或写入配置${C.reset}\n`);
      return;
    }
    console.log('');
    console.log(`${C.gray}测试连接 MCP Server: ${name}${C.reset}`);
    const res = await mcpManager.testServer(name, s);
    if (res.ok) {
      console.log(`  ${C.green}✓${C.reset} ${res.message}`);
    } else {
      console.log(`  ${C.red}✗${C.reset} ${res.message}`);
    }
    console.log('');
    return;
  }

  if (sub === 'add') {
    if (args.length === 0) {
      console.log(`${C.red}用法: /mcp add <name> [--workspace|--global]${C.reset}\n`);
      return;
    }
    const { scope, rest } = parseScope(args);
    const name = rest[0];
    await interactiveAddMcp(rl, name, scope);
    return;
  }

  console.log(`${C.red}未知 /mcp 子命令: ${sub}。支持 list / add / remove / reload / test${C.reset}\n`);
}

/** 交互式添加 MCP Server */
async function interactiveAddMcp(rl: readline.Interface, name: string, scope: ConfigScope): Promise<void> {
  console.log('');
  console.log(`${C.bold}添加 MCP Server: ${name} (写入 ${scope === 'workspace' ? '工作空间' : '全局'} 配置)${C.reset}`);

  const q = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  const typeRaw = await q(`传输类型 (stdio/sse, 默认 stdio): `).then((s) => s.trim() || 'stdio');
  if (typeRaw !== 'stdio' && typeRaw !== 'sse') {
    console.log(`${C.red}传输类型必须是 stdio 或 sse，已取消${C.reset}\n`);
    return;
  }

  let cfg: MCPServerConfig;
  if (typeRaw === 'stdio') {
    const command = await q(`可执行命令 (如 npx / python): `).then((s) => s.trim());
    if (!command) { console.log(`${C.red}命令不能为空${C.reset}\n`); return; }
    const argsRaw = await q(`参数 (空格分隔，如 -y pkg): `).then((s) => s.trim());
    const args = argsRaw ? argsRaw.split(/\s+/) : [];
    cfg = { type: 'stdio', command, args };
  } else {
    const url = await q(`SSE URL: `).then((s) => s.trim());
    if (!url) { console.log(`${C.red}URL 不能为空${C.reset}\n`); return; }
    cfg = { type: 'sse', url };
  }

  // 先测试连接
  console.log(`${C.gray}正在测试连接...${C.reset}`);
  const test = await mcpManager.testServer(name, cfg);
  if (!test.ok) {
    console.log(`${C.red}✗${C.reset} 测试连接失败: ${test.message}`);
    const force = await q(`仍然写入配置吗？(y/N): `).then((s) => s.trim().toLowerCase());
    if (force !== 'y') {
      console.log(`${C.gray}已取消${C.reset}\n`);
      return;
    }
  } else {
    console.log(`${C.green}✓${C.reset} ${test.message}`);
  }

  // 写入配置
  const partial: PartialAgentConfig = { tools: {} };
  (partial.tools as ToolsConfig).mcpServers = { [name]: cfg };
  try {
    await configWriter.updateScope(scope, partial);
    console.log(`${C.green}✓${C.reset} 已写入 ${scope === 'workspace' ? '工作空间' : '全局'} 配置`);
    // 如果测试成功了，正式注册到 registry（已在 testServer 时断开），做一次 reload
    if (test.ok) {
      await mcpManager.loadServers({ [name]: cfg });
      console.log(`${C.green}✓${C.reset} ${name} 已加载并注册工具\n`);
    } else {
      console.log('');
    }
  } catch (e) {
    console.error(`${C.bold}${C.red}[Error]${C.reset} 写入失败: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/**
 * /tools 命令处理器 (enable/disable/reload/list)
 */
async function handleTools(input: string, rl: readline.Interface): Promise<void> {
  const parts = input.split(/\s+/);
  const sub = parts[1] ?? 'list';
  const args = parts.slice(2);

  if (sub === 'list') {
    printTools();
    return;
  }

  if (sub === 'reload') {
    const { config: cfg } = configLoader.load();
    // 清空现有工具，重新注册内置 + 重新加载 MCP
    // 先卸载 MCP，避免清空后残留连接
    await mcpManager.disconnectAll();
    registry.clear();
    const built = registerBuiltinTools(cfg.tools);
    const mcp = await mcpManager.loadFromConfig();
    console.log('');
    console.log(`${C.green}✓${C.reset} 工具重新加载完成`);
    console.log(`  内置: ${built.length} 个 (${built.join(', ')})`);
    if (mcp.successes.length) console.log(`  MCP 成功: ${mcp.successes.join(', ')}`);
    if (mcp.failures.length) console.log(`  MCP 失败: ${mcp.failures.join(', ')}`);
    console.log('');
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    if (args.length === 0) {
      console.log(`${C.red}用法: /tools ${sub} <name> [--workspace|--global]${C.reset}\n`);
      return;
    }
    const { scope, rest } = parseScope(args);
    const toolName = rest[0];
    // 检查是否为内置工具（内置工具才用 enable/disable 配置，MCP 用 /mcp remove）
    const builtinNames = ['commandRun', 'fileRead', 'fileWrite', 'grep', 'activateSkill'];
    if (!builtinNames.includes(toolName)) {
      console.log(`${C.yellow}⚠️  /tools enable/disable 仅用于内置工具（commandRun/fileRead/fileWrite/grep），MCP 工具使用 /mcp remove${C.reset}\n`);
      return;
    }

    const { config: cfg } = configLoader.load();
    let enabled = cfg.tools.enabled.length > 0 ? [...cfg.tools.enabled] : [...builtinNames];
    const disabled = cfg.tools.disabled.length > 0 ? [...cfg.tools.disabled] : [];

    if (sub === 'enable') {
      if (!enabled.includes(toolName)) enabled.push(toolName);
      const di = disabled.indexOf(toolName);
      if (di >= 0) disabled.splice(di, 1);
    } else {
      // disable: 如果启用了白名单，则从 enabled 移除
      const ei = enabled.indexOf(toolName);
      if (ei >= 0) enabled.splice(ei, 1);
      if (!disabled.includes(toolName)) disabled.push(toolName);
    }

    const partial: PartialAgentConfig = {
      tools: { enabled, disabled },
    };
    try {
      await configWriter.updateScope(scope, partial);
      // 立即 registry 同步
      if (sub === 'enable') {
        const toolMap: Record<string, unknown> = { commandRun, fileRead, fileWrite, grep, activateSkill };
        const t = toolMap[toolName];
        if (t && !registry.has(toolName)) registry.register(t as never);
      } else {
        if (registry.has(toolName)) registry.unregister(toolName);
      }
      console.log(`${C.bold}${C.green}✓${C.reset} 已写入 ${scope} 配置并${sub === 'enable' ? '启用' : '禁用'}工具: ${toolName}\n`);
    } catch (e) {
      console.error(`${C.bold}${C.red}[Error]${C.reset} 写入失败: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    return;
  }

  console.log(`${C.red}未知 /tools 子命令: ${sub}。支持 list / enable / disable / reload${C.reset}\n`);
  void rl;
}

/**
 * /skill 命令处理器
 * 支持: list, reload, show <name>
 */
async function handleSkill(input: string, rl: readline.Interface): Promise<void> {
  const parts = input.split(/\s+/);
  const sub = parts[1] ?? 'list';
  const args = parts.slice(2);

  if (sub === 'list') {
    const { config: cfg } = configLoader.load();
    if (!cfg.skill.enabled) {
      console.log(`${C.gray}Skill 功能未启用${C.reset}\n`);
      return;
    }
    const skills = skillLoader.list();
    console.log('');
    console.log(`${C.bold}可用 Skill 列表 (${skills.length} 个):${C.reset}`);
    if (skills.length === 0) {
      console.log(`  ${C.gray}（暂无 Skill，可在 ~/.loop-agent/skills/ 或 <cwd>/.loop-agent/skills/ 下创建）${C.reset}`);
    } else {
      for (const s of skills) {
        const scopeTag = s.scope === 'workspace' ? `${C.green}[工作空间]${C.reset}` : `${C.magenta}[全局]${C.reset}`;
        console.log(`  ${C.bold}${s.name}${C.reset} ${scopeTag}`);
        console.log(`    ${C.gray}${s.description}${C.reset}`);
      }
    }
    console.log('');
    return;
  }

  if (sub === 'reload') {
    console.log('');
    console.log(`${C.gray}重新扫描 Skill...${C.reset}`);
    const skills = skillLoader.reload(process.cwd());
    console.log(`${C.green}✓${C.reset} 已发现 ${skills.length} 个 Skill`);
    console.log(formatSkillList(skills));
    console.log('');
    return;
  }

  if (sub === 'show') {
    if (args.length === 0) {
      console.log(`${C.red}用法: /skill show <name>${C.reset}\n`);
      return;
    }
    const name = args[0];
    const content = skillLoader.load(name);
    if (!content) {
      console.log(`${C.red}Skill "${name}" 未找到${C.reset}\n`);
      return;
    }
    console.log('');
    console.log(`${C.bold}${content.metadata.name}${C.reset} ${C.gray}(${content.metadata.scope === 'workspace' ? '工作空间' : '全局'})${C.reset}`);
    console.log(`${C.gray}描述:${C.reset} ${content.metadata.description}`);
    console.log(`${C.gray}路径:${C.reset} ${content.metadata.path}`);
    console.log(`${C.gray}内容:${C.reset}`);
    console.log(content.fullContent);
    console.log('');
    return;
  }

  console.log(`${C.red}未知 /skill 子命令: ${sub}。支持 list / reload / show${C.reset}\n`);
  void rl;
}

/**
 * /session 命令处理器
 * 支持: list, load <id>, save, new, current, delete <id>, delete-all
 */
/** 渲染消息历史到终端 */
function renderMessages(messages: { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }[]): void {
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
            const fn = (tc as { function?: { name: string; arguments: string } }).function;
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

async function handleSession(
  input: string,
  rl: readline.Interface,
  sessionStore: SessionStore | null,
): Promise<void> {
  if (!sessionStore || !keychain.isUnlocked()) {
    console.log(`${C.red}会话系统未启用或未解锁${C.reset}\n`);
    return;
  }

  const parts = input.split(/\s+/);
  const sub = parts[1] ?? 'list';
  const args = parts.slice(2);

  if (sub === 'list') {
    const sessions = await sessionStore.listSessions();
    console.log('');
    console.log(`${C.bold}当前工作空间会话 (${sessions.length} 个):${C.reset}`);
    if (sessions.length === 0) {
      console.log(`  ${C.gray}（暂无会话）${C.reset}`);
    }
    for (const s of sessions) {
      const isCurrent = s.id === agent.currentSessionId;
      const mark = isCurrent ? ` ${C.green}[当前]${C.reset}` : '';
      const date = new Date(s.updatedAt).toLocaleString('zh-CN', { hour12: false });
      console.log(`  ${C.bold}${s.id}${C.reset}${mark} ${C.gray}${date}${C.reset} [${s.messageCount}条] ${s.title}`);
    }
    console.log('');
    return;
  }

  if (sub === 'current') {
    const id = agent.currentSessionId;
    if (!id) {
      console.log(`${C.gray}当前无活跃会话${C.reset}\n`);
      return;
    }
    const sessions = await sessionStore.listSessions();
    const meta = sessions.find((s) => s.id === id);
    if (meta) {
      console.log('');
      console.log(`${C.bold}当前会话:${C.reset}`);
      console.log(`  ID: ${C.bold}${meta.id}${C.reset}`);
      console.log(`  标题: ${meta.title}`);
      console.log(`  消息数: ${meta.messageCount}`);
      console.log(`  创建时间: ${new Date(meta.createdAt).toLocaleString('zh-CN')}`);
      console.log(`  更新时间: ${new Date(meta.updatedAt).toLocaleString('zh-CN')}`);
      console.log('');
    }
    return;
  }

  if (sub === 'load') {
    if (args.length === 0) {
      console.log(`${C.red}用法: /session load <id>${C.reset}\n`);
      return;
    }
    const id = args[0];
    try {
      const data = await sessionStore.loadSession(id);

      // 构建 system prompt
      const { config: loadCfg } = configLoader.load();
      const skills = loadCfg.skill.enabled ? skillLoader.scan(process.cwd()) : [];
      const systemPrompt = loadCfg.agent.systemPrompt ?? buildSystemPrompt(skills);

      // 使用 restoreSession 方法（支持分层存储）
      agent.restoreSession(data, systemPrompt);

      // 显示恢复的会话历史（recentMessages，不含 system）
      const restoreMessages = SessionStore.getRestoreMessages(data);
      renderMessages(restoreMessages);
    } catch (e) {
      console.error(`${C.red}✗ 加载失败: ${e instanceof Error ? e.message : String(e)}${C.reset}\n`);
    }
    return;
  }

  if (sub === 'save') {
    const msgs = agent.getSessionMessages();
    if (msgs.length === 0) {
      console.log(`${C.yellow}无消息可保存${C.reset}\n`);
      return;
    }
    try {
      if (agent.currentSessionId) {
        // 更新现有会话
        await sessionStore.updateSession(agent.currentSessionId, msgs, []);
        console.log(`${C.green}✓ 会话已更新: ${agent.currentSessionId}${C.reset}\n`);
      } else {
        // 创建新会话
        const userMsg = msgs.find((m) => m.role === 'user')?.content ?? '新会话';
        const meta = await sessionStore.createSession(
          typeof userMsg === 'string' ? userMsg : '新会话',
          msgs,
          [],
        );
        agent.setCurrentSessionId(meta.id);
        console.log(`${C.green}✓ 会话已保存: ${meta.id}${C.reset}\n`);
      }
    } catch (e) {
      console.error(`${C.red}✗ 保存失败: ${e instanceof Error ? e.message : String(e)}${C.reset}\n`);
    }
    return;
  }

  if (sub === 'new') {
    agent.resetSession();
    console.log(`${C.green}✓ 已创建新会话（旧会话已自动保存）${C.reset}\n`);
    return;
  }

  if (sub === 'delete') {
    if (args.length === 0) {
      console.log(`${C.red}用法: /session delete <id>${C.reset}\n`);
      return;
    }
    const id = args[0];
    try {
      await sessionStore.deleteSession(id);
      if (agent.currentSessionId === id) {
        agent.setCurrentSessionId(null);
      }
      console.log(`${C.green}✓ 会话已删除: ${id}${C.reset}\n`);
    } catch (e) {
      console.error(`${C.red}✗ 删除失败: ${e instanceof Error ? e.message : String(e)}${C.reset}\n`);
    }
    return;
  }

  if (sub === 'delete-all') {
    const q = await new Promise<string>((resolve) => {
      const tempRl = readline.createInterface({ input: process.stdin, output: process.stdout });
      tempRl.question(`${C.red}确认删除当前工作空间的所有会话？(y/N):${C.reset} `, (a) => {
        tempRl.close();
        resolve(a);
      });
    });
    if (q.trim().toLowerCase() !== 'y') {
      console.log(`${C.gray}已取消${C.reset}\n`);
      return;
    }
    try {
      await sessionStore.deleteAllSessions();
      agent.resetSession();
      console.log(`${C.green}✓ 所有会话已删除${C.reset}\n`);
    } catch (e) {
      console.error(`${C.red}✗ 删除失败: ${e instanceof Error ? e.message : String(e)}${C.reset}\n`);
    }
    return;
  }

  console.log(`${C.red}未知 /session 子命令: ${sub}。支持 list / load / save / new / current / delete / delete-all${C.reset}\n`);
  void rl;
}

/**
 * /memory 命令处理器
 * 支持: status, curated (list/read/append/dedupe), episodic (list/read), search
 */
async function handleMemory(input: string, rl: readline.Interface): Promise<void> {
  const parts = input.split(/\s+/);
  const sub = parts[1] ?? 'status';
  const args = parts.slice(2);

  const epiMemory = agent.episodicMemory;
  const curMemory = agent.curatedMemory;

  // status 命令 - 不需要 memory 启用
  if (sub === 'status') {
    const enabled = agent.memoryEnabled;
    console.log('');
    console.log(`${C.bold}记忆系统状态:${C.reset}`);
    console.log(`  ${C.cyan}启用状态:${C.reset} ${enabled ? `${C.green}✓ 已启用${C.reset}` : `${C.gray}✗ 未启用${C.reset}`}`);
    
    if (enabled) {
      if (epiMemory) {
        const dir = epiMemory.getMemoryDir();
        const days = await epiMemory.listDays();
        console.log(`  ${C.cyan}L2 情景记忆:${C.reset} ${days.length} 天 (路径: ${dir})`);
      }
      if (curMemory) {
        const paths = curMemory.getFilePaths();
        console.log(`  ${C.cyan}L3 核心记忆:${C.reset} ${Object.values(paths).length} 个文件`);
        for (const [key, path] of Object.entries(paths)) {
          console.log(`    - ${C.bold}${key}${C.reset}: ${path}`);
        }
      }
      const { config: cfg } = configLoader.load();
      console.log(`  ${C.cyan}工作记忆 L1:${C.reset} maxTokens=${cfg.memory.working.maxTokens}, threshold=${cfg.memory.working.compactionThreshold}`);
    }
    console.log('');
    return;
  }

  if (!agent.memoryEnabled) {
    console.log(`${C.yellow}⚠ 记忆系统未启用，请在配置中设置 memory.enabled=true${C.reset}\n`);
    return;
  }

  // curated 子命令
  if (sub === 'curated') {
    if (!curMemory) {
      console.log(`${C.red}L3 Curated Memory 未初始化${C.reset}\n`);
      return;
    }
    const curSub = args[0] ?? 'list';
    const curArgs = args.slice(1);

    if (curSub === 'list') {
      console.log('');
      console.log(`${C.bold}L3 Curated 核心记忆文件:${C.reset}`);
      const paths = curMemory.getFilePaths();
      for (const [key, path] of Object.entries(paths)) {
        const content = await curMemory.read(key as CuratedFileKey);
        const lineCount = content.split('\n').length;
        const charCount = content.length;
        console.log(`  ${C.bold}${key}${C.reset} — ${path} (${lineCount} 行, ${charCount} 字符)`);
      }
      console.log('');
      return;
    }

    if (curSub === 'read') {
      if (curArgs.length === 0) {
        console.log(`${C.red}用法: /memory curated read <soul|user|memory>${C.reset}\n`);
        return;
      }
      const fileKey = curArgs[0] as CuratedFileKey;
      const validKeys: CuratedFileKey[] = ['soul', 'user', 'memory'];
      if (!validKeys.includes(fileKey)) {
        console.log(`${C.red}无效的文件键: ${fileKey}，可选: ${validKeys.join(', ')}${C.reset}\n`);
        return;
      }
      const content = await curMemory.read(fileKey);
      console.log('');
      console.log(`${C.bold}📖 ${fileKey.toUpperCase()}.md${C.reset}`);
      console.log('─'.repeat(50));
      console.log(content || `${C.gray}(空)${C.reset}`);
      console.log('─'.repeat(50));
      console.log('');
      return;
    }

    if (curSub === 'append') {
      if (curArgs.length < 2) {
        console.log(`${C.red}用法: /memory curated append <soul|user|memory> <内容>${C.reset}\n`);
        return;
      }
      const fileKey = curArgs[0] as CuratedFileKey;
      const validKeys: CuratedFileKey[] = ['soul', 'user', 'memory'];
      if (!validKeys.includes(fileKey)) {
        console.log(`${C.red}无效的文件键: ${fileKey}，可选: ${validKeys.join(', ')}${C.reset}\n`);
        return;
      }
      const fact = curArgs.slice(1).join(' ');
      await curMemory.append(fileKey, fact);
      console.log(`${C.green}✓ 已追加到 ${fileKey.toUpperCase()}.md: ${fact}${C.reset}\n`);
      return;
    }

    if (curSub === 'dedupe') {
      const fileKey = (curArgs[0] ?? 'memory') as CuratedFileKey;
      const validKeys: CuratedFileKey[] = ['soul', 'user', 'memory'];
      if (!validKeys.includes(fileKey)) {
        console.log(`${C.red}无效的文件键: ${fileKey}，可选: ${validKeys.join(', ')}${C.reset}\n`);
        return;
      }
      console.log(`${C.gray}正在使用 LLM 去重整理 ${fileKey.toUpperCase()}.md ...${C.reset}`);
      const result = await agent.dedupeCuratedMemory(fileKey);
      if (!result) {
        const paths = curMemory.getFilePaths();
        console.log(`${C.yellow}✗ 去重失败或 LLM 输出异常，文件保持原样${C.reset}`);
        console.log(`${C.gray}  （备份文件可能存在: ${paths[fileKey]}.dedupe.bak）${C.reset}\n`);
        return;
      }
      console.log(`${C.green}✓ 去重完成: ${result.before} 行 → ${result.after} 行${C.reset}`);
      console.log(`${C.gray}  原文件备份: ${result.backup}${C.reset}\n`);
      return;
    }

    console.log(`${C.red}未知 curated 子命令: ${curSub}。支持 list / read / append / dedupe${C.reset}\n`);
    return;
  }

  // episodic 子命令
  if (sub === 'episodic') {
    if (!epiMemory) {
      console.log(`${C.red}L2 Episodic Memory 未初始化${C.reset}\n`);
      return;
    }
    const epiSub = args[0] ?? 'list';
    const epiArgs = args.slice(1);

    if (epiSub === 'list') {
      const summaries = await epiMemory.listDaySummaries();
      console.log('');
      console.log(`${C.bold}L2 情景记忆日志 (${summaries.length} 天):${C.reset}`);
      if (summaries.length === 0) {
        console.log(`  ${C.gray}（暂无记录）${C.reset}`);
      }
      for (const s of summaries) {
        console.log(`  ${C.bold}${s.day}${C.reset} — ${s.entryCount} 条记录, ${s.size} 字符`);
      }
      console.log('');
      return;
    }

    if (epiSub === 'read') {
      if (epiArgs.length === 0) {
        console.log(`${C.red}用法: /memory episodic read <YYYY-MM-DD>${C.reset}\n`);
        return;
      }
      const day = epiArgs[0];
      const content = await epiMemory.readDay(day);
      if (!content) {
        console.log(`${C.gray}日期 ${day} 无记录${C.reset}\n`);
        return;
      }
      console.log('');
      console.log(`${C.bold}📅 ${day} 日志${C.reset}`);
      console.log('─'.repeat(50));
      console.log(content);
      console.log('─'.repeat(50));
      console.log('');
      return;
    }

    console.log(`${C.red}未知 episodic 子命令: ${epiSub}。支持 list / read${C.reset}\n`);
    return;
  }

  // search 命令
  if (sub === 'search') {
    if (!epiMemory) {
      console.log(`${C.red}L2 Episodic Memory 未初始化，无法搜索${C.reset}\n`);
      return;
    }
    if (args.length === 0) {
      console.log(`${C.red}用法: /memory search <关键词>${C.reset}\n`);
      return;
    }
    const query = args.join(' ');
    const results = await epiMemory.search(query, 5);
    console.log('');
    console.log(`${C.bold}搜索结果 "${query}" (${results.length} 条):${C.reset}`);
    if (results.length === 0) {
      console.log(`  ${C.gray}（未找到相关记忆）${C.reset}`);
    }
    for (const r of results) {
      console.log(`  ${C.cyan}📅 ${r.day}${C.reset} (score: ${r.score})`);
      console.log(`  ${C.gray}${r.content.slice(0, 200)}${r.content.length > 200 ? '...' : ''}${C.reset}`);
      console.log('');
    }
    return;
  }

  // init 命令：初始化 L3 Curated 文件（幂等）
  if (sub === 'init') {
    if (!curMemory) {
      console.log(`${C.red}L3 Curated Memory 未初始化${C.reset}\n`);
      return;
    }
    await curMemory.init();
    const paths = curMemory.getFilePaths();
    console.log(`${C.green}✓ L3 Curated 文件已就绪:${C.reset}`);
    for (const [key, path] of Object.entries(paths)) {
      console.log(`  - ${C.bold}${key}${C.reset}: ${path}`);
    }
    console.log('');
    return;
  }

  // dream 命令：手动触发 Dreaming 晋升
  if (sub === 'dream') {
    const daysBack = args.length > 0 ? parseInt(args[0], 10) : undefined;
    if (daysBack !== undefined && (Number.isNaN(daysBack) || daysBack <= 0)) {
      console.log(`${C.red}用法: /memory dream [天数]（默认读取配置）${C.reset}\n`);
      return;
    }
    const { config: cfg } = configLoader.load();
    if (!cfg.memory.dreaming.enabled) {
      console.log(`${C.yellow}⚠ Dreaming 未启用，请在配置中设置 memory.dreaming.enabled=true${C.reset}\n`);
      return;
    }
    console.log(`${C.cyan}⏳ Dreaming 巡检开始（最近 ${daysBack ?? cfg.memory.dreaming.daysBack} 天）...${C.reset}`);
    try {
      const result = await agent.runDreaming(daysBack, (msg) => {
        console.log(`  ${C.gray}↳ ${msg}${C.reset}`);
      });
      if (!result) {
        console.log(`${C.red}Dreaming 未初始化（请检查记忆系统状态）${C.reset}\n`);
        return;
      }
      console.log('');
      console.log(`${C.bold}Dreaming 巡检结果:${C.reset}`);
      console.log(`  ${C.green}✓ 晋升 ${result.promoted.length} 条${C.reset}`);
      for (const p of result.promoted) {
        console.log(`    - [${p.provenance}] ${p.fact} → ${p.targetFile}`);
      }
      if (result.skipped.length > 0) {
        console.log(`  ${C.gray}⏸ 待确认 ${result.skipped.length} 条${C.reset}`);
        const gate = agent.promotionGate;
        for (const s of result.skipped) {
          const count = gate?.getCount(s.fact) ?? 0;
          console.log(`    - [${s.provenance}] ${s.fact} (确认 ${count} 次)`);
        }
      }
      if (result.errors.length > 0) {
        console.log(`  ${C.yellow}⚠ 错误 ${result.errors.length} 条${C.reset}`);
        for (const e of result.errors) {
          console.log(`    - ${e}`);
        }
      }
      if (result.promoted.length === 0 && result.skipped.length === 0) {
        console.log(`  ${C.gray}（近期无值得晋升的记忆）${C.reset}`);
      }
      console.log('');
    } catch (e) {
      console.error(`${C.red}Dreaming 执行异常: ${e instanceof Error ? e.message : String(e)}${C.reset}\n`);
    }
    return;
  }

  // gate 命令：查看 Promotion Gate 待处理事实
  if (sub === 'gate') {
    const gate = agent.promotionGate;
    if (!gate) {
      console.log(`${C.red}Promotion Gate 未初始化${C.reset}\n`);
      return;
    }
    const pending = gate.listPending();
    const approved = gate.listApproved();
    console.log('');
    console.log(`${C.bold}Promotion Gate 状态:${C.reset}`);
    console.log(`  ${C.cyan}待确认事实:${C.reset} ${pending.length} 条`);
    for (const p of pending) {
      console.log(`    - [${p.provenance}] ×${p.count} ${p.fact} → ${p.targetFile} (首次: ${p.firstSeen.slice(0, 10)})`);
    }
    console.log(`  ${C.green}已达阈值待晋升:${C.reset} ${approved.length} 条`);
    for (const a of approved) {
      console.log(`    - [${a.provenance}] ×${a.count} ${a.fact} → ${a.targetFile}`);
    }
    console.log(`  ${C.gray}提示: 已达阈值的事实会在下次 /memory dream 时写入 L3${C.reset}`);
    console.log('');
    return;
  }

  console.log(`${C.red}未知 /memory 子命令: ${sub}。支持 status / curated / episodic / search / dream / gate / init${C.reset}\n`);
  void rl;
}

async function main() {
  // 0. 加载合并配置
  const { config: cfg } = configLoader.load();

  // 1. 初始化会话系统（自动生成/加载密钥，用户无感）
  let sessionStore: SessionStore | null = null;
  let restoredMessages: ChatMessage[] | null = null;
  try {
    if (cfg.session.encryptionEnabled) {
      sessionStore = new SessionStore();
      await sessionStore.init();

      const isNewKey = !keychain.exists();
      if (isNewKey) {
        console.log(`${C.green}✓ 加密密钥已自动生成，会话数据将加密存储${C.reset}`);
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

  // 2. 注册内置工具（根据配置的 enabled/disabled 过滤）
  registerBuiltinTools(cfg.tools);

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
    renderMessages(restoredMessages);
  }

  // 8. 创建 readline 接口
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.bold}${C.cyan}Agent>${C.reset} `,
  });

  /** 是否有正在执行的 Agent 任务 */
  let running = false;
  /** readline 是否已关闭（管道输入期间异步命令未完成就退出时为 true） */
  let rlClosed = false;

  /** 安全 prompt：rl 已关闭时跳过，避免 ERR_USE_AFTER_CLOSE */
  const safePrompt = (): void => {
    if (!rlClosed) rl.prompt();
  };

  // 9. REPL 主循环
  safePrompt();

  rl.on('line', async (raw: string) => {
    const input = raw.trim();

    // 空输入直接继续
    if (!input) {
      safePrompt();
      return;
    }

    if (running) {
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

    // 命令分支：/config /mcp /tools
    if (lower.startsWith('/config')) {
      running = true;
      try {
        await handleConfig(input, rl);
      } catch (e) {
        console.error(`${C.bold}${C.red}[Error]${C.reset} /config 异常: ${e instanceof Error ? e.message : String(e)}\n`);
      } finally {
        running = false;
        safePrompt();
      }
      return;
    }

    if (lower.startsWith('/mcp')) {
      running = true;
      try {
        await handleMcp(input, rl);
      } catch (e) {
        console.error(`${C.bold}${C.red}[Error]${C.reset} /mcp 异常: ${e instanceof Error ? e.message : String(e)}\n`);
      } finally {
        running = false;
        safePrompt();
      }
      return;
    }

    if (lower.startsWith('/tools')) {
      running = true;
      try {
        await handleTools(input, rl);
      } catch (e) {
        console.error(`${C.bold}${C.red}[Error]${C.reset} /tools 异常: ${e instanceof Error ? e.message : String(e)}\n`);
      } finally {
        running = false;
        safePrompt();
      }
      return;
    }

    if (lower.startsWith('/skill')) {
      running = true;
      try {
        await handleSkill(input, rl);
      } catch (e) {
        console.error(`${C.bold}${C.red}[Error]${C.reset} /skill 异常: ${e instanceof Error ? e.message : String(e)}\n`);
      } finally {
        running = false;
        safePrompt();
      }
      return;
    }

    if (lower.startsWith('/session')) {
      running = true;
      try {
        // sessionStore 通过闭包传递（在 main() 中定义）
        await handleSession(input, rl, sessionStore);
      } catch (e) {
        console.error(`${C.bold}${C.red}[Error]${C.reset} /session 异常: ${e instanceof Error ? e.message : String(e)}\n`);
      } finally {
        running = false;
        safePrompt();
      }
      return;
    }

    if (lower.startsWith('/memory')) {
      running = true;
      try {
        await handleMemory(input, rl);
      } catch (e) {
        console.error(`${C.bold}${C.red}[Error]${C.reset} /memory 异常: ${e instanceof Error ? e.message : String(e)}\n`);
      } finally {
        running = false;
        safePrompt();
      }
      return;
    }

    // 否则执行 Agent
    running = true;
    try {
      const result = await agent.run(input, { verbose: cfg.agent.verbose });
      console.log(
        `\n${C.gray}(完成：${result.iterations} 轮迭代 / ${result.steps.length} 步工具 / ${result.messages.length} 条消息历史)${C.reset}\n`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
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
