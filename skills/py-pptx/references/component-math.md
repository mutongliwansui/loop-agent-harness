---
name: component-math
description: Math 数学公式组件规范 — latex 必填语义、mathtext 语法子集、$ 包裹规则、color 着色、复杂 LaTeX 边界
---

# Math 组件规范

`Math` 是页面内容树的叶子组件，将 LaTeX 公式经 matplotlib mathtext 渲染为透明 PNG 并嵌入。无需外部 LaTeX 安装，离线可用（`render/math_render.py` `render_math_png` + `render/engine.py` `_render_math`），预览输出同一渲染函数转 base64（`preview/svg_renderer.py` `_render_math_svg`）。适用场景：关键公式、推导结论、指标定义。

## 核心属性

| 属性 | 必填 | 取值约束 | 默认 |
|---|---|---|---|
| `latex` | 是 | 非空字符串；matplotlib mathtext 兼容的 LaTeX 公式（可带或不带 `$`） | 无 |
| `style` | 否 | 白名单：`width` / `height` / `marginTop` / `marginBottom` / `flex` / `color` | `{}` |

```python
Box(style={"alignItems": "center", "gap": 24},
    children=[
        Math(latex=r"$E=mc^2$", style={"color": "#3B82F6", "width": 320, "height": 120}),
        Box(style={"flexDirection": "column", "gap": 8},
            children=[
                Text("质能方程", style={"fontSize": 32, "fontWeight": "bold", "color": "#0F172A"}),
                Text("能量与质量本质等价，相差光速平方。",
                     style={"fontSize": 18, "color": "#475569", "lineHeight": 1.6}),
            ]),
    ])
```

`latex` 为空报 `DSL_MISSING_REQUIRED_PROP`（`SLIDEP_1005`，hint：公式内容不能为空）。`color` 是 **style 键**：公式颜色通过 `style={"color": ...}` 传入（同 `FAIcon`），写入组件属性位置会报错；白名单外键（如 `fontSize`）报 `DSL_UNKNOWN_PROPERTY`（`SLIDEP_1001`）。

## $ 包裹规则

渲染器自动处理 `$` 包裹（`render_math_png`）：

- `latex` 去除首尾空白后**不以 `$` 开头**时，自动包成 `$...$`：`E=mc^2` → `$E=mc^2$`
- 已带 `$` 的**完整包裹**（`$...$`）原样使用
- **只写单个 `$`**（如 `$E=mc^2`）不会被自动补齐：matplotlib 将其按普通文本渲染（不报错），但结果可能包含字面 `$`、排版不受控，**应避免**
- **`$$` 空 math 模式**（如 `$$E=mc^2$$`）渲染报错 `SLIDEP_3001`（"公式渲染失败: ..."）
- 公式内的字面 `$` 需转义（`\$`）；推荐统一使用 `r"..."` 原始字符串，避免反斜杠转义问题

```python
Math(latex="E=mc^2")               # 自动补 $，等价于 $E=mc^2$
Math(latex=r"$\frac{a}{b}$")       # 完整包裹，原样使用
Math(latex=r"\frac{a}{b}")         # 自动补 $，等价于 $\frac{a}{b}$
```

## 支持语法（mathtext 子集）

matplotlib mathtext 支持 LaTeX 子集，无需外部 LaTeX：

| 类别 | 语法示例 |
|---|---|
| 上下标 | `x^2`、`a_i`、`x^{2n+1}` |
| 分数 | `\frac{a}{b}` |
| 根号 | `\sqrt{x}`、`\sqrt[3]{x}` |
| 希腊字母 | `\alpha` `\beta` `\gamma` `\Delta` `\pi` 等 |
| 运算符 | `\times` `\div` `\pm` `\cdot` `\sum_{i=1}^{n}` `\int` `\lim` |
| 关系/箭头 | `\leq` `\geq` `\approx` `\rightarrow` `\Rightarrow` |
| 其他 | `\overline` `\hat` `\bar` `\infty` `\prime`、`\mathrm{}` `\mathbb{}`、`\left(` `\right)` 括号 |

> 边界：mathtext **不是**完整 LaTeX 引擎，不支持自定义宏、外部包、`\begin{matrix}` 等矩阵 / `align` 对齐环境、`\text{}` 中文、复杂嵌套等语法；不支持的语法渲染时报 `SLIDEP_3001`（"公式渲染失败: ...（mathtext 语法不支持，请检查 LaTeX 公式）"）。多行公式请拆分多个 `Math` 组件展示。
>
> 中文边界：中文（含 CJK 字符）无论是否位于 `$...$` math 模式内，渲染都不会报错；但 matplotlib 默认字体（DejaVu Sans）无 CJK 字形，中文会显示为豆腐块（占位方块），且 math 模式内混入中文会干扰排版。公式请使用 ASCII 数学符号与英文单位。

## 渲染行为

