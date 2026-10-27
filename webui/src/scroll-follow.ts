/**
 * 对话流「跟随底部」状态机（task-20261027-004 / 优化建议 20261027-002）
 *
 * 纯函数、无 DOM 依赖，便于单测（webui 无 jsdom，沿用 autogrow.ts / stream-blocks.ts 先例）。
 *
 * 两种状态：
 *   pinned   跟随底部——活动事件到达时把视口拉到底（与原行为一致）
 *   released 已解绑——用户主动上滑，视口冻结在用户选择的位置，不再被拽回
 *
 * 迁移规则（见任务文档 D1~D3）：
 *   任意态 --用户手势(wheel/touchmove/pointerdown/键盘)--> released
 *   released --scroll 且距底 <= 阈值--> pinned
 *   任意态 --forcePin()（发送消息/切会话/新建会话/点回底按钮）--> pinned
 *
 * 注意：调用方必须自己过滤「程序化 scrollTop 写入触发的 scroll 事件」，
 * 只把真实用户滚动交给 onScroll()——否则每帧自动跟随都会把自己判成"贴底"，
 * 使 released 状态无法保持。
 */

/** 贴底阈值：约 1.5 行正文（正文 14px / 行高约 22px） */
export const STICK_THRESHOLD_PX = 24;

/** 仅取判定所需的三个几何量，便于单测与解耦 DOM */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * 距底距离。
 * clamp 到 >= 0：Safari 弹性滚动（rubber-band）会给出负 scrollTop 或超出范围的值，
 * 直接相减会得到负数或虚高值，导致贴底判定误判。
 */
export function distanceToBottom(m: ScrollMetrics): number {
  const raw = m.scrollHeight - m.scrollTop - m.clientHeight;
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, raw);
}

/** 是否贴底（可作为「继续自动跟随」的判定） */
export function isAtBottom(m: ScrollMetrics, threshold: number = STICK_THRESHOLD_PX): boolean {
  return distanceToBottom(m) <= threshold;
}

export type FollowMode = 'pinned' | 'released';

export interface FollowState {
  follow: FollowMode;
  /** 解绑期间是否来过新内容（驱动回底按钮上的「新内容」圆点） */
  hasPending: boolean;
}

export interface FollowController {
  /** 当前状态快照（每次调用返回新对象，便于响应式同步） */
  get(): FollowState;
  /** 用户手势 → released（幂等：已是 released 时只返回当前快照） */
  onUserGesture(): FollowState;
  /** 容器滚动（仅非程序化写入时调用）→ 贴底则回 pinned 并清 hasPending */
  onScroll(m: ScrollMetrics, threshold?: number): FollowState;
  /** 活动事件（新 chunk / 工具事件到达）→ released 时置 hasPending */
  onActivity(): FollowState;
  /** 强制回底（发送消息 / 切会话 / 新建会话 / 点回底按钮）→ pinned 且清 hasPending */
  forcePin(): FollowState;
}

/**
 * 创建跟随状态控制器。
 *
 * 状态存在闭包内，`get()` 返回拷贝，避免外部误改内部状态。
 */
export function createFollowState(init?: Partial<FollowState>): FollowController {
  let follow: FollowMode = init?.follow === 'released' ? 'released' : 'pinned';
  let hasPending = init?.follow === 'released' ? !!init?.hasPending : false;

  const snap = (): FollowState => ({ follow, hasPending });

  return {
    get: snap,
    onUserGesture(): FollowState {
      follow = 'released';
      return snap();
    },
    onScroll(m: ScrollMetrics, threshold: number = STICK_THRESHOLD_PX): FollowState {
      if (follow === 'released' && isAtBottom(m, threshold)) {
        follow = 'pinned';
        hasPending = false;
      }
      return snap();
    },
    onActivity(): FollowState {
      if (follow === 'released') hasPending = true;
      return snap();
    },
    forcePin(): FollowState {
      follow = 'pinned';
      hasPending = false;
      return snap();
    },
  };
}
