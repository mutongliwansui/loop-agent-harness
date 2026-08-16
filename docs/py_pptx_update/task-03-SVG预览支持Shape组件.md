# task-03：SVG/PNG 预览支持 Shape 组件

> **状态：已完成 ✅（2026-08）**
> 执行结果：SVG 预览完整渲染 Shape（倒梯形/平行四边形/对话框/旋转/渐变/边框），不支持的形状降级为占位色块并告警，PNG 一致输出。

## 一、任务目标需求

### 背景与问题

`slidep preview` 在渲染布局树时对 Shape 组件直接跳过：

```
[warning] 未知组件类型: shape, 跳过
```

梯形、平行四边形、对话框、倒梯形是国网电力风格的核心视觉元素（封面/章节页/卡片点缀大量使用）。预览中这些元素**全部消失**，导致：

- **视觉自查形同虚设**：生成者无法通过预览判断版面是否协调；
- **关键视觉回归无法发现**：Shape 位置/颜色/旋转错误只能等打开 .pptx 或用户反馈。

### 目标

1. SVG 预览完整渲染 Shape 组件（含旋转、圆角、边框、纯色/渐变背景）；
2. PNG 预览（经 `svg_to_png.py`）与 SVG 一致；
3. 渲染不支持的 Shape 类型/属性时**告警而非静默跳过**，并降级为可辨识占位色块。

---

## 二、实现方案

### 2.1 涉及文件

| 文件 | 改动 |
|---|---|
| `scripts/slidep/preview/svg_renderer.py` | 新增 Shape 渲染分支（`_render_shape_svg` + 几何/填充/旋转工具函数），注册到 `_SVG_LEAF_RENDERERS` |
| `tests/test_preview.py` | 新增 10 个 Shape 渲染测试用例 |

### 2.2 渲染能力矩阵

| 能力 | 需求 | 实现 | 验证 |
|---|---|---|---|
| 基础矩形 | R3.1 | `RECTANGLE` → `<rect>` | ✅ |
| 圆角 | R3.1 | `ROUNDED_RECTANGLE` → `<rect rx>`（borderRadius 优先，缺省 15% 高） | ✅ |
| 旋转 | R3.2 | `transform="rotate(angle cx cy)"`，中心=组件几何中心（与 OOXML `shape.rotation` 一致） | ✅ 对话框 -90° 中心 (120,100) 正确 |
| 渐变 | R3.3 | 复用 `_emit_gradient_def`（已是模块级），uuid 保证 id 唯一 | ✅ |
| 边框 | R3.4 | `border` → stroke + stroke-width | ✅ |
| 梯形/平行四边形 | — | `<polygon>`，slope/flip 语义对齐 `render/engine.py`（4 种 flip 组合） | ✅ 倒梯形 896=1280-1280×0.3 |
| 对话框 | — | 圆角矩形 + 尾巴 `<g>` 包裹，随 rotation 整体旋转 | ✅ |
| 椭圆/圆 | — | `CIRCLE`/`ELLIPSE` → `<ellipse>` | ✅ |
| 其他多边形 | — | TRIANGLE/DIAMOND/PENTAGON/HEXAGON/OCTAGON 等 → `<polygon>` | ✅ |
| 不支持的形状 | R3.5 | `STAR`/`CLOUD_CALLOUT` 等 → warning + 占位色块（`#FEF2F2`+红虚线），**不中断预览** | ✅ |

### 2.3 关键设计

- **几何口径对齐**：`_shape_points()` 的 slope/flip 四种组合与 `render/engine.py` 的 `_create_right_trapezoid` 逐点对应（默认右斜 / flip_h 左斜 / flip_v 倒梯形 / 双 flip 左下斜），确保预览与 .pptx 成品**方向一致**；
- **旋转语义统一**：SVG `rotate(angle cx cy)` 与 python-pptx `shape.rotation` 同为**顺时针角度、绕中心**，预览与成品位置不漂移；
- **渐变 id 唯一**：Shape 与 Box 共用 `uuid.uuid4().hex[:8]` 生成器，跨组件不冲突；
- **R3.6 达成**：`_SVG_LEAF_RENDERERS` 注册 `"shape"` 键，不再走"未知组件类型"分支；仅真正未知的 kind 保留告警；
- **不破坏 Box**：Shape 分支完全独立，`_render_box_svg` 未改动。

