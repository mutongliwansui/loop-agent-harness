# py-pptx references/component-*.md 重写计划

> **执行状态（2026-08-10）：T1–T12 已全部完成。** `references/component-other.md` 已删除，11 个组件文档（slide/box/text/chart/table/image/faicon/svg/qrcode/codeblock/math）全部就位，`SKILL.md` 组件映射表与 `tests/test_skill.py` 已同步更新。本文件保留作为文档变更记录。

## 背景与目标

py-pptx 现有的组件规范文档（`references/component-*.md`，7 个）与 tencent-pptx 技能（`skills/tencent-pptx/references/`，12 个）相比存在差距：

1. **缺少 frontmatter**：py-pptx 文档无 YAML 元数据头（`name` / `description`），tencent 有，供 AI 检索与路由。
2. **组件拆分不完整**：py-pptx 用 1 个 `component-other.md` 汇总了 6 类富媒体（Icon/SVG/QRCode/CodeBlock/Math/Diagram），tencent 拆为独立文档。
3. **结构松散**：tencent 统一为「组件定位 → 必填属性表 → 布局与样式 → 使用场景示例 → 风格一致性/约束清单」；py-pptx 为「职责 → 语义约束 → 推荐用法」。

目标：以 tencent-pptx 对应文档为格式与内容参考，对齐 py-pptx 引擎**实际实现的 11 个组件**（`scripts/slidep/dsl/components.py` + `scripts/slidep/render/*`），重写/新建全部组件文档，一个组件一个任务。

## 参考与现状对照

| py-pptx 组件 | 引擎实现 | 现状文件 | 参考文件（tencent） | 动作 |
|---|---|---|---|---|
| Slide | `dsl/components.py` Slide + `render/master.py` | component-slide.md | component-slide.md | 重写 |
| Box | `dsl/components.py` Box + `layout/` | component-box.md | component-box.md | 重写 |
| Text | `dsl/components.py` Text | component-text.md | component-text.md | 重写 |
| Chart | `dsl/components.py` Chart + `render/chart.py` | component-chart.md | component-chart.md | 重写 |
| Table | `dsl/components.py` Table + `render/table_render.py` | component-table.md | component-table.md | 重写 |
| Image | `dsl/components.py` Image + `render/image_render.py` | component-image.md | component-image.md | 重写 |
| FAIcon | `dsl/components.py` FAIcon + `render/icon.py` | component-other.md（Icon 小节） | component-faicon.md | 拆出新建 |
| SVG | `dsl/components.py` SVG + `render/svg_render.py` | component-other.md（SVG 小节） | component-svg.md | 拆出新建 |
| QRCode | `dsl/components.py` QRCode + `render/qrcode_render.py` | component-other.md（QRCode 小节） | component-qrcode.md | 拆出新建 |
| CodeBlock | `dsl/components.py` CodeBlock + `render/codeblock.py` | component-other.md（CodeBlock 小节） | component-codeblock.md | 拆出新建 |
| Math | `dsl/components.py` Math + `render/math_render.py` | component-other.md（Math 小节） | component-math.md | 拆出新建 |

注：tencent 另有 `component-diagram.md`（关系图），py-pptx 无独立 Diagram 组件，此类图形统一通过 SVG 组件实现——相关应用场景（流程图/时间轴/架构图）并入 component-svg.md，不单建文档。

## 统一模板约定（所有文档遵循）

每份文档固定结构：

1. **YAML frontmatter**（仿 tencent）：
   ```yaml
   ---
   name: component-<xx>
   description: <组件名> 组件规范 — <一句话定位>
   ---
   ```
2. **组件定位**：一段话说明组件职责、适用场景、与其他组件的边界。
3. **核心属性 / 必填属性**：表格列出属性名、必填与否、取值约束（**以 py-pptx DSL 实际属性名为准**，如 `object_fit` 而非 `objectFit`、`chart_type` 而非 `type`）。
4. **布局与样式**：flexbox 样式支持范围、默认值、尺寸约束。
5. **使用场景**：2-3 个典型场景 + **Python DSL 代码示例**（`Slide(...)` / `Box(...)` / `Text(...)`，严禁照抄 tencent 的 JSX 语法）。
6. **约束 / 风格一致性**：强制约束（错误级别）与建议（警告级别），引用现有 lint 规则（`scripts/slidep/validate/rules.json`）。
7. **引用说明**：标注引擎实现文件路径，供维护者溯源。

## 任务清单（一个组件一个任务）

### T1 重写 component-slide.md
- 参考：`skills/tencent-pptx/references/component-slide.md`；实现：`scripts/slidep/dsl/components.py`、`render/master.py`、`render/engine.py`
- 要点：画布固定 1280×720 规格与安全区；`page_type`（cover/toc/content/section/ending）、`role`（hero/supporting/transition）、`rhythm`（peak/valley/transition）、`background` 渐变支持、`title` 语义（含「title 在 children 中不重复渲染」约束）；页脚与页码自动生成；Speaker Notes 支持（若有）。
- 输出：`references/component-slide.md`（覆盖）

