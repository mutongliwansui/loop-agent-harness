/**
 * 对话流「跟随底部」状态机测试（task-20261027-004 / 优化建议 20261027-002）
 *
 * 覆盖 webui/src/scroll-follow.ts：
 * - distanceToBottom / isAtBottom：阈值边界与弹性滚动负值
 * - createFollowState：pinned ⇄ released 迁移、hasPending 生命周期
 * 真实滚动行为（wheel/touch/scroll 接线、回底按钮、阅读位置不漂移）
 * 无 jsdom，列入任务文档 6.4 人工验证清单。
 */
import { describe, it, expect } from 'vitest';
import {
  STICK_THRESHOLD_PX,
  distanceToBottom,
  isAtBottom,
  createFollowState,
  type ScrollMetrics,
} from '../webui/src/scroll-follow.js';

/** 构造几何量：内容总高 height、视口高 client、已滚 top */
function m(top: number, height = 1000, client = 400): ScrollMetrics {
  return { scrollTop: top, scrollHeight: height, clientHeight: client };
}

describe('distanceToBottom', () => {
  it('贴底时为 0', () => {
    expect(distanceToBottom(m(600))).toBe(0);
  });

  it('距底按 scrollHeight - scrollTop - clientHeight 计算', () => {
    expect(distanceToBottom(m(500))).toBe(100);
  });

  it('内容不足一屏（无滚动条）时 clamp 到 0', () => {
    expect(distanceToBottom(m(0, 300, 400))).toBe(0);
  });

  it('底部弹性过滚（scrollTop 超出最大值）时 clamp 到 0', () => {
    // Safari/macOS 底部橡皮筋：scrollTop 可临时超过 scrollHeight-clientHeight
    expect(distanceToBottom(m(640))).toBe(0);
  });

  it('顶部弹性过滚（scrollTop 为负）时距底变大而非变负', () => {
    // 顶部橡皮筋 scrollTop<0 → 距底 = 1000+60-400 = 660，仍判为「不贴底」，符合预期
    expect(distanceToBottom(m(-60))).toBe(660);
    expect(isAtBottom(m(-60))).toBe(false);
  });

  it('传入非有限值时按 0 处理（防 NaN 污染判定）', () => {
    expect(distanceToBottom({ scrollTop: NaN, scrollHeight: 1000, clientHeight: 400 })).toBe(0);
  });
});

describe('isAtBottom 阈值边界', () => {
  it('默认阈值常量是 24px', () => {
    expect(STICK_THRESHOLD_PX).toBe(24);
  });

  it('距底 0 / 23 / 24 判为贴底，25 判为脱离', () => {
    expect(isAtBottom(m(600))).toBe(true); // 距底 0
    expect(isAtBottom(m(577))).toBe(true); // 距底 23
    expect(isAtBottom(m(576))).toBe(true); // 距底 24（取等号，边界包含）
    expect(isAtBottom(m(575))).toBe(false); // 距底 25
  });

  it('支持自定义阈值', () => {
    expect(isAtBottom(m(500), 100)).toBe(true);
    expect(isAtBottom(m(500), 99)).toBe(false);
  });
});

describe('createFollowState 初始态', () => {
  it('默认 pinned 且无 pending', () => {
    expect(createFollowState().get()).toEqual({ follow: 'pinned', hasPending: false });
  });

  it('可按初始态构造（released 且带 pending）', () => {
    expect(createFollowState({ follow: 'released', hasPending: true }).get()).toEqual({
      follow: 'released',
      hasPending: true,
    });
  });

  it('get() 返回拷贝，外部修改不影响内部状态', () => {
    const ctl = createFollowState();
    const snap = ctl.get();
    snap.follow = 'released';
    expect(ctl.get().follow).toBe('pinned');
  });
});

describe('用户手势 → released', () => {
  it('pinned 态收到手势即解绑', () => {
    const ctl = createFollowState();
    expect(ctl.onUserGesture()).toEqual({ follow: 'released', hasPending: false });
  });

  it('已解绑时重复手势保持 released 且不重置 pending', () => {
    const ctl = createFollowState();
    ctl.onUserGesture();
    ctl.onActivity();
    expect(ctl.onUserGesture()).toEqual({ follow: 'released', hasPending: true });
  });
});

