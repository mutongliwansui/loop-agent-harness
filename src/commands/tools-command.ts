// /tools 命令处理器 (enable/disable/reload/list)
import {
  registerBuiltinTools,
  commandRun,
  fileRead,
  fileWrite,
  editFile,
  grep,
  activateSkill,
} from '../tools/index.js';
import type { PartialAgentConfig } from '../config/index.js';
import { COLORS } from '../ui/colors.js';
import { printTools } from '../ui/renderer.js';
import { parseScope } from './utils.js';
import type { CommandContext, CommandHandler } from './registry.js';

export const toolsCommand: CommandHandler = {
  name: '/tools',
  description: '工具管理（list/enable/disable/reload）',
  match: (input) => input.toLowerCase().startsWith('/tools'),
  async execute(input, ctx) {
    const { out, configLoader, configWriter, registry, mcpManager } = ctx;
    const parts = input.split(/\s+/);
    const sub = parts[1] ?? 'list';
    const args = parts.slice(2);

    if (sub === 'list') {
      const allTools = registry.list();
      printTools(allTools.map((t) => ({
        name: t.name,
        description: t.description,
        isMCP: t.name.includes('__'),
      })));
      return;
    }

    if (sub === 'reload') {
      const { config: cfg } = configLoader.load();
      await mcpManager.disconnectAll();
      registry.clear();
      const built = registerBuiltinTools(cfg.tools);
      const mcp = await mcpManager.loadFromConfig();
      out.blank();
      out.log(`${COLORS.green}✓${COLORS.reset} 工具重新加载完成`);
      out.log(`  内置: ${built.length} 个 (${built.join(', ')})`);
      if (mcp.successes.length) out.log(`  MCP 成功: ${mcp.successes.join(', ')}`);
      if (mcp.failures.length) out.log(`  MCP 失败: ${mcp.failures.join(', ')}`);
      out.blank();
      return;
    }

    if (sub === 'enable' || sub === 'disable') {
      if (args.length === 0) {
        out.log(`${COLORS.red}用法: /tools ${sub} <name> [--workspace|--global]${COLORS.reset}`);
        out.blank();
        return;
      }
      const { scope, rest } = parseScope(args);
      const toolName = rest[0];
      const builtinNames = ['commandRun', 'fileRead', 'fileWrite', 'editFile', 'grep', 'activateSkill'];
      if (!builtinNames.includes(toolName)) {
        out.log(`${COLORS.yellow}⚠️  /tools enable/disable 仅用于内置工具（commandRun/fileRead/fileWrite/editFile/grep/activateSkill），MCP 工具使用 /mcp remove${COLORS.reset}`);
        out.blank();
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
        const ei = enabled.indexOf(toolName);
        if (ei >= 0) enabled.splice(ei, 1);
        if (!disabled.includes(toolName)) disabled.push(toolName);
      }

      const partial: PartialAgentConfig = {
        tools: { enabled, disabled },
      };
      try {
        await configWriter.updateScope(scope, partial);
        if (sub === 'enable') {
          const toolMap: Record<string, unknown> = { commandRun, fileRead, fileWrite, editFile, grep, activateSkill };
          const t = toolMap[toolName];
          if (t && !registry.has(toolName)) registry.register(t as never);
        } else {
          if (registry.has(toolName)) registry.unregister(toolName);
        }
        out.log(`${COLORS.bold}${COLORS.green}✓${COLORS.reset} 已写入 ${scope} 配置并${sub === 'enable' ? '启用' : '禁用'}工具: ${toolName}`);
        out.blank();
      } catch (e) {
        out.error(`${COLORS.bold}${COLORS.red}[Error]${COLORS.reset} 写入失败: ${e instanceof Error ? e.message : String(e)}`);
        out.blank();
      }
      return;
    }

    out.log(`${COLORS.red}未知 /tools 子命令: ${sub}。支持 list / enable / disable / reload${COLORS.reset}`);
    out.blank();
  },
};
