---
name: component-faicon
description: FAIcon 图标组件规范 — FontAwesome 内置图标子集、name/color 必填语义、图标速查表、尺寸与着色规范、与 Emoji 的边界
---

# FAIcon 组件规范

`FAIcon` 是页面内容树的叶子组件，用于嵌入单色矢量图标（FontAwesome 5 Free solid 子集）。PPTX 输出经 matplotlib 将 SVG path 渲染为透明 PNG 再嵌入（`render/icon.py` `render_icon_png` + `render/engine.py` `_render_icon`），预览输出行为一致（`preview/svg_renderer.py` `_render_icon_svg`）。适用场景：要点卡片锚点图标、带背景容器强调图标、超大 Header 锚点。

## 核心属性

| 属性 | 必填 | 取值约束 | 默认 |
|---|---|---|---|
| `name` | 是 | 非空字符串；须为内置图标名（见下方速查表） | 无 |
| `style` | 否 | 白名单：`width` / `height` / `marginTop` / `marginBottom` / `flex` / `color` | `{}` |

```python
Box(style={"alignItems": "center", "gap": 12},
    children=[
        FAIcon(name="chart-line", style={"color": "#3B82F6", "width": 32, "height": 32}),
        Text("营收连续三年增长", style={"fontSize": 20, "color": "#0F172A"}),
    ])
```

`color` 是 **style 键而非组件属性**：填充色通过 `style={"color": ...}` 传入，写入组件属性位置会报错。`name` 为空串报 `DSL_MISSING_REQUIRED_PROP`（`SLIDEP_1005`，hint：图标名称不能为空）；`fontSize` 等白名单外的 style 键报 `DSL_UNKNOWN_PROPERTY`（`SLIDEP_1001`）。

## 内置图标清单

内置 57 个常用 solid 图标（`render/icon.py` `ICONS` 字典，path 数据来自 FontAwesome 5 Free，CC BY 4.0）。**禁止编造清单外的图标名**：未知 `name` 在渲染期报 `RENDER_OOXML_FAILED`（`SLIDEP_3001`）。

| 类别 | 图标名 |
|---|---|
| 状态反馈 | `check` `check-circle` `check-square` `times` `times-circle` `info-circle` `exclamation-circle` `exclamation-triangle` `question-circle` |
| 导航与操作 | `home` `search` `plus` `minus` `arrow-right` `arrow-left` `arrow-up` `arrow-down` `cog` `cogs` |
| 人脉与通信 | `user` `users` `heart` `bell` `envelope` `phone` `map-marker` `calendar` `clock` |
| 数据与内容 | `chart-bar` `chart-line` `chart-pie` `file` `folder` `download` `upload` `tag` `bookmark` `database` `cloud` `code` `link` `wifi` |
| 状态与安全 | `eye` `eye-slash` `lock` `unlock` `shield` |
| 激励与个性 | `star` `lightbulb` `flag` `trophy` `fire` `thumbs-up` `thumbs-down` `play` `pause` `rocket` |

## 渲染行为

| 项 | 行为 |
|---|---|
| 输出格式 | matplotlib PathPatch → 透明背景 PNG bytes，嵌入 PPTX 图片 |
| 默认颜色 | `#1E293B`（未设置 `color` 时） |
| 着色方式 | `PathPatch(facecolor=...)` 单色填充，线性风格，无描边 |
| 路径支持 | M/L/C/Q/A/S/T/Z 命令（含相对坐标），圆弧（A）简化为直线 |
| 未知 `name` | `RENDER_OOXML_FAILED`（`SLIDEP_3001`），错误信息列出前 10 个内置图标名与总数 |
| 依赖 | matplotlib 为可选依赖；缺失时提示 `pip install matplotlib`（同样报 `SLIDEP_3001`） |

## 布局与样式

`FAIcon` 为叶子组件，默认尺寸 48×48（`layout/engine.py` `_LEAF_DEFAULT_SIZES`），可用 `style` 覆盖：

- `width` / `height`：数值 / `'Npx'` / `'N%'`（百分比相对父容器），两者应成比例，避免图标变形
- `marginTop` / `marginBottom`：px（≥0），纵向间距
- `flex`：正整数权重，在 flex 容器中参与弹性分配
- `color`：`#RRGGBB` 十六进制填充色，优先级高于默认色

尺寸与着色规范：

- 图标作行内点缀 / 角标时建议 ≤64px，作超大 Header 锚点时 80-120px；**同一逻辑组的图标尺寸必须一致**
- 着色优先取主题色板（与 `Text` / `Chart` 同源色板），不用默认灰 `#1E293B` 以外的杂色；同页警示类语义（`exclamation-triangle` 等）统一用同一警示色
- 图标仅承载语义点缀，不承载文字信息；需要文字说明时用 `Text` 组件并排放置

## 使用场景

**要点卡片锚点图标**：卡片左上角图标 + 标题 + 正文，图标统一主题色，卡片标题落 title 档（32-40px）：

