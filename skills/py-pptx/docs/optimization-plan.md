# py-pptx 优化方案（基于 2026Q3 业务汇报真实生成复盘）

> 本文档沉淀于使用 py-pptx Skill 从零生成《2026 年第三季度业务汇报》（10 页，商务咨询风格）的完整过程，共经历 3 次校验失败、1 次渲染失败、2 次环境修复。
> 全部问题均为**真实踩坑**，优先级按"影响面 × 踩坑频率 × 修复成本"排序，供引擎侧迭代参考。

---

## 一、问题总览

| # | 问题 | 环节 | 严重度 | 优先级 |
|---|---|---|---|---|
| 1 | column 容器 `alignItems` 非 stretch 导致文本不换行溢出 | 布局引擎 | 高（构建中断） | P0 |
| 2 | 主色/辅色面积按 Text 整行 rect 统计，严重高估 | lint 校验 | 高（误报、难调平） | P0 |
| 3 | 卡片填充率 85% 下限与深色 KPI 卡天然冲突 | lint 校验 | 中（无法消除的警告） | P1 |
| 4 | matplotlib 与 numpy 版本兼容未锁定 | 环境依赖 | 高（渲染中断） | P0 |
| 5 | SLIDEP_3001 报错信息误导（"未安装"实为"版本不兼容"） | 错误处理 | 中 | P1 |
| 6 | 依赖安装网络问题（PyPI 超时 / 断点续传 501） | 环境依赖 | 中 | P1 |
| 7 | 字号阶梯对 section 页装饰性大字号一刀切 | lint 校验 | 低（视觉妥协） | P2 |
| 8 | lint 报错缺少可操作的修复建议 | lint 校验 | 中（排障耗时） | P1 |
| 9 | 布局问题调试手段缺失（需手写脚本绕过溢出检查） | CLI / DX | 中 | P1 |
| 10 | SVG `<text>` 中文豆腐块，无校验无兜底 | SVG 渲染 | 低（靠规范规避） | P2 |
| 11 | SVG `<text>` 不支持 text-anchor 居中 | SVG 渲染 | 低 | P2 |
| 12 | validate / build 参数不一致（`--project` vs 位置参数） | CLI / DX | 低 | P2 |
| 13 | 缺少页级预览能力（无 PNG 预览命令） | CLI / DX | 中 | P1 |
| 14 | Windows 控制台中文乱码（需手动 PYTHONIOENCODING） | CLI / DX | 低 | P2 |
| 15 | row 容器支持边界不明确（文档"避免 row"是玄学） | 布局引擎 | 中 | P1 |
| 16 | Text 宽度测量为启发式，与真实渲染有偏差 | 布局引擎 | 低 | P2 |

---

## 二、详细分析与优化方案

### P0-1 布局引擎：column 容器 alignItems 非 stretch 导致文本不换行溢出

**现象**

`slide_03_exec_summary.py` 三栏正文、`slide_02_toc.py` 摘要文字在 `alignItems: "flex-start"` 下渲染为**单行不换行**，宽度溢出画布，构建报 `SLIDEP_2001 布局溢出`。

**根因**

`scripts/slidep/layout/engine.py` `_arrange_children()` 的交叉轴尺寸逻辑：

```python
if st.align_items == "stretch":
    cross_size = max(cross_len - m_cross(c), 0.0)
else:
    cross_size = c.measured_h if is_row else c.measured_w  # ← 取固有宽 = 单行宽度
```

column 容器中 `alignItems != "stretch"` 时，Text 交叉轴（宽度）取 `measured_w`——而 `measured_w` 是**无宽度约束下的单行固有宽度**，长文本因此不换行、溢出。这是高频踩坑点：所有"左对齐 + column"的自然写法都会触发。

**优化方案**

1. **核心修复（建议）**：交叉轴为 Text 时，无论 `alignItems` 如何，一律以容器可用宽度为约束重测高度（换行），`alignItems` 仅影响 x 起点对齐：

   ```python
   if c.kind == "text":
       # 以容器宽度为约束强制换行（不受 alignItems 影响）
       cross_size = max(cross_len - m_cross(c), 0.0)
       _, h, _ = _text_measure(c, cross_size)
       c.rect = Rect(cross_pos, main_pos, cross_size, h)
   ```

2. **DSL 校验层兜底**：column 容器 + `alignItems: flex-start` + 子 Text 无显式 width 时，自动补 `width: 100%` 或直接 lint 警告提示。
3. **文档同步**：`component-box.md` 明确"column 容器内 Text 换行与 alignItems 的关系"，`component-text.md` 补充"文本必须可换行，宽度取容器或显式 width"。

