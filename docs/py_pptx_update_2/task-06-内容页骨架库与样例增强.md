# task-06：内容页骨架库与样例增强

> **状态：已完成 ✅（2026-08）**
> 执行结果：`examples/state-grid-template/skeletons/` 新增 **5 种内容页骨架**（KPI 大数字 / 2×2 功能卡 /
> 流程时间线 / 表格图表混排 / 章节小结），全部通过 lint 门禁（0 错误 0 警告）+ build + preview；
> 新增 `tests/test_skeletons.py` 自动化检查（16 用例）；骨架可直接套用改内容（验收验证通过）；
> 两个回归基准无新错误；全量回归无新增失败。

## 一、任务目标需求

### 背景与问题

**问题 8（内置样例覆盖不足，内容页骨架缺失）**：内置样例 `state-grid-template` 仅 4 页
（cover/toc/content/ending），真实汇报的高频内容页版式——多卡片横排、表格+图表混排、
流程时间线、数据大数字页、章节过渡页——在样例中完全没有。制作本期 13 页 deck 时几乎
每一页都在踩新坑（卡片判定、字数口径、嵌套深度、填充率），因为"合法版式"只能靠试错摸索。

### 目标

1. 为风格包提供 ≥3 种内容页骨架（覆盖高频版式），全部通过 lint 门禁；
2. 骨架可直接套用改内容；
3. 骨架作为"规则可预期"的活教材：标注涉及的规则与达标要点。

---

## 二、设计和实现思路

### 2.1 骨架目录结构（R6.1）

```
examples/state-grid-template/skeletons/
├── README.md                     # 骨架索引 + 选用指南 + 规则要点
├── sk-01-kpi-cards/              # 数据大数字页（3 KPI 横排 + 展望条）
├── sk-02-feature-grid/           # 功能卡片页（2×2 卡片 + 图表对比）
├── sk-03-flow-timeline/          # 流程时间线页（非等宽三阶段 + 展望条）
├── sk-04-table-chart-mix/        # 表格 + 图表混排页（左表格右柱状图）
└── sk-05-section-summary/        # 章节小结页（大数字锚点 + 要点列表）
```

每个骨架为**单页工程**（`pages/slide_01.py`）+ 独立 README（替换指南 + 规则要点）。

### 2.2 骨架实现要点（R6.2）

单页校验（`validate_slide`）全部 **0 错误 0 警告**，覆盖 task-01/03/04/05 修复后的口径。

**开发中踩坑与规避（沉淀为骨架注释 + README 规则要点）**：

| 骨架 | 踩坑点 | 规避方式 |
|---|---|---|
| sk-01 | 卡片底浅绿 `#EBF5F4` → 3 张卡主色面积 91% 触发 `color.primary_ratio` | 卡片底用中性浅灰 `#F7F7F7`（豁免） |
| sk-01 | 大数字 96 过大、44 过小 | 62（display 档），保持视觉锚点 |
| sk-02 | 图标容器 48×48 + borderRadius → 被判真卡片，填充率 29% | 图标容器 **absolute 定位（不计层）+ 去 borderRadius（方形底）** |
| sk-02 | 卡片 padding 20 + 3 行说明 → 溢出 8-12px | padding 16 + 说明 2 行内 |
| sk-02 | 图标名 `robot` 不在 ICONS 白名单 → build 失败 | 改用白名单内 `lightbulb` |
| sk-03 | 描述 2 行 → 卡片溢出 29.9px | 描述保持 1 行 |
| sk-03 | 标签条带 border → 3 个标签条填充率 61-76% | 标签条去 border（无边框白底 + padding） |
| sk-05 | 无图表无结构卡 → 180 字口径 + 留白 37% | 要点文字写满 + 右侧要点列表包浅灰底容器 |

### 2.3 骨架覆盖版式（R6.3）

| 骨架 | 覆盖版式 | 页面语义 | 规则要点 |
|---|---|---|---|
| sk-01 | 3 KPI 横排大数字 | content / hero / peak | 锚点 62pt、中性色卡片底、数据页 120 字 |
| sk-02 | 2×2 功能卡 + 图表 | content / supporting / valley | 图标容器 absolute 方形、overflow、120 字 |
| sk-03 | 三阶段流程时间线 | content / supporting / valley | 描述 1 行、标签条无边框、120 字 |
| sk-04 | 表格 + 柱状图混排 | content / supporting / valley | 图表面积 ≥40% B 区 → 120 字、双锚点 |
| sk-05 | 章节小结 + 大数字锚点 | content / supporting / valley | 180 字口径、96pt 锚点、留白控制 |

### 2.4 验证脚本（R6.4）

