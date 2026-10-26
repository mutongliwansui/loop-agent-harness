/**
 * Task-20261026-003-01 单测：5 字段 cron 引擎（方案 D1/D6）
 *
 * 覆盖任务文档 6.1 清单：
 * - 合法表达式：`0 3 * * *` / 步长 `*\/15` / `0 9 * * 1-5` / `@daily` / `0 0 29 2 *`
 * - 非法表达式：`61 * * * *` / `0 3 * * * *` / `0 3 L * *` / `0 3 30 2 *`，错误文案含字段序号
 * - 步长语义：`*\/7` = 0,7,…,56；`5/10` = 5,15,…,55；周 7 → 0
 * - 下一次触发：2 月 29 日、月末 31 日、DOM/DOW 并集语义
 * - describeCron 中文描述
 * - localMinuteKey 墙钟分钟键（DST 去重依据）
 *
 * 说明：全部时间断言都用「本地时间构造 + 本地时间回读」，因此在任意时区跑都成立。
 */

import { describe, it, expect } from 'vitest';
import {
  describeCron,
  localMinuteKey,
  neverFires,
  nextFireTime,
  nextFireTimes,
  parseCron,
  timezoneOffsetMin,
} from '../src/api/cron.js';
import type { CronFields } from '../src/api/cron.js';

/** 断言解析成功并返回字段（失败时把 error 打出来，便于定位） */
function ok(expr: string): CronFields {
  const r = parseCron(expr);
  if (!r.ok) throw new Error(`期望「${expr}」合法，实际失败：${r.error}`);
  return r.fields;
}

/** 断言解析失败并返回错误信息 */
function fail(expr: string): { error: string; fieldIndex?: number } {
  const r = parseCron(expr);
  if (r.ok) throw new Error(`期望「${expr}」非法，实际解析成功`);
  return { error: r.error, fieldIndex: r.fieldIndex };
}

/** 本地时间构造（月份 0 基） */
function local(
  y: number,
  mo: number,
  d: number,
  h = 0,
  mi = 0,
): Date {
  return new Date(y, mo, d, h, mi, 0, 0);
}

/** 断言时间戳落在指定的本地年月日时分 */
function expectLocal(ms: number | null, y: number, mo: number, d: number, h: number, mi: number): void {
  expect(ms).not.toBeNull();
  const dt = new Date(ms as number);
  expect([dt.getFullYear(), dt.getMonth(), dt.getDate(), dt.getHours(), dt.getMinutes()]).toEqual([y, mo, d, h, mi]);
}

// ---------- 解析：合法 ----------

