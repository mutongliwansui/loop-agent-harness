"""页面加载器：``pages/*.py`` → ``Slide`` 列表（T3.2）。

约定（对齐 ppt-ecosystem-plan.md 的 pages/ 目录规范）：
- 项目根目录下 ``pages/`` 子目录，每个 ``.py`` 文件代表一页
- 文件名推荐 ``slide_{NN}_{desc}.py``（NN 为零填充页码），按 NN 升序加载
- 每个文件须定义模块级变量 ``slide: Slide``（单个页面）
- 也支持 ``slides: list[Slide]``（一个文件产出多页，按声明顺序）

加载失败处理（定位到文件 + 行号）：
- 语法错（``SyntaxError``）→ 提取 ``lineno``
- 导入错 / DSL 校验错（``SlidepUserError``）→ 附加文件路径
- 缺少 ``slide`` 属性 → 报告文件名

公共 API：
- ``load_pages(project_dir) -> list[Slide]``：加载全量页面
- ``load_single_page(file_path) -> list[Slide]``：加载单文件（validate 单页用）
"""

from __future__ import annotations

import importlib.util
import os
import re
import sys
from pathlib import Path
from typing import Optional

from slidep import ErrorCode, SlidepSystemError, SlidepUserError, cli_error
from slidep.dsl import Slide

#: 页面文件名模式：slide_{NN}_{desc}.py 或任意 .py（后者按文件名排序）
_PAGE_RE = re.compile(r"^slide_(\d+)_")

#: pages 目录名
PAGES_DIR = "pages"


def _sort_key(path: Path) -> tuple[int, str]:
    """排序键：有 NN 前缀的按数字升序，其余按文件名兜底。"""
    m = _PAGE_RE.match(path.name)
    if m:
        return (int(m.group(1)), path.name)
    return (99999, path.name)


def _discover_page_files(pages_dir: Path) -> list[Path]:
    """发现 pages/ 下所有 .py 文件（排除 __init__.py），按页码升序。"""
    if not pages_dir.is_dir():
        return []
    files = [f for f in pages_dir.glob("*.py") if f.name != "__init__.py"]
    files.sort(key=_sort_key)
    return files


def _import_page_module(file_path: Path, module_name: str):
    """动态导入单个页面文件为模块。

    Returns:
        module 对象

    Raises:
        SlidepUserError: 语法错 / 导入错 / DSL 校验错（含文件+行号定位）
    """
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        raise SlidepSystemError(
            ErrorCode.CLI_EXEC_FAILED,
            detail=f"无法加载模块 {file_path}",
            file=str(file_path),
        )
    module = importlib.util.module_from_spec(spec)
    # 注册到 sys.modules 以支持页面文件内部的相对引用（如 from .helpers import ...）
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)  # type: ignore[union-attr]
    except SyntaxError as e:
        # 语法错：Python 自带 filename + lineno
        raise cli_error(
            ErrorCode.CLI_EXEC_FAILED,
            detail=f"语法错误：{e.msg}",
            file=str(file_path),
            lineno=e.lineno,
            hint="检查页面文件的 Python 语法",
        ) from e
    except SlidepUserError as e:
        # DSL 校验错（Slide 构造时触发）：附加文件路径
        if e.file is None:
            e.file = str(file_path)
        if e.lineno is None:
            e.lineno = 1
        raise
    except Exception as e:
        # 其他导入时异常（如 NameError、ImportError）
        import traceback

        tb = traceback.extract_tb(e.__traceback__)
        lineno = tb[-1].lineno if tb else 1
        raise cli_error(
            ErrorCode.CLI_EXEC_FAILED,
            detail=f"页面加载失败：{e}",
            file=str(file_path),
            lineno=lineno,
            hint="检查页面文件中的导入与变量定义",
        ) from e
    return module


def _extract_slides(module, file_path: Path) -> list[Slide]:
    """从模块中提取 slide(s) 变量。

    优先 ``slides: list[Slide]``，其次 ``slide: Slide``。
    """
    if hasattr(module, "slides"):
        slides_val = getattr(module, "slides")
        if not isinstance(slides_val, list):
            raise cli_error(
                ErrorCode.CLI_INVALID_ARGS,
                detail=f"`slides` 必须是 list[Slide]，实际为 {type(slides_val).__name__}",
                file=str(file_path),
                hint="将 slides 定义为 Slide 列表",
            )
        result: list[Slide] = []
        for i, s in enumerate(slides_val):
            if not isinstance(s, Slide):
                raise cli_error(
                    ErrorCode.CLI_INVALID_ARGS,
                    detail=f"`slides[{i}]` 必须是 Slide，实际为 {type(s).__name__}",
                    file=str(file_path),
                    hint="确保列表中每个元素都是 Slide 实例",
                )
            result.append(s)
        return result

    if hasattr(module, "slide"):
        slide_val = getattr(module, "slide")
        if not isinstance(slide_val, Slide):
            raise cli_error(
                ErrorCode.CLI_INVALID_ARGS,
                detail=f"`slide` 必须是 Slide 实例，实际为 {type(slide_val).__name__}",
                file=str(file_path),
                hint="将 slide 定义为 Slide(...) 实例",
            )
        return [slide_val]

    raise cli_error(
        ErrorCode.CLI_INVALID_ARGS,
        detail=f"页面文件未定义 `slide` 或 `slides` 变量",
        file=str(file_path),
        hint="在文件顶层添加 `slide = Slide(...)` 或 `slides = [Slide(...), ...]`",
    )


def load_pages(project_dir: str | Path) -> list[Slide]:
    """加载项目的全量页面。

    Args:
        project_dir: 项目根目录（其下应有 ``pages/`` 子目录）。

    Returns:
        按 NN 升序排列的 Slide 列表。

    Raises:
        SlidepUserError: pages/ 不存在或页面加载失败。
    """
    project = Path(project_dir).resolve()
    pages_dir = project / PAGES_DIR

    files = _discover_page_files(pages_dir)
    if not files:
        raise cli_error(
            ErrorCode.CLI_INVALID_ARGS,
            detail=f"项目 {project} 下未找到 pages/ 目录或无 .py 页面文件",
            file=str(pages_dir),
            hint="在项目根目录创建 pages/ 子目录，并添加 slide_01_cover.py 等页面文件",
        )

    all_slides: list[Slide] = []
    for file_path in files:
        module_name = f"_slidep_page_{file_path.stem}"
        module = _import_page_module(file_path, module_name)
        all_slides.extend(_extract_slides(module, file_path))

    return all_slides


def load_single_page(file_path: str | Path) -> list[Slide]:
    """加载单个页面文件（validate 单页用）。

    Args:
        file_path: 页面 .py 文件路径。

    Returns:
        该文件产出的 Slide 列表（通常为 1 个）。
    """
    path = Path(file_path).resolve()
    if not path.is_file():
        raise cli_error(
            ErrorCode.IO_FILE_NOT_FOUND,
            path=str(path),
            hint="确认文件路径是否正确",
        )
    module_name = f"_slidep_page_single_{path.stem}"
    module = _import_page_module(path, module_name)
    return _extract_slides(module, path)


def find_pages_dir(project_dir: str | Path) -> Optional[Path]:
    """查找项目的 pages/ 目录（不存在返回 None）。"""
    pages_dir = Path(project_dir).resolve() / PAGES_DIR
    return pages_dir if pages_dir.is_dir() else None
