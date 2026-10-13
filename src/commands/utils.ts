// 命令处理器共用的工具函数
import type { ConfigScope } from '../config/index.js';

/** 解析命令行 flag：--workspace / --global（explicit 标记用户是否显式指定了 flag） */
export function parseScope(args: string[]): { scope: ConfigScope; rest: string[]; explicit: boolean } {
  let scope: ConfigScope = 'workspace';
  let explicit = false;
  const rest: string[] = [];
  for (const a of args) {
    if (a === '--workspace') { scope = 'workspace'; explicit = true; }
    else if (a === '--global') { scope = 'global'; explicit = true; }
    else rest.push(a);
  }
  return { scope, rest, explicit };
}

/** 从字符串解析配置值（支持 JSON / number / boolean） */
export function parseValue(raw: string): unknown {
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