describe('parseCron 合法表达式', () => {
  it('`0 3 * * *` → 每天 03:00', () => {
    const f = ok('0 3 * * *');
    expect(f.minute).toEqual([0]);
    expect(f.hour).toEqual([3]);
    expect(f.month).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(f.dayOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(f.domRestricted).toBe(false);
    expect(f.dowRestricted).toBe(false);
    expect(f.expr).toBe('0 3 * * *');
  });

  it('`*/15 * * * *` → 分 0,15,30,45', () => {
    expect(ok('*/15 * * * *').minute).toEqual([0, 15, 30, 45]);
  });

  it('`0 9 * * 1-5` → 周中 09:00，dowRestricted=true', () => {
    const f = ok('0 9 * * 1-5');
    expect(f.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(f.dowRestricted).toBe(true);
  });

  it('`@daily` 宏展开为 `0 0 * * *`', () => {
    const f = ok('@daily');
    expect(f.minute).toEqual([0]);
    expect(f.hour).toEqual([0]);
    expect(f.expr).toBe('0 0 * * *');
  });

  it('`0 0 29 2 *`（四年一次）可解析', () => {
    const f = ok('0 0 29 2 *');
    expect(f.dayOfMonth).toEqual([29]);
    expect(f.month).toEqual([2]);
    expect(f.domRestricted).toBe(true);
  });

  it('`@hourly/@weekly/@monthly/@yearly` 四个宏均可用', () => {
    expect(ok('@hourly').expr).toBe('0 * * * *');
    expect(ok('@weekly').expr).toBe('0 0 * * 0');
    expect(ok('@monthly').expr).toBe('0 0 1 * *');
    expect(ok('@yearly').expr).toBe('0 0 1 1 *');
  });

  it('月份/星期支持 3 字母缩写（大小写不敏感）', () => {
    const f = ok('0 0 1 JAN MON');
    expect(f.month).toEqual([1]);
    expect(f.dayOfWeek).toEqual([1]);
    expect(ok('0 0 1 jan sun').dayOfWeek).toEqual([0]);
  });

  it('`7` 与 `0` 都表示周日（归一化后去重）', () => {
    expect(ok('0 0 * * 7').dayOfWeek).toEqual([0]);
    const both = ok('0 0 * * 0,7').dayOfWeek;
    expect(both).toEqual([0]);
  });

  it('`0-7` 覆盖整周 → 视为未限制', () => {
    const f = ok('0 0 * * 0-7');
    expect(f.dayOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(f.dowRestricted).toBe(false);
  });

  it('`1-31` 日覆盖整段 → 视为未限制', () => {
    expect(ok('0 0 1-31 * *').domRestricted).toBe(false);
  });

  it('`*/7` 分从字段最小值起步行进（0,7,…,56）', () => {
    expect(ok('*/7 * * * *').minute).toEqual([0, 7, 14, 21, 28, 35, 42, 49, 56]);
  });

  it('`5/10` 分从 5 起步行进到上界（5,15,…,55）', () => {
    expect(ok('5/10 * * * *').minute).toEqual([5, 15, 25, 35, 45, 55]);
  });

  it('多值逗号 + 区间混合', () => {
    expect(ok('0,30 8-10 * * *').minute).toEqual([0, 30]);
    expect(ok('0,30 8-10 * * *').hour).toEqual([8, 9, 10]);
  });

  it('多余空白与首尾空格容错', () => {
    expect(parseCron('  0   3  *  *  * ').ok).toBe(true);
  });
});

// ---------- 解析：非法 ----------

describe('parseCron 非法表达式（错误文案含字段序号）', () => {
  it('空表达式', () => {
    expect(fail('').error).toContain('为空');
  });

  it('`61 * * * *` → 第 1 个字段（分钟）超出范围', () => {
    const e = fail('61 * * * *');
    expect(e.fieldIndex).toBe(0);
    expect(e.error).toContain('第 1 个字段（分钟）');
    expect(e.error).toContain('0-59');
  });

  it('`0 25 * * *` → 第 2 个字段（小时）超出范围 0-23', () => {
    const e = fail('0 25 * * *');
    expect(e.fieldIndex).toBe(1);
    expect(e.error).toContain('第 2 个字段（小时）');
    expect(e.error).toContain('0-23');
  });

  it('`0 3 * * * *` → 6 字段明确拒绝', () => {
    expect(fail('0 3 * * * *').error).toContain('5 字段');
  });

  it('`0 3 L * *` → 不支持 L/W/#/? 扩展语法', () => {
    const e = fail('0 3 L * *');
    expect(e.error).toContain('不支持 L/W/#/?');
  });

  it('`0 3 * * 5#2` 与 `0 3 ? * *` 同样拒绝', () => {
    expect(fail('0 3 * * 5#2').error).toContain('不支持');
    expect(fail('0 3 ? * *').error).toContain('不支持');
  });

  it('`0 3 30 2 *` 语法合法但永不触发', () => {
    const f = ok('0 3 30 2 *');
    expect(neverFires(f, local(2026, 9, 26).getTime())).toBe(true);
    expect(nextFireTime(f, local(2026, 9, 26).getTime())).toBeNull();
  });

  it('字段数不足 / 区间倒置 / 步长为 0 均报错', () => {
    expect(fail('0 3 * *').error).toContain('5 个字段');
    expect(fail('0 3 * * 3-1').error).toContain('起始值大于结束值');
    expect(fail('*/0 * * * *').error).toContain('步长必须 ≥ 1');
    expect(fail('0 3 * * abc').error).toContain('第 5 个字段（星期）');
  });
});

// ---------- 下一次触发 ----------

describe('nextFireTime / nextFireTimes', () => {
  it('`0 3 * * *`：22:13 → 次日 03:00', () => {
    const f = ok('0 3 * * *');
    expectLocal(nextFireTime(f, local(2026, 9, 26, 22, 13).getTime()), 2026, 9, 27, 3, 0);
  });

  it('`0 3 * * *`：当天 02:00 → 当天 03:00', () => {
    const f = ok('0 3 * * *');
    expectLocal(nextFireTime(f, local(2026, 9, 26, 2, 0).getTime()), 2026, 9, 26, 3, 0);
  });

  it('严格大于：恰好在 03:00:00 时下一次是次日', () => {
    const f = ok('0 3 * * *');
    expectLocal(nextFireTime(f, local(2026, 9, 26, 3, 0).getTime()), 2026, 9, 27, 3, 0);
  });

  it('月末 31 日：`0 0 31 * *` 从 4 月出发 → 5 月 31 日（跳过 4 月无 31 日）', () => {
    const f = ok('0 0 31 * *');
    expectLocal(nextFireTime(f, local(2026, 3, 30).getTime()), 2026, 4, 31, 0, 0);
  });

  it('2 月 29 日：`0 0 29 2 *` 从 2026 出发 → 2028-02-29', () => {
    const f = ok('0 0 29 2 *');
    expectLocal(nextFireTime(f, local(2026, 9, 26).getTime()), 2028, 1, 29, 0, 0);
  });

  it('2 月 29 日连续 3 次预览：2028 / 2032 / 2036', () => {
    const f = ok('0 0 29 2 *');
    const list = nextFireTimes(f, local(2026, 9, 26).getTime(), 3).map((t) => new Date(t).getFullYear());
    expect(list).toEqual([2028, 2032, 2036]);
  });

  it('DOM/DOW 并集：`0 3 1 * 1` 从周三 10-28 出发 → 先到 11-01（日）还是 11-02（周一）', () => {
    const f = ok('0 3 1 * 1');
    // 2026-11-01 是周日（不满足 DOW=1，但满足 DOM=1）→ 并集语义应命中 11-01 03:00
    expectLocal(nextFireTime(f, local(2026, 9, 28, 12, 0).getTime()), 2026, 10, 1, 3, 0);
  });

  it('DOM/DOW 并集：`0 3 15 * 1` 从 11-02（周一）→ 当天 11-02 03:00 已过则 11-09（周一）', () => {
    const f = ok('0 3 15 * 1');
    expectLocal(nextFireTime(f, local(2026, 10, 2, 12, 0).getTime()), 2026, 10, 9, 3, 0);
  });

  it('周中 `0 9 * * 1-5`：周六 10-31 → 周一 11-02 09:00', () => {
    const f = ok('0 9 * * 1-5');
    expectLocal(nextFireTime(f, local(2026, 9, 31, 12, 0).getTime()), 2026, 10, 2, 9, 0);
  });

  it('多时刻 `0 3,15 * * *`：05:00 → 当天 15:00', () => {
    const f = ok('0 3,15 * * *');
    expectLocal(nextFireTime(f, local(2026, 9, 26, 5, 0).getTime()), 2026, 9, 26, 15, 0);
  });

  it('nextFireTimes 返回连续 3 次且严格递增', () => {
    const f = ok('0 3 * * *');
    const list = nextFireTimes(f, local(2026, 9, 26, 22, 13).getTime(), 3);
    expect(list).toHaveLength(3);
    expect(list[1]).toBeGreaterThan(list[0]);
    expect(list[2]).toBeGreaterThan(list[1]);
    for (const t of list) expect(new Date(t).getHours()).toBe(3);
  });

  it('count<=0 或非法 fromMs 返回空数组', () => {
    const f = ok('0 3 * * *');
    expect(nextFireTimes(f, local(2026, 9, 26).getTime(), 0)).toEqual([]);
    expect(nextFireTimes(f, Number.NaN, 3)).toEqual([]);
  });
});

// ---------- 中文描述 ----------

describe('describeCron 中文可读描述', () => {
  it('每天 03:00', () => {
    expect(describeCron(ok('0 3 * * *'))).toBe('每天 03:00');
  });

  it('每周一 09:00', () => {
    expect(describeCron(ok('0 9 * * 1'))).toBe('每周一 09:00');
  });

  it('每周一、三 09:00', () => {
    expect(describeCron(ok('0 9 * * 1,3'))).toBe('每周一、三 09:00');
  });

  it('每月 1 日 03:00', () => {
    expect(describeCron(ok('0 3 1 * *'))).toBe('每月 1 日 03:00');
  });

  it('DOM/DOW 同时受限 → 「或」表达并集', () => {
    expect(describeCron(ok('0 3 1 * 1'))).toBe('每月 1 日或每周一 03:00');
  });

  it('每小时第 0 分', () => {
    expect(describeCron(ok('0 * * * *'))).toBe('每小时第 0 分');
  });

  it('多分钟单小时 → 「03 点的第 0、30 分」', () => {
    expect(describeCron(ok('0,30 3 * * *'))).toBe('每天 03 点的第 0、30 分');
  });
});

// ---------- 墙钟键与时区 ----------

describe('localMinuteKey / timezoneOffsetMin', () => {
  it('返回本地墙钟分钟键（同一本地分钟下毫秒不同 → 键相同）', () => {
    const a = new Date(2026, 9, 26, 22, 13, 5, 100).getTime();
    const b = new Date(2026, 9, 26, 22, 13, 59, 900).getTime();
    expect(localMinuteKey(a)).toBe('2026-10-26T22:13');
    expect(localMinuteKey(b)).toBe('2026-10-26T22:13');
  });

  it('补零格式：个位数月/日/时/分', () => {
    expect(localMinuteKey(new Date(2026, 0, 5, 3, 7).getTime())).toBe('2026-01-05T03:07');
  });

  it('timezoneOffsetMin 与 Date#getTimezoneOffset 互为相反数', () => {
    const now = Date.now();
    expect(timezoneOffsetMin(now)).toBe(-new Date(now).getTimezoneOffset());
  });
});