新增 `tests/test_skeletons.py`（16 用例）：
- 骨架数量 ≥5 且 README + pages/slide_01.py 齐全；
- 每个骨架：`validate_slide` 0 错误 0 警告（单页校验，跳过 deck 级配额）；
- 每个骨架：`render_deck` 产出 .pptx；
- 每个骨架：`render_slide_svg` 产出非空 SVG。

**单页工程与 deck 级规则**：整目录 build 时 `layout.hero_page_ratio`（hero 占比 20%-30%）
对单页必然 warning（0% 或 100% 均越界），**不阻止非 strict 构建**。骨架是"最小页面"，
deck 级配额需完整 deck 才有意义——故验收用单页校验（与 `validate_slide` 口径一致），
骨架 README 均注明"拼入完整 deck 后自动满足配额"。

### 2.5 文档同步

- `skeletons/README.md`：骨架索引（覆盖版式/页面语义/适用场景）+ 选用指南 + 通用规则要点 + 验证方式；
- 每个骨架独立 README：替换指南（只需改顶部数据列表 + 标题 + 说明）+ 规则要点表；
- `state-grid-template/README.md`：追加骨架库入口小节；
- `create-from-scratch.md` Step4：追加"内容页骨架库"使用指引互链。

---

## 三、涉及文件

| 文件 | 改动 |
|---|---|
| `examples/state-grid-template/skeletons/README.md` | 新增：骨架索引 + 选用指南 + 规则要点 |
| `examples/state-grid-template/skeletons/sk-01-kpi-cards/` | 新增：pages/slide_01.py + README.md |
| `examples/state-grid-template/skeletons/sk-02-feature-grid/` | 新增：pages/slide_01.py + README.md |
| `examples/state-grid-template/skeletons/sk-03-flow-timeline/` | 新增：pages/slide_01.py + README.md |
| `examples/state-grid-template/skeletons/sk-04-table-chart-mix/` | 新增：pages/slide_01.py + README.md |
| `examples/state-grid-template/skeletons/sk-05-section-summary/` | 新增：pages/slide_01.py + README.md |
| `examples/state-grid-template/README.md` | 追加骨架库入口 |
| `references/create-from-scratch.md` | Step4 追加骨架库使用指引 |
| `tests/test_skeletons.py` | 新增：骨架遍历校验/build/preview |

## 四、验收测试清单（执行结果）

| # | 验收项 | 操作 | 结果 |
|---|---|---|---|
| 1 | 骨架数量 | 列出 skeletons 目录 | ✅ 5 种骨架（sk-01~sk-05） |
| 2 | 骨架全过门禁 | 每个骨架 validate | ✅ 单页校验 0 错误 0 警告（5/5） |
| 3 | 骨架可构建 | 每个骨架 build | ✅ PPTX 生成成功（5/5，hero 配额 warning 不阻止） |
| 4 | 骨架可预览 | 每个骨架 preview | ✅ SVG 生成成功（5/5） |
| 5 | 骨架可套用 | 复制 sk-01 改 3 个数字与说明文字 | ✅ 替换后仍 0 错误 0 警告（95%/71%/58% + 新标题验证） |
| 6 | 覆盖高频版式 | 核对 5 种骨架 | ✅ KPI/功能卡/流程/表格图表/小结 全覆盖 |
| 7 | 自动化检查 | `pytest tests/test_skeletons.py` | ✅ 16 用例全过 |
| 8 | 文档索引 | 打开 skeletons/README.md | ✅ 选用指南 + 规则要点完整 |
| 9 | 无回归 | `pytest tests/` | ✅ 仅 2 个既有失败（与 task-01~05 基线一致） |

## 五、遗留说明

- **单页工程的 deck 级规则**：骨架整目录 build 会提示 `layout.hero_page_ratio` warning（单页 0%/100% 均越界），
  不阻止构建；验收与 README 均采用单页校验口径。若未来希望骨架目录 build 也 0 警告，
  可将骨架工程扩展为 3-5 页 mini-deck（1 个 hero + 若干 supporting）凑配额，但会失去"最小页面"的简洁性，暂不实施；
- **风格包扩展**：骨架以 `state-grid-template` 风格起步；后续若 `designs/` 出现多风格包，
  可复制骨架后按风格着色（替换顶部 PRIMARY/TITLE_GREEN/LIGHT_GRAY 常量即可，页面结构无需改动）；
- **替换指南随规则演进**：各骨架 README 的"规则要点"与 task-01/03/04/05 规则联动，
  `tests/test_skeletons.py` 保障规则变更时骨架不脱节（任何骨架失效立即测试失败）；
- 全量回归剩 **2 个既有失败**（`test_baseline_fallback_column`、`test_row_text_children`），
  与 task-01~05 基线一致，属第一次任务期遗留，建议后续任务一并评估。
