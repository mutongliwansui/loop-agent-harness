# task-08：文档一致性收口

> **状态：已完成 ✅（2026-08）**
> 执行结果：设计文档/样例/lint 三侧量化参数统一以 `rules.json` 为单一数据源；样例移除半像素字号后仍 0 错误 0 警告；`component-shape.md` 新增"Shape 与 lint 面积统计"章节（含真实 78%→57% 案例）；新增 `scripts/check_docs_rules.py` 一致性检查脚本（0 差异）。
> **追加：字号单位统一为 pt（全量单测 640 用例 0 失败 ✅）**——见文末「六、字号单位统一（pt 语义收口）」。

## 一、任务目标需求

### 背景与问题

**问题 10（样例与规范文档冲突）**：设计文档字号阶梯（56-72 / 32-40 / 18-24 / 12-16 四档）与 lint 实际 7 档（rules.json）不一致；样例目录含 53.3px 半像素字号；设计文档、样例、lint 三者各自为政。

**问题 12（Shape 对 lint 的影响未文档化）**：封面主色 78% 超限的元凶是倒梯形大色块 Shape，但 `component-shape.md` 未说明 Shape 背景面积计入 `color.primary_ratio` 统计。

### 目标

1. 设计文档、样例、rules.json 对同一规则（字号阶梯、目录格式、主题色）表述一致；
2. `component-shape.md` 明确 Shape 对 lint 面积统计的影响与规避手法；
3. 文档中的数值/约束与 `rules.json` 单一数据源核对一致，杜绝硬编码漂移。

---

## 二、执行明细

### R8.1 量化参数核对（design-principle.md 为主）

| 参数 | rules.json | 修复前文档 | 修复后 |
|---|---|---|---|
| 字号阶梯 | 7 档（caption 9-14 / body 16-20 / sub_title 22-26 / title 28-36 / section_title 38-42 / hero 44-60 / display 62-96，单位 pt） | 4 档（Hero 56-72 / 标题 32-40 / 正文 18-24 / 辅助 12-16） | 统一为 rules.json 7 档表，标注"以 rules.json 为准" |
| 母版 A 区主标题 | title 28-36 | 32-40 | 28-36（title 档） |
| 母版 C 区页码 | caption 9-14 | 12-16 | 9-14（caption 档） |
| 文字锚点 | ≥33pt | ≥44px | ≥33pt（推荐 ≥44pt） |
| Hero 留白 | ≤45% | 40-50% | ≤45%（旧表述废弃） |
| flex | 正实数（task-05） | "必须为正整数" | 正实数（3:5 用 flex:3/5；1.3:2 用 flex:1.3/2） |
| 主题色 | ≤4 + 中性色豁免 | ≤4 | 一致（标注中性色豁免 task-06） |

### R8.2 样例对齐（state-grid-template）

| 项 | 修复 |
|---|---|
| 半像素字号 | `slide_02_toc.py` "目录"竖排字 `53.3` → `54`（2 处） |
| 封面标题 | 54pt（在 hero 44-60 档内，已合规，保留） |
| 目录序号 | 中文序号"一、二、三、"（已与 stategrid 文档一致，保留） |
| README | 已注明"0 错误 0 警告"（保留） |

### R8.3 component-shape.md 新增章节

「Shape 与 lint 面积统计」：面积统计口径（rect 面积计入 color.*_ratio、渐变对半计、中性色豁免、文字墨迹折算）、真实案例（国网封面主色带 1280×270 ≈ 54% + 平行四边形群 ≈ 3%，合计 ≈ 57% < 60%；初版 376px 高时 ≈ 78% 超限）、5 条规避手法、主题色计数影响。

### R8.4 单一数据源声明 + 一致性脚本

