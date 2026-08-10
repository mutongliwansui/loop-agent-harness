---
name: component-text
description: Text 文本组件规范 — 富文本换行与内联样式、样式白名单、字号阶梯、标题去重联动
---

# Text 组件规范

`Text` 是页面内容树的叶子组件，承载所有文字内容。通过 `Text("内容", style={...})` 声明，支持多段落、局部内联样式（变色/加粗/改字号）、对齐与行距控制，是所有正文、标注、锚点大标题的载体。`Text` 没有 `children`，文字内容即 `text` 字段本身。

## 核心属性

| 属性 | 必填 | 取值约束 | 默认 |
|---|---|---|---|
| `text` | 是 | 字符串，支持 `\n` 与 `<br />` 换行、`<span>` 内联样式 | `""` |
| `style` | 否 | 白名单键见下表；未知键直接报错 | `{}` |

```python
Slide(
    page_type="content",
    children=[
        Text("2026 年营收突破 120 亿，同比增长 34%",
             style={"fontSize": 20, "color": "#334155", "lineHeight": 1.5}),
    ],
)
```

## 富文本语法

`text` 是纯字符串，解析规则与 `render/engine.py` 的 `_parse_rich_text` 一致：

| 语法 | 效果 | 说明 |
|---|---|---|
| `<br />`（或 `<br>`） | 段落分隔 | 独立标签，大小写不敏感；每个标签生成一个独立段落 |
| `\n` | 换行（兼容） | 原样透传给渲染器，不生成段落分隔；布局测量不识别 `\n` 分行，多行文本**优先用 `<br />`** |
| `<span style={{...}}>文字</span>` | 局部内联样式 | style 内支持 `color` / `fontWeight` / `fontSize`，`key:"value"` 逗号分隔 |
| `<strong>` / `<em>` / `<b>` / `<i>` | 不支持 | HTML 语义标签一律用 span 内联样式或顶层 style 表达 |
| span 嵌套 | 不支持 | 嵌套会破坏解析（正则非贪婪匹配），输出错位文本 |

```python
Text(
    '营收 <span style={{color:"#E5484D"}}>120亿</span><br />同比增长 34%',
    style={"fontSize": 20, "lineHeight": 1.6},
)
```

内联样式支持 `color`（`#hex` 或命名色）、`fontWeight`（`bold`）、`fontSize`（数值，px）。span 内的 `fontWeight`/`fontSize` 只做局部覆盖，不参与字号阶梯 lint（阶梯只检查顶层 `style.fontSize`）。

## 样式属性白名单

以下为 `Text` 允许的全部样式键（`scripts/slidep/dsl/styles.py` `STYLE_WHITELIST`，单一数据源）：

| 类别 | 属性 | 取值约束 | 默认 |
|---|---|---|---|
| 字号 | `fontSize` | 正数（px），须落在字号阶梯 | `18` |
| 字重 | `fontWeight` | `normal` / `bold`（仅两档） | `normal` |
| 字体 | `fontFamily` | 字符串；全篇 ≤ 2 个家族（lint） | 继承默认字体 |
| 颜色 | `color` | `#hex`（3/6/8 位）或内置命名色 | 默认黑 |
| 对齐 | `textAlign` | `left` / `center` / `right` | `left` |
| 行高 | `lineHeight` | 数值倍率 ≥ 1.0，推荐 1.3-1.6 | `1.3` |
| 字距 | `letterSpacing` | px（≥0），标题可适当放宽 | `0` |
| 尺寸 | `width` / `height` | 数值 / `'Npx'` / `'N%'` | 内容自适应 |
| 外边距 | `marginTop` / `marginBottom` | px（≥0），纵向间距 | `0` |

`Text` 不支持 Box 的布局与视觉键：`flex` / `gap` / `padding` / `margin` 简写 / `background` / `opacity` / `border` / `boxShadow` / `position`，写入直接报错。横向间距用容器 `Box` 的 `gap` 或 `justifyContent` 控制。

