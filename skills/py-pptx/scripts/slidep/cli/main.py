"""CLI 命令编排（typer）：build / validate / serve / version（T3.2）。

命令：
    slidep build [PROJECT] [--filename/-f NAME] [--no-lint] [--strict]
        全量编译 pages/*.py → .pptx（失败即停，报告定位到文件+行号）
    slidep validate [FILE] [--project/-p DIR] [--strict]
        单页/全量 lint + 语法检查（不产出文件）
    slidep serve [PROJECT] [--port/-p PORT]
        启动热更新 daemon（T4.1，当前占位）
    slidep version
        版本信息

退出码约定（对齐 errors.py）：
    0 成功
    1 校验/用户错误（DSL 违规、lint 门禁未通过、页面语法错）
    2 系统错误（依赖缺失、渲染崩溃）
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Optional

import typer

from slidep import (
    ErrorCode,
    SlidepError,
    SlidepSystemError,
    SlidepUserError,
    __version__,
    cli_error,
)
from slidep.cli.loader import load_pages, load_single_page
from slidep.logging_setup import setup_logging
from slidep.validate import LintReport, validate_deck, validate_slide

app = typer.Typer(
    name="slidep",
    help="Python PPT 生成引擎：声明式 DSL -> 布局 -> OOXML -> 校验门禁",
    add_completion=False,
    no_args_is_help=True,
)

log = setup_logging()


# ---------------------------------------------------------------- 输出格式化

def _print_lint_report(report: LintReport, *, verbose: bool = False) -> None:
    """打印 lint 报告（面向用户，隐藏内部 AST 细节）。"""
    if not report.issues:
        print("[slidep] 校验通过，无告警")
        return

    # 按页分组
    by_page: dict[int, list] = {}
    for issue in report.issues:
        by_page.setdefault(issue.page, []).append(issue)

    for page in sorted(by_page.keys()):
        label = "全局" if page == -1 else f"第 {page + 1} 页"
        print(f"\n[{label}]")
        for issue in by_page[page]:
            tag = "错误" if issue.level == "error" else "警告"
            print(f"  {tag} {issue.rule_name}（{issue.rule_id}）")
            print(f"    实测 {issue.actual}，阈值 {issue.limit}")
            print(f"    {issue.message}")
            if verbose:
                print(f"    详情：{issue.to_dict()}")

    print(f"\n[slidep] 共 {report.error_count} 错误，{report.warning_count} 警告")


def _resolve_output_path(project_dir: str, filename: Optional[str]) -> str:
    """解析输出 .pptx 路径。

    优先 --filename，其次项目名.pptx，输出到 dist/ 子目录。
    """
    project = Path(project_dir).resolve()
    dist_dir = project / "dist"
    dist_dir.mkdir(parents=True, exist_ok=True)

    if filename:
        name = filename if filename.endswith(".pptx") else f"{filename}.pptx"
        return str(dist_dir / name)

    # 默认取项目目录名
    return str(dist_dir / f"{project.name}.pptx")


# ---------------------------------------------------------------- 统一错误出口

def _handle_error(e: SlidepError) -> int:
    """统一错误出口：UserError -> 1（无堆栈），SystemError -> 2（带堆栈）。"""
    loc = e.location if e.location != "-" else ""
    log.error_ctx(str(e), code=e.code.value, page=e.page, file=e.file, lineno=e.lineno)
    print(f"[slidep] 错误 {e.code.value}: {e}", file=sys.stderr)
    if loc:
        print(f"  位置: {loc}", file=sys.stderr)
    if e.hint:
        print(f"  提示: {e.hint}", file=sys.stderr)
    if isinstance(e, SlidepSystemError):
        raise typer.Exit(code=2)
    raise typer.Exit(code=1)


# ---------------------------------------------------------------- 全局选项

@app.callback()
def main(verbose: bool = typer.Option(False, "--verbose", "-v", help="输出调试日志")) -> None:
    """全局选项。"""
    if verbose:
        import logging

        logging.getLogger("slidep").setLevel(logging.DEBUG)


# ---------------------------------------------------------------- build 命令

@app.command("build")
def build(
    project: str = typer.Argument(".", help="项目根目录（须含 pages/ 子目录）"),
    filename: Optional[str] = typer.Option(None, "--filename", "-f", help="输出 .pptx 文件名（不含路径，输出到 dist/）"),
    no_lint: bool = typer.Option(False, "--no-lint", help="跳过 lint 门禁（不推荐）"),
    strict: bool = typer.Option(False, "--strict", help="严格模式：warning 也视为失败"),
) -> None:
    """编译全部页面为 .pptx（含 lint 门禁）。"""
    try:
        # 1. 加载页面
        log.info_ctx(f"加载页面: {project}")
        slides = load_pages(project)
        print(f"[slidep] 已加载 {len(slides)} 页")

        # 2. lint 门禁
        if not no_lint:
            log.info_ctx("执行 lint 门禁检查")
            report = validate_deck(slides)
            _print_lint_report(report)

            # strict 模式：warning 也导致失败
            failed = report.error_count > 0 or (strict and report.warning_count > 0)
            if failed:
                if strict and report.warning_count > 0 and report.error_count == 0:
                    print("[slidep] 严格模式：存在 warning，构建中止", file=sys.stderr)
                else:
                    print("[slidep] lint 门禁未通过，构建中止（使用 --no-lint 跳过，不推荐）", file=sys.stderr)
                raise typer.Exit(code=1)
        else:
            print("[slidep] 已跳过 lint 门禁（--no-lint）")

        # 3. 渲染
        from slidep.render import RenderOptions, render_deck

        output_path = _resolve_output_path(project, filename)
        log.info_ctx(f"渲染输出: {output_path}")

        project_name = Path(project).resolve().name
        opts = RenderOptions(project_name=project_name)
        render_deck(slides, output_path, options=opts)

        print(f"[slidep] 构建成功: {output_path}")

    except SlidepError as e:
        _handle_error(e)
    except typer.Exit:
        raise
    except Exception as e:  # noqa: BLE001
        _handle_error(SlidepSystemError(ErrorCode.CLI_EXEC_FAILED, detail=str(e)))


# ---------------------------------------------------------------- validate 命令

@app.command("validate")
def validate(
    file: Optional[str] = typer.Argument(None, help="单页文件路径；缺省时校验全量 pages/"),
    project: str = typer.Option(".", "--project", "-p", help="项目根目录（校验全量时使用）"),
    strict: bool = typer.Option(False, "--strict", help="严格模式：warning 也视为失败"),
) -> None:
    """校验页面语法与设计规范门禁（不产出文件）。"""
    try:
        if file:
            # 单页校验
            log.info_ctx(f"校验单页: {file}")
            slides = load_single_page(file)
            print(f"[slidep] 已加载 {len(slides)} 页（来自 {file}）")

            # 单页校验：对每个 slide 调用 validate_slide
            all_issues = []
            for idx, slide in enumerate(slides):
                issues = validate_slide(slide, page_index=idx)
                all_issues.extend(issues)
            report = LintReport(issues=all_issues)
        else:
            # 全量校验
            log.info_ctx(f"校验全量页面: {project}")
            slides = load_pages(project)
            print(f"[slidep] 已加载 {len(slides)} 页")
            report = validate_deck(slides)

        _print_lint_report(report)

        # 退出码：error 存在 → 1，strict 下 warning 也 → 1
        if report.error_count > 0:
            raise typer.Exit(code=1)
        if strict and report.warning_count > 0:
            print("[slidep] 严格模式：存在 warning，视为失败", file=sys.stderr)
            raise typer.Exit(code=1)

        print(f"\n[slidep] 校验完成: {report.error_count} 错误，{report.warning_count} 警告")

    except SlidepError as e:
        _handle_error(e)
    except typer.Exit:
        raise
    except Exception as e:  # noqa: BLE001
        _handle_error(SlidepSystemError(ErrorCode.CLI_EXEC_FAILED, detail=str(e)))


# ---------------------------------------------------------------- serve 命令

@app.command("serve")
def serve(
    project: str = typer.Argument(".", help="项目根目录"),
    action: str = typer.Option(
        "start",
        "--action",
        "-a",
        help="daemon 操作: start（启动）/ stop（停止）/ status（状态）/ restart（重启）",
    ),
    filename: Optional[str] = typer.Option(None, "--filename", "-f", help="输出 .pptx 文件名"),
    no_lint: bool = typer.Option(False, "--no-lint", help="跳过 lint 门禁"),
    debounce: int = typer.Option(300, "--debounce-ms", help="去抖窗口（毫秒）"),
    port: int = typer.Option(8000, "--port", "-p", help="预览服务端口（T4.2）"),
) -> None:
    """启动/停止/查询热更新 daemon + 预览服务（T4.1+T4.2）。"""
    try:
        from slidep.daemon import DaemonManager

        manager = DaemonManager(project)
        action_lower = action.lower()

        if action_lower == "start":
            output_path = _resolve_output_path(project, filename)
            status = manager.start(output_path, skip_lint=no_lint, debounce_ms=debounce, port=port)
            if status.running:
                print(f"[slidep] Daemon 已启动 (PID={status.pid})")
                print(f"  监听目录: {Path(project).resolve() / 'pages'}")
                print(f"  输出: {status.output_path}")
                print(f"  去抖: {debounce}ms")
                print(f"  预览: http://localhost:{port}/")
            else:
                print("[slidep] Daemon 启动失败", file=sys.stderr)
                raise typer.Exit(code=2)

        elif action_lower == "stop":
            stopped = manager.stop()
            if stopped:
                print("[slidep] Daemon 已停止")
            else:
                print("[slidep] Daemon 停止超时，进程可能仍存活", file=sys.stderr)
                raise typer.Exit(code=2)

        elif action_lower == "status":
            status = manager.status()
            if status.running:
                print(f"[slidep] Daemon 运行中 (PID={status.pid})")
                print(f"  启动时间: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(status.start_time))}")
                print(f"  运行时长: {status.uptime_seconds:.1f}s")
                print(f"  输出: {status.output_path}")
                print(f"  预览: http://localhost:{port}/")
            else:
                print("[slidep] Daemon 未运行")

        elif action_lower == "restart":
            status = manager.restart(
                output_path=_resolve_output_path(project, filename) if filename else None,
                skip_lint=no_lint,
                debounce_ms=debounce,
                port=port,
            )
            if status.running:
                print(f"[slidep] Daemon 已重启 (PID={status.pid})")
                print(f"  预览: http://localhost:{port}/")
            else:
                print("[slidep] Daemon 重启失败", file=sys.stderr)
                raise typer.Exit(code=2)

        else:
            raise cli_error(
                ErrorCode.CLI_INVALID_ARGS,
                detail=f"未知 action: {action}",
                hint="支持: start / stop / status / restart",
            )

    except SlidepError as e:
        _handle_error(e)
    except typer.Exit:
        raise
    except Exception as e:  # noqa: BLE001
        _handle_error(SlidepSystemError(ErrorCode.CLI_EXEC_FAILED, detail=str(e)))


# ---------------------------------------------------------------- version 命令

@app.command("version")
def version() -> None:
    """打印版本信息。"""
    print(f"slidep {__version__}")


# ---------------------------------------------------------------- 入口

def entry() -> None:
    """console script 入口：统一异常出口。"""
    try:
        app()
    except SlidepError as e:  # 内部子系统直接抛出
        _handle_error(e)
    except typer.Exit:
        raise
    except Exception as e:  # noqa: BLE001 - 兜底系统错误
        _handle_error(SlidepSystemError(ErrorCode.CLI_EXEC_FAILED, detail=str(e)))


if __name__ == "__main__":
    entry()