- **声明**：`design-principle.md` 顶部、`component-text.md` 阶梯表、stategrid/academic/consulting/redgold 四个风格分支均声明"量化参数以 `scripts/slidep/validate/rules.json` 为唯一数据源，出入以 rules.json 为准"；
- **脚本**：新增 `scripts/check_docs_rules.py`——扫描通用文档残留旧字号阶梯/旧 flex 约束、核对关键文档含 rules.json 声明、校验 rules.json 7 档阶梯完整性；当前运行 **0 差异**，退出码 0。

### 附带修正（扫描发现的其他文档漂移）

| 文件 | 修复 |
|---|---|
| `component-text.md` | 4 档阶梯表 → 7 档；删除"中间值（如 44、48）非法"错误描述（实际按区间判断）；锚点说明 56-72 → 44-60（≥33 即锚点） |
| `component-faicon.md` | 卡片标题"title 档（32-40px）"→"title 档（28-36pt）" |
| `designs/*.md`（academic/consulting/redgold） | 顶部加"字号硬门禁以 rules.json 7 档为准"声明（风格参考值豁免，超出 display 上界的美术巨字提示用图片/SVG 承载） |

## 三、涉及文件

| 文件 | 改动 |
|---|---|
| `references/design-principle.md` | 单一数据源声明、字号阶梯 7 档、母版表、锚点、Hero 留白 |
| `references/designs/design-principle.stategrid.md` | 顶部声明、字号档位表对齐（封面 hero 44-60、目录项 title 28-36、正文 body 16-20、页码 caption 9-14） |
| `references/designs/design-principle.{academic,consulting,redgold}.md` | 顶部字号硬门禁声明 |
| `references/component-text.md` | 7 档阶梯表、锚点 33pt/44-60 修正 |
| `references/component-faicon.md` | title 档区间修正 |
| `references/component-shape.md` | 新增「Shape 与 lint 面积统计」章节 |
| `references/create-from-scratch.md` | size_ladder 速查、锚点 ≥33pt、flex 正实数、自检第 6 条 |
| `examples/state-grid-template/pages/slide_02_toc.py` | 53.3 → 54（移除半像素字号） |
| `scripts/check_docs_rules.py` | 新增一致性检查脚本 |

## 四、验收测试清单（执行结果）

| # | 验收项 | 结果 |
|---|---|---|
| 1 | design-principle.md 顶部有"以 rules.json 为唯一数据源"声明，量化参数与 rules.json 一致 | ✅ 声明 + 7 档阶梯表 |
| 2 | 样例封面/目录与设计文档一致：封面标题在阶梯内、目录中文序号、无半像素字号 | ✅ 封面 54pt（hero 档）、目录中文序号、53.3→54 |
| 3 | component-shape.md 有"Shape 与 lint 面积统计"章节，含真实案例与规避手法 | ✅ 78%→57% 案例 + 5 条规避手法 |
| 4 | 样例 README 注明 0 错误 0 警告 | ✅（原有，保留） |
| 5 | check_docs_rules.py 运行 0 差异 | ✅ OK，退出码 0 |
| 6 | 文档修改后 validate+build 样例 | ✅ 0 错误 0 警告，构建成功 |
| 7 | 文档间链接无死链 | ✅ 20 个相对链接检查 0 缺失 |

## 五、回归与遗留

- 样例 + 真实项目（model-compute-monitor）validate/build 均 0 错误 0 警告；
- 全量单测曾剩 8 个基线失败（test_layout ×6 字体测量 + test_render ×2 字号 pt/px），**已在「六」彻底清零**；
- 三个风格分支（academic/consulting/redgold）的"风格参考字号"作为常量值层保留，但已声明"硬门禁以 rules.json 7 档为准"——若分支参考值超出 display 档且需 Text 承载，属规则层问题，应提 issue 到 task-01/05 而非本任务修改；
- 一致性脚本为独立工具，可纳入 `slidep doctor` 或 CI（当前未接线）。

---

## 六、字号单位统一（pt 语义收口，追加）

### 问题

