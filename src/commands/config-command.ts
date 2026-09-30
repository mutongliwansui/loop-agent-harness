// /config 命令处理器
// 支持: list, get <key>, set <key> <value> [--workspace|--global],
//       delete <key> [--workspace|--global], path
import { existsSync } from 'node:fs';
import {
  ConfigWriter,
  type ConfigSource,
  type PartialAgentConfig,
} from '../config/index.js';
import { COLORS, sourceColor } from '../ui/colors.js';
import { parseScope, parseValue } from './utils.js';
import type { CommandContext, CommandHandler } from './registry.js';

/** 递归打印配置层（带来源着色） */
function printConfigLayer(obj: Record<string, unknown>, sources: Record<string, ConfigSource>, prefix: string, out: CommandContext['out']): void {
  const keys = Object.keys(obj).sort();
  for (const k of keys) {
    const flat = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    const src = sources[flat];
    const tag = src ? ` ${COLORS.gray}(${sourceColor(src)}${src}${COLORS.reset}${COLORS.gray})${COLORS.reset}` : '';
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      out.log(`  ${COLORS.cyan}${flat}${COLORS.reset}:${tag}`);
      printConfigLayer(v as Record<string, unknown>, sources, flat, out);
    } else {
      const pretty = JSON.stringify(v);
      out.log(`  ${COLORS.white}${flat}${COLORS.reset} = ${pretty}${tag}`);
    }
  }
}

export const configCommand: CommandHandler = {
  name: '/config',
  description: '配置管理（list/get/set/delete/path）',
  subcommands: ['list', 'get', 'set', 'delete', 'path'],
  match: (input) => input.toLowerCase().startsWith('/config'),
  async execute(input, ctx) {
    const { out } = ctx;
    const parts = input.split(/\s+/);
    const sub = parts[1] ?? 'list';
    const args = parts.slice(2);

    if (sub === 'list') {
      const { config: cfg, sources } = ctx.configLoader.load();
      out.blank();
      out.log(`${COLORS.bold}当前生效配置 (含来源标注):${COLORS.reset}`);
      printConfigLayer(cfg as unknown as Record<string, unknown>, sources, '', out);
      out.blank();
      return;
    }

    if (sub === 'get') {
      if (args.length === 0) {
        out.log(`${COLORS.red}用法: /config get <key>（如 model.name）${COLORS.reset}`);
        out.blank();
        return;
      }
      const key = args[0];
      const { config: cfg, sources } = ctx.configLoader.load();
      const val = ConfigWriter.getByKey(cfg as unknown as Record<string, unknown>, key);
      const source = sources[key];
      out.blank();
      out.log(`  ${COLORS.bold}${key}${COLORS.reset} = ${JSON.stringify(val, null, 2)}`);
      if (source) out.log(`  ${COLORS.gray}来源: ${sourceColor(source)}${source}${COLORS.reset}`);
      out.blank();
      return;
    }

    if (sub === 'set') {
      if (args.length < 2) {
        out.log(`${COLORS.red}用法: /config set <key> <value> [--workspace|--global]${COLORS.reset}`);
        out.blank();
        return;
      }
      const { scope, rest } = parseScope(args);
      const key = rest[0];
      const valueRaw = rest.slice(1).join(' ');
      const value = parseValue(valueRaw);

      const partial: PartialAgentConfig = {};
      ConfigWriter.setByKey(partial as Record<string, unknown>, key, value);
      try {
        await ctx.configWriter.updateScope(scope, partial);
        out.log(`${COLORS.bold}${COLORS.green}✓ 已写入${COLORS.reset} ${COLORS.bold}${scope === 'workspace' ? '工作空间' : '全局'}${COLORS.reset} 配置: ${key} = ${JSON.stringify(value)}`);
        out.blank();
      } catch (e) {
        out.error(`${COLORS.bold}${COLORS.red}[Error]${COLORS.reset} 写入失败: ${e instanceof Error ? e.message : String(e)}`);
        out.blank();
      }
      return;
    }

    if (sub === 'delete') {
      if (args.length === 0) {
        out.log(`${COLORS.red}用法: /config delete <key> [--workspace|--global]${COLORS.reset}`);
        out.blank();
        return;
      }
      const { scope, rest } = parseScope(args);
      const key = rest[0];
      try {
        await ctx.configWriter.deleteScopeKey(scope, ConfigWriter.parseKey(key));
        out.log(`${COLORS.bold}${COLORS.green}✓ 已从 ${scope === 'workspace' ? '工作空间' : '全局'} 配置删除: ${key}${COLORS.reset}`);
        out.blank();
      } catch (e) {
        out.error(`${COLORS.bold}${COLORS.red}[Error]${COLORS.reset} 删除失败: ${e instanceof Error ? e.message : String(e)}`);
        out.blank();
      }
      return;
    }

    if (sub === 'path') {
      out.blank();
      const wp = ctx.configLoader.workspaceConfigPath;
      const gp = ctx.configLoader.globalConfigPath;
      out.log(`  ${COLORS.bold}工作空间:${COLORS.reset} ${wp} ${existsSync(wp) ? `${COLORS.green}[存在]${COLORS.reset}` : `${COLORS.gray}[不存在]${COLORS.reset}`}`);
      out.log(`  ${COLORS.bold}全局:${COLORS.reset}     ${gp} ${existsSync(gp) ? `${COLORS.green}[存在]${COLORS.reset}` : `${COLORS.gray}[不存在]${COLORS.reset}`}`);
      out.blank();
      return;
    }

    out.log(`${COLORS.red}未知 /config 子命令: ${sub}。支持 list / get / set / delete / path${COLORS.reset}`);
    out.blank();
  },
};
