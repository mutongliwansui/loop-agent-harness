// chart-labels.ts：图表容器副标题（.chart-kind .kind-sub）的纯函数推导
//
// 外框重设计（Task-20261023-003）把原先像调试遗留的等宽类型名（"echarts" / "mermaid"）
// 换成「图标 + 中文名 + 副标题」。中文名由容器类型（chart / diagram）决定，副标题则是
// 具体图表形态，这里按各自输入推导：
//   - echarts：读 option.series[].type → 柱状 / 折线 / 饼图 …
//   - mermaid：读源码首个关键字 → 流程图 / 时序图 / 类图 …
// 推导不到副标题时返回空串，容器便不渲染 .kind-sub 节点（副标题可选）。
// 纯函数、不碰 DOM，便于单测（tests/webui-chart-labels.test.ts）。

/** echarts 系列类型 → 中文名 */
export const SERIES_CN: Record<string, string> = {
  bar: '柱状',
  line: '折线',
  pie: '饼图',
  scatter: '散点',
  effectScatter: '涟漪',
  radar: '雷达',
  gauge: '仪表盘',
  funnel: '漏斗',
  tree: '树图',
  heatmap: '热力图',
  sankey: '桑基',
  graph: '关系图',
  boxplot: '箱线',
  candlestick: 'K 线',
  map: '地图',
  sunburst: '旭日',
  treemap: '矩形树图',
  parallel: '平行坐标',
  pictorialBar: '象形柱',
  themeRiver: '主题河流',
  custom: '自定义',
};

/**
 * 从 echarts option 推导系列副标题（如「柱状 · 折线」）。
 * 未知类型回落原英文名；去重后最多取 3 种，避免副标题撑爆工具栏。
 */
export function seriesLabel(option: Record<string, unknown>): string {
  const raw = option.series;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: string[] = [];
  for (const item of list) {
    const t = (item as { type?: unknown } | null | undefined)?.type;
    if (typeof t !== 'string' || t === '') continue;
    const cn = SERIES_CN[t] ?? t;
    if (!out.includes(cn)) out.push(cn);
  }
  return out.slice(0, 3).join(' · ');
}

/** mermaid 图类型关键字（按首个命中返回）→ 中文名；注意顺序：更具体的关键字在前 */
const DIAGRAM_CN: [RegExp, string][] = [
  [/^\s*(?:flowchart|graph)\b/i, '流程图'],
  [/^\s*sequenceDiagram\b/i, '时序图'],
  [/^\s*classDiagram/i, '类图'],
  [/^\s*stateDiagram/i, '状态图'],
  [/^\s*erDiagram\b/i, 'ER 图'],
  [/^\s*gantt\b/i, '甘特图'],
  [/^\s*quadrantChart\b/i, '象限图'],
  [/^\s*pie\b/i, '饼图'],
  [/^\s*journey\b/i, '旅程图'],
  [/^\s*gitGraph\b/i, 'Git 图'],
  [/^\s*mindmap\b/i, '思维导图'],
  [/^\s*timeline\b/i, '时间线'],
  [/^\s*requirementDiagram\b/i, '需求图'],
  [/^\s*C4(?:Context|Container|Component|Dynamic|Deployment)\b/i, 'C4 图'],
  [/^\s*(?:block|architecture)-beta\b/i, '块图'],
  [/^\s*xychart/i, 'XY 图'],
  [/^\s*sankey/i, '桑基图'],
];

/** 从 mermaid 源码推导图类型副标题（如「流程图」）；识别不到返回空串 */
export function diagramLabel(src: string): string {
  for (const [re, cn] of DIAGRAM_CN) if (re.test(src)) return cn;
  return '';
}
