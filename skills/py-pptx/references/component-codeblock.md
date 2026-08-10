---
name: component-codeblock
description: CodeBlock 代码块组件规范 — code 必填与 language 语义、暗色主题与语法高亮色、行号与字号自适应、与 Text 的边界
---

# CodeBlock 组件规范

`CodeBlock` 是页面内容树的叶子组件，用于展示带语法高亮的代码片段。`code` 为代码文本，PPTX 输出经 Pillow 渲染为暗色主题 PNG 再嵌入（`render/codeblock.py` `render_codeblock_png` + `render/engine.py` `_render_codeblock`），预览输出同一渲染函数转 base64（`preview/svg_renderer.py` `_render_codeblock_svg`）。适用场景：架构说明、API 示例、SQL 查询。

## 核心属性

| 属性 | 必填 | 取值约束 | 默认 |
|---|---|---|---|
| `code` | 是 | 非空字符串，代码文本（多行用 `\n` 连接） | 无 |
| `language` | 否 | 高亮语言名（内置 9 种见下表）；其他字符串合法但退化为纯文本 | `"text"` |
| `style` | 否 | 白名单：`width` / `height` / `marginTop` / `marginBottom` / `flex` | `{}` |

```python
Box(style={"flexDirection": "column", "gap": 12},
    children=[
        Text("API 示例", style={"fontSize": 32, "fontWeight": "bold", "color": "#0F172A"}),
        CodeBlock(
            code="def fib(n):\n    return n if n <= 1 else fib(n - 1) + fib(n - 2)",
            language="python",
            style={"width": 640, "height": 200},
        ),
    ])
```

`code` 为空报 `DSL_MISSING_REQUIRED_PROP`（`SLIDEP_1005`，hint：代码内容不能为空）。`color` 不在 `CodeBlock` 白名单内，报 `DSL_UNKNOWN_PROPERTY`（`SLIDEP_1001`）。`language` 无枚举校验：传入 `_KEYWORDS` 之外的值不报错，渲染为无关键字高亮、无注释识别的纯文本样式（与 `"text"` 等价）。

## 支持语言与高亮

内置 9 种语言（`render/codeblock.py` `_KEYWORDS` / `_COMMENT_PREFIX`）：

| language | 关键字集 | 注释前缀 |
|---|---|---|
| `python` | `def` `class` `if` `else` `for` `while` `return` `import` `lambda` `yield` 等 | `#` |
| `javascript` | `let` `const` `function` `class` `async` `await` `import` `export` 等 | `//` |
| `java` | `public` `private` `static` `final` `void` `String` `synchronized` 等 | `//` |
| `go` | `func` `type` `struct` `interface` `go` `defer` `select` `chan` 等 | `//` |
| `sql` | `SELECT` `FROM` `WHERE` `JOIN` `GROUP BY` `CASE` `COUNT` 等（大写） | `--` |
| `json` | `true` `false` `null` | 无 |
| `yaml` | `true` `false` `null` `yes` `no` | `#` |
| `bash` | `if` `then` `fi` `for` `do` `done` `export` `echo` 等 | `#` |
| `text` | 无（纯文本） | 无 |

## 渲染行为

| 项 | 行为 |
|---|---|
| 输出格式 | Pillow 暗色主题 PNG bytes，嵌入 PPTX 图片；预览转 base64 `<image>` |
| 背景 | `#1E1E26`（固定暗色，无 `theme` 亮/暗切换属性） |
| 高亮色 | 关键字 `#569CD6`（蓝）、字符串 `#CE9178`（橙）、注释 `#6A9955`（绿）、数字 `#B5CEA8`（浅绿）、函数调用 `#DCDCAA`（黄）、行号 `#858585`（灰）、正文 `#D5D5D5` |
| 分词规则 | 双/单引号字符串；数字；注释（仅行内 `#` / `//` / `--`，且引号内不识别）；语言关键字；标识符后跟 `(` 视为函数调用 |
| 等宽字体 | 优先 matplotlib 自带 DejaVu Sans Mono；Windows 退化 Consolas / Courier New；均缺失时 `load_default()` |
| 字号 | 按行数与高度自适应：`min(16, max(10, height / (行数 × 1.6)))`，行高 = 1.5 × 字号 |
| 行号 | 右侧对齐（`1` 起），行号区域宽度 = 位数 × 字号 + 2 × 字号 |
| 画布 | 宽度 = `max(宽度, 行号区 + 100)`（**不随行内容增长**，超长行横向溢出被裁切）；高度 = `max(高度, 行数 × 行高 + 20)`（行数多时自动增高） |

> 字体边界：等宽字体（DejaVu Sans Mono 等）不含 CJK 字形，**`code` 中的中文（含注释）会显示为豆腐块**。代码与注释建议使用英文；中文说明用旁边叠加的 `Text` 组件呈现。

## 布局与样式

`CodeBlock` 为叶子组件，默认尺寸 600×400（`layout/engine.py` `_LEAF_DEFAULT_SIZES`），可用 `style` 覆盖：

