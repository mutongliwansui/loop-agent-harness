---
name: component-slide
description: Slide 页面组件规范 — 画布规格、三区母版、页面类型/角色/节奏、标题与页脚、演讲备注
---

# Slide 组件规范

`Slide` 是页面的唯一根组件，声明整页的画布、母版区划、元信息（`page_type` / `role` / `rhythm`）、标题、背景与内容子树。一个页面文件只允许一个顶层 `Slide`，且必须为文件顶层表达式的返回值（存为模块级变量 `slide`）。

## 核心属性

```python
Slide(
    page_type="content",        # cover / toc / content / section / ending
    role="supporting",          # hero / supporting / transition
    rhythm="valley",            # peak / valley / transition
    title="季度业务汇报",         # 页内主标题；None 时不渲染母版标题块
    background="#0F172A",       # 页面背景（纯色 hex 或渐变），并入 style.background
    children=[...],             # 内容子树（Box/Text/Chart/Image/Table/FAIcon/SVG/QRCode/CodeBlock/Math）
)
```

| 属性 | 必填 | 类型 | 默认 | 约束 |
|---|---|---|---|---|
| `page_type` | 否 | str | `"content"` | 枚举 `cover / toc / content / section / ending`，见「页面类型」 |
| `role` | 否 | str | `"supporting"` | 枚举 `hero / supporting / transition`，见「叙事角色」 |
| `rhythm` | 否 | str | `"valley"` | 枚举 `peak / valley / transition`，见「节奏曲线」 |
| `title` | 否 | str \| None | `None` | 页内主标题；与 children 中同名 Text 自动去重 |
| `background` | 否 | str \| None | `None` | 纯色 hex（如 `#0F172A`）或渐变；构造时并入 `style["background"]` |
| `children` | 否 | list[Node] | `[]` | 不允许嵌套 Slide |
| `style` | 否 | dict | `{}` | Flexbox 样式（background/flexDirection/gap/padding 等），白名单校验 |

语义约束：

- `Slide` 是唯一根节点，**不允许出现在任何 children 中**（编译期 `DSL_INVALID_CHILDREN` 错误）。
- 每个页面文件顶层只能有 1 个 `Slide`（见「文件组织」）。
- `page_type` / `role` / `rhythm` 必须为枚举合法值，否则构造即报错。

## 画布规格与三区母版

画布固定 **1280 × 720 px（16:9）**，不可修改（`layout/engine.py` `CANVAS_RECT`）。渲染按三区母版划分：

| 区 | 位置 | 尺寸 | 用途 |
|---|---|---|---|
| A 区·标题块 | top 0 | 高 120px | 页内主标题（引擎按页类型渲染） |
| B 区·内容区 | (48, 120) | 1184 × 540 px | `Slide.children` 的布局容器（`SLIDE_CONTENT_RECT`，左右留白 48px） |
| C 区·页脚条 | top 660 | 高 60px | 项目名 + 页码 NN/TOTAL（引擎自动生成，作者不可改） |

- 内容**绝对不允许溢出画布**：任何节点 rect 超出 `(0, 0, 1280, 720)` 即报 `LAYOUT_OVERFLOW` 错误（`layout/engine.py` 溢出检测）。
- 编写前必须估算总高度：`上padding + 标题区 + 内容区 + 各间距(gap/margin) + 下padding ≤ 720px`；内容区可用高度 540px。
- 优先使用相对单位（百分比）或精确计算的固定值；禁止在主内容区用 `flex: 1` 而不计算实际高度。

## 文件组织与加载约定

- 页面文件位于项目根 `pages/` 子目录，每个 `.py` 文件代表一页。
- 文件名推荐 `slide_{NN}_{desc}.py`（NN 为零填充页码），按 NN 升序加载（`cli/loader.py`）。
- 文件须定义模块级变量 `slide: Slide`（单个页面）；也支持 `slides: list[Slide]`（一个文件产出多页）。
- 加载失败（语法错 / DSL 校验错 / 缺 `slide` 变量）会定位到文件 + 行号。
- 编译入口唯一：`slidep build`（全量编译 `pages/*.py` → `.pptx`）。

## 页面类型

`page_type` 决定母版标题块的默认布局与页脚显隐（`render/master.py`）：

| page_type | 母版标题布局 | 标题字号 | 页脚 |
|---|---|---|---|
| `cover` | hero-center：标题居中 | 56px 加粗 | 不显示 |
| `toc` | 左上 A 区 | 32px 加粗 | 显示 |
| `content` | 左上 A 区 | 32px 加粗 | 显示 |
| `section` | 全幅色块 + 标题居中偏左（白字） | 44px 加粗 | 不显示 |
| `ending` | hero-center：标题居中（略小于封面） | 44px 加粗 | 不显示 |

标准 deck 的建议顺序（详见 `story-principle.md`）：

```
cover（peak）
  → toc（transition，≤8 条）
    → [section（transition）→ content × n（peak/valley 混合）] × m
      → ending（peak，行动号召）
```

## 叙事角色与节奏曲线

- `role` 决定页面在叙事中的功能：`hero`（高峰页，承载核心论点与视觉记忆点，全篇占 20%-30%）、`supporting`（论证/展开页）、`transition`（转场页）。
- `rhythm` 声明节奏：`peak`（大字号、大视觉、少文字、强对比）、`valley`（高信息密度、多图表数据）、`transition`（过渡）。
- 约束：高峰页（hero/peak）之间必须间隔至少 2 页；结尾页必须是 peak，与倒数第 2 页形成「谷→峰」收束；Hero 页占比越界触发 `layout.hero_page_ratio` 警告（`rules.json`）。

