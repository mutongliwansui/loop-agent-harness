# task-05：布局 DSL 能力增强（alignItems baseline + 浮点 flex）

> **状态：已完成 ✅（2026-08）**
> 执行结果：`alignItems: baseline` 按文本基线对齐（62.8% + GPU 利用率基线重合）；`flex` 支持正实数权重（1.3:2、0.5/1/1.5 精确比例）；布局引擎/OOXML/SVG 三侧一致；向后兼容（正整数 flex、center 行为不变）。

## 一、任务目标需求

### 背景与问题

**问题 6（无 baseline 对齐）**：`alignItems` 仅支持 `flex-start | center | flex-end | stretch`，"62.8% GPU利用率"这类**数字+文字基线对齐**是数据卡片高频排版，当前只能用 `center` 近似，基线不齐。

**问题 7（flex 强制正整数）**：`flex` 校验"须为正整数"，左右分栏常见的 **3:5、1:1.3** 等浮点比例无法表达，只能折中取整。

### 目标

1. `alignItems` 支持 `baseline`，按文本基线对齐子项；
2. `flex` 支持浮点权重（>0 的实数），按比例分配剩余空间；
3. 三项能力在布局引擎、OOXML 渲染、SVG 预览三侧行为一致；
4. 向后兼容：现有写法（正整数 flex、center 对齐）行为不变。

---

## 二、实现方案

### 2.1 styles.py（R5.1：合法值 + 校验放宽）

- `_ENUMS["alignItems"]` 加入 `"baseline"`；
- `flex` 校验从 `isinstance(value, int) and value >= 1` 放宽为
  `isinstance(value, (int, float)) and not bool and value > 0`，报错文案改为 **"flex 须为正实数"**；
- 仍拒绝 `0` / 负值 / 非数值 / `True` / `None`（防滥用）。

### 2.2 engine.py（R5.2/R5.3：布局逻辑）

- `_resolve_style`：`st.flex = float(s["flex"])`（原来 `int()` 截断是浮点 flex 的关键阻塞点）；
- `_arrange_children` 提取 `_cross_size(c)` 嵌套函数（交叉轴尺寸计算，baseline 预计算与主循环共用）；
- **baseline 预计算**（仅 `row` 容器 + `alignItems: baseline`）：
  - 文本子项基线偏移 = `fontSize_px × 0.88`（CJK ascent 近似）；
  - 非文本子项回退 center（高度中点视为基线锚点）；
  - 锚定子项 = 基线偏移最大者（通常最大字号），其 top 对齐交叉轴起点；
  - `baseline_y = content.y + anchor_margin + anchor_offset`，其余子项 `top = baseline_y - 自身偏移`；
  - 保护性 clamp：极端 margin/字号差下不越容器顶部；
- 交叉轴定位新增 baseline 分支；**column 容器中 baseline 自动回退 center**（交叉轴水平，无意义，不报错）；
- flex 主轴分配 `unit = remaining / Σflex`、`size = unit × flex` 天然支持浮点（无需改动分配式，只改入口校验 + 解析）。

### 2.3 渲染/预览（R5.4：三侧一致）

确认架构：`render/engine.py` 与 `preview/svg_renderer.py` 均以 `layout_slide` 输出的 `node.rect` 为唯一坐标源——
- OOXML：`add_textbox(emu(rect.x), emu(rect.y), ...)` 直接消费 rect，baseline 对齐后的不同 top 天然透传；
- SVG：`<text y="rect.y + fontSize_px">` 消费 rect，baseline 对齐透传；
- **无需渲染端二次布局**，布局引擎是唯一计算点，三侧天然一致（已通过 render/preview 单测断言 rect 一致性验证）。

### 2.4 文档（R5.5）

| 文件 | 改动 |
|---|---|
| `references/component-box.md` | alignItems 白名单 + `baseline`；flex 类型"正整数"→"正实数"；新增 **baseline 对齐** 与 **浮点 flex** 两个完整示例小节（含 column 回退、0/负值报错说明） |
| `references/component-text.md` | 新增"row 容器中 alignItems: baseline"说明（含非文本回退、column 回退） |
| `tests/test_errors.py` | flex 错误提示断言文案"正整数"→"正实数"（与新校验一致） |

## 三、涉及文件

| 文件 | 改动 |
|---|---|
| `scripts/slidep/dsl/styles.py` | alignItems 枚举 + baseline；flex 校验放宽正实数 |
| `scripts/slidep/layout/engine.py` | flex 解析浮点化；`_cross_size` 提取；baseline 预计算 + 定位分支 |
| `references/component-box.md` / `component-text.md` | baseline 与浮点 flex 用法/边界文档 |
| `tests/test_dsl.py` | +4 用例（baseline 合法/Text 拒绝、flex 浮点合法、非法值参数化） |
| `tests/test_layout.py` | +4 用例（baseline 对齐效果、column 回退、1.3:2 比例、0.5/1/1.5 → 1:2:3） |
| `tests/test_render.py` | +2 用例（OOXML 文本框 top/width 与布局 rect 一致） |
| `tests/test_preview.py` | +1 用例（SVG text y 与布局 rect 一致） |
| `tests/test_errors.py` | flex 提示文案断言同步 |

## 四、验收测试清单（执行结果）

| # | 验收项 | 操作 | 结果 |
|---|---|---|---|
| 1 | baseline 合法 | `alignItems: "baseline"` 的 row 容器 | ✅ DSL 校验通过，不再报 SLIDEP_1002 |
| 2 | baseline 对齐效果 | row 内 fontSize 42 数字 + 16 说明文字 | ✅ 两文本 baseline_y 均为 169.3（布局树断言） |
| 3 | baseline 回退 | column 容器用 baseline | ✅ 自动回退 center，不崩溃（子项水平居中） |
| 4 | 浮点 flex | `flex: 1.3` 与 `flex: 2` 双栏 | ✅ 宽度比 0.650（布局树 + OOXML 一致） |
| 5 | 混合 flex | `flex: 0.5 / 1 / 1.5` 三栏 | ✅ 精确 1:2:3 |
| 6 | 非法 flex | `flex: 0 / -1 / "a" / True` | ✅ 均报 DSL 校验错误 |
| 7 | 渲染一致 | build 含 baseline/浮点 flex 页面 | ✅ OOXML 文本框 top/width 与布局树 rect 一致 |
| 8 | 预览一致 | preview 同页面 | ✅ SVG `<text y>` 与布局树 rect 一致 |
| 9 | 向后兼容 | 样例 + 真实项目 validate+build | ✅ 均 0 错误 0 警告，构建成功（无回归） |
| 10 | 单测覆盖 | 4 个测试文件 | ✅ 新增 11 用例全过；全量回归仅剩 8 个既有基线失败 |

## 五、遗留说明

- 全量回归剩 **8 个既有失败**（test_layout ×6 字体测量 + test_render ×2 字号 pt/px），与 task-09 基线一致，**非本次引入**；
- 基线偏移用统一系数 0.88（CJK ascent 近似），跨字体稳定；精确度量（fontTools）留作 `text_measure` 增强项（任务文档已注明）；
- baseline 在 row 容器中若存在显式 height 子项 + 极端 margin 差，会触发保护性 clamp（不越容器顶部），该场景视觉上基线略偏下属预期。
