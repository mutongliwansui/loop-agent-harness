---
name: component-svg
description: SVG 图形组件规范 — markup 必填语义、支持元素与属性子集、viewBox 坐标空间、Diagram 应用场景、与 Text 的边界
---

# SVG 组件规范

`SVG` 是页面内容树的叶子组件，用于嵌入结构化矢量图形（流程图、时间轴、架构图、装饰线条）。`markup` 为完整 SVG 标记字符串，PPTX 输出经轻量解析器（`render/svg_render.py` `render_svg_png`）转 matplotlib 基元后输出透明 PNG 再嵌入（`render/engine.py` `_render_svg`）；预览输出直接嵌入原生 SVG 标记（`preview/svg_renderer.py` `_render_svg_component_svg`）。不依赖 CairoSVG，离线可用。

## 核心属性

| 属性 | 必填 | 取值约束 | 默认 |
|---|---|---|---|
| `markup` | 是 | 非空字符串；合法 SVG 标记（支持元素见下表） | 无 |
| `style` | 否 | 白名单：`width` / `height` / `marginTop` / `marginBottom` / `flex` | `{}` |

```python
SVG(
    markup='<svg viewBox="0 0 100 100">'
           '<rect x="10" y="10" width="80" height="80" rx="8" fill="#3B82F6"/>'
           '</svg>',
    style={"width": 200, "height": 200},
)
```

`markup` 为空串报 `DSL_MISSING_REQUIRED_PROP`（`SLIDEP_1005`，hint：SVG 标记不能为空）。`color` 不在 `SVG` 白名单内，SVG 内部颜色一律在 `markup` 内通过 `fill` / `stroke` 属性指定；在 style 中写 `color` 报 `DSL_UNKNOWN_PROPERTY`（`SLIDEP_1001`）。

## 支持元素与属性

轻量解析器支持以下元素子集（`render/svg_render.py` `_render_element`），子集外的元素被静默忽略：

| 元素 | 支持属性 | 说明 |
|---|---|---|
| `<rect>` | `x` `y` `width` `height` `rx` | `rx>0` 时渲染圆角矩形 |
| `<circle>` | `cx` `cy` `r` | 圆心 + 半径 |
| `<ellipse>` | `cx` `cy` `rx` `ry` | — |
| `<line>` | `x1` `y1` `x2` `y2` | 线段，`stroke` 着色，圆头端点 |
| `<polyline>` / `<polygon>` | `points` | `polygon` 自动闭合 |
| `<path>` | `d` | M/L/H/V/C/Q/A 命令（含相对坐标小写），`z` 闭合，圆弧（A）简化为直线 |
| `<text>` | `x` `y` `font-size` | 文字标注，`fill` 为文字颜色，**左对齐基线**（不支持 `text-anchor` 居中，`x` 即文字起点） |
| `<g>` | `transform` | 分组，仅支持 `translate(x,y)` 偏移 |

公共属性（作用于除 `<g>` 外各元素）：`fill`（默认 `black`）、`stroke`（默认 `none` 无描边）、`stroke-width`（默认 1）、`opacity`（默认 1）。

颜色支持 `#RRGGBB` 与 18 个命名色（`white/black/red/green/blue/yellow/gray/grey/orange/purple/pink/brown/cyan/magenta/lime/navy/teal/transparent`）；`fill="none"` / `stroke="none"` 表示不填充 / 不描边（`render/svg_render.py` `_parse_color`）。建议一律使用 `#RRGGBB` 十六进制，与主题色板同源。

## 渲染行为

| 项 | 行为 |
|---|---|
| 输出格式 | ElementTree 解析 → matplotlib 基元 → 透明 PNG bytes，嵌入 PPTX 图片 |
| 坐标空间 | `viewBox`（或 `viewbox`）决定坐标系；缺失时以根节点 `width`/`height` 属性为坐标空间；SVG y 轴向下 |
| 非法 XML | `RENDER_OOXML_FAILED`（`SLIDEP_3001`），提示"SVG 解析失败" |
| 渲染异常 | `RENDER_OOXML_FAILED`（`SLIDEP_3001`），提示"SVG 渲染失败" |
| 依赖 | matplotlib 为可选依赖；缺失时提示 `pip install matplotlib`（同样报 `SLIDEP_3001`） |
| 预览路径 | 直接嵌入原始 markup（外层 `<g>` + translate 定位），不经 matplotlib |