**验收**：`slide_03` 三栏正文在 `alignItems: flex-start` 下正常换行、不溢出；新增 golden 测试覆盖此组合。

---

### P0-2 lint：颜色面积按 Text 整行 rect 统计，严重高估

**现象**

`slide_03_exec_summary.py` 仅加长 80 字正文，主色 `#061F32` 面积占比从 61% 飙到 68%（阈值 60%）；`slide_02_toc.py` 摘要文字宽度过长导致强调色 `#44546A` 占比 15%（阈值 10%）。被迫反复收缩文字、拆色块才通过。

**根因**

`scripts/slidep/validate/lint.py` `_color_area_map()`：

```python
elif isinstance(comp, Text) and "color" in style:
    area_map[c.hex6] += area   # area = rect.width × rect.height（整行矩形）
```

Text 的 `rect` 是文本占位矩形，**实际墨迹面积远小于矩形**（尤其正文是 1.7 行距 + 大量空白）。按整行矩形统计导致主色占比系统性虚高 30-50%，lint 的"≤60% 主色"规则实际上把正文文字面积等同于色块面积，缺乏区分度。

**优化方案**

1. **短期（低成本，建议先做）**：Text 面积按**文字覆盖率**折算：
   - 按 `measure_text` 的字符宽度估算墨迹面积：`Σ char_width × fontSize`（替代 `rect.w × rect.h`），行距不放大面积。
   - 或保守系数：单行文字按 `rect.width × fontSize` 计，而非 `rect.width × rect.height`。
2. **长期（准确）**：渲染管线输出后，用 Pillow 对每页位图做颜色像素统计，得到真实面积占比（消除一切估算误差）。
3. **报错增强**：主色超限时给出可操作建议（如"正文改辅色 #44546A / 缩小正文宽度 / 主色仅用于标题与锚点"），减少试错轮次。

**验收**：`slide_03` 加长正文不再触发主色超限误报；lint 报错附带 1-2 条修复建议。

---

### P0-3 环境：matplotlib 与 numpy 版本兼容未锁定

**现象**

`slide_07/08/09`（SVG 结构图）渲染时崩溃：

```
AttributeError: _ARRAY_API not found
[SLIDEP_3001] OOXML 写入失败：matplotlib 未安装，SVG 渲染不可用。请安装：pip install matplotlib
```

numpy 2.4.4 与 matplotlib 3.8 不兼容，但报错却提示"未安装"——排查近 10 轮才定位到是 numpy 版本问题。

**根因**

- `pyproject.toml` 未声明 `numpy` / `matplotlib` 的版本约束，`pip install -e .` 装入 numpy 2.x；
- 渲染端 `svg_render.py` 的异常捕获把"版本不兼容"也归类为"未安装"。

**优化方案**

1. `pyproject.toml` 锁定兼容范围：
   ```toml
   dependencies = [
       "numpy>=1.24,<2",
       "matplotlib>=3.7,<4",
       "qrcode>=7",
       "python-pptx>=0.6.21",
   ]
   ```
2. 提供 `requirements.txt` 与一键安装脚本 `install.bat`（含 `-i https://pypi.tuna.tsinghua.edu.cn/simple`）。
3. `svg_render.py` 错误分类：区分 `ModuleNotFoundError`（未安装）与 `AttributeError`（版本不兼容），后者提示"请执行 pip install 'numpy<2'"。
4. 启动时做环境自检：`slidep doctor` 检查 numpy/matplotlib/pptx/qrcode 版本并输出兼容矩阵。

**验收**：新环境 `pip install .` 后 `slidep build` 一次通过；`slidep doctor` 秒级定位版本问题。

---

### P1-1 lint：卡片填充率 85% 下限与深色 KPI 卡天然冲突

**现象**

`slide_05_highlights.py` 三张 Navy KPI 卡（大数字 + 两行说明）填充率仅 52%，`slide_03` 锚点色块 63%，均为**无法通过结构优化消除的警告**，最终以"0 错误 + 4 警告"交付。

**根因**

填充率 = 子元素面积 / 卡片面积（`_content_area_used` 对 Box 全量计面积），而：
- 卡片有 `padding`，空白区计入分母；
- 深色卡/数字卡设计上"大色块 + 少量文字"，天然低填充；
- 该规则对"带 background 的任意 Box"一刀切，未区分卡片形态。

**优化方案**

1. 填充率分母改为 **content-box**（扣除 padding 与 border），与 CSS 语义一致；
2. 按卡片内容类型豁免：仅含 Text 且无图片/图表的卡片（KPI/数字/标签卡）跳过该检查，或引入 `fill: "sparse"` 显式声明；
3. 把规则等级从 warning 调整为"可配置"：`rules.json` 中允许 `exclude_page_types: ["toc", "ending"]` 或按 `role` 豁免。

