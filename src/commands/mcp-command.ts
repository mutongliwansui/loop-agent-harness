// /mcp 命令处理器
// 支持: list, add <name>, remove <name> [--workspace|--global], reload, test <name>
import {
  ConfigWriter,
  type ConfigScope,
  type PartialAgentConfig,
  type ToolsConfig,
} from '../config/index.js';
import { normalizeMcpTransportType } from '../tools/index.js';
import type {
  MCPServerConfig,
  StdioConfig,
  SSEConfig,
  StreamableHttpConfig,
} from '../tools/index.js';
import { COLORS } from '../ui/colors.js';
import { parseScope } from './utils.js';
import type { CommandContext, CommandHandler } from './registry.js';

/** 渲染单个 MCP Server 的配置摘要（headers 仅列键名，脱敏，D7） */
export function describeServer(s: MCPServerConfig): string {
  const type = normalizeMcpTransportType(String((s as { type?: unknown }).type ?? ''));
  if (type === 'stdio') {
    const c = s as StdioConfig;
    return `stdio: ${c.command} ${(c.args ?? []).join(' ')}`.trim();
  }
  if (type === 'sse') {
    return `sse（已废弃）: ${(s as SSEConfig).url}`;
  }
  if (type === 'streamableHttp') {
    const c = s as StreamableHttpConfig;
    const keys = c.headers ? Object.keys(c.headers) : [];
    const h = keys.length > 0 ? ` headers: [${keys.join(', ')}]` : '';
    return `streamableHttp: ${c.url}${h}`;
  }
  return `${String((s as { type?: unknown }).type)}:（未知传输类型）`;
}

/** 交互式添加 MCP Server */
async function interactiveAddMcp(
  rl: CommandContext['rl'],
  name: string,
  scope: ConfigScope,
  ctx: CommandContext,
): Promise<void> {
  const { out, configWriter, mcpManager } = ctx;
  out.blank();
  out.log(`${COLORS.bold}添加 MCP Server: ${name} (写入 ${scope === 'workspace' ? '工作空间' : '全局'} 配置)${COLORS.reset}`);

  const q = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  const typeRaw = await q(`传输类型 (stdio/sse/http, 默认 stdio): `).then((s) => s.trim() || 'stdio');
  const transport = normalizeMcpTransportType(typeRaw);
  if (!transport) {
    out.log(`${COLORS.red}传输类型必须是 stdio / sse / http，已取消${COLORS.reset}`);
    out.blank();
    return;
  }

  let cfg: MCPServerConfig;
  if (transport === 'stdio') {
    const command = await q(`可执行命令 (如 npx / python): `).then((s) => s.trim());
    if (!command) { out.log(`${COLORS.red}命令不能为空${COLORS.reset}`); out.blank(); return; }
    const argsRaw = await q(`参数 (空格分隔，如 -y pkg): `).then((s) => s.trim());
    const args = argsRaw ? argsRaw.split(/\s+/) : [];
    cfg = { type: 'stdio', command, args };
  } else if (transport === 'sse') {
    // sse 已废弃（规范自 2025-03-26 起由 Streamable HTTP 取代），保留仅为兼容存量服务
    const url = await q(`SSE URL（已废弃，建议改用 http）: `).then((s) => s.trim());
    if (!url) { out.log(`${COLORS.red}URL 不能为空${COLORS.reset}`); out.blank(); return; }
    cfg = { type: 'sse', url };
  } else {
    const url = await q(`HTTP URL (Streamable HTTP 端点，如 https://host/mcp): `).then((s) => s.trim());
    if (!url) { out.log(`${COLORS.red}URL 不能为空${COLORS.reset}`); out.blank(); return; }
    const headerRaw = await q(`认证头 (如 Authorization: Bearer xxx，留空跳过): `).then((s) => s.trim());
    let headers: Record<string, string> | undefined;
    if (headerRaw) {
      const sep = headerRaw.indexOf(':');
      if (sep <= 0) {
        out.log(`${COLORS.red}认证头格式应为 "Key: Value"，已取消${COLORS.reset}`);
        out.blank();
        return;
      }
      headers = { [headerRaw.slice(0, sep).trim()]: headerRaw.slice(sep + 1).trim() };
    }
    cfg = headers ? { type: 'streamableHttp', url, headers } : { type: 'streamableHttp', url };
  }

  out.log(`${COLORS.gray}正在测试连接...${COLORS.reset}`);
  const test = await mcpManager.testServer(name, cfg);
  if (!test.ok) {
    out.log(`${COLORS.red}✗${COLORS.reset} 测试连接失败: ${test.message}`);
    const force = await q(`仍然写入配置吗？(y/N): `).then((s) => s.trim().toLowerCase());
    if (force !== 'y') {
      out.log(`${COLORS.gray}已取消${COLORS.reset}`);
      out.blank();
      return;
    }
  } else {
    out.log(`${COLORS.green}✓${COLORS.reset} ${test.message}`);
  }

  const partial: PartialAgentConfig = { tools: {} };
  (partial.tools as ToolsConfig).mcpServers = { [name]: cfg };
  try {
    await configWriter.updateScope(scope, partial);
    out.log(`${COLORS.green}✓${COLORS.reset} 已写入 ${scope === 'workspace' ? '工作空间' : '全局'} 配置`);
    if (test.ok) {
      await mcpManager.loadServers({ [name]: cfg });
      out.log(`${COLORS.green}✓${COLORS.reset} ${name} 已加载并注册工具`);
      out.blank();
    } else {
      out.blank();
    }
  } catch (e) {
    out.error(`${COLORS.bold}${COLORS.red}[Error]${COLORS.reset} 写入失败: ${e instanceof Error ? e.message : String(e)}`);
    out.blank();
  }
}

