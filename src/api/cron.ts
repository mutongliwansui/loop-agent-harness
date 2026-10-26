// 5 字段 crontab 表达式引擎（Task-20261026-003-01 / 方案 D1）
//
// 为什么自写而不是引库（方案 §三 联网调研结论）：
// - croner 10.0.1：功能溢出（L/#/时区）+ 154KB + 需进 SEA 打包链
// - cron-parser 5.10.2：拖 luxon（完整时区库），与「零依赖优先」冲突
// - node-cron 4.6.0：327KB，面向长驻分布式任务，其 overlap 协调本场景用不到
// 自写约 200 行 + 单测，零新依赖、零 SEA 打包风险、错误消息可中文化、行为可精确断言。
//
// 语义约定（对齐 vixie cron）：
// - 字段顺序：分 时 日 月 周（无秒；触发点一律落在整分）
// - day-of-month 与 day-of-week **同时受限**时取**并集**（`0 3 1 * 1` = 每月 1 日 03:00 或每周一 03:00）
// - 周字段 0 与 7 都表示周日，解析时归一化 7 → 0
// - `*/n` 从字段最小值起步行进（`*/7` 分 = 0,7,…,56）；`a/n` 从 a 起步行进（`5/10` = 5,15,…,55）
// - 时区一律**服务器本地时区**（方案 D3），不引 IANA 库
// - 不支持 `L/W/#/?` 与 6 字段秒级语法，解析期即报中文错误
//
// 已知坑（方案 §三）：
// 1) setTimeout 上限 24.8 天 → 调度器侧分片等待（D4，不在本模块）
// 3) DST 回拨同一墙钟分钟出现两次 → 调度器侧用 localMinuteKey() 去重
// 4) DST 前拨某些墙钟时刻不存在 → 本模块候选构造后回读校验，不存在即跳过
// 5) `0 0 29 2 *` 四年一次 → 搜索上限 MAX_SEARCH_DAYS=1461 天，超出判定「永不触发」

/** 解析后的 cron 字段（各数组均已排序去重） */
export interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  /** 0-6（周日=0；输入 7 已归一化为 0） */
  dayOfWeek: number[];
  /** 日字段是否被显式限制（非 `*`）——并集语义判定用 */
  domRestricted: boolean;
  /** 周字段是否被显式限制（非 `*`）——并集语义判定用 */
  dowRestricted: boolean;
  /** 归一化后的 5 字段表达式（宏已展开） */
  expr: string;
}

export type ParseResult =
  | { ok: true; fields: CronFields }
  | { ok: false; error: string; fieldIndex?: number };

/** 宏别名（vixie cron 标准 5 个） */
const MACROS: Readonly<Record<string, string>> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
/** 中文星期（describeCron 用） */
const DOW_CN = ['日', '一', '二', '三', '四', '五', '六'];

/** 各字段元信息：名称 / 最小值 / 最大值 / 名称表 / 名称基偏移 / 全量取值个数 */
interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** 名称索引 → 数值的偏移（月份名称 0 基 → 数值 1 基，偏移 +1；周名称偏移 0） */
  nameOffset: number;
  /** 「未限制」判定用的全量取值个数（周字段 0-7 实为 7 个不同值） */
  fullCount: number;
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { name: '分钟', min: 0, max: 59, nameOffset: 0, fullCount: 60 },
  { name: '小时', min: 0, max: 23, nameOffset: 0, fullCount: 24 },
  { name: '日', min: 1, max: 31, nameOffset: 0, fullCount: 31 },
  { name: '月', min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1, fullCount: 12 },
  { name: '星期', min: 0, max: 7, names: DOW_NAMES, nameOffset: 0, fullCount: 7 },
];

/** 从 fromMs 起最多向后搜索的天数（4 年 + 1 天，覆盖 2 月 29 日） */
const MAX_SEARCH_DAYS = 1461;
/** 多次预览时的绝对搜索上限（40 年），避免异常表达式把请求拖成长任务 */
const MAX_TOTAL_DAYS = 14_610;

/** 名称 → 数字（大小写不敏感；未命中返回 null） */
function nameToNumber(raw: string, names?: string[]): number | null {
  if (!names) return null;
  const up = raw.toUpperCase();
  const idx = names.indexOf(up);
  return idx < 0 ? null : idx;
}

/** 解析单个数字项（支持 3 字母名称） */
function parseNumber(raw: string, spec: FieldSpec): { ok: true; value: number } | { ok: false } {
  const byName = nameToNumber(raw, spec.names);
  if (byName !== null) return { ok: true, value: byName + spec.nameOffset };
  if (!/^\d+$/.test(raw)) return { ok: false };
  return { ok: true, value: Number(raw) };
}

/**
 * 解析单个字段为数值集合（已排序去重）。
 * 返回 `restricted=false` 表示该字段为 `*`（未限制）。
 */