**验收**：KPI 卡不再产生不可消除的警告；填充率规则仅对"图文混排卡片"生效。

---

### P1-2 CLI/DX：布局调试手段缺失

**现象**

排查 `SLIDEP_2001` 溢出点时，需要手写 Python 脚本 `monkeypatch(eng._check_overflow = lambda n: None)` 才能绕过异常、打印全部节点 rect。对使用者极不友好。

**优化方案**

CLI 新增调试命令：

```bash
slidep layout --project q3_business_review --debug
```

输出每页布局树（缩进 + 组件名 + x/y/w/h + bottom/right + 溢出标记 `<<<<`），并支持 `--no-overflow-check` 跳过溢出异常以便完整输出。复用现有 `LayoutResult` / `flatten`，改动集中在 CLI 层。

**验收**：一条命令定位任意页面的溢出节点，不再依赖手写脚本。

---

### P1-3 DX：lint 报错缺少修复建议（规则需自解释）

**现象**

所有 lint 报错只输出"实测 X，阈值 Y"，如何修完全靠使用者对照 `rules.json` 和设计文档自行推导，每次修复平均 2-3 轮。

**优化方案**

1. `rules.json` 每条规则增加 `hint` 字段（中文化、可操作的 1-3 条建议），lint 输出时随报错附带；
2. 示例：
   - `color.primary_ratio` → "主色占比超标：正文改辅色 #44546A、缩短正文宽度、主色仅用于标题/锚点/卡片底色"
   - `layout.max_whitespace_ratio` → "留白超标：补充正文 ≥180 字、扩大图表/结构图面积、或增加说明行"
   - `anchor.per_page_required` → "页面缺少视觉锚点：添加 ≥56px 关键数字，或让图表/结构图占 B 区 ≥40%"
3. 文档侧：`references/create-from-scratch.md` 附"常见 lint 报错与修法速查表"。

**验收**：初次使用者凭报错 hint 即可独立修复，单页校验通过轮次 ≤2。

---

### P1-4 DX：缺少页级预览能力

**现象**

交付前无法快速查看 10 页效果，只能打开 .pptx 或等用户反馈。

**优化方案**

CLI 新增：

```bash
slidep preview --project q3_business_review      # 输出 dist/preview/slide_NN.png
slidep preview --project q3_business_review --pdf # 可选：集成 LibreOffice 转 PDF
```

复用渲染管线的位图输出（SVG/图表已有 matplotlib 渲染能力，普通页可走 LibreOffice 或 PIL 拼接），让生成者在交付前自查每一页。若实现成本高，至少输出 `dist/preview.png` 九宫格拼图（示例项目 `dist/preview.png` 已有先例）。

---

### P1-5 布局引擎：row 容器支持边界不明确

**现象**

示例项目注释反复写"纯 column，避免 row 容器"，但引擎实际支持 row（`flex_direction` 枚举含 row），lint 也不禁止。使用者不知 row 到底能不能用、何时会翻车——本次 P3/P5 初版均用 row，与 absolute 混排后出现不可预期的溢出。

**优化方案**

二选一，明确边界：
- **方案 A（推荐，支持并测试 row）**：补齐 row 容器 + absolute 混排的黄金测试，修复已知问题后正式支持，文档写明 row 的使用约束；
- **方案 B（禁用并提示）**：DSL 校验层对 row 容器直接报错（或强警告），文档与 lint 一致，杜绝"看似能用"的灰色地带。

---

### P1-6 环境：依赖安装网络问题

**现象**

- `pip install numpy` 直连 PyPI 超时（多次 30s 超时）；
- 自研 `download_wheel.py` 用 Range 续传被 PyPI CDN 拒绝（HTTP 501 Unsupported client range）；
- 最终用清华镜像 `pip install numpy==1.26.4 -i https://pypi.tuna.tsinghua.edu.cn/simple` 才成功。

**优化方案**

1. 技能包内置 `scripts/install.bat` / `install.sh`，默认走清华镜像并允许覆盖：
   ```bash
   python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
   ```
2. 文档（SKILL.md 或 README）新增"安装与网络"小节：国内环境一律用镜像；标注 PyPI CDN 不支持 Range 续传。
3. 首次运行自动探测依赖缺失并给出安装命令，而不是渲染时才报错。

---

### P2-1 lint：字号阶梯对 section 页装饰性大字号一刀切

**现象**

`slide_06_section.py` 章节过渡页"02"巨字编号初版用 240px，被阶梯校验拒绝（上限 72px），被迫缩至 72px，视觉冲击明显减弱。

