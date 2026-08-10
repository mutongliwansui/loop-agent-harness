---
name: component-box
description: Box 容器组件规范 — Flexbox 布局、样式属性白名单、盒模型、硬性限制、嵌套约束
---

# Box 组件规范

`Box` 是页面内容树的布局容器，负责声明一组子元素的排列方式：方向、间距、对齐、分配比例。所有结构组织（分组、卡片、分栏、装饰）都通过 `Box` 完成，可任意嵌套，是构建页面结构的基本单元。

## 核心属性

```python
Box(
    children=[...],  # 内容子树（除 Slide 外的任意组件）
    style={...},     # Flexbox 样式（白名单校验，见下表）
)
```

| 属性 | 必填 | 类型 | 默认 | 约束 |
|---|---|---|---|---|
| `type` | 否 | str | `"Box"` | 字面量，不可修改 |
| `children` | 否 | list[Node] | `[]` | 可含 Box/Text/Chart/Image/Table/FAIcon/SVG/QRCode/CodeBlock/Math；**不允许包含 Slide**（编译期 `DSL_INVALID_CHILDREN` 错误） |
| `style` | 否 | dict | `{}` | 键必须命中白名单（见下表），非法键抛 `DSL_UNKNOWN_PROPERTY`，非法值抛 `DSL_INVALID_STYLE_VALUE` |

`Box` 本身是 flex 容器，`style` 缺省即等价于 `display: flex; flexDirection: column`（`display` 属性可写可不写，仅允许 `"flex"`）。

## 默认布局与盒模型

布局引擎采用两遍算法（`layout/engine.py`）：先 `measure`（自底向上计算固有尺寸），再 `arrange`（自顶向下分配绝对坐标，产出 bounding box）。

| 项 | 默认值 | 说明 |
|---|---|---|
| 主轴方向 | `column`（纵向） | `flexDirection` 仅支持 `row` / `column`，**无 wrap**（单行/单列） |
| 子项间距 | `gap: 0` | px 数值 |
| 主轴对齐 | `justifyContent: flex-start` | 剩余空间分配策略 |
| 交叉轴对齐 | `alignItems: stretch` | **默认拉伸**：子项在交叉轴占满容器（扣除交叉轴 margin） |
| 内边距 | `padding: 0` | px 数值，四边一致 |
| 外边距 | `margin` / 四方向单边 | 主轴方向参与尺寸与排布，交叉轴方向参与对齐定位 |
| 定位 | `position: static` | 仅支持 `static` / `relative` / `absolute` |

- **盒模型（border-box 语义）**：`width` / `height` 已包含 `padding` 与 `border`，内容可用空间 = `尺寸 - 2 × padding - 2 × border`；例如 `Box(style={"width": 400, "padding": 20, "border": "2px solid #000"})` 内部可用宽 = 400 − 20×2 − 2×2 = **356px**。
- **尺寸解析**：`width` / `height` 支持数值 / `'Npx'` / `'N%'`，百分比相对父容器内容区；缺省时由子项内容 + `2 × (padding + border)` 决定（column：高 = Σ子项高 + margin + gap，宽 = 最大子项宽）。
- **min/max 夹取**：`minWidth` / `maxWidth` / `minHeight` / `maxHeight` 在布局分配后对尺寸做下限保底 / 上限封顶，百分比相对父容器主轴/交叉轴长度。
- **margin 语义**：主轴方向（row 的左右、column 的上下）占用布局空间，交叉轴方向（row 的上下、column 的左右）参与对齐起点；`margin` 简写 1/2/3/4 值按 top/right/bottom/left 展开。
- **flex 分配**：`flex` 为正整数权重，仅当子项无显式主轴尺寸时参与分配；**父容器无显式主轴尺寸时剩余空间为 0，`flex` 权重不生效，子项回退到内容固有尺寸而非塌陷为 0**（实测含文字子项回退到 26px，仅空子项为 0）；如 column 容器无显式 `height` 时 `flex: 1` 无效，弹性均分需显式高度。
- **overflow 是硬错误**：任何节点 rect 超出画布 `(0, 0, 1280, 720)` 即抛 `LAYOUT_OVERFLOW`（错误定位到节点类型），内容区可用高度 540px（B 区）。`relative` 偏移后的位置同样参与溢出检查。

