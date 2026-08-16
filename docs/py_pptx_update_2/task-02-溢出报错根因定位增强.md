# task-02：溢出报错根因定位增强（padding/border-box）

> **状态：已完成 ✅（2026-08）**
> 执行结果：`_check_overflow`/`_check_child_overflow` 附加 `overflow_cause` 根因标记（`absolute_padding_stack` / `padding_crush`）；
> `_overflow_hint` 新增 padding/border-box 叠加专属提示（含 3 条可执行修法）；validate 消息前置"根因：…"摘要行，
> build 抛错 hint 与 validate 口径一致；修法（`top=0;bottom=0` 拉伸）后溢出消除；新增 5 个单测用例全过。

## 一、任务目标需求

### 背景与问题

**问题 2（溢出报错只给现象不给根因）**：P10「看得见的改变」页中，卡片内放了一条**绝对定位的竖向装饰条**：

```python
Box(
    style={"position": "absolute", "top": 0, "left": 0, "width": 8, "height": 260},
)
```

外层卡片同时带 `padding: 16`。由于引擎按 **border-box** 语义计算（padding 占满容器高，absolute 子项的高度 260 会与 padding 叠加），实际出现 **16px 的隐性溢出**。但报错只给：

```
错误 布局溢出（layout.overflow）实测 16.0，阈值 0
Box 节点在 bottom 方向超出画布 16.0px（rect=(48,160 373x260)）
```

排障时需要**人工心算**"260 + 2×16 padding − 容器高 = 16"才能定位到是"装饰竖条 + padding 叠加"导致。同类场景还包括：row 容器内 Text 不换行、absolute 坐标越界、卡片内容超高——第一期虽已有 `_overflow_hint` 根因分类（text-in-row / absolute / 容器不足 / 通用），但 **padding/border-box 叠加**这一高频场景未被识别，且部分分支缺具体修法。

### 目标

1. 溢出报错区分并识别 **padding/border-box 叠加**导致子项越界的场景，给出专属提示与修法；
2. 所有溢出分支的修复建议**可执行**（给具体操作，如"absolute 装饰条高度应 ≤ 容器内容高 − padding"）；
3. `validate` 与 `build` 两条路径的根因提示**口径一致**（继续共用 engine 的单一来源）。

---

## 二、设计和实现思路

### 2.1 溢出根因标记 overflow_cause（R2.1 + R2.3）

`LayoutNode` 新增 `overflow_cause: Optional[str]` 字段；`_check_overflow`（画布级）与 `_check_child_overflow`（容器内容区级）记录溢出时，通过新增检测函数附加根因分类：

```python
def _detect_child_overflow_cause(node, rect, inset) -> Optional[str]:
    """容器子项溢出根因：
    - absolute_padding_stack：absolute 子项（装饰条/色块）固定高/宽与容器 padding/border 叠加；
    - padding_crush：容器 padding 使内容区过小，static 子项挤出。
    """
    st = node.style
    if st.padding <= 0 and st.border_w <= 0:
        return None
    content_bottom = rect.y + rect.height - inset
    content_right = rect.x + rect.width - inset
    for c in node.children:
        if c.rect is None:
            continue
        if c.style.position == "absolute":
            if c.rect.bottom > content_bottom + 0.01 or c.rect.right > content_right + 0.01:
                return "absolute_padding_stack"
    return "padding_crush"
```

- `overflow` dict 增加 `"cause"` 键（向前兼容：lint 读取不到时回退通用分类）；
- `_detect_canvas_overflow_cause`：画布级溢出的 absolute 子项 + 父容器 padding → 同样标记 `absolute_padding_stack`。

### 2.2 `_overflow_hint` 扩充 padding 分支（R2.1）

```python
if cause == "absolute_padding_stack":
    return (f"容器 padding {pad}px 与 absolute 子项（装饰条/色块）尺寸叠加，子项 {direction} 方向超出内容区 {amount}px："
            f"① 装饰条改用 top=0/bottom=0（或 left=0/right=0）拉伸定位，不设固定高/宽；"
            f"② 固定 height/width 应 ≤ 容器内容尺寸（容器 − 2×padding − 2×border）；"
            f"③ 减小容器 padding")
if cause == "padding_crush":
    return (f"容器 padding {pad}px 使内容区过小，子项 {direction} 方向超出 {amount}px："
            f"① 减小 padding；② 缩短子项内容；③ 把子项改 flex 比例分配")
```

