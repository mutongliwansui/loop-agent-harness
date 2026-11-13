// 后台子任务指示器（SubAgentDock）展示逻辑单测（2026-11-07 样式重设计）
// 纯函数无 DOM 依赖，可在 Node vitest 下直测；组件模板只做布局。
import { describe, expect, it } from 'vitest';
import {
  DOCK_DONE_OPEN_DEFAULT,
  DOCK_ERROR_MAX,
  DOCK_ID_MAX,
  DOCK_LIST_MAX_PX,
  DOCK_MAX_CHIPS,
  DOCK_SHORT_TITLE_MAX,
  dockChips,
  dockErrorLine,
  dockGroups,
  dockKindLabel,
  dockOverflow,
  dockShortId,
  dockShortTitle,
  dockStatusLabel,
  dockTaskElapsed,
  dockTaskTitle,
  dockTotalElapsed,
  formatDockElapsed,
} from '../webui/src/subagent-dock.js';
import type { SubAgentTaskVM } from '../webui/src/chat-stream.js';

function task(over: Partial<SubAgentTaskVM> & Pick<SubAgentTaskVM, 'taskId'>): SubAgentTaskVM {
  return { task: '任务', status: 'running', ...over };
}

describe('formatDockElapsed：秒 / 分秒', () => {
  it('分钟以下只显示秒，分钟以上带补零秒', () => {
    expect(formatDockElapsed(0)).toBe('0s');
    expect(formatDockElapsed(42_000)).toBe('42s');
    expect(formatDockElapsed(59_000)).toBe('59s');
    expect(formatDockElapsed(60_000)).toBe('1m00s');
    expect(formatDockElapsed(134_000)).toBe('2m14s');
    expect(formatDockElapsed(3_900_000)).toBe('65m00s');
  });

  it('负数按 0 处理（时钟回拨/脏数据不出现负耗时）', () => {
    expect(formatDockElapsed(-5000)).toBe('0s');
  });
});

describe('dockTaskElapsed / dockTotalElapsed：运行中走表、终态用落盘值', () => {
  it('running 用 now - startedAt（接口 elapsedMs 只是采样点）', () => {
    const now = 1_000_000;
    expect(dockTaskElapsed(task({ taskId: 'a', startedAt: now - 3000 }), now)).toBe(3000);
    // 缺 startedAt：按 0 而不是 now
    expect(dockTaskElapsed(task({ taskId: 'b' }), now)).toBe(0);
  });

  it('终态用 elapsedMs，缺省/负数按 0', () => {
    expect(dockTaskElapsed(task({ taskId: 'a', status: 'done', elapsedMs: 8000 }), 0)).toBe(8000);
    expect(dockTaskElapsed(task({ taskId: 'b', status: 'failed' }), 0)).toBe(0);
  });

  it('聚合耗时取运行中任务的最大值；空列表为 0', () => {
    const now = 1_000_000;
    const list = [
      task({ taskId: 'a', startedAt: now - 3000 }),
      task({ taskId: 'b', startedAt: now - 134_000 }),
      task({ taskId: 'c', status: 'done', elapsedMs: 500_000 }),
    ];
    // 组件只传 running（终态任务的 elapsedMs 不参与「共 X」）
    expect(dockTotalElapsed(list.filter((t) => t.status === 'running'), now)).toBe(134_000);
    expect(dockTotalElapsed([], now)).toBe(0);
  });
});

describe('dockChips / dockOverflow：收起态序号 + 最多 3 个 + 溢出计数', () => {
  it('取前 N 个，序号从 1 开始且与展开列表一致', () => {
    const now = 1_000_000;
    const list = [
      task({ taskId: 'a', task: '任务一', startedAt: now - 42_000 }),
      task({ taskId: 'b', task: '任务二', startedAt: now - 8000 }),
    ];
    expect(dockChips(list, now)).toEqual([
      { taskId: 'a', index: 1, elapsed: '42s', title: '任务一' },
      { taskId: 'b', index: 2, elapsed: '8s', title: '任务二' },
    ]);
  });

  it('超过 3 个只保留前 3 个，其余由 dockOverflow 汇总', () => {
    expect(DOCK_MAX_CHIPS).toBe(3);
    const now = 0;
    const list = Array.from({ length: 5 }, (_, i) =>
      task({ taskId: `t${i}`, startedAt: -1000 }),
    );
    expect(dockChips(list, now).map((c) => c.index)).toEqual([1, 2, 3]);
    expect(dockOverflow(list.length)).toBe(2);
    expect(dockOverflow(3)).toBe(0);
    expect(dockOverflow(0)).toBe(0);
  });
});