- `width` / `height`：数值 / `'Npx'` / `'N%'`（百分比相对父容器）；`height` 需容纳全部代码行（行高 = 字号 × 1.5），过小会被画布自动放大而非裁切
- `marginTop` / `marginBottom`：px（≥0），纵向间距
- `flex`：正整数权重，在 flex 容器中参与弹性分配

布局与视觉规范：

- 代码块高度按代码行数估算：约 `行数 × 24px`（16px 字号）+ 20px 内边距；行数过多（>15 行）建议拆分或精简为关键片段
- 代码块宽度至少容纳最长行（等宽字符宽 ≈ 0.6 × 字号），超长行会横向溢出画布
- `height` 超出 B 区可用高度时布局报错 `LAYOUT_OVERFLOW`（`SLIDEP_2xxx`），而非静默裁切
- 代码块固定暗色主题，放置于浅色背景页时天然形成对比，无需额外加边框

## 使用场景

**架构说明**：配置 / 伪代码 + 标题说明，突出关键配置项：

```python
Box(style={"flexDirection": "column", "gap": 12},
    children=[
        Text("部署架构", style={"fontSize": 32, "fontWeight": "bold", "color": "#0F172A"}),
        CodeBlock(
            code="services:\n  api:\n    image: app/api:v2\n    replicas: 3\n    env:\n      LOG_LEVEL: info",
            language="yaml",
            style={"width": 640, "height": 260},
        ),
        Text("核心服务三副本部署，日志级别默认 info。",
             style={"fontSize": 18, "color": "#475569", "lineHeight": 1.6}),
    ])
```

**API 示例**：接口调用代码 + 参数说明：

```python
Box(style={"flexDirection": "column", "gap": 12},
    children=[
        Text("创建订单接口", style={"fontSize": 32, "fontWeight": "bold", "color": "#0F172A"}),
        CodeBlock(
            code="const res = await fetch('/api/orders', {\n"
                 "  method: 'POST',\n"
                 "  headers: { 'Content-Type': 'application/json' },\n"
                 "  body: JSON.stringify({ sku: 'A-1001', qty: 2 }),\n"
                 "});",
            language="javascript",
            style={"width": 640, "height": 260},
        ),
    ])
```

**SQL 查询**：查询语句 + 结果说明：

```python
Box(style={"flexDirection": "column", "gap": 12},
    children=[
        Text("营收统计 SQL", style={"fontSize": 32, "fontWeight": "bold", "color": "#0F172A"}),
        CodeBlock(
            code="SELECT region, SUM(revenue) AS total\n"
                 "FROM orders\n"
                 "WHERE year = 2025\n"
                 "GROUP BY region\n"
                 "ORDER BY total DESC;",
            language="sql",
            style={"width": 640, "height": 240},
        ),
        Text("按区域汇总年度营收，降序排列。",
             style={"fontSize": 18, "color": "#475569", "lineHeight": 1.6}),
    ])
```

## 与 Text 的边界

- 代码、配置、SQL 等**机器可读内容**用 `CodeBlock`；标题、正文说明用 `Text` 组件
- 代码块内文字不参与字号阶梯与字体家族 lint（整体为一张图片）；代码块**上方的标题与说明**仍须遵守 `Text` 规范
- 短代码（≤2 行）可考虑行内 `Text` + 等宽风格，避免整块暗色图片打断版面节奏

## 约束（lint 门禁）

`CodeBlock` 无专属 lint 规则（`validate/rules.json` 未定义 codeblock 类规则）：DSL 层校验 `code` 非空与 style 白名单；渲染层固定暗色主题输出。`CodeBlock` 计入内容面积统计（`validate/lint.py` `_LEAF_TYPES` / `is_media`），但不参与 `anchor.per_page_required` 锚点判定（锚点仅 ≥40% B 区的 `Image`）。

| 检查点 | 阶段 | 错误/行为 |
|---|---|---|
| `code` 为空 | DSL | `DSL_MISSING_REQUIRED_PROP`（`SLIDEP_1005`） |
| style 白名单外键（如 `color`） | DSL | `DSL_UNKNOWN_PROPERTY`（`SLIDEP_1001`） |
| `height` 超出 B 区 | 布局 | `LAYOUT_OVERFLOW`（`SLIDEP_2xxx`） |

## 引用说明

引擎实现文件：`scripts/slidep/dsl/components.py`（CodeBlock 模型与 `_validate_codeblock` 非空校验）、`scripts/slidep/dsl/styles.py`（`STYLE_WHITELIST["CodeBlock"]`）、`scripts/slidep/render/codeblock.py`（`render_codeblock_png`、`_THEME` 暗色主题、`_KEYWORDS` / `_COMMENT_PREFIX` 语言表）、`scripts/slidep/render/engine.py`（`_render_codeblock` 接线）、`scripts/slidep/preview/svg_renderer.py`（`_render_codeblock_svg` 预览接线）、`scripts/slidep/layout/engine.py`（默认尺寸 600×400 与溢出检测）。