## 字号阶梯与标题层级

**字号阶梯**（lint `typography.size_ladder`，error）：每个显式 `fontSize` 必须落在以下离散区间之一，中间值（如 44、48）非法：

| 档位 | 区间（px） | 用途 |
|---|---|---|
| `hero_title` | 56-72 | 封面标题、锚点大标题 |
| `title` | 32-40 | 章节级标题 |
| `body` | 18-24 | 正文 |
| `caption` | 12-16 | 注释、说明 |

**标题与 `Slide.title` 联动**：`Slide(title=...)` 会自动渲染标题块（content/toc 左上 32px 粗体，cover 居中 56px，section 居中 44px 白字，ending 居中 44px）。若 children 树任意层级存在文本与 `title` 一致（空白归一化比较）的 `Text`，自动标题块跳过（`render/engine.py` `_title_in_children`）——需要自定义标题样式时，把标题文本放进 children 并用 `fontSize`/`color` 控制，即可替代母版标题。

**文字锚点**（lint `typography.anchor_min_size` warning + `anchor.per_page_required` error）：≥ 44px 的文本构成视觉锚点，每页至少 1 个。由于阶梯中 ≥ 44 的合法区间只有 `hero_title`（56-72），锚点文字应取 **56-72px**；一页建议只设 1 个锚点大标题，避免多个大字号相互竞争。

## 使用场景

**正文段落**：`body` 档字号 + 行高 1.5 左右，纵向间距用 `marginTop` 而不用空行堆叠：

```python
Box(style={"flexDirection": "column", "gap": 16},
    children=[
        Text("核心结论", style={"fontSize": 32, "fontWeight": "bold", "color": "#1E293B"}),
        Text("本季度营收达到一百二十亿元，同比增长百分之三十四，创下历史新高。",
             style={"fontSize": 20, "color": "#475569", "lineHeight": 1.6}),
    ])
```

**富文本强调**：关键数字用 span 变色加粗，其余保持正文样式：

```python
Text(
    '活跃用户突破 <span style={{color:"#2563EB", "fontWeight": "bold"}}>8000万</span>，'
    '同比增长 <span style={{color:"#E5484D"}}>34%</span>',
    style={"fontSize": 20, "lineHeight": 1.6},
)
```

**锚点大标题**：56-72px 作为页内视觉锚点（同时满足 `anchor.per_page_required`）：

```python
Slide(
    page_type="content",
    title="2026 战略复盘",  # children 无同名 Text 时渲染母版标题
    children=[
        Text("三个关键增长引擎", style={"fontSize": 56, "fontWeight": "bold", "color": "#0F172A"}),
    ],
)
```

## 约束（lint 门禁）

| 规则 | 级别 | 要求 |
|---|---|---|
| `typography.size_ladder` | error | 字号落在 hero_title/title/body/caption 四档之一 |
| `typography.max_font_families` | error | 全篇字体家族 ≤ 2 |
| `typography.min_body_chars` | error | content 页正文字数 ≥ 180（只统计 children 中 `Text`，不含 `Slide.title`） |
| `anchor.per_page_required` | error | 每页至少 1 个视觉锚点（≥44px 文字或 ≥40% B 区主视觉） |
| `typography.anchor_min_size` | warning | 文字锚点字号 ≥ 44px |
| `color.max_theme_colors` | error | 全篇主题色 ≤ 4（含文字 `color` 与背景） |

规则参数与等级以 `scripts/slidep/validate/rules.json` 为单一数据源。

## 引用说明

引擎实现文件：`scripts/slidep/dsl/components.py`（Text 模型）、`scripts/slidep/dsl/styles.py`（样式白名单与值校验）、`scripts/slidep/layout/engine.py`（文本测量与排布）、`scripts/slidep/render/engine.py`（富文本解析与渲染）、`scripts/slidep/render/master.py`（标题块）、`scripts/slidep/validate/rules.json`（lint 规则）。
