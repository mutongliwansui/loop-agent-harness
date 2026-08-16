# task-01：样例模板通过自身 lint 门禁

> **状态：已完成 ✅（2026-08）**
> 执行结果：`validate` 0 错误 0 警告，`build` 一次通过，`preview` 正常生成。

## 一、任务目标需求

### 背景与问题

`examples/state-grid-template/` 是技能的**内置样例**，文档定位为"国网电力风格最佳实践示范"。但照抄其封面/目录/章节页编写页面后，执行 `validate` 报出：

- **3 个错误**：主题色 9 个超限（`color.max_theme_colors`，阈值 4）；封面主色面积 78% 超限（`color.primary_ratio`，阈值 60%）；封面辅色（浅灰）面积 52% 超限（`color.secondary_ratio`，阈值 30%）
- **14 个警告**：Hero 页配额 0%（0/3）；目录页卡片填充率 11 条（含 1px 双竖线、装饰矩阵误判）；L1 主视觉面积 8% 超限；L2 支撑图 350×40 超限

> 注：计划初稿描述"7 错误 14 警告（含字号越界）"与实际运行不符——实际无字号错误（54/53.3/42 均在 hero_title 阶梯 42-60 内），已按实际结果执行。

**核心矛盾**：样例本应是"最佳实践示范"，结果成了"错误示范"，误导性极强——新用户照抄即失败，且会误以为是自己的写法有问题。

### 目标

1. `examples/state-grid-template` 全量 `validate` 达到 **0 错误 0 警告**；
2. 在**不牺牲样例视觉风格**（倒梯形、平行四边形、对话框等国网元素）的前提下完成修复；
3. 样例作为后续所有 lint 规则变更的**回归基准**。

---

## 二、执行记录

### 2.1 lint 规则修复（前置 task-04/06 核心，样例通过的必要条件）

仅靠改样例**无法**让样例通过：白底 + 灰阶中性色会被 `_extract_colors` 全部计入（白/灰 4 个色值直接爆表），任何正常"白底+灰阶"设计都无法 ≤4 色。故前置落地两条规则修复（与 task-04/06 目标一致，task-04/06 执行时聚焦参数化与测试覆盖即可）：

| 修复 | 文件 | 说明 | 对应任务 |
|---|---|---|---|
| 中性色豁免 | `validate/lint.py` `_extract_colors` + 新增 `_is_neutral_color` | 白/黑/纯灰（R==G==B）不计入主题色计数 | task-06 R6.1 |
| 目录条目识别 | `validate/lint.py` `validate_toc` + 新增 `_toc_entries` | 只统计带目录编号的 Text（`^\s*(?:第\s*)?(?:[一二三四五六七八九十]+|\d{1,2})\s*[\.、．章]`），排除 Logo/竖线/艺术字 | task-04 R4.1 |
| CLI 项目目录切换 | `cli/main.py` 新增 `_enter_project` | build/preview 自动切换到项目根目录，页面内相对资源（`resources/xx.png`）以项目为基准解析——此前从技能根目录 build 必然报 SLIDEP_3002 图片缺失 | task-09 体验 |

### 2.2 样例修改

| 文件 | 修改 | 目的 |
|---|---|---|
| `slide_01_cover.py` | 主色带 height 376→270；浅灰梯形 height 515→290；页脚条 `#1D9BA1`→`#177A7F`；`role="hero"` | 主色 78%→57.2%、辅色 52%→29.5%；收敛主题色；hero 配额 |
| `slide_02_toc.py` | `page_type="content"`→`"toc"`；页脚条 `#1D9BA1`→`#177A7F` | 目录页不再触发 content 类密度/锚点/图片分级检查（消除 13 条警告）；收敛主题色 |
| `slide_04_ending.py` | **新增**结束页（白底 + "谢谢聆听" 60pt + 渐变条 + 页脚条） | 3 页→4 页，cover(hero) 占比 25% 落入 [20%,30%] 配额 |

### 2.3 修复后指标

