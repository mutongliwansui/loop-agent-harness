"""Daemon 子进程入口：被 ``DaemonManager.start`` fork 执行。

接收命令行参数：
    python -m slidep.daemon._runner <project_dir> <output_path> [options]

选项：
    --skip-lint / --no-skip-lint    跳过/启用 lint 门禁
    --debounce-ms N                 去抖窗口（毫秒）
    --port N                        预览服务端口（T4.2，0=不启动预览）

职责：
- 注册 SIGTERM/SIGINT/SIGBREAK 信号处理 → 优雅退出
- 启动 DaemonCore（文件监听 + 去抖编译）
- 启动 PreviewServer（HTTP 画廊 + SSE，T4.2）
- 编译事件通过 on_compile 回调推送到预览服务
- 退出时清理 PID 文件
"""

from __future__ import annotations

import signal
import sys
import threading
from pathlib import Path

from slidep.daemon.core import DaemonCore
from slidep.daemon.lifecycle import _remove_pid_file
from slidep.logging_setup import get_logger

log = get_logger("daemon.runner")


def _parse_args(argv: list[str]) -> dict:
    """解析命令行参数。"""
    if len(argv) < 3:
        print(
            "用法: python -m slidep.daemon._runner <project_dir> <output_path> [options]",
            file=sys.stderr,
        )
        sys.exit(2)

    opts: dict = {
        "project_dir": argv[1],
        "output_path": argv[2],
        "skip_lint": False,
        "debounce_ms": 300,
        "port": 8000,
    }

    i = 3
    while i < len(argv):
        arg = argv[i]
        if arg == "--skip-lint":
            opts["skip_lint"] = True
        elif arg == "--no-skip-lint":
            opts["skip_lint"] = False
        elif arg == "--debounce-ms" and i + 1 < len(argv):
            try:
                opts["debounce_ms"] = int(argv[i + 1])
            except ValueError:
                pass
            i += 1
        elif arg == "--port" and i + 1 < len(argv):
            try:
                opts["port"] = int(argv[i + 1])
            except ValueError:
                pass
            i += 1
        i += 1

    return opts


def main() -> int:
    """子进程主函数。"""
    opts = _parse_args(sys.argv)
    project_dir = opts["project_dir"]
    output_path = opts["output_path"]
    skip_lint = opts["skip_lint"]
    debounce_ms = opts["debounce_ms"]
    port = opts["port"]

    # 预览服务（T4.2）
    preview_server = None
    on_compile = None

    if port > 0:
        try:
            from slidep.preview import PreviewServer

            preview_server = PreviewServer(
                project_dir,
                port=port,
                skip_lint=skip_lint,
            )

            def _on_compile(event):
                """编译完成 → 通知预览服务 SSE 推送。"""
                preview_server.notify_compile(
                    success=event.success,
                    error=event.error,
                )

            on_compile = _on_compile
        except ImportError:
            log.warn_ctx("预览服务依赖未安装（fastapi/uvicorn），仅运行 daemon")

    # 创建 DaemonCore
    core = DaemonCore(
        project_dir,
        output_path,
        skip_lint=skip_lint,
        debounce_ms=debounce_ms,
        on_compile=on_compile,
    )

    # 信号处理：优雅退出
    stop_event = threading.Event()

    def _signal_handler(signum, frame):
        core.stop()
        if preview_server is not None:
            preview_server.stop()
        stop_event.set()

    signal.signal(signal.SIGTERM, _signal_handler)
    signal.signal(signal.SIGINT, _signal_handler)
    # Windows 不支持 SIGTERM，用 SIGBREAK 替代
    if sys.platform == "win32":
        try:
            signal.signal(signal.SIGBREAK, _signal_handler)
        except (AttributeError, ValueError):
            pass

    # 启动 DaemonCore（非阻塞：start() 启动后台线程）
    try:
        core.start()
    except Exception:
        pass

    # 启动预览服务（阻塞运行）
    if preview_server is not None:
        # 预览服务在主线程阻塞运行
        try:
            preview_server.run()
        except KeyboardInterrupt:
            pass
        finally:
            core.stop()
    else:
        # 无预览服务：阻塞等待停止信号
        try:
            while not stop_event.is_set():
                stop_event.wait(timeout=1.0)
        except KeyboardInterrupt:
            pass
        finally:
            core.stop()

    # 清理 PID 文件
    _remove_pid_file(project_dir)

    return 0


if __name__ == "__main__":
    sys.exit(main())
