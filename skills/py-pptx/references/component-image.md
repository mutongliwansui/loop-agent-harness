---
name: component-image
description: Image 图片组件规范 — src 路径约束与资源搜索、objectFit 裁剪语义、PNG 统一输出、L1/L2/L3 配图分级
---

# Image 组件规范

`Image` 是页面内容树的叶子组件，用于嵌入位图（照片、渲染图、截图）。PPTX 输出经 Pillow 加载并按 `object_fit` 裁剪/适配后统一输出 PNG 再嵌入（`render/image.py` `render_image_png` + `render/engine.py` `_render_image`），不保留源图格式。适用场景：主视觉大图、图文左右布局、产品/场景照片。

## 核心属性

| 属性 | 必填 | 取值约束 | 默认 |
|---|---|---|---|
| `src` | 是 | 本地路径字符串，非空；相对或绝对路径 | 无 |
| `object_fit` | 否 | `cover`（裁剪填充）/ `contain`（等比缩放留白） | `cover` |
| `style` | 否 | 白名单：`width` / `height` / `marginTop` / `marginBottom` / `flex` / `borderRadius` | `{}` |

```python
Box(style={"justifyContent": "space-between", "gap": 24},
    children=[
        Text("技术架构总览", style={"fontSize": 56, "fontWeight": "bold", "color": "#0F172A"}),
        Image(
            src="resources/images/arch.png",
            object_fit="cover",
            style={"width": 560, "height": 360, "borderRadius": 12},
        ),
    ])
```

`object_fit` 是**组件属性**而非 style 键，写入 `style` 会报未知样式键错误（`SLIDEP_1001`）。

## 路径与资源管理

`src` 支持两类路径（`render/image.py` `_resolve_image_path`）：

- **绝对路径**：直接使用
- **相对路径**：按 `resources/images` → `resources` → 当前工作目录 依次查找，命中即用

渲染期找不到文件时报 `RENDER_IMAGE_MISSING` 错误。**禁止网络 URL**（`http://` / `https://`），引擎不做网络拉取。

资源管理约定：

- 图片文件放入项目 `resources/images/`，用英文 / 数字 / 下划线命名
- 更换图片时覆盖明确文件，不用通配符批量删除资源目录
- 图片不应自带页面需要精确控制的文字 / Logo，精确文字用 `Text` 组件叠加

## 渲染行为

| 项 | 行为 |
|---|---|
| 输出格式 | 统一转 RGBA 后输出 PNG，源格式（jpg/webp/...）不保留 |
| `cover` | 等比缩放至填满目标框，居中裁剪溢出部分，不留白 |
| `contain` | 等比缩放完整显示，居中放置，四周透明留白 |
| `borderRadius` | alpha mask 圆角裁剪，半径上限为短边的一半；`0` 为直角 |
| 缩放算法 | LANCZOS 高质量重采样 |

**DPI 建议**：布局尺寸按 pt（1pt = 1/72 英寸）传给渲染器作为像素，等效 72dpi 基准。源图像素尺寸应 ≥ 目标显示尺寸，推荐 1.5-2 倍（如显示 560×360 时源图 ≥ 840×540px），避免投影时发虚。

## 布局与样式

`Image` 为叶子组件，默认尺寸 400×300（`layout/engine.py` `_LEAF_DEFAULT_SIZES`），可用 `style` 覆盖：

- `width` / `height`：数值 / `'Npx'` / `'N%'`（百分比相对父容器）
- `marginTop` / `marginBottom`：px（≥0），纵向间距
- `flex`：正整数权重，在 flex 容器中参与弹性分配
- `borderRadius`：圆角半径（px）

横向布局由父容器 `Box` 控制。**锚点判定**：`Image` 占 B 区面积 ≥ 40% 时作为视觉锚点（`validate/lint.py` `validate_anchor`），满足 `anchor.per_page_required`。

## 使用场景

**图文左右布局**：`Box` 横向排列，图片 `cover` 填充 + 圆角：

```python
Box(style={"justifyContent": "space-between", "gap": 24},
    children=[
        Box(style={"flexDirection": "column", "gap": 16, "width": "45%"},
            children=[
                Text("混合云架构", style={"fontSize": 56, "fontWeight": "bold", "color": "#0F172A"}),
                Text("本地算力与公有云弹性结合，满足峰值业务弹性扩容与数据主权合规要求。",
                     style={"fontSize": 20, "color": "#475569", "lineHeight": 1.6}),
            ]),
        Image(
            src="resources/images/hybrid_cloud.png",
            object_fit="cover",
            style={"width": "50%", "height": 360, "borderRadius": 12},
        ),
    ])
```

**全宽主视觉**：`width: "100%"` 占满内容区，`cover` 保证无留白：

```python
Image(
    src="resources/images/campus.png",
    object_fit="cover",
    style={"width": "100%", "height": 420, "borderRadius": 16},
)
```

**透明素材**：品牌图 / 抠图素材用 `contain`，透明区域显示页面背景：

```python
Image(
    src="resources/images/product_cutout.png",
    object_fit="contain",
    style={"width": 320, "height": 240},
)
```

## 约束（lint 门禁）

content 页图片按面积分级，L1/L2 规则依赖布局结果（`validate_deck` 校验时生效，`rules.json` 为单一数据源）：

| 规则 | 级别 | 要求 |
|---|---|---|
| `image.l1_area` | warning | 页内最大图片面积 ≥ 40% B 区（L1 主视觉），低于报 warning |
| `image.l2_min_size` | warning | 除最大图外的图片，凡任一边 ≥64px 且尺寸 < 280×180 时报 warning；两边均严格 <64px 的角标豁免 |
| `image.l3_max_size` | warning | L3 角标（两边均 <64px）仅为 L2 的豁免类别，规则自身不产生告警 |
| `anchor.min_image_area_ratio` | warning | 图片面积低于 40% B 区时给出提示 |
| `anchor.per_page_required` | error | 每页 ≥1 视觉锚点；仅 ≥40% B 区图片计为锚点 |

图片文件缺失、路径非法在渲染期报 `RENDER_IMAGE_MISSING` 错误（DSL 阶段不校验文件存在性）。

## 引用说明

引擎实现文件：`scripts/slidep/dsl/components.py`（Image 模型）、`scripts/slidep/render/image.py`（Pillow 处理与路径解析）、`scripts/slidep/render/engine.py`（`_render_image` 接线）、`scripts/slidep/layout/engine.py`（默认尺寸与排布）、`scripts/slidep/validate/rules.json`（lint 规则）。
