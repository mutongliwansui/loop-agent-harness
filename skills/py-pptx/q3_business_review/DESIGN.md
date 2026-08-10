# DESIGN.md — 2026 年第三季度业务汇报

## 风格路由判断

- 主题：「2026 年第三季度业务汇报」
- 关键词命中：「季度」「汇报」命中 **business 包硬关键词（matched）** → 商务咨询规范（`design-principle.consulting.md`）
- **结构层 + 常量值层整体执行**：Action Title（结论式标题）、Navy 权威感、结构图优先（≥20% 全篇）、数据 + Source 可信、左对齐纪律、禁金/正红/彩虹

## 设计令牌（DESIGN TOKENS）

全篇**可编辑文本与背景颜色严格 ≤ 4 hex**（lint `color.max_theme_colors`；图表内置色板、表格引擎样式、SVG 内部 fill 不参与主题色统计）：

| 角色 | Hex | 用途 |
|---|---|---|
| Navy 主色 | `#061F32` | 封面/章节底、标题、结构图主色、KPI 数字 |
| Cyan 强调 | `#08A6F6` | 关键数据高亮、结构图强调节点、分割线（单页 ≤5%） |
| 背景 | `#FFFFFF` | 内页主底 |
| 中性灰 | `#44546A` | 正文次级文字、Source/Footnote、辅助信息 |

### 字号阶梯（引擎 lint ∩ 咨询规范）

| 层级 | px | 用途 |
|---|---|---|
| hero 大数字 | 64–72 | KPI 锚点（每页 ≤1 个） |
| title 标题 | 32–40 | Action Title（B 区主标题，结论句） |
| body 正文 | 22–24 | 段落（咨询规范正文硬下限 ≥22px） |
| caption 辅助 | 14–16 | Source / Footnote / 图注 |

- 字体：`Arial`（西文）+ `Microsoft YaHei`（中文黑体），全篇 ≤2 家族
- 锚点策略：每页 ≥1 视觉锚点（64–72px 大数字，或占 B 区 ≥40% 的图表 / 结构图）
- Source/Footnote：数据页、正文页、结构图页在 B 区底部左侧放 14px 灰字来源与脚注

## 页面清单（页面映射表）

| # | 文件 | 类型 | 角色 | 节奏 | 骨架 | 主视觉 | 字数 | 留白 | 色彩分配 | 关键约束 |
|---|---|---|---|---|---|---|---|---|---|---|
| 01 | slide_01_cover.py | cover | hero | peak | 满 Navy 底+左对齐大标题 | — | 30 | 30% | Navy 60%+Cyan 5% | 主标 64px Bold 左对齐；副标+公司+时间 |
| 02 | slide_02_toc.py | toc | transition | transition | 左标题+右 2×2 条目 | — | 80 | 25% | Navy 40% | 4 条目，每条含编号+章节名+摘要 |
| 03 | slide_03_exec_summary.py | content | supporting | valley | 三栏 Context/Complication/Resolution | — | 200 | 22% | Navy 30% | Action Title 结论句；每栏 ≥60 字；Source |
| 04 | slide_04_q3_results.py | content | supporting | valley | 左图右洞察（数据图表） | barChart+lineChart | 180 | 24% | Navy 30% | 主图 ≥50% B 区作锚点；洞察 80-150 字；Source |
| 05 | slide_05_highlights.py | content | hero | peak | 三 KPI 大数横排 | — | 120 | 32% | Cyan ≤5% 点缀 | KPI 数字 72px 锚点；Action Title |
| 06 | slide_06_section.py | section | transition | transition | 满 Navy+左巨字编号 | — | 20 | 40% | Navy 80% | 巨字编号 200px+章节标题 44px 白字 |
| 07 | slide_07_market_map.py | content | supporting | valley | 2×2 矩阵+右侧洞察 | SVG 结构图 | 200 | 22% | Navy 40% | 结构图 ≥50% C 区；文图分离（SVG 形状+Text 文字）；Source |
| 08 | slide_08_q4_strategy.py | content | supporting | valley | 三支柱战略结构图 | SVG 结构图 | 200 | 20% | Navy 45% | 结构图 ≥70% C 区；文图分离；Source |
| 09 | slide_09_roadmap.py | content | supporting | valley | 三阶段路线图 | SVG 结构图 | 180 | 22% | Navy 40% | 结构图 ≥70% C 区；文图分离；Source |
| 10 | slide_10_ending.py | ending | hero | peak | 居中号召+CTA | — | 60 | 35% | Navy 60% | CTA 明确「批准 Q4 增长预算」；禁「谢谢观看」 |

## 骨架与节奏检查

- 相邻页骨架不同 ✓（cover → toc → 三栏摘要 → 图表 → KPI → section → 矩阵 → 三支柱 → 路线图 → 居中号召）
- 对称骨架：P2 / P3 / P5 / P10 = 4 页 = 40%；**非对称 60% ≥ 40%** ✓
- N 卡横排（card-row）：仅 P5 KPI 三列 = 1 页 ≤ 2 ✓（P3 为三栏段落、非卡片结构）
- hero 页：P1 / P5 / P10 = 30%（20%-30%）✓
- 结构图页：P7 / P8 / P9 = 3 页 = 30% ≥ 20%（咨询风「结构图优先」）✓

## 组件覆盖

Slide / Box / Text / Chart（barChart + lineChart）/ FAIcon / SVG —— 覆盖咨询风核心组件；结构图一律「SVG 形状骨架 + 独立 Text 文字层」（文图分离，文字可编辑）。
