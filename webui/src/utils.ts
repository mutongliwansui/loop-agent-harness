// 共享小工具（P1 管理台各视图复用）

/** 错误 → 展示文本（AuthError 由调用方先行短路，不走这里） */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 尝试把输入解析为 JSON（对象/数组/数字/布尔/null），失败则按原始字符串返回 */
export function parseLoose(raw: string): unknown {
  const s = raw.trim();
  if (s === '') return '';
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return raw;
  }
}

/** 值 → 单行展示文本（字符串原样，其余 JSON 序列化） */
export function displayValue(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}