| 指标 | 修复前 | 修复后 |
|---|---|---|
| validate 错误 | 3 | **0** |
| validate 警告 | 14 | **0** |
| 主题色（非中性） | 9 | **4**（`#007470` `#177A7F` `#D5ECEA` `#EBF5F4`） |
| 封面主色占比 | 78.4% | 57.2% |
| 封面辅色占比 | 52.4% | 29.5% |
| build | 因 lint 门禁中止 | **一次通过** |
| 产物 | — | `dist/state-grid-template.pptx`（4 页，倒梯形/平行四边形/对话框元素完整保留） |

---

## 三、为通过 lint 而做的视觉妥协清单（task-08 文档口径输入）

| # | 妥协 | 视觉影响 | 是否可接受 |
|---|---|---|---|
| 1 | 封面主色带高度 376→270 | 主色带变矮（底部留白增多），倒梯形斜边仍保留 | 可接受，色带仍醒目 |
| 2 | 封面浅灰梯形高度 515→290 | 右上装饰块变扁 | 可接受 |
| 3 | 页脚装饰条 `#1D9BA1`→`#177A7F` | 青绿变深绿，视觉几乎无差 | 可接受 |
| 4 | 新增 ending 页 | 样例从 3 页变 4 页（更完整的模板） | 正面增强 |
| 5 | 目录页 `content`→`toc` | 无视觉影响，语义更准确（目录页本就不适用 content 类检查） | 正面修正 |

**无不可接受的视觉牺牲**；倒梯形、平行四边形、对话框、竖排目录、双竖线等国网元素全部保留。

---

## 四、冻结基准（回归锚点）

样例页面代码已冻结，后续任务（task-04/06/08 等）只允许改 lint 代码，不允许改样例来迁就。

| 文件 | SHA-256（前 16 位） |
|---|---|
| `examples/state-grid-template/pages/slide_01_cover.py` | `961e22c546ae8cdb` |
| `examples/state-grid-template/pages/slide_02_toc.py` | `ad1ec120bae6e1ce` |
| `examples/state-grid-template/pages/slide_03_section.py` | `59b642513645cadb` |
| `examples/state-grid-template/pages/slide_04_ending.py` | `9e727696d9953545` |

## 五、验收测试清单（执行结果）

| # | 验收项 | 操作 | 结果 |
|---|---|---|---|
| 1 | 样例零告警 | `python -m slidep.cli.main validate examples/state-grid-template` | ✅ 0 错误 0 警告 |
| 2 | 构建通过 | `python -m slidep.cli.main build examples/state-grid-template` | ✅ 一次通过，无 SLIDEP_2001 |
| 3 | 产物可打开 | python-pptx 打开 `dist/state-grid-template.pptx` | ✅ 4 页，形状/图片/文本完整，视觉元素保留 |
| 4 | 主题色收敛 | validate 输出 + `_extract_colors` 验证 | ✅ 非中性色 4 个 |
| 5 | 字号合规 | validate 输出 | ✅ 无字号阶梯越界（54/53.3/42 均在 hero_title 42-60） |
| 6 | 封面主色 | validate 输出 | ✅ primary_ratio 57.2%（≤60%） |
| 7 | 冻结基准 | pages 文件 hash 记录 | ✅ 见第四节 |
| 8 | 回归安全 | `pytest tests/` | ✅ 与修改前基线一致（9 个既有失败，无新增；`test_lint.py` 全部通过） |

## 六、遗留说明

- `pytest tests/` 存在 **9 个既有失败**（与本次改动无关）：`test_layout.py`×6（字体测量）、`test_render.py`×2、`test_rules.py`×1（rules.json 顶层常量 `title_size [24,30]` 与规则数组 `size_ladder.title [28,36]` 不一致）。其中 `test_typography_consistent` 暴露的 rules.json 内部不一致，建议在 task-08（文档一致性收口）一并修正。
- `preview` 对 Shape 组件仍输出"未知组件类型: shape, 跳过"——由 task-03 修复，不影响本任务验收。