describe('活动事件 → pending 圆点', () => {
  it('pinned 态有新内容不置 pending（用户看得到，无需提示）', () => {
    const ctl = createFollowState();
    expect(ctl.onActivity()).toEqual({ follow: 'pinned', hasPending: false });
  });

  it('released 态有新内容置 pending', () => {
    const ctl = createFollowState();
    ctl.onUserGesture();
    expect(ctl.onActivity()).toEqual({ follow: 'released', hasPending: true });
  });

  it('pending 一经置位持续保持（多次活动事件不翻转）', () => {
    const ctl = createFollowState();
    ctl.onUserGesture();
    ctl.onActivity();
    ctl.onActivity();
    expect(ctl.get().hasPending).toBe(true);
  });
});

describe('滚动回吸 → pinned', () => {
  it('released 态滚回底部（距底 ≤ 24）自动恢复跟随并清 pending', () => {
    const ctl = createFollowState();
    ctl.onUserGesture();
    ctl.onActivity();
    expect(ctl.onScroll(m(600))).toEqual({ follow: 'pinned', hasPending: false });
  });

  it('released 态未滚到底（距底 25）保持解绑', () => {
    const ctl = createFollowState();
    ctl.onUserGesture();
    expect(ctl.onScroll(m(575))).toEqual({ follow: 'released', hasPending: false });
  });

  it('pinned 态滚到中间不会误置 released（只有用户手势能解绑）', () => {
    const ctl = createFollowState();
    expect(ctl.onScroll(m(100))).toEqual({ follow: 'pinned', hasPending: false });
  });

  it('自定义阈值下回吸判定生效', () => {
    const within = createFollowState({ follow: 'released' });
    expect(within.onScroll(m(500), 100).follow).toBe('pinned');
    const outside = createFollowState({ follow: 'released' });
    expect(outside.onScroll(m(500), 99).follow).toBe('released');
  });
});

describe('forcePin 强制回底', () => {
  it('released + pending 时强制回底清空两个标记', () => {
    const ctl = createFollowState();
    ctl.onUserGesture();
    ctl.onActivity();
    expect(ctl.forcePin()).toEqual({ follow: 'pinned', hasPending: false });
  });

  it('pinned 态强制回底幂等', () => {
    const ctl = createFollowState();
    expect(ctl.forcePin()).toEqual({ follow: 'pinned', hasPending: false });
  });

  it('强制回底后可再次被手势解绑', () => {
    const ctl = createFollowState();
    ctl.onUserGesture();
    ctl.forcePin();
    expect(ctl.onUserGesture()).toEqual({ follow: 'released', hasPending: false });
  });
});

describe('完整交互序列（对齐流式真实时序）', () => {
  it('上滑 → 多个 chunk → 回底 → 后续 chunk 恢复跟随', () => {
    const ctl = createFollowState();
    // 流式中：跟随时来 chunk
    ctl.onActivity();
    expect(ctl.get()).toEqual({ follow: 'pinned', hasPending: false });
    // 用户上滑
    ctl.onUserGesture();
    // 后续 chunk 持续到达（视口应冻结，只累积 pending）
    ctl.onActivity();
    ctl.onActivity();
    expect(ctl.get()).toEqual({ follow: 'released', hasPending: true });
    // 用户滚回底部
    ctl.onScroll(m(600));
    expect(ctl.get()).toEqual({ follow: 'pinned', hasPending: false });
    // 后续 chunk 不再置 pending
    ctl.onActivity();
    expect(ctl.get()).toEqual({ follow: 'pinned', hasPending: false });
  });

  it('上滑后 run 结束不回弹（终态活动事件不改变 released）', () => {
    const ctl = createFollowState();
    ctl.onUserGesture();
    ctl.onActivity(); // 终态的 notifyActivity
    expect(ctl.get()).toEqual({ follow: 'released', hasPending: true });
  });
});