### T2 重写 component-box.md
- 参考：tencent `component-box.md`；实现：`dsl/components.py` Box、`layout/` flexbox 引擎
- 要点：flexDirection/justifyContent/alignItems/gap/padding/margin/flex/width/height 等属性表；flex 权重与溢出约束（flex:1 需显式高度）；background 渐变、borderRadius、border 支持；嵌套容器最佳实践。
- 输出：`references/component-box.md`（覆盖）

### T3 重写 component-text.md
- 参考：tencent `component-text.md`；实现：`dsl/components.py` Text、`render/advanced.py`
- 要点：text 字符串语义（支持 `\n` 换行）；style 属性表（fontSize/fontWeight/color/textAlign/lineHeight/letterSpacing/marginTop 等）；标题层级（与 Slide.title 去重逻辑联动）；正文与标题字号阶梯约束。
- 输出：`references/component-text.md`（覆盖）

### T4 重写 component-chart.md
- 参考：tencent `component-chart.md`；实现：`dsl/components.py` Chart、`render/chart.py`
- 要点：`chart_type` 枚举（barChart/lineChart/pieChart/areaChart/scatterChart）与 `data` 二维数组格式（首行表头、首列分类）；`title`、色板自定义；python-pptx 原生图表（可编辑）；各类型适用场景与数据建议（如饼图≤6 类）。
- 输出：`references/component-chart.md`（覆盖）

### T5 重写 component-table.md
- 参考：tencent `component-table.md`；实现：`dsl/components.py` Table、`render/table_render.py`
- 要点：`data` 二维数组 + `header` / `zebra` 布尔属性；行列一致性校验；表头样式/斑马纹自动生成；表格高度与行数约束（防溢出）。
- 输出：`references/component-table.md`（覆盖）

### T6 重写 component-image.md
- 参考：tencent `component-image.md`；实现：`dsl/components.py` Image、`render/image_render.py`
- 要点：`src` 路径约定（resources/images/ 相对路径）；`object_fit`（cover/contain）裁剪语义；占位图/图片资源管理；尺寸与 DPI 建议。
- 输出：`references/component-image.md`（覆盖）

### T7 新建 component-faicon.md（从 other.md 拆出）
- 参考：tencent `component-faicon.md`；实现：`dsl/components.py` FAIcon、`render/icon.py`
- 要点：`name` 必填 + 内置图标清单（ICONS 字典，约 40 个）；`color` 填充色；图标尺寸与着色规范（主题色优先）；与 Emoji 的边界（优先 FAIcon）；matplotlib 可选依赖提示。
- 输出：`references/component-faicon.md`（新建）

### T8 新建 component-svg.md（从 other.md 拆出，含 Diagram 场景）
- 参考：tencent `component-svg.md`；实现：`dsl/components.py` SVG、`render/svg_render.py`
- 要点：`markup` 必填 + 合法 SVG 子集（rect/circle/ellipse/line/polyline/polygon/path/text/g）；viewBox 坐标空间；流程图/时间轴/架构图等 Diagram 应用场景示例；matplotlib 可选依赖提示。
- 输出：`references/component-svg.md`（新建）

### T9 新建 component-qrcode.md（从 other.md 拆出）
- 参考：tencent `component-qrcode.md`；实现：`dsl/components.py` QRCode、`render/qrcode_render.py`
- 要点：`value` 必填（文本/URL）；二维码尺寸与留白规范；使用场景（会议邀请/资源链接/扫码投票）；生成规则（qrcode 库，无网络依赖）。
- 输出：`references/component-qrcode.md`（新建）

### T10 新建 component-codeblock.md（从 other.md 拆出）
- 参考：tencent `component-codeblock.md`；实现：`dsl/components.py` CodeBlock、`render/codeblock.py`
- 要点：`code` 必填 + `language` 枚举（python/javascript/java/go/sql/json/yaml/bash/text）；暗色主题与语法高亮色；行号与字号自适应；使用场景（架构说明/API 示例/SQL 查询）。
- 输出：`references/component-codeblock.md`（新建）

### T11 新建 component-math.md（从 other.md 拆出）
- 参考：tencent `component-math.md`；实现：`dsl/components.py` Math、`render/math_render.py`
- 要点：`latex` 必填 + mathtext 语法子集（上下标/分数/根号/希腊字母/矩阵）；`$` 包裹规则；`color` 属性；不支持复杂 LaTeX（无外部 LaTeX 安装）的边界说明。
- 输出：`references/component-math.md`（新建）

### T12 收尾：删除 other.md + 更新引用
- 删除 `references/component-other.md`
- 更新 `SKILL.md` 组件映射表（约第 170-176 行）：`FAIcon / SVG / QRCode / CodeBlock / Math | 其他富媒体 | references/component-other.md` → 逐行拆分指向新文档
- 更新 `tests/test_skill.py`：`REQUIRED_REFS` 列表（约第 133-145 行）将 `component-other.md` 替换为 5 个新文档；同步方法论文档完整性测试（约第 172 行）
- 清理 plan.md 中本计划执行完毕的状态标记（可保留本文件作为文档变更记录）

## 验证方式

1. `python -m pytest tests/test_skill.py -v`：references 完整性、frontmatter、命名规范断言全绿
2. `python -m pytest tests/ -q`：全量回归，确认文档改动不影响引擎
3. 人工抽查 3 份（slide / text / faicon）：frontmatter 存在、属性名与 `dsl/components.py` 一致、代码示例为 Python DSL 语法
