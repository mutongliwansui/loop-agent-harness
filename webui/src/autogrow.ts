/**
 * textarea 自增高（task-20261025-002 P0 ②）
 *
 * 纯函数、无 DOM 依赖，便于单测：把「内容实际需要的高度」夹取到 [min, max]。
 * 调用方拿 scrollHeight 传入，返回值直接赋给 style.height；
 * 超过 max 后由 CSS overflow-y:auto 接管内部滚动。
 */

/** 空态高度（与原型一致：单行 44px） */
export const AUTOGROW_MIN = 44;
/** 上限（约 8 行，超过即内部滚动，避免输入坞挤占消息区） */
export const AUTOGROW_MAX = 200;

/**
 * 计算下一次应设置的 textarea 高度。
 *
 * @param scrollHeight 内容实际高度（取 textarea.scrollHeight）
 * @param min 最小高度，默认 44
 * @param max 最大高度，默认 200
 * @returns 夹取后的像素高度；入参非法（NaN/负数）时返回 min，避免写出 `height:NaNpx`
 */
export function nextTextareaHeight(
  scrollHeight: number,
  min: number = AUTOGROW_MIN,
  max: number = AUTOGROW_MAX,
): number {
  if (!Number.isFinite(scrollHeight)) return min;
  const floor = Number.isFinite(min) ? min : AUTOGROW_MIN;
  const ceil = Number.isFinite(max) ? max : AUTOGROW_MAX;
  const lo = Math.min(floor, ceil);
  const hi = Math.max(floor, ceil);
  return Math.min(Math.max(scrollHeight, lo), hi);
}