function parseField(
  raw: string,
  spec: FieldSpec,
  fieldIndex: number,
): { ok: true; values: number[]; restricted: boolean } | { ok: false; error: string; fieldIndex: number } {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, error: `第 ${fieldIndex + 1} 个字段（${spec.name}）为空`, fieldIndex };
  }
  // 明确不支持的扩展语法，给可操作的中文提示（方案 D1）
  const unsupported = /[LW#?]/i.exec(trimmed);
  if (unsupported) {
    return {
      ok: false,
      error: `第 ${fieldIndex + 1} 个字段（${spec.name}）不支持 L/W/#/? 扩展语法`,
      fieldIndex,
    };
  }

  const out = new Set<number>();
  for (const part of trimmed.split(',')) {
    const seg = part.trim();
    if (seg === '') {
      return { ok: false, error: `第 ${fieldIndex + 1} 个字段（${spec.name}）存在空项`, fieldIndex };
    }

    // 拆出 /step
    const slash = seg.indexOf('/');
    const rangePart = slash < 0 ? seg : seg.slice(0, slash);
    const stepPart = slash < 0 ? null : seg.slice(slash + 1);

    let step = 1;
    if (stepPart !== null) {
      if (!/^\d+$/.test(stepPart)) {
        return {
          ok: false,
          error: `第 ${fieldIndex + 1} 个字段（${spec.name}）的步长「${stepPart}」不是正整数`,
          fieldIndex,
        };
      }
      step = Number(stepPart);
      if (step <= 0) {
        return {
          ok: false,
          error: `第 ${fieldIndex + 1} 个字段（${spec.name}）的步长必须 ≥ 1`,
          fieldIndex,
        };
      }
    }

    let from: number;
    let to: number;
    if (rangePart === '*') {
      from = spec.min;
      to = spec.max;
    } else if (rangePart.includes('-')) {
      const [a, b, ...rest] = rangePart.split('-');
      if (rest.length > 0) {
        return {
          ok: false,
          error: `第 ${fieldIndex + 1} 个字段（${spec.name}）的区间「${rangePart}」格式非法`,
          fieldIndex,
        };
      }
      const pa = parseNumber(a.trim(), spec);
      const pb = parseNumber(b.trim(), spec);
      if (!pa.ok || !pb.ok) {
        return {
          ok: false,
          error: `第 ${fieldIndex + 1} 个字段（${spec.name}）的区间「${rangePart}」含非法数值`,
          fieldIndex,
        };
      }
      from = pa.value;
      to = pb.value;
      if (from > to) {
        return {
          ok: false,
          error: `第 ${fieldIndex + 1} 个字段（${spec.name}）的区间「${rangePart}」起始值大于结束值`,
          fieldIndex,
        };
      }
    } else {
      const pv = parseNumber(rangePart.trim(), spec);
      if (!pv.ok) {
        return {
          ok: false,
          error: `第 ${fieldIndex + 1} 个字段（${spec.name}）含非法值「${rangePart}」`,
          fieldIndex,
        };
      }
      from = pv.value;
      // `a/n` = 从 a 起步行进到字段上界
      to = stepPart !== null ? spec.max : pv.value;
    }

    if (from < spec.min || from > spec.max) {
      return {
        ok: false,
        error: `第 ${fieldIndex + 1} 个字段（${spec.name}）超出范围 ${spec.min}-${spec.max}：${from}`,
        fieldIndex,
      };
    }
    if (to < spec.min || to > spec.max) {
      return {
        ok: false,
        error: `第 ${fieldIndex + 1} 个字段（${spec.name}）超出范围 ${spec.min}-${spec.max}：${to}`,
        fieldIndex,
      };
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }

  const values = [...out].sort((a, b) => a - b);
  if (values.length === 0) {
    return {
      ok: false,
      error: `第 ${fieldIndex + 1} 个字段（${spec.name}）没有匹配到任何值`,
      fieldIndex,
    };
  }
  // 周字段 7 归一化为 0（坑 7）
  const normalized = spec.name === '星期' ? [...new Set(values.map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b) : values;
  // `*`、`*/1`、`a-b` 覆盖整段 都视为「未限制」——并集语义只看是否等价于全域
  const unrestricted =
    trimmed === '*' || (normalized.length >= spec.fullCount && normalized[0] === spec.min);
  return { ok: true, values: normalized, restricted: !unrestricted };
}

/**
 * 解析 5 字段 cron 表达式。
 * 失败返回 `{ok:false, error, fieldIndex}`（fieldIndex 0 基），错误文案为中文且指出字段与期望范围。
 */
export function parseCron(expr: string): ParseResult {
  const raw = (expr ?? '').trim();
  if (raw === '') return { ok: false, error: 'cron 表达式为空' };

  const lower = raw.toLowerCase();
  const expanded = MACROS[lower] ?? raw;
  const parts = expanded.trim().split(/\s+/);
  if (parts.length === 6) {
    return { ok: false, error: '仅支持 5 字段（分 时 日 月 周），不支持 6 字段秒级表达式' };
  }
  if (parts.length !== 5) {
    return { ok: false, error: `cron 表达式必须为 5 个字段（分 时 日 月 周），实际 ${parts.length} 个：${expanded}` };
  }

  const cols: number[][] = [];
  let domRestricted = false;
  let dowRestricted = false;
  for (let i = 0; i < FIELD_SPECS.length; i++) {
    const r = parseField(parts[i], FIELD_SPECS[i], i);
    if (!r.ok) return { ok: false, error: r.error, fieldIndex: r.fieldIndex };
    cols.push(r.values);
    if (i === 2) domRestricted = r.restricted;
    if (i === 4) dowRestricted = r.restricted;
  }

  return {
    ok: true,
    fields: {
      minute: cols[0],
      hour: cols[1],
      dayOfMonth: cols[2],
      month: cols[3],
      dayOfWeek: cols[4],
      domRestricted,
      dowRestricted,
      expr: parts.join(' '),
    },
  };
}

/** 该日是否命中「日/周」条件（同时受限时取并集，方案 D6） */
function dayMatches(fields: CronFields, dom: number, dow: number): boolean {
  const domOk = fields.dayOfMonth.includes(dom);
  const dowOk = fields.dayOfWeek.includes(dow);
  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/**
 * 从 `fromMs` 之后（严格大于）的下一个触发时刻（毫秒时间戳，落在整分）。
 * 永不触发（如 `0 0 30 2 *`）返回 null。
 *
 * 算法按「天 → 时 → 分」跳跃，非逐分钟扫描：日不匹配跳次日、月不匹配跳下月，
 * 候选构造后回读校验（DST 前拨不存在的墙钟时刻会被 Date 顺延，回读不等即跳过）。
 */
export function nextFireTimes(fields: CronFields, fromMs: number, count: number): number[] {
  const out: number[] = [];
  if (!Number.isFinite(fromMs) || count <= 0) return out;
  const base = new Date(fromMs);
  const year = base.getFullYear();
  const month = base.getMonth();
  const date = base.getDate();
  // 上界随 count 放大（`0 0 29 2 *` 取 5 次需 20 年），总量仍有硬上限 40 年
  const limitDays = Math.min(MAX_SEARCH_DAYS * Math.max(1, count), MAX_TOTAL_DAYS);

  for (let d = 0; d <= limitDays && out.length < count; d++) {
    // 用「基准年月日 + d」构造，跨月/跨年由 Date 自动归一化
    const day = new Date(year, month, date + d);
    if (!fields.month.includes(day.getMonth() + 1)) continue;
    if (!dayMatches(fields, day.getDate(), day.getDay())) continue;

    for (const h of fields.hour) {
      for (const mi of fields.minute) {
        const cand = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, mi, 0, 0);
        // 回读校验（坑 4）：DST 前拨导致 02:30 不存在 → Date 顺延为 03:30，此处丢弃
        if (cand.getDate() !== day.getDate() || cand.getHours() !== h || cand.getMinutes() !== mi) continue;
        const t = cand.getTime();
        if (t <= fromMs) continue;
        out.push(t);
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}

/** 单次版本：fromMs 之后的下一个触发时刻；永不触发返回 null */
export function nextFireTime(fields: CronFields, fromMs: number): number | null {
  const [first] = nextFireTimes(fields, fromMs, 1);
  return first ?? null;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 该表达式是否「永不触发」（用于保存前拒绝 `0 0 30 2 *` 一类别名） */
export function neverFires(fields: CronFields, fromMs: number): boolean {
  return nextFireTime(fields, fromMs) === null;
}

/**
 * 中文可读描述（卡片 A 与 status 用）。
 * 例：`每天 03:00` / `每周一、三 09:00` / `每月 1 日 03:00` / `每月 1 日或每周一 03:00`
 */
export function describeCron(fields: CronFields): string {
  const time = fields.hour.length === 1 && fields.minute.length === 1
    ? ` ${pad2(fields.hour[0])}:${pad2(fields.minute[0])}`
    : '';
  if (fields.domRestricted && fields.dowRestricted) {
    const dom = fields.dayOfMonth.join('、');
    const dow = fields.dayOfWeek.map((d) => DOW_CN[d]).join('、');
    return `每月 ${dom} 日或每周${dow}${time}`;
  }
  if (fields.dowRestricted) {
    return `每周${fields.dayOfWeek.map((d) => DOW_CN[d]).join('、')}${time}`;
  }
  if (fields.domRestricted) {
    return `每月 ${fields.dayOfMonth.join('、')} 日${time}`;
  }
  if (fields.hour.length === 24 && fields.minute.length === 1) {
    return `每小时第 ${fields.minute[0]} 分`;
  }
  if (time) return `每天${time}`;
  if (fields.hour.length === 1) {
    return `每天 ${pad2(fields.hour[0])} 点的第 ${fields.minute.join('、')} 分`;
  }
  return `自定义（${fields.expr}）`;
}

/**
 * 本地墙钟分钟键 `YYYY-MM-DDTHH:mm`，用于 DST 回拨去重（方案 D4 / 坑 3）。
 * 同一墙钟分钟在回拨后会再次到达，用该键即可识别「已触发过」。
 */
export function localMinuteKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 本地时区偏置（分钟，东八区为 480；status 里以 UTC+08:00 展示） */
export function timezoneOffsetMin(nowMs: number): number {
  return -new Date(nowMs).getTimezoneOffset();
}
