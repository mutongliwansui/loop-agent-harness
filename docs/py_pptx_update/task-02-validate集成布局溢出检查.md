# task-02：validate 集成布局溢出检查

> **状态：已完成 ✅（2026-08）**
> 执行结果：溢出问题在 validate 阶段前置暴露，与 build 判定口径完全一致，样例回归 0 错误 0 警告。

## 一、任务目标需求

### 背景与问题

当前流程中，布局溢出（`SLIDEP_2001`）**只在 `build` 阶段抛出**，而 `validate` 阶段完全不检查。实际踩坑表现：

```
> validate .            → 0 错误 0 警告（通过）
> build                 → SLIDEP_2001 布局溢出（4 页文字溢出画布，构建中断）
```

校验通过却编译失败，问题被推到**流水线最后一步**才暴露，排查成本高，也动摇了"validate 通过 = 可以交付"的信任。

### 目标

1. `validate` 阶段对每页执行布局计算并检查溢出，与 `build` 判定**完全一致**；
2. 溢出问题在 validate 阶段即报出，报错信息带定位（页/节点类型/方向/超限值）与修复指引（联动 task-07）；
3. 保留 `--no-overflow-check` 逃生开关，便于调试布局树。

---

## 二、实现方案

### 2.1 判定口径统一（核心）

**`engine.py` 抽出 `_overflow_direction(r) -> (direction, exceed)`** 作为唯一溢出判定源：

```python
def _overflow_direction(r: Rect) -> tuple[str, float]:
    """判定溢出方向与超限值（lint 与 build 共用同一口径）。"""
    # 遍历 bottom/right/left/top 四个方向，取超出画布最大者
```

`_check_overflow` 改为**总是记录溢出**到 `node.overflow`，仅在 build 模式（`_OVERFLOW_RAISE=True`）抛 `LAYOUT_OVERFLOW`：

```python
def _check_overflow(node: LayoutNode) -> None:
    if not _OVERFLOW_CHECK_ENABLED:
        return
    assert node.rect is not None
    r = node.rect
    if r.right > CANVAS_WIDTH + 0.01 or ...:
        direction, exceed = _overflow_direction(r)
        node.overflow = {"amount": ..., "direction": ..., "rect": ...}
        if _OVERFLOW_RAISE:
            raise layout_error(ErrorCode.LAYOUT_OVERFLOW, ...)
```

### 2.2 lint 新增 `layout.overflow` 规则

| 文件 | 改动 |
|---|---|
| `engine.py` | `LayoutNode` 增加 `overflow` 字段；新增 `_OVERFLOW_RAISE` 开关与 `set_overflow_raise()`；`layout_slide(slide, collect_overflow=False)` 参数（collect 模式不中断布局） |
| `validate/lint.py` | 新增 `validate_overflow()`（扫描 `node.overflow` → error issue，带方向/超限值/rect/hint）；`_overflow_hint()` 按节点类型给修复指引；`validate_deck`/`validate_slide` 布局计算改用 `collect_overflow=True`；溢出 issue 排在动态检查最前 |
| `validate/rules.json` | 新增规则 `layout.overflow`（level=error, applies_to=all） |
| `validate/__init__.py` | 导出 `validate_overflow` |
| `cli/main.py` | validate 命令新增 `--no-overflow-check` 逃生开关（透传 `set_overflow_check`），校验结束恢复开关 |
| `references/design-principle.md` | §1 画布章节与 §4 信息密度门禁表补充 `` `layout.overflow` `` 引用（通过文档覆盖测试） |

### 2.3 行为对比

| 场景 | 修改前 | 修改后 |
|---|---|---|
| 溢出页面 validate | 0 错误 0 警告（吞掉） | **error 级报出**，带方向/超限值/rect/hint，且**一次报全部溢出节点** |
| 溢出页面 build | SLIDEP_2001（只报第一个） | 不变（口径一致） |
| `--no-overflow-check` | validate 无此开关 | validate 支持，溢出跳过其余照常 |

---

## 三、验收测试清单（执行结果）

| # | 验收项 | 操作 | 结果 |
|---|---|---|---|
| 1 | 溢出前置暴露 | 构造溢出页面（right 溢出 320px + bottom 溢出 140px + 文本溢出 9.3px）→ validate | ✅ 直接报 3 条 `layout.overflow` error，不再等到 build |
| 2 | 与 build 一致 | 同一溢出项目分别 validate 与 build | ✅ 判定一致：validate 报 right 320.0px ↔ build 报 SLIDEP_2001 320.0px（同一 `_overflow_direction`） |
| 3 | 定位信息完整 | 触发溢出 | ✅ issue 含页码、节点类型（Box/Text）、方向（right/bottom）、超限值、rect 坐标、修复指引 hint |
| 4 | 逃生开关 | `validate --no-overflow-check` | ✅ 3 条溢出消失，其余规则（字号/字数/留白/卡片填充）照常输出 |
| 5 | 性能基准 | 50 页项目 validate | ✅ 完整校验仅 **0.041s**；collect 模式零额外布局开销（无溢出时仅多 O(n) 扫描），增量远 < 30% |
| 6 | 样例回归 | `validate examples/state-grid-template` | ✅ 0 错误 0 警告；build 一次通过 |
| 7 | 单测覆盖 | `pytest tests/test_lint.py tests/test_layout.py` | ✅ 新增 8 用例全过：TestOverflowRules×5（error 判定/无溢出/hint/开关/多节点全报）+ test_layout collect 模式×3（记录/正常不记录/布局树完整） |
| 8 | 全量回归 | `pytest tests/` | ✅ 与基线一致：仅 9 个既有失败（字体测量/渲染/rules 常量，见遗留），**无新增**；文档覆盖测试由文档补充后通过 |

## 四、性能数据

| 指标 | 数值 |
|---|---|
| 50 页静态检查（run_layout=False） | 0.006s |
| 50 页完整校验（含布局 + 溢出） | **0.041s** |
| 溢出检查引入增量 | 微乎其微（collect 模式仅改变溢出行为 + O(n) 扫描） |

## 五、遗留说明

- 全量回归仍有 **9 个既有失败**（与 task-01 基线一致，非本次引入）：
  - `test_layout.py`×6、`test_render.py`×2（字体测量/渲染差异）
  - `test_rules.py::test_typography_consistent`（rules.json 顶层 `title_size [24,30]` 与规则数组 `size_ladder.title [28,36]` 不一致）→ 建议 task-08 一并修正
- build 的 `LAYOUT_OVERFLOW` 错误消息固定用词"底部超出画布"（`layout_error` 模板），超限值准确但方向词不精确——validate 已给出精确方向，build 端消息模板优化可列入后续 task-07/09 收口。