## 样式属性白名单

以下为 `Box` 允许的全部样式键（`scripts/slidep/dsl/styles.py` `_BOX_LAYOUT_KEYS`，单一数据源）：

| 类别 | 属性 | 取值约束 | 默认 |
|---|---|---|---|
| 方向 | `flexDirection` | `row` / `column` | `column` |
| 间距 | `gap` | px 数值（≥0） | `0` |
| 对齐 | `justifyContent` | `flex-start` / `center` / `flex-end` / `space-between` / `space-around` | `flex-start` |
| 对齐 | `alignItems` | `flex-start` / `center` / `flex-end` / `stretch` | `stretch` |
| 分配 | `flex` | 正整数 | `0` |
| 尺寸 | `width` / `height` | 数值 / `'Npx'` / `'N%'`（百分比相对父容器，0-100） | 内容自适应 |
| 尺寸 | `minWidth` / `maxWidth` / `minHeight` / `maxHeight` | 数值 / `'Npx'` / `'N%'`（相对父容器） | 无 |
| 内边距 | `padding` | px 数值（≥0） | `0` |
| 外边距 | `margin` | 1-4 值简写（top, right, bottom, left；纯数值或 px） | `0` |
| 外边距 | `marginTop` / `marginBottom` / `marginLeft` / `marginRight` | px 数值（≥0），显式单边覆盖 `margin` 简写 | `0` |
| 背景 | `background` | 纯色 `#hex`（3/6/8 位）或 `linear-gradient(Ndeg, #hex, #hex)` | 无 |
| 圆角 | `borderRadius` | px 数值（≥0） | `0` |
| 边框 | `border` | `'<width>px solid <color>'`，border-box 计入尺寸 | 无 |
| 阴影 | `boxShadow` | `'<x>px <y>px <blur>px <alpha 0-255 \| rgba()>'`，向下投影；**`<x>`（offsetX）解析但渲染时忽略**——OOXML 外阴影 `outerShdw` 仅支持方向角（固定 90° 向下），偏移只由 `<y>` 表达 | 无 |
| 透明度 | `opacity` | 0-1 数值，作用于容器自身背景（与背景 alpha 相乘） | `1` |
| 叠放 | `zIndex` | 整数（可负），大者后渲染（在上层） | `0` |
| 定位 | `position` | `static` / `relative` / `absolute` | `static` |
| 定位 | `top` / `left` / `right` / `bottom` | px 数值；`relative` 时相对自身原位偏移（**top 优先 bottom**、left 优先 right），`absolute` 时相对父 padding box，**`static` 时全部忽略** | 无 |

> `display` 仅允许 `"flex"`（默认值，可不写）；其余任何 `display` 值直接报错。

## 硬性限制（必须遵守）

| 禁止项 | 原因 | 替代 |
|---|---|---|
| `display: grid` / `display: table` | 布局引擎只实现 flex | 用 flex 嵌套 |
| `calc()` / `var()` / `!important` | 不解析表达式（值中检测到即报错） | Python 表达式 / 模块级常量 |
| `flexWrap` / `flex-wrap` | PPT 无响应式需求，无 wrap 支持 | 用 row + flex 分配 |
| `flexGrow` / `flexShrink` / `flexBasis` | 不在白名单，`flex` 即权重简写 | 用 `flex` 权重 |
| `borderStyle`（非 solid）/ `border-dashed` | 仅支持 solid 边框 | 用 `border` solid |
| `position: sticky` / `fixed` | 仅支持 `static` / `relative` / `absolute` | 用 `absolute` 相对父容器定位 |
| 子项包含 `Slide` | Slide 是唯一根节点 | 拆为独立页面文件 |

**违反以上任意一项即 DSL 错误**（`DSL_UNKNOWN_PROPERTY` / `DSL_INVALID_STYLE_VALUE`），禁止静默忽略。

## 使用场景

### 横向排列（图标 + 文字组合）

