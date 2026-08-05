// ReAct Agent CLI 入口：交互式 REPL
// 运行：npm run dev 或 npm start
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { agent } from './agent/react-agent.js';
import {
  registerBuiltinTools,
  registry,
  mcpManager,
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
import type { MCPServerConfig } from './tools/mcp/client.js';

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
  console.log('');
  console.log(`${C.gray}使用说明:${C.reset}`);
  console.log(`  ${C.bold}输入问题${C.reset}    → Agent 流式输出 Thought / Action / Observation / Final`);
  console.log(`  ${C.bold}/help${C.reset}         → 查看此帮助`);
  console.log(`  ${C.bold}/config${C.reset}       → 配置管理（get/set/delete/list/path）`);
  console.log(`  ${C.bold}/mcp${C.reset}          → MCP 管理（list/add/remove/reload/test）`);
  console.log(`  ${C.bold}/tools${C.reset}        → 工具管理（enable/disable/reload/list）`);
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
  console.log('');
  console.log(`  ${C.bold}消息历史:${C.reset} ${msgs.length} 条`);
  console.log(`  ${C.bold}内置工具:${C.reset} ${builtin.length} 个 (${builtin.map((t) => t.name).join(', ')})`);
  if (mcp.length > 0) {
    console.log(`  ${C.bold}MCP Server:${C.reset} ${mcpServers.join(', ') || '无'}`);
    console.log(`  ${C.bold}MCP 工具:${C.reset} ${mcp.length} 个`);
  } else {
    console.log(`  ${C.bold}MCP 工具:${C.reset} 未加载（可用 /mcp add 或写入配置后 /mcp reload）`);
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
    const { existsSync } = require('node:fs');
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
    const builtinNames = ['commandRun', 'fileRead', 'fileWrite', 'grep'];
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
        // 从 tools/ 直接 import 内置工具注册表
        const toolMap: Record<string, unknown> = {};
        const { commandRun, fileRead, fileWrite, grep } = require('./tools/index.js');
        toolMap.commandRun = commandRun;
        toolMap.fileRead = fileRead;
        toolMap.fileWrite = fileWrite;
        toolMap.grep = grep;
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

async function main() {
  // 0. 加载合并配置
  const { config: cfg } = configLoader.load();

  // 1. 注册内置工具（根据配置的 enabled/disabled 过滤）
  registerBuiltinTools(cfg.tools);

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

  // 3. 启动横幅
  printBanner();

  // 4. 创建 readline 接口
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.bold}${C.cyan}Agent>${C.reset} `,
  });

  /** 是否有正在执行的 Agent 任务 */
  let running = false;

  // 5. REPL 主循环
  rl.prompt();

  rl.on('line', async (raw: string) => {
    const input = raw.trim();

    // 空输入直接继续
    if (!input) {
      rl.prompt();
      return;
    }

    if (running) {
      console.log(`${C.yellow}⚠️  Agent 正在处理上一个请求，请稍候...${C.reset}`);
      rl.prompt();
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
      rl.prompt();
      return;
    }

    if (lower === '/reset' || lower === '/clear') {
      agent.resetSession();
      console.log(`${C.bold}${C.green}✓ 会话历史已清空，开始新对话${C.reset}\n`);
      rl.prompt();
      return;
    }

    if (lower === '/status') {
      printStatus();
      rl.prompt();
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
        rl.prompt();
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
        rl.prompt();
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
        rl.prompt();
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
      rl.prompt();
    }
  });

  rl.on('SIGINT', async () => {
    await mcpManager.disconnectAll().catch(() => {});
    console.log('');
    rl.close();
  });

  rl.on('close', () => {
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