describe('dockTaskTitle / dockShortTitle：标题折叠与短名截断', () => {
  it('标题折叠空白、去首尾，空描述给占位文案', () => {
    expect(dockTaskTitle('  a\n b\tc  ')).toBe('a b c');
    expect(dockTaskTitle('')).toBe('（无描述）');
    expect(dockTaskTitle(undefined)).toBe('（无描述）');
  });

  it('单任务短名超长截断并加省略号，占位文案不重复显示', () => {
    expect(DOCK_SHORT_TITLE_MAX).toBe(18);
    expect(dockShortTitle('README 中英全量比对')).toBe('README 中英全量比对');
    const long = '对 D:\\workspace\\loop-agent-command\\README.md 与 README.en.md 全量比对';
    const out = dockShortTitle(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(19); // 18 字符 + 省略号
    expect(dockShortTitle('')).toBe('');
  });
});

describe('dockErrorLine：失败行只留首行摘要', () => {
  it('取首个非空行并剥首尾空白', () => {
    expect(dockErrorLine('\n\n  工具执行失败：ENOENT  \n第二行')).toBe('工具执行失败：ENOENT');
    expect(dockErrorLine('')).toBe('');
    expect(dockErrorLine(undefined)).toBe('');
  });

  it('超过 60 字截断', () => {
    const out = dockErrorLine(`E: ${'x'.repeat(120)}`);
    expect(DOCK_ERROR_MAX).toBe(60);
    expect(out.length).toBe(61);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('dockStatusLabel：五种状态词', () => {
  it('运行中显示「进行中」，终态各有明确文案', () => {
    expect(dockStatusLabel('running')).toBe('进行中');
    expect(dockStatusLabel('done')).toBe('完成');
    expect(dockStatusLabel('failed')).toBe('失败');
    expect(dockStatusLabel('aborted')).toBe('已取消');
    expect(dockStatusLabel('interrupted')).toBe('已中断');
  });
});

describe('20261113-007 列表展示优化：分组 / 类型徽标 / ID 缩略 / 常量口径', () => {
  it('dockKindLabel：命令任务显示「命令」，后台子 Agent 显示「子任务」', () => {
    expect(dockKindLabel('command')).toBe('命令');
    expect(dockKindLabel('subagent')).toBe('子任务');
  });

  it('dockShortId：不超过阈值原样返回，超过则截前 9 字符加省略号', () => {
    expect(DOCK_ID_MAX).toBe(11);
    expect(dockShortId('cmd_1')).toBe('cmd_1');
    expect(dockShortId('cmd_33aa90d7')).toBe('cmd_33aa9…'); // 12 字符 → 截前 9 加省略号
    expect(dockShortId('sub_4d2b8e61')).toBe('sub_4d2b8…');
    expect(dockShortId('')).toBe('');
  });

  it('dockGroups：运行中在上、已结束在下，各自保持原顺序', () => {
    const list = [
      task({ taskId: 'r1' }),
      task({ taskId: 'd1', status: 'done' }),
      task({ taskId: 'r2' }),
      task({ taskId: 'f1', status: 'failed' }),
      task({ taskId: 'a1', status: 'aborted' }),
      task({ taskId: 'i1', status: 'interrupted' }),
    ];
    const g = dockGroups(list);
    expect(g.running.map((t) => t.taskId)).toEqual(['r1', 'r2']);
    expect(g.ended.map((t) => t.taskId)).toEqual(['d1', 'f1', 'a1', 'i1']);
    expect(dockGroups([])).toEqual({ running: [], ended: [] });
  });

  it('dockGroups 保留 kind 等扩展字段（JobTaskVM 泛型不失真）', () => {
    const g = dockGroups([
      { taskId: 'c1', task: 'x', status: 'running' as const, kind: 'command' as const, canStop: true },
    ]);
    expect(g.running[0].kind).toBe('command');
    expect(g.running[0].canStop).toBe(true);
  });

  it('常量口径：展开区封顶 320px、已结束组默认收起', () => {
    expect(DOCK_LIST_MAX_PX).toBe(320);
    expect(DOCK_DONE_OPEN_DEFAULT).toBe(false);
  });
});