export const mcpCommand: CommandHandler = {
  name: '/mcp',
  description: 'MCP 管理（list/add/remove/reload/test）',
  subcommands: ['list', 'add', 'remove', 'reload', 'test'],
  match: (input) => input.toLowerCase().startsWith('/mcp'),
  async execute(input, ctx) {
    const { out, configLoader, configWriter, mcpManager, rl } = ctx;
    const parts = input.split(/\s+/);
    const sub = parts[1] ?? 'list';
    const args = parts.slice(2);

    if (sub === 'list') {
      const { config: cfg } = configLoader.load();
      const servers = cfg.tools.mcpServers;
      const connected = mcpManager.listConnected();
      out.blank();
      out.log(`${COLORS.bold}MCP Server 配置:${COLORS.reset}`);
      if (Object.keys(servers).length === 0) {
        out.log(`  ${COLORS.gray}（暂无，可用 /mcp add 添加）${COLORS.reset}`);
      }
      for (const [name, s] of Object.entries(servers)) {
        const conn = connected.includes(name) ? `${COLORS.green}[已连接]${COLORS.reset}` : `${COLORS.red}[未连接]${COLORS.reset}`;
        const detail = describeServer(s);
        out.log(`  - ${COLORS.bold}${name}${COLORS.reset} ${conn} ${COLORS.gray}(${detail})${COLORS.reset}`);
      }
      out.blank();
      return;
    }

    if (sub === 'reload') {
      out.blank();
      out.log(`${COLORS.gray}重新加载 MCP 配置...${COLORS.reset}`);
      const res = await mcpManager.reload();
      for (const s of res.successes) out.log(`  ${COLORS.green}✓${COLORS.reset} ${s}`);
      for (const s of res.failures) out.log(`  ${COLORS.red}✗${COLORS.reset} ${s}`);
      out.blank();
      return;
    }

    if (sub === 'remove') {
      if (args.length === 0) {
        out.log(`${COLORS.red}用法: /mcp remove <name> [--workspace|--global]${COLORS.reset}`);
        out.blank();
        return;
      }
      const { scope, rest } = parseScope(args);
      const name = rest[0];
      const key = `tools.mcpServers.${name}`;
      try {
        await configWriter.deleteScopeKey(scope, ConfigWriter.parseKey(key));
        await mcpManager.unloadServer(name);
        out.log(`${COLORS.bold}${COLORS.green}✓${COLORS.reset} 已从 ${scope} 配置删除并卸载 MCP Server: ${name}`);
        out.blank();
      } catch (e) {
        out.error(`${COLORS.bold}${COLORS.red}[Error]${COLORS.reset} 删除失败: ${e instanceof Error ? e.message : String(e)}`);
        out.blank();
      }
      return;
    }

    if (sub === 'test') {
      if (args.length === 0) {
        out.log(`${COLORS.red}用法: /mcp test <name>${COLORS.reset}`);
        out.blank();
        return;
      }
      const name = args[0];
      const { config: cfg } = configLoader.load();
      const s = cfg.tools.mcpServers[name];
      if (!s) {
        out.log(`${COLORS.red}MCP Server ${name} 未在配置中找到，请先 /mcp add 或写入配置${COLORS.reset}`);
        out.blank();
        return;
      }
      out.blank();
      out.log(`${COLORS.gray}测试连接 MCP Server: ${name}${COLORS.reset}`);
      const res = await mcpManager.testServer(name, s);
      if (res.ok) {
        out.log(`  ${COLORS.green}✓${COLORS.reset} ${res.message}`);
      } else {
        out.log(`  ${COLORS.red}✗${COLORS.reset} ${res.message}`);
      }
      out.blank();
      return;
    }

    if (sub === 'add') {
      if (args.length === 0) {
        out.log(`${COLORS.red}用法: /mcp add <name> [--workspace|--global]${COLORS.reset}`);
        out.blank();
        return;
      }
      const { scope, rest } = parseScope(args);
      const name = rest[0];
      await interactiveAddMcp(rl, name, scope, ctx);
      return;
    }

    out.log(`${COLORS.red}未知 /mcp 子命令: ${sub}。支持 list / add / remove / reload / test${COLORS.reset}`);
    out.blank();
  },
};
