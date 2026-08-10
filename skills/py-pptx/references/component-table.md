---
name: component-table
description: Table 表格组件规范 — 原生可编辑表格、字符串单元格约束、表头与斑马纹自动样式、行高列宽规则
---

# Table 组件规范

`Table` 是页面内容树的叶子组件，用于结构化数据的行式展示。PPTX 输出生成 python-pptx 原生表格（`render/table_render.py` `render_table`），可在 PowerPoint 中直接编辑单元格。表头与斑马纹由引擎自动生成，适用场景：指标对比、明细清单、规格参数。

## 核心属性

| 属性 | 必填 | 取值约束 | 默认 |
|---|---|---|---|
| `data` | 是 | 二维数组，所有单元格必须为字符串 | `[]` |
| `header` | 否 | 布尔，首行作为表头（深色底 + 白字加粗） | `True` |
| `zebra` | 否 | 布尔，数据行浅灰斑马纹交替 | `True` |
| `style` | 否 | 白名单：`width` / `height` / `marginTop` / `marginBottom` / `flex` | `{}` |

```python
Table(
    data=[
        ["指标", "2025", "2026", "增幅"],
        ["营收(亿)", "90", "120", "+33%"],
        ["客户数", "3200", "4100", "+28%"],
        ["毛利率", "42", "45", "+3%"],
    ],
    style={"width": "100%", "height": 240},
)
```

## 数据格式与校验

`data` 为二维数组，第一行即表头（`header=True` 时）。**单元格必须为字符串**：模型类型为 `list[list[str]]`，pydantic v2 不做 int→str 隐式转换，传数字直接抛 `ValidationError`，需自行 `str()`（如 `str(90)`）。

DSL 校验（不符合直接报错）：

| 校验项 | 规则 |
|---|---|
| 非空 | `data` 至少 1 行 × 1 列，缺失即报 `SLIDEP_1005` |
| 行列一致性 | 所有行列数必须与表头一致，不一致报 `SLIDEP_1002` |
| 未知样式键 | 白名单外的键（如 `colWidths`）报 `SLIDEP_1001`，Table 不支持自定义列宽 |

## 渲染行为

表格样式由引擎内置，无自定义入口：

| 项 | 行为 |
|---|---|
| 表头 | `header=True` 时首行深蓝灰 `#1E293B` 底 + 白色 14pt 加粗文字；`header=False` 时首行与正文同款 |
| 正文 | 14pt `#1E293B`，Calibri |
| 斑马纹 | `zebra=True` 时数据行白 / 浅灰 `#F1F5F9` 交替 |
| 对齐 | 单元格左对齐、垂直居中、自动换行 |
| 行列尺寸 | 列宽均分（总宽 / 列数），行高均分（总高 / 行数） |

行高均分意味着行数越多每行越矮（如 10 行 320px 时每行 32px）。行数较多时显式加大 `height`，或拆分多张表。表格可编辑性保留（原生 `add_table`，不经图片）。

## 布局与样式

`Table` 为叶子组件，默认尺寸 600×300（`layout/engine.py` `_LEAF_DEFAULT_SIZES`），可用 `style` 覆盖：

- `width` / `height`：数值 / `'Npx'` / `'N%'`（百分比相对父容器）
- `marginTop` / `marginBottom`：px（≥0），纵向间距
- `flex`：正整数权重，在 flex 容器中参与弹性分配

横向布局由父容器 `Box` 控制。**锚点判定**：`Table` 不构成视觉锚点（锚点判定仅认 ≥44px 文字与占 B 区 ≥40% 的 Image/Chart，见 `validate/lint.py` `validate_anchor`），表格页需另配锚点元素。

## 使用场景

**指标对比表**：指标行 + 年份列 + 增幅列，表头与斑马纹默认开启：

```python
Box(style={"gap": 24},
    children=[
        Text("年度关键指标", style={"fontSize": 56, "fontWeight": "bold", "color": "#0F172A"}),
        Table(
            data=[
                ["指标", "2025", "2026", "增幅"],
                ["营收(亿)", "90", "120", "+33%"],
                ["客户数", "3200", "4100", "+28%"],
                ["毛利率", "42", "45", "+3%"],
            ],
            style={"width": "100%", "height": 240},
        ),
    ])
```

**无表头清单**：列表式内容关掉表头，突出数据本身：

```python
Table(
    data=[
        ["AI 芯片", "昇腾 910B", "华为"],
        ["训练框架", "MindSpore", "华为"],
        ["算力调度", "Atlas 集群", "自研"],
    ],
    header=False,
    style={"width": "100%", "height": 200},
)
```

## 约束与建议

**lint 相关**（`scripts/slidep/validate/rules.json` 为单一数据源）：

| 规则 | 级别 | 与 Table 的关系 |
|---|---|---|
| `anchor.per_page_required` | error | 每页 ≥1 视觉锚点；Table 不计为锚点，表格页需 ≥44px 文字或 ≥40% B 区图表/图片 |
| `typography.min_body_chars` | error | content 页正文 ≥180 字；Table 单元格不计字数，表格页需配文字说明 |

**设计建议**（引擎不强制）：

- 单元格统一字符串，数字、百分比、单位在写入前格式化好（如 `"+33%"`、`"120 亿"`）
- 列数过多（如 >6）时列宽过窄，建议精简列或改用 `Chart` 表达趋势与占比
- 行数较多时增大 `height` 或拆表，避免每行过矮影响可读性
- 表头语义需明确（指标行 + 数值列），`header=False` 仅用于清单式内容

## 引用说明

引擎实现文件：`scripts/slidep/dsl/components.py`（Table 模型与校验）、`scripts/slidep/render/table_render.py`（原生表格渲染）、`scripts/slidep/render/engine.py`（`_render_table` 接线）、`scripts/slidep/layout/engine.py`（默认尺寸与排布）、`scripts/slidep/validate/rules.json`（lint 规则）。