## 布局与样式

`SVG` 为叶子组件，默认尺寸 400×300（`layout/engine.py` `_LEAF_DEFAULT_SIZES`），可用 `style` 覆盖：

- `width` / `height`：数值 / `'Npx'` / `'N%'`（百分比相对父容器）
- `marginTop` / `marginBottom`：px（≥0），纵向间距
- `flex`：正整数权重，在 flex 容器中参与弹性分配

尺寸与坐标规范：

- **`viewBox` 与显示尺寸比例保持一致**，否则图形被拉伸变形；建议 `viewBox="0 0 W H"` 与 `width/height` 同比例
- 图形内文字（`<text>`）只作标注（节点名、步骤序号），字号以 viewBox 单位计算，随缩放等比变化；需要精确控制排版的文字用 `Text` 组件叠加
- 复杂图形优先拆分为多个基础元素组合（`<g>` 分组），避免单条超长 `path`

## 使用场景

SVG 承担旧版 Diagram（流程图 / 时间轴 / 架构图）的建模职责，节点与连接线均用 SVG 元素表达。

> 字体边界：PPTX 输出经 matplotlib 渲染，默认字体不包含 CJK 字形，**`<text>` 内中文会显示为豆腐块**（仅 UserWarning，不报错）。图形内标注建议使用英文 / 数字；中文标注请叠加 `Text` 组件（走 PPTX 原生文本，无字体问题）。如确需 SVG 内中文，需为 matplotlib 配置含 CJK 的字体（如 `Noto Sans CJK SC`）。

**流程图**：`<rect>` 节点 + `<path>` 连接线 + `<text>` 标注（左对齐，`x` 为文字起点），单页节点数建议 ≤8：

```python
SVG(
    markup='<svg viewBox="0 0 960 240">'
           '<rect x="20" y="70" width="180" height="100" rx="10" fill="#DBEAFE" stroke="#3B82F6" stroke-width="2"/>'
           '<text x="40" y="115" font-size="20" fill="#1E3A8A">Analysis</text>'
           '<line x1="200" y1="120" x2="280" y2="120" stroke="#94A3B8" stroke-width="3"/>'
           '<path d="M280 112 l20 8 l-20 8 z" fill="#94A3B8"/>'
           '<rect x="300" y="70" width="180" height="100" rx="10" fill="#DBEAFE" stroke="#3B82F6" stroke-width="2"/>'
           '<text x="320" y="115" font-size="20" fill="#1E3A8A">Design</text>'
           '<line x1="480" y1="120" x2="560" y2="120" stroke="#94A3B8" stroke-width="3"/>'
           '<path d="M560 112 l20 8 l-20 8 z" fill="#94A3B8"/>'
           '<rect x="580" y="70" width="180" height="100" rx="10" fill="#3B82F6"/>'
           '<text x="600" y="115" font-size="20" fill="#FFFFFF">Launch</text>'
           '<line x1="760" y1="120" x2="840" y2="120" stroke="#94A3B8" stroke-width="3"/>'
           '<path d="M840 112 l20 8 l-20 8 z" fill="#94A3B8"/>'
           '<rect x="860" y="70" width="80" height="100" rx="10" fill="#DBEAFE" stroke="#3B82F6" stroke-width="2"/>'
           '<text x="880" y="115" font-size="20" fill="#1E3A8A">Retro</text>'
           '</svg>',
    style={"width": 960, "height": 240},
)
```

**时间轴**：`<line>` 主轴 + `<circle>` 节点 + 阶段 `<text>`，线性叙事：

