// /config 命令处理器
// 支持: list, get <key>, set <key> <value> [--workspace|--global],
//       delete <key> [--workspace|--global], path
import { existsSync } from 'node:fs';
import {
  ConfigWriter,
  type ConfigSource,
  type PartialAgentConfig,
} from '../config/index.js';
import { registerBuiltinTools } from '../tools/index.js';
import { VISION_TOOL_NAMES } from '../tools/vision/tools.js';
import { COLORS, sourceColor } from '../ui/colors.js';
import { parseScope, parseValue } from './utils.js';
import type { CommandContext, CommandHandler } from './registry.js';

/**
 * vision.enabled 写入/删除后立即同步视觉工具注册（与 /tools reload 的内置工具语义一致，免去手动重载）
 * - 生效值为 true：按 tools.enabled/disabled 过滤注册尚未注册的工具
 * - 生效值非 true：注销全部视觉工具（其余内置工具不受影响）
 */
function syncVisionTools(ctx: CommandContext): void {
  const { config: cfg } = ctx.configLoader.load();
  if (cfg.vision.enabled === true) {
    const before = new Set(ctx.registry.list().map((t) => t.name));
    registerBuiltinTools(cfg.tools, cfg.vision);
    const added = VISION_TOOL_NAMES.filter((n) => !before.has(n));
    if (added.length > 0) {
      ctx.out.log(`  ${COLORS.green}✓ 已自动注册视觉工具: ${added.join(', ')}${COLORS.reset}`);
    }
  } else {
    const removed = VISION_TOOL_NAMES.filter((n) => ctx.registry.has(n));
    for (const n of removed) ctx.registry.unregister(n);
    if (removed.length > 0) {
      ctx.out.log(`  ${COLORS.gray}✓ 已自动注销视觉工具: ${removed.join(', ')}${COLORS.reset}`);
    }
  }
}

/**
 * 深度遮蔽 apiKey / token 字段（Task-20261011-002 D8：仅保留尾 4 位）。
 * profiles 引入多份 apiKey 副本后，list/get 展示必须全链路遮蔽；
 * 顺带修复既有 model.apiKey / vision.apiKey 明文打印问题。返回遮蔽副本，不改原值。
 * Task-20261016-001 D7：api.token 同为敏感凭据，纳入遮蔽。
 */
function maskSecretsDeep(v: unknown, key = ''): unknown {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = maskSecretsDeep(val, k);
    }
    return out;
  }
  if (key === 'apiKey' || key === 'token') {
    return typeof v === 'string' && v.length > 0 ? `****${v.slice(-4)}` : v;
  }
  return v;
}

/**
 * 将配置对象扁平化为点路径「叶子键」列表（用于 /config get|set|delete 的 Tab 补全）。
 * - 仅递归普通对象；数组、null 与原始值一律视为叶子（与 printConfigLayer 展示口径一致）
 * - 空对象不产出候选（如未登记任何 profile 的 models.profiles）
 * - 结果按字典序排序，保证补全候选顺序稳定
 */
export function flattenConfigKeys(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return prefix ? [prefix] : [];
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const flat = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      out.push(...flattenConfigKeys(v, flat));
    } else {
      out.push(flat);
    }
  }
  return out.sort();
}

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
      const pretty = k === 'apiKey' ? JSON.stringify(maskSecretsDeep(v, k)) : JSON.stringify(v);
      out.log(`  ${COLORS.white}${flat}${COLORS.reset} = ${pretty}${tag}`);
    }
  }
}

export const configCommand: CommandHandler = {
  name: '/config',
  description: '配置管理（list/get/set/delete/path）',
  subcommands: ['list', 'get', 'set', 'delete', 'path', 'help'],
  subcommandHelp: {
    list: '列出全部配置项（含来源）',
    get: '读取指定配置项，如 /config get model.name',
    set: '设置配置项（--workspace|--global 指定写入层级）',
    delete: '删除配置项（--workspace|--global）',
    path: '显示全局 / 工作空间配置文件路径',
  },
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
      const leafKey = key.split('.').pop() ?? '';
      out.blank();
      out.log(`  ${COLORS.bold}${key}${COLORS.reset} = ${JSON.stringify(maskSecretsDeep(val, leafKey), null, 2)}`);
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
        if (key === 'vision.enabled') syncVisionTools(ctx);
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
        if (key === 'vision.enabled') syncVisionTools(ctx);
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
