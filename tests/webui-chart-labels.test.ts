/**
 * 图表容器副标题推导纯逻辑测试（Task-20261023-003）
 *
 * 覆盖 webui/src/chart-labels.ts：
 * - seriesLabel：echarts option → 「柱状 · 折线」式副标题
 * - diagramLabel：mermaid 源码首关键字 → 图类型中文名
 * 容器 DOM 交互（缩放读数、源码切换、复制按钮）无 jsdom，列入任务文档人工验证清单。
 */
import { describe, it, expect } from 'vitest';
import { diagramLabel, seriesLabel } from '../webui/src/chart-labels.js';

describe('seriesLabel', () => {
  it('多系列去重后以「 · 」连接', () => {
    const option = { series: [{ type: 'bar' }, { type: 'line' }] };
    expect(seriesLabel(option)).toBe('柱状 · 折线');
  });

  it('同类系列只保留一次', () => {
    const option = { series: [{ type: 'bar' }, { type: 'bar' }] };
    expect(seriesLabel(option)).toBe('柱状');
  });

  it('单对象 series（非数组）同样支持', () => {
    expect(seriesLabel({ series: { type: 'pie' } })).toBe('饼图');
  });

  it('未知类型回落原英文名', () => {
    expect(seriesLabel({ series: [{ type: 'myCustomSeries' }] })).toBe('myCustomSeries');
  });

  it('最多取 3 种类型，避免副标题撑爆工具栏', () => {
    const option = { series: [{ type: 'bar' }, { type: 'line' }, { type: 'pie' }, { type: 'radar' }] };
    expect(seriesLabel(option)).toBe('柱状 · 折线 · 饼图');
  });

  it('无 series / 空数组 / 缺 type → 空串（不渲染 .kind-sub）', () => {
    expect(seriesLabel({})).toBe('');
    expect(seriesLabel({ series: [] })).toBe('');
    expect(seriesLabel({ series: [{ data: [1, 2] }] })).toBe('');
    expect(seriesLabel({ series: [null] })).toBe('');
    expect(seriesLabel({ series: [{ type: '' }] })).toBe('');
  });
});

describe('diagramLabel', () => {
  it('识别常见 mermaid 图类型', () => {
    expect(diagramLabel('flowchart TD\n  A-->B')).toBe('流程图');
    expect(diagramLabel('graph LR\n  A-->B')).toBe('流程图');
    expect(diagramLabel('sequenceDiagram\n  A->>B: hi')).toBe('时序图');
    expect(diagramLabel('classDiagram\n  class A')).toBe('类图');
    expect(diagramLabel('stateDiagram-v2\n  [*] --> A')).toBe('状态图');
    expect(diagramLabel('erDiagram\n  A ||--o{ B : has')).toBe('ER 图');
    expect(diagramLabel('gantt\n  title T')).toBe('甘特图');
    expect(diagramLabel('pie title T\n  "a" : 1')).toBe('饼图');
    expect(diagramLabel('mindmap\n  root')).toBe('思维导图');
    expect(diagramLabel('timeline\n  2024 : x')).toBe('时间线');
  });

  it('容忍前导空白与空行', () => {
    expect(diagramLabel('\n\n   flowchart TD\n A-->B')).toBe('流程图');
  });

  it('区分象限图与饼图（关键字不可混用）', () => {
    expect(diagramLabel('quadrantChart\n  x-axis low --> high')).toBe('象限图');
  });

  it('无法识别 → 空串（不渲染 .kind-sub）', () => {
    expect(diagramLabel('')).toBe('');
    expect(diagramLabel('%% 只有注释')).toBe('');
    expect(diagramLabel('unknownDiagram X')).toBe('');
  });
});
