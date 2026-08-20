// 统一 ANSI 颜色码定义
// logger.ts 和 index.ts 共用此定义，避免重复

export const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
} as const;

/** 来源着色 */
export function sourceColor(s: string): string {
  switch (s) {
    case 'cli': return COLORS.red;
    case 'workspace': return COLORS.green;
    case 'global': return COLORS.magenta;
    case 'env': return COLORS.yellow;
    default: return COLORS.gray;
  }
}