8 个既有基线测试失败，根因是**字号单位口径冲突**：
- **引擎**：`fontSize` 以 **pt** 为单位——布局 `font_size_px = fontSize × 96/72`（1280×720 px 画布按 96dpi 换算），渲染 `run.font.size = Pt(fontSize)`（`render/engine.py` 注释"fontSize 直接以 pt 为单位"），两者在 96dpi 下自洽；
- **测试/文档**：按 **px** 口径断言/描述（如期望 `fontSize 20 → 高 20×1.3=26px`，实际 `20pt→26.67px×1.3=34.67px`；`test_render` 期望 `fontSize 28 → pt(28)=21pt`，实际 28pt）。

### 决策

统一为 **pt 语义**（保留引擎现状，修正测试与文档）：
- PPT（OOXML）字号唯一合法单位是 pt，DSL `fontSize` 与 PPT 字号一致最直观；
- rules.json 阶梯（16-20 正文 / 28-36 标题 / 44-60 hero）作为 pt 值符合 PPT 惯例；
- 样例 54pt 封面、34pt 目录项、20pt 页码均为标准 PPT 字号。

### 修复内容

**1. 测试断言（8 个，pt 口径）**

| 测试 | 修复前（px 期望） | 修复后（pt 口径） |
|---|---|---|
| `test_column_stack_texts` | 高 26、t2.y=156 | 高 `20×96/72×1.3`、t2.y=`120+…+10` |
| `test_text_wrap_in_constrained_box` | 高 52（2 行） | 高 `20×96/72×1.3×3`（26.67px/字 → 每行 3 字 → 8 字 3 行 = 104） |
| `test_container_sizes_to_content` | 宽 31、高 46 | 宽 `20×96/72×0.55+20`=34.67、高 `20×96/72×1.3+20`=54.67 |
| `test_margin_shorthand_cross_axis` | t2.y=156 | t2.y=`120+20×96/72×1.3+10`=164.67 |
| `test_row_text_children` | t1.w=36、t2.x=96 | t1.w=`2×1.0×(18×96/72)`=48、t2.x=108 |
| `test_row_stretch_text_not_stretched` | 高 23.4 | 高 `18×96/72×1.3`=31.2 |
| `test_font_size_bold_color_align` | `pt(28)`=21 | 直接 28pt |
| `test_rich_text_span_quoted_keys` | `pt(28)`/`pt(20)` | 28pt / 20pt |

**2. 文档字号单位统一（px → pt，仅字号；布局/间距/尺寸 px 保留）**

- `component-text.md`：fontSize 单位"px"→"pt"（46/54/88 行）、锚点 ≥44px→≥33pt、阶梯表头"区间（px）"→"区间（pt）"、"四档之一"→"7 档之一"；
- `component-box.md` / `component-slide.md` / `component-table.md`：锚点 ≥44px→≥33pt；母版标题字号表 56/32/44px→pt；
- `component-codeblock.md`：16px 字号→16pt（行高/内边距 px 保留）；
- `design-principle.md`：字号阶梯表头"（px/pt）"→"（pt）"、母版 A 区 28-36px→pt、C 区页码 9-14px→pt、"正文 regular 18px、数据 bold 56px"→pt；
- `designs/*.md`：字号表头/表内/结构图子版式所有字号 px→pt（stategrid 34/36px、academic 32-40/14-16px、consulting 全量字号含 ⑨ 系列、redgold 32-40px）；
- `rules.json`：`typography.size_ladder` description/hint 标注"（单位 pt）"；
- 保留 px：母版区坐标、卡片高度、间距/呼吸空间、线宽、图标尺寸、位置误差等布局属性。

### 最终状态

- **全量单测：640 用例 0 失败**（原 8 个基线失败清零）；
- `check_docs_rules.py`：0 差异；
- 样例 + 真实项目 validate：0 错误 0 警告；
- 全库扫描确认：references/ 下无"字号 px"残留（剩余 px 均为布局/间距/尺寸，正确保留）。