```python
Box(style={"justifyContent": "space-between", "gap": 24},
    children=[
        Box(style={"width": "30%", "flexDirection": "column", "gap": 12},
            children=[
                FAIcon(name="lightbulb", style={"color": "#3B82F6", "width": 40, "height": 40}),
                Text("AI 能力", style={"fontSize": 32, "fontWeight": "bold", "color": "#0F172A"}),
                Text("内置大模型推理与多模态理解，开箱即用。",
                     style={"fontSize": 18, "color": "#475569", "lineHeight": 1.6}),
            ]),
        Box(style={"width": "30%", "flexDirection": "column", "gap": 12},
            children=[
                FAIcon(name="rocket", style={"color": "#3B82F6", "width": 40, "height": 40}),
                Text("极速交付", style={"fontSize": 32, "fontWeight": "bold", "color": "#0F172A"}),
                Text("分钟级构建发布，持续集成与回滚保障。",
                     style={"fontSize": 18, "color": "#475569", "lineHeight": 1.6}),
            ]),
        Box(style={"width": "30%", "flexDirection": "column", "gap": 12},
            children=[
                FAIcon(name="shield", style={"color": "#3B82F6", "width": 40, "height": 40}),
                Text("安全合规", style={"fontSize": 32, "fontWeight": "bold", "color": "#0F172A"}),
                Text("全链路加密与审计，满足企业级合规要求。",
                     style={"fontSize": 18, "color": "#475569", "lineHeight": 1.6}),
            ]),
    ])
```

**带背景容器强调图标**：`Box` 底色 + 居中图标 + 大标题，图标颜色与背景形成对比：

```python
Box(style={"width": "100%", "flexDirection": "column", "alignItems": "center",
           "gap": 16, "background": "#F8FAFC", "borderRadius": 16, "padding": 48},
    children=[
        FAIcon(name="trophy", style={"color": "#F59E0B", "width": 64, "height": 64}),
        Text("2024 年度卓越解决方案奖", style={"fontSize": 36, "fontWeight": "bold", "color": "#0F172A"}),
        Text("权威第三方机构评选，技术实力与客户口碑双认可。",
             style={"fontSize": 18, "color": "#475569", "lineHeight": 1.6}),
    ])
```

**超大 Header 锚点**：全宽首屏以图标 + 大标题建立视觉锚点，图标尺寸明显大于正文点缀：

```python
Box(style={"flexDirection": "column", "gap": 16},
    children=[
        FAIcon(name="chart-line", style={"color": "#2563EB", "width": 96, "height": 96}),
        Text("增长,来自每一次正确的决策", style={"fontSize": 64, "fontWeight": "bold", "color": "#0F172A"}),
        Text("以数据驱动业务增长,让每一步都有据可依。",
             style={"fontSize": 24, "color": "#475569", "lineHeight": 1.6}),
    ])
```

## 与 Emoji 的边界

图标语义与 Emoji 重叠时，**优先使用 `FAIcon`**：

- 品牌/业务语义（勾选、警告、数据、文件、安全等）用 `FAIcon`，统一单色风格，可随主题着色
- Emoji 仅用于口语化、非正式的辅助表达（如口头语"✅ 已办结"之外的纯装饰场景应避免）
- 同一页内 `FAIcon` 与 Emoji 不同时混用表达同一语义层级，避免风格割裂

## 约束（lint 门禁）

`FAIcon` 无专属 lint 规则（`validate/rules.json` 未定义 icon 类规则）：DSL 层校验 `name` 非空与 style 白名单；渲染层校验 `name` 在内置清单内。图标计入内容面积统计（`validate/lint.py` `_LEAF_TYPES` / `is_media`），但不参与 `anchor.per_page_required` 锚点判定（锚点仅 ≥40% B 区的 `Image`）。

| 检查点 | 阶段 | 错误/行为 |
|---|---|---|
| `name` 为空 | DSL | `DSL_MISSING_REQUIRED_PROP`（`SLIDEP_1005`） |
| style 白名单外键（如 `fontSize`） | DSL | `DSL_UNKNOWN_PROPERTY`（`SLIDEP_1001`） |
| `name` 不在内置清单 | 渲染 | `RENDER_OOXML_FAILED`（`SLIDEP_3001`，提示内置图标清单） |
| matplotlib 未安装 | 渲染 | `RENDER_OOXML_FAILED`（`SLIDEP_3001`，提示 `pip install matplotlib`） |

## 引用说明

引擎实现文件：`scripts/slidep/dsl/components.py`（FAIcon 模型与 `_validate_icon` 非空校验）、`scripts/slidep/dsl/styles.py`（`STYLE_WHITELIST["FAIcon"]`）、`scripts/slidep/render/icon.py`（`ICONS` 字典与 `render_icon_png`）、`scripts/slidep/render/engine.py`（`_render_icon` 接线）、`scripts/slidep/preview/svg_renderer.py`（`_render_icon_svg` 预览接线）、`scripts/slidep/layout/engine.py`（默认尺寸 48×48）。