- 优先级高于 text-in-row / absolute 越界 / 容器不足 / 通用（cause 命中时优先）；
- `pad` 取值：absolute 子项自身溢出时取**父容器 padding**（border-box 叠加语义），容器级溢出取自身 padding。

### 2.3 lint 消息前置根因摘要（R2.2）

`validate_overflow` 读取 `overflow["cause"]`，在 message 后追加 ` 根因：{摘要}`：

```python
_OVERFLOW_CAUSE_LABELS = {
    "absolute_padding_stack": "absolute 子项尺寸与容器 padding/border 叠加",
    "padding_crush": "容器 padding 使内容区不足",
}
```

build 路径 `_check_overflow` raise 时 `hint=_overflow_hint(node, node.overflow)` 天然一致（同源）。

### 2.4 文档速查（R2.4）

`references/create-from-scratch.md`「布局溢出根因分类」新增条目：
- **absolute 装饰条 + padding/border 叠加**（第 2 优先级）：修法 = `top=0;bottom=0` 拉伸 / 固定尺寸 ≤ 内容尺寸 / 减小 padding；
- **容器 padding 撑破**（第 3 优先级）；
- 附 **border-box 语义提醒**：装饰条优先用拉伸写法而非固定高度。

---

## 三、涉及文件

| 文件 | 改动 |
|---|---|
| `scripts/slidep/layout/engine.py` | `LayoutNode` 增加 `overflow_cause`；新增 `_detect_child_overflow_cause` / `_detect_canvas_overflow_cause`；`_check_overflow` / `_check_child_overflow` 附加 cause；`_overflow_hint` 新增 padding 分支 |
| `scripts/slidep/validate/lint.py` | `validate_overflow` message 前置根因摘要；`_OVERFLOW_CAUSE_LABELS` 映射 |
| `references/create-from-scratch.md` | 溢出根因速查新增 padding/border-box 条目 + border-box 语义提醒 |
| `tests/test_lint.py` | 新增 `TestOverflowRules`×4（padding 叠加/撑破/修法/不回归） |
| `tests/test_errors.py` | 新增 `TestHintEnhancement.test_layout_overflow_raise_padding_stack_hint` |

## 四、验收测试清单（执行结果）

| # | 验收项 | 操作 | 结果 |
|---|---|---|---|
| 1 | absolute+padding 叠加识别 | 卡片(padding 16)内 absolute 竖条(height 260 > 内容高) validate | ✅ 报错含"根因：absolute 子项尺寸与容器 padding/border 叠加" + 3 条修法 |
| 2 | 修法可执行 | 按提示①将 height 改为 top=0/bottom=0 拉伸 | ✅ 溢出消除（0 溢出） |
| 3 | 非 absolute padding 撑破 | 容器(height 100, padding 40) + 高文字 | ✅ 归因"padding_crush"，提示减小 padding |
| 4 | 既有分类不回归 | text-in-row / absolute 越界 / 容器不足 | ✅ 分类与第一期一致（新增用例锁定） |
| 5 | validate 与 build 口径一致 | 同一溢出项目分别 validate、build | ✅ 竖条超画布时 build hint 与 validate 相同（含 padding 提示） |
| 6 | 装饰条不溢出 | top=0/bottom=0 写法 | ✅ 0 溢出，无假报 |
| 7 | 单测覆盖 | `pytest tests/test_lint.py tests/test_errors.py` | ✅ 新增 5 用例全过 |
| 8 | 全量回归 | `pytest tests/` | ✅ 仅 2 个既有失败（与 task-01 基线一致，非本次引入） |
| 9 | 真实项目 | `ai-office-efficiency` validate | ✅ 0 错误（P10 竖条已用 top/bottom 写法后） |

## 五、遗留说明

- border 叠加与 padding 叠加同源，当前统一归入 `absolute_padding_stack`；border 单独占比高时提示文案仍适用（"padding/border 叠加"措辞已覆盖）；
- 容器内容区级溢出（`_check_child_overflow`）在 build 模式**不中断**（既有设计）：这类溢出只影响 lint 反馈；真正画布越界仍由 `_check_overflow` 硬性抛错；
- `overflow_cause` 为可选标记，旧版 API 调用方（读取 `node.overflow` 无 cause 键）不受影响。
