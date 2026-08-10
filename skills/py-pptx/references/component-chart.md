---
name: component-chart
description: Chart 图表组件规范 — 5 类原生可编辑图表、二维数组数据格式与校验、渲染行为、锚点判定
---

# Chart 组件规范

`Chart` 是页面内容树的叶子组件，用于嵌入数据图表。PPTX 输出调用 python-pptx 原生图表 API（`render/chart.py` `add_native_chart`），生成可在 PowerPoint 中直接编辑的图表。适用场景：趋势（折线/面积）、对比（柱状）、占比（饼图）、点分布（散点）。

## 核心属性

| 属性 | 必填 | 取值约束 | 默认 |
|---|---|---|---|
| `chart_type` | 是 | `barChart` / `lineChart` / `pieChart` / `areaChart` / `scatterChart` | 无 |
| `data` | 是 | 二维数组，首行表头、首列分类；详见下方数据格式 | `[]` |
| `title` | 否 | 字符串，图表标题 | 无标题 |
| `style` | 否 | 白名单：`width` / `height` / `marginTop` / `marginBottom` / `flex` | `{}` |

```python
Chart(
    chart_type="barChart",
    title="季度销售对比",
    data=[
        ["季度", "2023", "2024"],
        ["Q1", 120, 145],
        ["Q2", 156, 178],
        ["Q3", 198, 210],
        ["Q4", 230, 256],
    ],
    style={"width": "60%", "height": 320},
)
```

## 数据格式

`data` 为二维数组，第一行表头（首列为分类名，其余为系列名），后续每行第一列为分类值、其余列为数值。所有数值必须为 `int` / `float`，字符串数字（如 `"120"`）与 `bool` 均判错。

```python
data=[
    ["类别名", "系列1", "系列2"],
    ["分类1", 10, 20],
    ["分类2", 15, 18],
]
```

DSL 校验（`dsl/components.py` `_validate_chart_data`，不符合直接报错）：

| 校验项 | 规则 |
|---|---|
| 行数 | 至少 2 行（表头 + 1 数据行） |
| 列数 | 每行至少 2 列（分类 + 1 系列） |
| 行一致性 | 所有行列数必须与表头一致 |
| 数值类型 | 数值列必须 `int`/`float`，字符串与 `bool` 非法 |
| 饼图限制 | `pieChart` 仅支持单系列（表头 2 列） |

**散点图特殊约定**：`scatterChart` 的 x 坐标为分类索引（0, 1, 2, ...），首列分类值不参与定位，只决定数据点数量；y 取数值列。

## 渲染行为

图表样式由引擎内置（无自定义入口），输出均为原生可编辑图表：

| 项 | 行为 |
|---|---|
| 色板 | 固定 6 色 `#0EA5E9 / #F59E0B / #10B981 / #8B5CF6 / #EF4444 / #6366F1`，按系列循环取色（饼图按扇区取色）；不参与主题色 lint 统计 |
| 图例 | 饼图固定右侧；多系列（>1）底部；单系列非饼图不显示 |
| 数据标签 | 非散点图默认显示（保留 1 位小数）；饼图显示百分比；柱状图标签在柱外上方，折线图在数据点上方 |
| 坐标轴 | 非饼图轴标签 9px、灰色 `#64748B`；数值轴带主网格线 |
| 标题 | `title` 设置为图表标题，缺省时关闭标题块 |

## 布局与样式

`Chart` 为叶子组件，默认尺寸 480×320（`layout/engine.py` `_LEAF_DEFAULT_SIZES`），可用 `style` 覆盖：

- `width` / `height`：数值 / `'Npx'` / `'N%'`（百分比相对父容器）
- `marginTop` / `marginBottom`：px（≥0），纵向间距
- `flex`：正整数权重，在 flex 容器中参与弹性分配

横向布局由父容器 `Box` 控制（`justifyContent` / `gap`）。图表默认背景为母版背景，无独立背景样式键。

**锚点判定**：`Chart` 占 B 区面积 ≥ 40% 时可作为视觉锚点（与 `Image` 同一判定路径，见 `validate/lint.py` `validate_anchor`），满足 `anchor.per_page_required`。

## 使用场景

**柱状对比**：多类别横向比较，数据标签默认显示：

```python
Box(style={"gap": 24},
    children=[
        Text("各部门季度目标达成", style={"fontSize": 32, "fontWeight": "bold", "color": "#1E293B"}),
        Chart(
            chart_type="barChart",
            title="部门业绩对比",
            data=[
                ["部门", "目标", "实际"],
                ["销售部", 100, 115],
                ["市场部", 80, 72],
                ["研发部", 120, 125],
            ],
            style={"width": "100%", "height": 320},
        ),
    ])
```

**折线趋势**：时间序列或趋势变化最清晰：

```python
Chart(
    chart_type="lineChart",
    title="月度用户增长趋势",
    data=[
        ["月份", "活跃用户", "新增用户"],
        ["1月", 1200, 350],
        ["2月", 1450, 420],
        ["3月", 1780, 480],
        ["4月", 2100, 520],
    ],
    style={"width": "100%", "height": 320},
)
```

**饼图占比**：单系列占比表达，建议分类 ≤ 6 个，过多时改用柱状图或表格：

```python
Chart(
    chart_type="pieChart",
    title="市场份额分布",
    data=[
        ["产品", "份额"],
        ["产品A", 35],
        ["产品B", 28],
        ["产品C", 22],
        ["产品D", 15],
    ],
    style={"width": 420, "height": 320},
)
```

## 约束与建议

**lint 相关**（`scripts/slidep/validate/rules.json` 为单一数据源）：

| 规则 | 级别 | 与 Chart 的关系 |
|---|---|---|
| `anchor.per_page_required` | error | 每页 ≥1 视觉锚点；仅当 Chart 占 B 区 ≥40% 时计为锚点 |
| `typography.min_body_chars` | error | content 页正文 ≥180 字；Chart 不计字数，图表页需配足文字说明 |
| `color.max_theme_colors` | error | 全篇主题色 ≤4；图表内置色板不参与统计 |

**设计建议**（引擎不强制）：

- 分类过多（如 >12）时标签拥挤、可读性下降，建议拆分图表或改用 `Table`
- 图表页避免单独出现：Chart 不是锚点时（面积 <40% B 区），页内需有 ≥44px 文字或其他锚点
- 单位写进表头（如 `"营收(亿元)"`），轴标签不单独加单位
- 数值保持 `number` 类型，避免字符串数字

## 引用说明

引擎实现文件：`scripts/slidep/dsl/components.py`（Chart 模型与数据校验）、`scripts/slidep/render/chart.py`（原生图表渲染与 matplotlib 预览）、`scripts/slidep/render/engine.py`（`_render_chart` 接线）、`scripts/slidep/layout/engine.py`（默认尺寸与排布）、`scripts/slidep/validate/rules.json`（lint 规则）。