## 标题语义（含去重约束）

- `title` 声明页内主标题。引擎按 `page_type` 渲染对应母版标题块（见上表）；`title=None` 时跳过。
- **去重约束**：若 `children` 树中已存在与 `title` 文本一致的 `Text` 组件（归一化比较：去除全部空白字符，含换行/空格/制表符），则引擎**不再渲染母版标题块**，避免标题重复出现（`render/engine.py` `_title_in_children`）。

```python
# 封面将大标题作为 children 中的 Text（含换行排版）→ 母版标题块自动不渲染
slide = Slide(
    page_type="cover",
    role="hero",
    rhythm="peak",
    title="人工智能在医疗领域的应用与展望",
    background="#061F32",
    children=[
        Box(style={"flexDirection": "column", "alignItems": "flex-start", "padding": 80},
            children=[
                Text("人工智能在医疗领域\n的应用与展望",
                     style={"fontSize": 64, "color": "#FFFFFF", "fontWeight": "bold"}),
                Text("AI IN HEALTHCARE: APPLICATIONS AND OUTLOOK",
                     style={"fontSize": 18, "color": "#08A6F6", "fontWeight": "bold"}),
            ]),
    ],
)
```

- 若 children 中无同名文本，则正常渲染母版标题块（A 区左上或居中）。
- A 区只放页内主标题，不放正文；标题字号遵循字号阶梯（`typography.size_ladder`，见「约束」）。

## 页脚与页码

- 页脚由引擎自动生成：右下角页码 `NN/TOTAL`（9pt，slate-400），左下角项目名（通过 `RenderOptions.project_name` 传入，可为空）。
- `cover / section / ending` 三种页类型**不显示页脚**；`toc / content` 显示。
- 可通过 `RenderOptions.footer=False` 全局关闭页脚渲染。

## 演讲者备注（Speaker Notes）

- **默认不写**。仅当用户明确要求（如「每页带演讲稿 / 附讲者备注」）时才添加，通过 `RenderOptions.notes: dict[int, str]`（页索引 0-based → 备注文本）传入，引擎写入 `notes_slide`。
- 备注应为自然的现场逐字演讲稿（≤300 字），用第一人称直接讲观点，**严禁**「这一页展示了 / 接下来进入」等元描述、过渡语或指导性语言；分点逻辑须换行分段。

## 使用场景

### 封面页（hero · peak）

```python
slide = Slide(
    page_type="cover",
    role="hero",
    rhythm="peak",
    title="2025 全球 AI 产业格局洞察",
    background="#0F172A",
    children=[...],  # 居中大标题/强调条/副标题（封面模板自动布局）
)
```

### 常规内容页（supporting · valley）

```python
slide = Slide(
    page_type="content",
    role="supporting",
    rhythm="valley",
    title="市场规模与增长趋势",
    children=[
        Box(style={"flexDirection": "row", "gap": 24},
            children=[...]),  # 图表 + 文字论证
    ],
)
```

### 章节过渡页（transition）

```python
slide = Slide(
    page_type="section",
    role="transition",
    rhythm="transition",
    title="02 · 技术路线",
    children=[],  # 全幅色块由 section 母版生成
)
```

## 约束与风格一致性

以下为与 Slide 直接相关的 lint 规则（单一数据源 `scripts/slidep/validate/rules.json`）：

| 规则 id | 级别 | 约束 |
|---|---|---|
| `typography.size_ladder` | error | 字号必须落阶梯：标题 32-40 / hero 标题 56-72 / 正文 18-24 / 注释 12-16 |
| `typography.min_body_chars` | error | 常规 content 页正文 ≥ 180 字，防信息空洞 |
| `layout.max_whitespace_ratio` | warning | content 页留白 ≤ 35% |
| `layout.card_fill_min_ratio` | warning | 卡片内容填充率 ≥ 85% |
| `layout.hero_page_ratio` | warning | hero 页占全篇 20%-30% |
| `layout.asymmetric_min_ratio` | error | 全篇非对称版式占比 ≥ 40% |
| `layout.card_row_max_pages` | error | N 卡片横排版式全篇 ≤ 2 页 |
| `toc.max_entries` | warning | 目录页条目 ≤ 8 条 |
| `color.max_theme_colors` | error | 全篇主题色 ≤ 4 个 hex |
| `anchor.per_page_required` | error | 每页至少 1 个视觉锚点（≥44px 文字或 ≥40% B 区主视觉） |

- 背景装饰元素可用绝对定位，但不影响内容布局、不占用安全区。
- 保持整篇视觉一致性：颜色取自设计风格主题色（`accent1` / `accent2`），字号遵循阶梯，避免自创对比色。

## 引用说明

引擎实现文件：`scripts/slidep/dsl/components.py`（Slide 模型与校验）、`scripts/slidep/layout/engine.py`（画布与溢出检测）、`scripts/slidep/render/master.py`（三区母版/标题/页脚）、`scripts/slidep/render/engine.py`（渲染编排与 title 去重）、`scripts/slidep/cli/loader.py`（页面加载）、`scripts/slidep/validate/rules.json`（lint 规则）。

相关方法论文档：`references/story-principle.md`（叙事结构/角色/节奏）、`references/design-principle.md`（色彩/排版/布局）。