| 项 | 行为 |
|---|---|
| 输出格式 | matplotlib mathtext → 透明 PNG bytes，嵌入 PPTX 图片；预览转 base64 `<image>` |
| 渲染引擎 | matplotlib mathtext（`matplotlib.use("Agg")`），无外部 LaTeX 依赖 |
| 默认颜色 | `#1E293B`（未设置 `color` 时） |
| 画布 | dpi=150，figsize = 显示宽高 / 150；`bbox_inches="tight"` 裁切空白 |
| 对齐 | 公式在画布内水平垂直居中 |
| 依赖 | matplotlib 为可选依赖；缺失时提示 `pip install matplotlib`（报 `SLIDEP_3001`） |

## 布局与样式

`Math` 为叶子组件，默认尺寸 400×100（`layout/engine.py` `_LEAF_DEFAULT_SIZES`），可用 `style` 覆盖：

- `width` / `height`：数值 / `'Npx'` / `'N%'`（百分比相对父容器）；公式较长或含分数/矩阵时需加大高度，避免渲染过密
- `marginTop` / `marginBottom`：px（≥0），纵向间距
- `flex`：正整数权重，在 flex 容器中参与弹性分配
- `color`：`#RRGGBB` 十六进制公式颜色，优先级高于默认色；优先取主题色板（与 `Text` / `FAIcon` 同源）

布局与视觉规范：

- 公式作为**结论性表达**（关键公式、指标定义），与说明文案（`Text`）并列使用，不单独孤立出现
- 一行公式放不下时，优先拆分为多个 `Math` 组件分行展示，而非强行缩小字号
- 公式行内语义（如 `x^2`）若嵌在正文句中，使用 `Text` 富文本（span 支持 `superscript`/`subscript`）表达，`Math` 留给独立展示的公式块

## 使用场景

**关键公式**：核心指标公式 + 变量说明，公式用主题色：

```python
Box(style={"alignItems": "center", "gap": 48},
    children=[
        Box(style={"flexDirection": "column", "gap": 12},
            children=[
                Text("毛利率", style={"fontSize": 36, "fontWeight": "bold", "color": "#0F172A"}),
                Text("剔除成本后的利润占比，反映业务盈利质量。",
                     style={"fontSize": 18, "color": "#475569", "lineHeight": 1.6}),
            ]),
        Math(latex=r"$\frac{Revenue - COGS}{Revenue} \times 100\%$",
             style={"color": "#3B82F6", "width": 420, "height": 140}),
    ])
```

**推导结论**：求根公式 + 适用条件说明：

```python
Box(style={"flexDirection": "column", "gap": 12},
    children=[
        Text("一元二次方程求根", style={"fontSize": 32, "fontWeight": "bold", "color": "#0F172A"}),
        Math(latex=r"$x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$",
             style={"color": "#1E293B", "width": 480, "height": 120}),
        Text("判别式大于 0 时有两个实根。",
             style={"fontSize": 18, "color": "#475569", "lineHeight": 1.6}),
    ])
```

**指标定义**：带希腊字母与上下标的统计口径：

```python
Box(style={"flexDirection": "column", "gap": 12},
    children=[
        Text("样本标准差", style={"fontSize": 32, "fontWeight": "bold", "color": "#0F172A"}),
        Math(latex=r"$s = \sqrt{\frac{1}{n-1} \sum_{i=1}^{n} (x_i - \bar{x})^2}$",
             style={"color": "#1E293B", "width": 560, "height": 140}),
        Text("n 为样本量，\\bar{x} 为样本均值。",
             style={"fontSize": 18, "color": "#475569", "lineHeight": 1.6}),
    ])
```

## 约束（lint 门禁）

`Math` 无专属 lint 规则（`validate/rules.json` 未定义 math 类规则）：DSL 层校验 `latex` 非空与 style 白名单；渲染层校验 mathtext 解析与渲染结果。`Math` 计入内容面积统计（`validate/lint.py` `_LEAF_TYPES` / `is_media`），但不参与 `anchor.per_page_required` 锚点判定（锚点仅 ≥40% B 区的 `Image`）。

| 检查点 | 阶段 | 错误/行为 |
|---|---|---|
| `latex` 为空 | DSL | `DSL_MISSING_REQUIRED_PROP`（`SLIDEP_1005`） |
| style 白名单外键（如 `fontSize`） | DSL | `DSL_UNKNOWN_PROPERTY`（`SLIDEP_1001`） |
| mathtext 语法不支持（如 `$$` 空模式、复杂宏） | 渲染 | `RENDER_OOXML_FAILED`（`SLIDEP_3001`，提示"公式渲染失败: ...（mathtext 语法不支持）"） |
| matplotlib 未安装 | 渲染 | `RENDER_OOXML_FAILED`（`SLIDEP_3001`，提示 `pip install matplotlib`） |

## 引用说明

引擎实现文件：`scripts/slidep/dsl/components.py`（Math 模型与 `_validate_math` 非空校验）、`scripts/slidep/dsl/styles.py`（`STYLE_WHITELIST["Math"]`）、`scripts/slidep/render/math_render.py`（`render_math_png` 与 `$` 包裹、默认色）、`scripts/slidep/render/engine.py`（`_render_math` 接线）、`scripts/slidep/preview/svg_renderer.py`（`_render_math_svg` 预览接线）、`scripts/slidep/layout/engine.py`（默认尺寸 400×100）。
