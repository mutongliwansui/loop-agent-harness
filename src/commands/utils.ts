// 命令处理器共用的工具函数
//
// 需求 20261112-008（D10）：配置作用域收敛为全局，--workspace 已移除。
// 保留 flag 的解析位置（命中即错误），让旧习惯用户得到「已移除」的明确反馈，
// 而不是「未知参数」的误导。

/** --workspace 命中的标准错误文案（各命令复用） */
export const WORKSPACE_FLAG_REMOVED =
  '工作空间级配置已移除（需求 20261112-008），配置一律为全局。请去掉 --workspace 后重试（--global 可省略）。';

export interface ParsedScopeArgs {
  /** 是否命中已移除的 --workspace（调用方应输出 WORKSPACE_FLAG_REMOVED 并中止） */
  workspaceFlag: boolean;
  /** 是否显式传了 --global（仅用于提示文案，行为一致） */
  explicit: boolean;
  /** 去掉 scope flag 后的剩余参数 */
  rest: string[];
}

/** 解析命令行 flag：--global 忽略，--workspace 标记为错误（explicit 标记用户是否显式指定） */
export function parseScope(args: string[]): ParsedScopeArgs {
  let workspaceFlag = false;
  let explicit = false;
  const rest: string[] = [];
  for (const a of args) {
    if (a === '--workspace') { workspaceFlag = true; explicit = true; }
    else if (a === '--global') { explicit = true; }
    else rest.push(a);
  }
  return { workspaceFlag, explicit, rest };
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
