// autogrow 单测（task-20261025-002 P0 ②）
// 纯函数无 DOM 依赖：验证 44 起、200 封顶、非法入参兜底
import { describe, expect, it } from 'vitest';
import { AUTOGROW_MAX, AUTOGROW_MIN, nextTextareaHeight } from '../webui/src/autogrow.js';

describe('nextTextareaHeight：内容高度 → 输入框高度', () => {
  it('空态/单行保持最小 44px', () => {
    expect(nextTextareaHeight(20)).toBe(AUTOGROW_MIN);
    expect(nextTextareaHeight(AUTOGROW_MIN)).toBe(AUTOGROW_MIN);
  });

  it('中间值按内容增高', () => {
    expect(nextTextareaHeight(88)).toBe(88);
    expect(nextTextareaHeight(146)).toBe(146);
  });

  it('超过上限封顶 200px（超出部分内部滚动）', () => {
    expect(nextTextareaHeight(AUTOGROW_MAX)).toBe(AUTOGROW_MAX);
    expect(nextTextareaHeight(420)).toBe(AUTOGROW_MAX);
  });

  it('非法入参回落最小值，不产生 height:NaNpx', () => {
    expect(nextTextareaHeight(Number.NaN)).toBe(AUTOGROW_MIN);
    // 非有限值一律视为非法（scrollHeight 理论上不会出现，但不能写出 height:Infinitypx）
    expect(nextTextareaHeight(Number.POSITIVE_INFINITY)).toBe(AUTOGROW_MIN);
  });

  it('自定义上下限生效且自动纠正倒置区间', () => {
    expect(nextTextareaHeight(300, 60, 120)).toBe(120);
    expect(nextTextareaHeight(10, 60, 120)).toBe(60);
    // min > max 时按大小排序夹取，不会返回越界值
    expect(nextTextareaHeight(100, 200, 50)).toBe(100);
  });
});