```python
from slidep.dsl import Box, Text, FAIcon

Box(
    style={"flexDirection": "row", "alignItems": "center", "gap": 20,
           "padding": 20, "background": "#F1F5F9", "borderRadius": 8},
    children=[
        FAIcon(name="info-circle", style={"color": "#3B82F6", "width": 24, "height": 24}),
        Box(style={"flexDirection": "column"},
            children=[
                Text("标题", style={"fontSize": 18, "fontWeight": "bold"}),
                Text("描述文本", style={"fontSize": 14, "color": "#64748B"}),
            ]),
    ],
)
```

### Flex 纵向均分（内容卡片组）

```python
from slidep.dsl import Box

# 父容器需显式高度，flex: 1 才会分配剩余空间
Box(
    style={"flexDirection": "column", "gap": 24, "height": 460,
           "justifyContent": "space-between", "padding": 24,
           "background": "#0F172A", "borderRadius": 12},
    children=[
        Box(style={"flex": 1, "background": "#1E293B", "borderRadius": 8}),  # 卡片 1
        Box(style={"flex": 1, "background": "#1E293B", "borderRadius": 8}),  # 卡片 2
        Box(style={"flex": 1, "background": "#1E293B", "borderRadius": 8}),  # 卡片 3
    ],
)
```

### 两栏（hero-split，左文右图）

```python
from slidep.dsl import Box, Image

Box(
    style={"flexDirection": "row", "gap": 24, "width": "100%", "height": 400},
    children=[
        Box(style={"flex": 3, "flexDirection": "column", "gap": 16},
            children=[...]),                  # 文字论证列
        Box(style={"flex": 2, "alignItems": "center"},
            children=[Image(src="resources/images/hero.png")]),  # 主视觉列
    ],
)
```

### 绝对定位装饰元素

```python
from slidep.dsl import Box, Text

Box(  # 定位基准：static 容器
    style={"width": "100%", "height": 480, "padding": 24},
    children=[
        Box(style={"position": "absolute", "top": 0, "right": 0,
                   "width": 200, "height": 200,
                   "background": "linear-gradient(135deg, #3B82F6 0%, #0F172A 100%)",
                   "borderRadius": 100}),    # 右上角装饰圆，不占布局流
        Text("主内容", style={"fontSize": 32, "fontWeight": "bold"}),
    ],
)
```

## 约束与风格一致性

| 规则 id | 级别 | 约束 |
|---|---|---|
| `layout.card_row_max_pages` | error | N 卡片均分横排版式全篇 ≤ 2 页，超限即流水线感 |
| `layout.asymmetric_min_ratio` | error | 全篇非对称版式页占比 ≥ 40%，防千篇一律居中 |
| `layout.max_whitespace_ratio` | warning | content 页留白 ≤ 35%（卡片过大/内容过少会触发） |
| `layout.card_fill_min_ratio` | warning | 卡片内部内容填充率 ≥ 85%，防大卡片小内容 |
| `anchor.per_page_required` | error | 每页至少 1 个视觉锚点（≥44px 文字或 ≥40% B 区主视觉） |

- 容器嵌套深度超过 **5 层**时 lint 给出 `structure.max_nesting_depth` 告警（规则定义见 `validate/rules.json`），结构过深难维护；优先用 `flex` 分配而非层层嵌套。
- 页面内每个视觉区块用独立容器 `Box` 包裹，必要时加 `background`（纯色或半透明渐变）增强分区感。
- 卡片组用 flex + `flex: 1` 均分空间，而非固定高度堆叠。
- 背景装饰元素用 `position: absolute`，不占用布局流、不遮挡内容。

## 引用说明

引擎实现文件：`scripts/slidep/dsl/components.py`（Box 模型与 children 校验）、`scripts/slidep/dsl/styles.py`（样式白名单与值校验）、`scripts/slidep/layout/engine.py`（两遍 flexbox 布局与溢出检测）、`scripts/slidep/validate/rules.json`（lint 规则）。

相关方法论文档：`references/component-slide.md`（画布规格与三区母版）、`references/design-principle.md`（版式骨架/留白/对齐）。
