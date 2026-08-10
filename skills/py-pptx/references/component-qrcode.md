---
name: component-qrcode
description: QRCode 二维码组件规范 — value 必填语义、尺寸与留白规范、无网络内联生成、使用场景与链接原则
---

# QRCode 组件规范

`QRCode` 是页面内容树的叶子组件，将文本 / URL 内联生成二维码 PNG 并嵌入。生成使用 `qrcode` 库（`render/qrcode_render.py` `render_qrcode_png`），不依赖网络；PPTX 与预览输出走同一渲染函数（`render/engine.py` `_render_qrcode`、`preview/svg_renderer.py` `_render_qrcode_svg`）。适用场景：会议邀请、资源链接、扫码投票。

## 核心属性

| 属性 | 必填 | 取值约束 | 默认 |
|---|---|---|---|
| `value` | 是 | 非空字符串；建议为真实可访问的文本或 URL | 无 |
| `style` | 否 | 白名单：`width` / `height` / `marginTop` / `marginBottom` / `flex` | `{}` |

```python
Box(style={"alignItems": "center", "gap": 24},
    children=[
        QRCode(value="https://example.com/signup", style={"width": 200, "height": 200}),
        Box(style={"flexDirection": "column", "gap": 8},
            children=[
                Text("扫码报名", style={"fontSize": 32, "fontWeight": "bold", "color": "#0F172A"}),
                Text("提交需求后 1 个工作日内联系。",
                     style={"fontSize": 18, "color": "#475569", "lineHeight": 1.6}),
            ]),
    ])
```

`value` 为空串报 `DSL_MISSING_REQUIRED_PROP`（`SLIDEP_1005`，hint：二维码内容不能为空）。`color` 不在 `QRCode` 白名单内，报 `DSL_UNKNOWN_PROPERTY`（`SLIDEP_1001`）。

## 生成规则

| 项 | 行为 |
|---|---|
| 生成方式 | `qrcode` 库内联生成（`version=None` + `make(fit=True)` 自适应版本），无网络依赖 |
| 纠错等级 | `ERROR_CORRECT_M`（M 级），可容忍约 15% 损毁 |
| 静区（border） | 2 个模块宽度，标准二维码须保留静区，**不得贴边裁剪或叠加背景** |
| 配色 | 默认前景 `#151515`、背景 `#FFFFFF`；`render_qrcode_png` 预留 `fg_color` / `bg_color` 参数，当前引擎接线固定使用默认黑白配色 |
| 输出尺寸 | 正方形：取显示宽高的较小者（`max(int(min(w, h)), 32)`，下限 32px），NEAREST 缩放 |
| 输出格式 | RGBA PNG bytes，嵌入 PPTX 图片 |

## 布局与样式

`QRCode` 为叶子组件，默认尺寸 200×200（`layout/engine.py` `_LEAF_DEFAULT_SIZES`），可用 `style` 覆盖：

- `width` / `height`：数值 / `'Npx'` / `'N%'`（百分比相对父容器）；建议边长 150-300px，过小（<100px）扫码困难，过大（>400px）信息密度下降
- `marginTop` / `marginBottom`：px（≥0），纵向间距
- `flex`：正整数权重，在 flex 容器中参与弹性分配

布局与视觉规范：

- 二维码保持正方形，`width` 与 `height` 应一致；不一致时按较小边缩放
- 二维码与说明文案（`Text`）并列排放，文案说明扫码后的用途与价值，不留无解释的孤码
- 如需叠加品牌元素或背景纹理，先规划视觉层级与容错策略，**确保静区不被遮挡**、前景与背景对比度足够（默认黑白已是最高对比）

## 使用场景

**会议邀请**：二维码 + 报名标题 + 截止说明，二维码作为视觉锚点置于文案一侧：

```python
Box(style={"alignItems": "center", "gap": 48},
    children=[
        QRCode(value="https://example.com/meeting/2026", style={"width": 240, "height": 240}),
        Box(style={"flexDirection": "column", "gap": 12},
            children=[
                Text("2026 生态大会 · 报名通道", style={"fontSize": 36, "fontWeight": "bold", "color": "#0F172A"}),
                Text("扫码报名，5 月 30 日截止。", style={"fontSize": 18, "color": "#475569", "lineHeight": 1.6}),
            ]),
    ])
```

**资源链接**：扫码下载报告 / 打开文档，二维码居中、文案居下：

```python
Box(style={"width": "100%", "flexDirection": "column", "alignItems": "center", "gap": 16},
    children=[
        QRCode(value="https://example.com/report/2025.pdf", style={"width": 200, "height": 200}),
        Text("扫码下载年度报告 PDF", style={"fontSize": 18, "color": "#475569", "lineHeight": 1.6}),
    ])
```

**扫码投票**：活动页二维码 + 投票说明，保证扫码路径直达投票表单：

```python
Box(style={"width": "100%", "flexDirection": "column", "alignItems": "center", "gap": 12},
    children=[
        QRCode(value="https://example.com/vote/demo-a", style={"width": 240, "height": 240}),
        Text("扫码为 Demo A 投票", style={"fontSize": 32, "fontWeight": "bold", "color": "#0F172A"}),
        Text("每人限投一次，截止 24:00。", style={"fontSize": 18, "color": "#475569", "lineHeight": 1.6}),
    ])
```

## 链接原则

- `value` 必须为**真实可访问**的链接或文本，禁止使用无效占位符（如 `https://example.com/xxxx` 以外的编造地址）
- 生成前验证链接真实有效且与当前内容主题一致；二维码旁须配套说明文案，明确扫码后的用途与价值
- 如需叠加品牌元素或背景纹理，先规划视觉层级与容错策略
- 建立二维码链接与使用场景的记录，便于追踪与复用（同一链接重复出现在多页时，位置与尺寸保持一致）

## 约束（lint 门禁）

`QRCode` 无专属 lint 规则（`validate/rules.json` 未定义 qrcode 类规则）：DSL 层校验 `value` 非空与 style 白名单；渲染层校验生成结果。`QRCode` 计入内容面积统计（`validate/lint.py` `_LEAF_TYPES` / `is_media`），但不参与 `anchor.per_page_required` 锚点判定（锚点仅 ≥40% B 区的 `Image`）。

| 检查点 | 阶段 | 错误/行为 |
|---|---|---|
| `value` 为空 | DSL | `DSL_MISSING_REQUIRED_PROP`（`SLIDEP_1005`） |
| style 白名单外键（如 `color`） | DSL | `DSL_UNKNOWN_PROPERTY`（`SLIDEP_1001`） |
| 生成异常 | 渲染 | `RENDER_OOXML_FAILED`（`SLIDEP_3001`，提示"二维码生成失败"） |

## 引用说明

引擎实现文件：`scripts/slidep/dsl/components.py`（QRCode 模型与 `_validate_qrcode` 非空校验）、`scripts/slidep/dsl/styles.py`（`STYLE_WHITELIST["QRCode"]`）、`scripts/slidep/render/qrcode_render.py`（`render_qrcode_png`）、`scripts/slidep/render/engine.py`（`_render_qrcode` 接线）、`scripts/slidep/preview/svg_renderer.py`（`_render_qrcode_svg` 预览接线）、`scripts/slidep/layout/engine.py`（默认尺寸 200×200）。
