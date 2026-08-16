# task-07：错误信息修复指引增强

> **状态：已完成 ✅（2026-08）**
> 执行结果：lint issue **任何情况都带 hint**（规则 hint + 兜底双保险）；溢出报错带**根因分类**（text-in-row > absolute 越界 > 容器不足 > 通用）；build 模式溢出抛错同样带 hint；DSL 枚举错误已带合法值列表；`create-from-scratch.md` 新增 14 项速查表。

## 一、任务目标需求

### 背景与问题

**问题 9（溢出报错无根因指引）**：布局溢出报错只给出表面现象（`SLIDEP_2001 布局溢出：Box 底部超出画布 37.7px`），不说**根因**（如"row 容器中 Text 不换行导致单行宽度溢出"），也不说**怎么修**。

**问题 11（部分错误缺修复建议）**：`rules.json` 已为部分规则配置 `hint`，但**覆盖不全**：布局溢出（engine 抛错路径）、DSL 校验错误、部分 CLI 报错仍无 hint，排障靠人工对照文档。

### 目标

1. 所有用户可见的 error/warning **附带 1-2 条可操作的中文修复建议**；
2. 溢出报错给出**根因提示**：区分"row 内 Text 未换行"、"容器高度不足"、"负坐标/越界"等典型场景；
3. 修复建议可执行：用户按建议操作即可通过校验。

---

## 二、实现方案

### 2.1 lint hint 全覆盖 + 兜底机制（R7.1）

- **核查**：rules.json 24 条规则**已全部配置 hint**（task-01/04/06 逐步补齐），无需新增；
- **兜底**：`_attach_hints` 增强——规则无 hint 时，按 `rule_id` 前缀从 `_FALLBACK_HINTS` 生成默认建议（`typography.*` → 调字号/字体、`color.*` → 合并颜色、`layout.*` → 调整容器/flex 等 7 类前缀）；仍无则输出通用指引。**保证任何 lint issue 都自解释**（含自定义规则）。

### 2.2 溢出根因分类（R7.2）

`_overflow_hint(node, overflow)` 移入 **layout/engine.py**（单一来源，build/lint 共用），按优先级分类：

```python
if kind == "text":
    if parent is row 容器:  # 场景1：text-in-row 高频根因
        return "Text 在 row 容器内不换行导致…：①设显式 width ②移入 column/加 flexWrap ③缩小字号"
    ...
if st.position == "absolute":  # 场景2：absolute 越界
    return "absolute 定位越界…：检查 top/left/right/bottom 坐标…"
if kind == "box":             # 场景3：容器不足
    return "容器…超出…：减小 padding/margin、缩短子项、改 flex 比例"
return "通用：调整尺寸或定位…"
```

- **engine.build 抛错路径**（`_check_overflow` → `LAYOUT_OVERFLOW`）同样携带 hint；
- **lint 路径**（`validate_overflow`）复用 engine 的 `_overflow_hint`，根因口径两处一致；
- `layout/__init__.py` 导出 `_overflow_hint`。

### 2.3 DSL 校验错误（R7.3）

核查发现 `styles.py` 枚举校验**已带合法值列表**（`SLIDEP_1002` → `reason="允许值: ['center', 'flex-end', 'flex-start', 'stretch']"`），数值属性带取值范围提示（`flex 须为正整数`、`lineHeight 须 ≥ 1.0` 等），**已满足**；补充测试锁定该行为，未改动校验逻辑。

### 2.4 文档速查表（R7.4）

`references/create-from-scratch.md` 新增「常见报错与修法速查表」：14 项高频报错（字号阶梯/主题色/面积占比/留白/溢出/不换行/绝对定位/卡片填充/目录条目/视觉锚点/枚举值/flex/图片分级），每项含触发场景→根因→1-2 步修复；另附**布局溢出根因分类速查**（优先级：text-in-row > absolute > 容器不足 > 通用），与 `_overflow_hint` 口径一致。

## 三、涉及文件

| 文件 | 改动 |
|---|---|
| `scripts/slidep/layout/engine.py` | 新增 `_overflow_hint` 根因分类；`_check_overflow` build 抛错带 hint |
| `scripts/slidep/layout/__init__.py` | 导出 `_overflow_hint` |
| `scripts/slidep/validate/lint.py` | `_attach_hints` 兜底机制（`_FALLBACK_HINTS` 7 类前缀）；删除本地 `_overflow_hint`，复用 engine |
| `references/create-from-scratch.md` | 新增「常见报错与修法速查表」14 项 + 溢出根因速查 |
| `tests/test_lint.py` | 新增 TestErrorHints×5（兜底/优先级/text-in-row/absolute/全 issue 带 hint） |
| `tests/test_errors.py` | 新增 TestHintEnhancement×3（build 溢出带 hint/枚举合法值/flex 提示） |

## 四、验收测试清单（执行结果）

| # | 验收项 | 操作 | 结果 |
|---|---|---|---|
| 1 | lint hint 全覆盖 | 遍历 rules.json 全部规则 | ✅ 24 条均有 hint + 代码兜底 |
| 2 | 任何 issue 带 hint | 对样例制造各类违规 | ✅ 每条 issue 均有 hint（含自定义规则） |
| 3 | row 内 Text 溢出 | row 容器 + 无 width 长文本贴近画布右侧 | ✅ hint 含"row 容器内不换行"与 3 条修复选项 |
| 4 | absolute 越界 | top 超出画布底部 | ✅ hint 提示检查 top/left/right/bottom 坐标 |
| 5 | alignItems 非法值 | `alignItems: "middle"` | ✅ 报错列出合法值集合（center/flex-end/flex-start/stretch） |
| 6 | 速查表落地 | 打开 create-from-scratch.md | ✅ 14 个高频场景 + 溢出根因速查 |
| 7 | 单测覆盖 | `pytest tests/test_lint.py tests/test_errors.py` | ✅ 新增 8 用例全过 |
| 8 | 无回归 | `pytest tests/` | ✅ 与 task-06 基线一致（8 个既有失败，无新增） |
| — | 样例/真实项目 | validate + build | ✅ 均 0 错误 0 警告、build 一次通过 |
| — | build 溢出演示 | absolute 越界 build | ✅ `[SLIDEP_2001] 布局溢出…` + `建议: absolute 定位越界 80.0px…` |

## 五、遗留说明

- 全量回归剩 **8 个既有失败**（`test_layout.py`×6 字体测量 + `test_render.py`×2），与 task-01/04/06 基线一致，非本次引入；
- 溢出 hint 的"容器高度不足"细分（如 row 子项压垮容器）未单独展开，当前统一归入"容器不足"分支；如后续有高频场景可再细分；
- CLI 层报错（`SLIDEP_6xxx`）hint 已在 `errors.py` 结构支持（`hint` 字段 + `to_dict`），具体命令的 hint 文案留待 task-09 统一增强。