**优化方案**

- `typography.size_ladder` 增加装饰性级别 `decorative`（如 120-300px），仅对 `page_type=section` / `role=transition` 页的**纯数字/短文本**放行（防滥用）；
- 或 section 页整体豁免阶梯校验，但 lint 单独检查"装饰字号仅允许 1-2 个且为纯短文本"。

---

### P2-2 SVG：`<text>` 中文豆腐块无校验、不支持 text-anchor

**现象**

- matplotlib 默认字体不含 CJK，SVG 内中文渲染为豆腐块（仅 UserWarning）；本次靠"SVG 骨架 + Text 叠层"的文图分离规避，但无强制校验；
- `<text>` 仅支持左对齐基线，居中需手工计算 x 坐标。

**优化方案**

1. lint 新增规则：扫描 SVG `markup` 中的 CJK 字符，命中即 warning"SVG 内中文会渲染为豆腐块，请用 Text 组件叠层或为 matplotlib 配置 CJK 字体（Noto Sans CJK SC）"；
2. 渲染端：若系统存在 `Noto Sans CJK SC` / `Microsoft YaHei` 等字体，自动注册到 matplotlib，支持 SVG 内中文；
3. `<text>` 增加 `text-anchor`（middle/end）支持，与标准 SVG 对齐。

---

### P2-3 CLI：validate/build 参数不一致

**现象**

`slidep validate --project X`（选项）vs `slidep build X`（位置参数），同义参数两种写法。

**优化方案**

统一为位置参数 `slidep validate X` / `slidep build X`，保留 `--project` 为兼容别名（deprecated）；或统一 `--project`。改动小、收益明确。

---

### P2-4 DX：Windows 控制台中文乱码

**现象**

Windows 默认 GBK 控制台，`slidep` 输出中文日志乱码，需手动 `set PYTHONIOENCODING=utf-8`。

**优化方案**

CLI 入口（`main.py` 的 `entry()`）统一：

```python
if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
```

或日志层统一用英文输出（保持 ASCII 兼容）。

---

### P2-5 布局引擎：Text 宽度测量为启发式

**现象**

`text_measure.py` 用 CJK=1.0×fontSize、ASCII=0.55×fontSize 估算字符宽，与真实渲染存在偏差（长正文可能出现"测得过窄 → 布局紧凑但渲染溢出"的边界情况）。

**优化方案**

- 接口已预留（`measure_text` 可替换），可选接入 `fontTools` / 系统字体真实度量；
- 默认保留启发式（零依赖、可 golden 测试），但提供 `SLIDEP_TEXT_MEASURE=exact` 环境变量切换精确模式。

---

## 三、优先级路线图

### P0（下个迭代必做，阻断新用户）
| 项 | 说明 | 工作量 |
|---|---|---|
| 布局引擎 alignItems 文本换行修复 | 消除最大高频踩坑 | 0.5d |
| 颜色面积统计修正 + lint hint | 消除误报与试错轮次 | 1d |
| 依赖版本锁定 + `slidep doctor` | 环境一次装对 | 0.5d |

### P1（快速跟进）
| 项 | 说明 | 工作量 |
|---|---|---|
| 卡片填充率规则重构 | 消除不可消除警告 | 0.5d |
| `slidep layout --debug` | 一行定位溢出 | 0.5d |
| lint hint 全量补全 | 报错自解释 | 0.5d |
| `slidep preview` | 交付前自查 | 1d |
| row 容器边界明确（A 支持/B 禁用） | 消除灰色地带 | 0.5-1d |
| 安装脚本 + 镜像指引 | 网络一次通过 | 0.25d |

### P2（backlog）
| 项 | 说明 |
|---|---|
| section 装饰字号豁免 | 恢复章节页视觉冲击 |
| SVG CJK 校验 + text-anchor | 豆腐块提前预警、排版对齐 |
| CLI 参数统一 | 低风险 DX 改进 |
| UTF-8 控制台 | Windows 体验 |
| 精确文本测量 | 可开关 |

---

## 四、验收标准（整体）

1. 新环境 `pip install -e .` 后 `slidep doctor` 全绿，`slidep build` 一次通过；
2. 用本次《2026Q3 业务汇报》10 页重跑：**0 错误、0 警告**；
3. 初次使用者按 lint hint 独立修复，单页校验轮次 ≤2；
4. `slidep layout --debug` 与 `slidep preview` 开箱可用；
5. 文档（component-box/text、create-from-scratch）与引擎行为完全一致，无"避免 row"类玄学表述。

---

*附：本优化方案对应的真实产物路径 `skills/py-pptx/q3_business_review/`，校验/构建日志可追溯。*