---

## 三、验收测试清单（执行结果）

| # | 验收项 | 操作 | 结果 |
|---|---|---|---|
| 1 | 基础 Shape 渲染 | preview 含矩形 Shape 页面 | ✅ `<rect x="100" y="200" width="300" height="150">` 与布局 rect 一致 |
| 2 | 圆角 | 含 `borderRadius: 20` | ✅ `rx="20.0"` |
| 3 | 旋转 | `rotation: 30` | ✅ `rotate(30.0 300.0 250.0)`（中心=几何中心） |
| 4 | 渐变背景 | Gradient Shape | ✅ `url(#grad_xxx)` + defs 唯一 |
| 5 | 边框 | `border: 2px solid` | ✅ `stroke="rgb(0,116,112)" stroke-width="2.0"` |
| 6 | 降级处理 | STAR / CLOUD_CALLOUT | ✅ warning + 2 个占位色块 + 占位文本，预览不中断 |
| 7 | 与成品一致 | 样例 preview | ✅ 封面倒梯形（0,218 → 896,488 底部倾斜）、浅灰梯形（左斜）、平行四边形群、章节对话框（-90°旋转+尾巴）全部可见且方向正确 |
| 8 | PNG 一致 | `preview --png` | ✅ 4 张 PNG 全部生成 |
| 9 | 回归 | `pytest tests/test_preview.py` | ✅ 43 个用例全过（含新增 10 个） |
| 10 | 无静默跳过 | 观察 preview 日志 | ✅ 无"未知组件类型: shape"输出 |
| — | 全量回归 | `pytest tests/` | ✅ 与基线一致（9 个既有失败，无新增） |

---

## 四、样例验证细节

| 元素 | rect | SVG 输出 | 正确性 |
|---|---|---|---|
| 封面主色带（RIGHT_TRAPEZOID, flip_v, slope=0.3） | (0,218,1280×270) | `0.0,218.0 1280.0,218.0 896.0,488.0 0.0,488.0` | ✅ 倒梯形（1280-1280×0.3=896） |
| 封面浅灰梯形（RIGHT_TRAPEZOID, flip_h, slope=0.45） | (630,130,650×290) | `922.5,130.0 1280.0,130.0 1280.0,420.0 630.0,420.0` | ✅ 左侧倾斜（630+650×0.45=922.5） |
| 平行四边形（PARALLELOGRAM） | (1,601,92×35) | `24.0,601.0 93.0,601.0 70.0,636.0 1.0,636.0` | ✅ 斜切 25%（1+92×0.25=24） |
| 章节对话框（ROUNDED_RECTANGULAR_CALLOUT, rot=-90） | (80,40,80×120) | `<g transform="rotate(-90.0 120.0 100.0)">` + 圆角矩形 + 尾巴 | ✅ 旋转中心 (120,100) 正确 |

## 五、遗留说明

- 全量回归仍为基线 **9 个既有失败**（字体测量/渲染/rules 常量，与 task-01/02 相同，非本次引入）；
- 复杂形状（STAR/ARROW/CALLOUT 变体等）当前以占位色块降级——如需精确几何，可在后续任务按 `_shape_points` 模式逐个补充 polygon 近似（MSO_SHAPE 调整值可参考 PPT 默认）；
- 对话框尾巴为简化近似（固定左下），旋转 -90° 时方向正确，其余角度为近似效果，与 .pptx 成品可能有细微差异（列入 task-08 文档口径收口候选）。
