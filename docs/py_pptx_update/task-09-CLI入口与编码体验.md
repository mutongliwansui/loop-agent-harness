# task-09：CLI 入口与编码体验

> **状态：已完成 ✅（2026-08）**
> 执行结果：`python -m slidep.cli.main` **RuntimeWarning 已消除**；`validate`/`build` **三种输入自动识别一致**（单页/pages 目录/项目根目录）；CLI 输出**全平台统一 UTF-8**（Windows 乱码根治）；文档同步。

## 一、任务目标需求

### 背景与问题

**问题 13（CLI 入口与文档对齐）**：
- 文档写 `slidep validate`，但 `slidep` 命令**未安装到 PATH**（`where slidep` 找不到），只能 `python -m slidep.cli.main ...`，且带 RuntimeWarning；
- `validate pages`（传 pages 目录）报错"未找到 pages/"，与文档"自动识别单页/项目目录"的描述不符。

**问题 14（Windows 中文乱码）**：Windows 默认 GBK 控制台，`slidep` 输出中文日志乱码，需手动 `set PYTHONIOENCODING=utf-8`。

### 目标

1. 文档描述的 CLI 用法与真实命令**完全一致**，`slidep` 命令开箱可用；
2. `validate` 对 pages 目录/单页/项目目录三种输入自动识别，与文档一致；
3. Windows 控制台中文输出正常，无需手动设置环境变量。

---

## 二、实现方案

### 2.1 CLI 入口可用 + RuntimeWarning 消除（R9.1）

**根因定位**：`slidep/cli/__init__.py` 顶层 `from .main import app, entry` 导致 `python -m slidep.cli.main` 时，`slidep.cli` 包在 runpy 执行前已把 main 放入 `sys.modules`，触发：

```
<frozen runpy>:128: RuntimeWarning: 'slidep.cli.main' found in sys.modules after import of package 'slidep.cli' ...
```

**修复**：改为 **PEP 562 惰性导出**（`__getattr__` 首次访问才导入 main）：

```python
def __getattr__(name: str):
    if name in ("app", "entry"):
        from .main import app, entry
        return app if name == "app" else entry
    raise AttributeError(...)
```

- `from slidep.cli import app` 仍然可用（向后兼容）；
- `pyproject.toml` 的 `[project.scripts] slidep = "slidep.cli.main:app"` 已声明，`pip install .` 后 `slidep` 进 PATH（文档注明：未安装时用 `python -m slidep.cli.main` 等价入口）。

### 2.2 三种输入自动识别（R9.2）

`loader.py` 统一识别逻辑，validate/build **共用**：

- `load_pages()` 增强：传**项目根目录**（定位 `pages/`）或 **pages 目录本身**均可用；
- 新增 `load_input()`：单页 `.py` → `load_single_page`；目录 → `load_pages`；无法识别 → 友好报错（列出合法输入）；
- `validate` 目录分支改用 `load_input`；`build._enter_project` 同样识别 pages 目录（行为与 validate 一致）；
- 报错信息增强："…未找到 pages/ 目录或无 .py 页面文件" + 提示（创建 pages/ 或直接传 pages 目录/项目根）。

### 2.3 UTF-8 编码统一（R9.3）

- `_force_utf8_stdio()`：**无条件** reconfigure stdout/stderr 为 UTF-8（原来仅 win32）；`entry()` 顶部兜底调用（console script 入口不经过 callback 也保证）；
- `logging_setup.setup_logging()`：创建 handler 前先尝试 reconfigure stderr（日志 JSON 含中文页面标题）；
- 非 TextIOWrapper 流静默跳过，由 `PYTHONIOENCODING` 兜底。

### 2.4 文档同步（R9.4）

| 文件 | 改动 |
|---|---|
| `SKILL.md` | validate 行注明三种输入；命令可用性说明（`pip install .` 后 `slidep` 可用 / `python -m` 等价无 warning）；Windows 乱码说明（已自动处理，老 conhost `chcp 65001`） |
| `README.md` | 补充未安装时 `python -m` 入口、三种输入、编码说明 |
| `examples/state-grid-template/README.md` | 已用 `python -m slidep.cli.main`（等价入口，无需改） |

## 三、涉及文件

| 文件 | 改动 |
|---|---|
| `scripts/slidep/cli/__init__.py` | 移除 eager import main → PEP 562 惰性导出（消除 RuntimeWarning） |
| `scripts/slidep/cli/loader.py` | `load_pages` 自动识别 pages 目录/项目根；新增 `load_input`；友好报错 |
| `scripts/slidep/cli/main.py` | `_force_utf8_stdio` 无条件化；`entry()` 顶部调用；validate 用 `load_input`；build `_enter_project` 识别 pages 目录 |
| `scripts/slidep/logging_setup.py` | setup_logging 前 reconfigure stderr UTF-8 |
| `SKILL.md` / `README.md` | CLI 用法、三种输入、Windows 乱码说明同步 |
| `tests/test_cli.py` | 新增 TestCliEntry×6 |

## 四、验收测试清单（执行结果）

| # | 验收项 | 操作 | 结果 |
|---|---|---|---|
| 1 | 命令可用 | 安装后 `slidep --help` | ✅ console_scripts 已声明（`slidep.cli.main:app`）；文档注明安装/`python -m` 两入口 |
| 2 | 无 RuntimeWarning | `python -W error::RuntimeWarning -m slidep.cli.main version` | ✅ 正常输出无异常 |
| 3 | validate 传 pages 目录 | `validate project/pages` | ✅ 加载 4 页、0 错误 0 警告 |
| 4 | 三种输入一致 | 单页/pages 目录/项目根 | ✅ 结果一致（1 页 vs 4 页，均通过） |
| 5 | 与 build 一致 | `build project/pages` | ✅ 同样识别成功 |
| 6 | 中文正常输出 | subprocess UTF-8 解码校验 | ✅ 输出含正确中文（"校验通过"等） |
| 7 | 全链路回归 | doctor / validate / build / preview | ✅ 均正常 |
| 8 | 文档一致 | SKILL.md / README CLI 章节 | ✅ 命令、参数、示例与真实行为一致 |
| 9 | 单测覆盖 | `pytest tests/test_cli.py` | ✅ 32 用例全过（新增 6） |
| 10 | 全量回归 | `pytest tests/` | ✅ 与基线一致（8 个既有失败，无新增） |

## 五、遗留说明

- 全量回归剩 **8 个既有失败**（`test_layout.py`×6 字体测量 + `test_render.py`×2），与 task-04/06/07 基线一致，非本次引入；
- `slidep` console script 需 `pip install .`（或 `-e .`）后进 PATH；**本开发环境未重新安装**，验证以 `python -m slidep.cli.main` 为准（等价且已无 warning）；安装脚本 `install.bat`/`install.sh` 已内置 `python -m` 形式；
- 老式 conhost（非 Windows Terminal）若仍乱码，需 `chcp 65001`——已在文档注明，属终端字体/代码页限制，代码层已尽力（reconfigure UTF-8）。