```python
SVG(
    markup='<svg viewBox="0 0 960 200">'
           '<line x1="40" y1="100" x2="920" y2="100" stroke="#CBD5E1" stroke-width="4"/>'
           '<circle cx="160" cy="100" r="14" fill="#3B82F6"/>'
           '<text x="120" y="50" font-size="20" fill="#0F172A">2022</text>'
           '<text x="128" y="145" font-size="16" fill="#475569">Platform</text>'
           '<circle cx="400" cy="100" r="14" fill="#3B82F6"/>'
           '<text x="360" y="50" font-size="20" fill="#0F172A">2023</text>'
           '<text x="368" y="145" font-size="16" fill="#475569">Scale</text>'
           '<circle cx="640" cy="100" r="14" fill="#3B82F6"/>'
           '<text x="600" y="50" font-size="20" fill="#0F172A">2024</text>'
           '<text x="608" y="145" font-size="16" fill="#475569">Global</text>'
           '<circle cx="880" cy="100" r="14" fill="#F59E0B"/>'
           '<text x="840" y="50" font-size="20" fill="#0F172A">2025</text>'
           '<text x="848" y="145" font-size="16" fill="#475569">Ecosystem</text>'
           '</svg>',
    style={"width": 960, "height": 200},
)
```

**架构图**：分层区块用 `<rect>` + `<g>` 分组，区块内部文字用 `<text>` 标注（左对齐基线）：

```python
SVG(
    markup='<svg viewBox="0 0 960 360">'
           '<rect x="20" y="20" width="920" height="80" rx="8" fill="#EFF6FF" stroke="#93C5FD"/>'
           '<text x="40" y="65" font-size="20" fill="#1E40AF">Access  ·  Gateway / LB / CDN</text>'
           '<rect x="20" y="120" width="920" height="100" rx="8" fill="#F0FDF4" stroke="#86EFAC"/>'
           '<text x="40" y="165" font-size="20" fill="#166534">App  ·  Microservices / K8s / MQ</text>'
           '<rect x="20" y="240" width="920" height="100" rx="8" fill="#FEF2F2" stroke="#FCA5A5"/>'
           '<text x="40" y="285" font-size="20" fill="#991B1B">Data  ·  MySQL / Redis / OSS</text>'
           '</svg>',
    style={"width": 960, "height": 360},
)
```

## 与 Text 的边界

`SVG` 仅用于低语义图形元素，**禁止承载需要精确控制排版与语义的文字信息**：

- 标题、正文、列表、数字结论等一律用 `Text` 组件（参与字号阶梯与字体家族 lint）
- `<text>` 只作图形内标注（节点名、步骤序号、时间年份），且 SVG 整体建议配合 `Text` 标题使用
- 装饰线条 / 背景图形优先考虑 `Box` + `border` 表达，`SVG` 留给无法用基础组件拼出的图形
- 能直接用 `FAIcon` 表达的语义（勾选、警告、箭头等）优先 `FAIcon`，仅特殊自定义图形才用 `SVG`

## 约束（lint 门禁）

`SVG` 无专属 lint 规则（`validate/rules.json` 未定义 svg 类规则）：DSL 层校验 `markup` 非空与 style 白名单；渲染层校验 XML 合法性与渲染结果。`SVG` 计入内容面积统计（`validate/lint.py` `_LEAF_TYPES` / `is_media`），但不参与 `anchor.per_page_required` 锚点判定（锚点仅 ≥40% B 区的 `Image`）。

| 检查点 | 阶段 | 错误/行为 |
|---|---|---|
| `markup` 为空 | DSL | `DSL_MISSING_REQUIRED_PROP`（`SLIDEP_1005`） |
| style 白名单外键（如 `color`） | DSL | `DSL_UNKNOWN_PROPERTY`（`SLIDEP_1001`） |
| `markup` 非合法 XML | 渲染 | `RENDER_OOXML_FAILED`（`SLIDEP_3001`，提示"SVG 解析失败"） |
| matplotlib 未安装 | 渲染 | `RENDER_OOXML_FAILED`（`SLIDEP_3001`，提示 `pip install matplotlib`） |

## 引用说明

引擎实现文件：`scripts/slidep/dsl/components.py`（SVG 模型与 `_validate_svg` 非空校验）、`scripts/slidep/dsl/styles.py`（`STYLE_WHITELIST["SVG"]`）、`scripts/slidep/render/svg_render.py`（`render_svg_png` 与元素/属性子集）、`scripts/slidep/render/engine.py`（`_render_svg` 接线）、`scripts/slidep/preview/svg_renderer.py`（`_render_svg_component_svg` 预览接线）、`scripts/slidep/layout/engine.py`（默认尺寸 400×300）。
