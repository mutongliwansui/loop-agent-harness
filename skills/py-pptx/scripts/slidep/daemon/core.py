"""热更新 Daemon 核心（T4.1）：watchdog 监听 → 去抖 → 增量重编译 → 原子替换。

核心组件：
- ``CompileQueue``：去抖编译队列（300ms 去抖窗口，单线程消费避免并发写文件）
- ``DaemonWatcher``：watchdog 事件回调 → 入队；过滤 .pptx 等输出文件
- ``CompileEvent``：编译事件结构（成功/失败 + 时间戳），供预览服务（T4.2）消费
- ``DaemonCore``：组合以上，提供 ``run()`` 阻塞入口与 ``stop()`` 优雅退出

原子替换：编译先写到临时文件 ``.pptx.tmp``，成功后 ``os.replace`` 覆盖目标
（POSIX 原子，Windows 上目标存在时也能替换）。
"""

from __future__ import annotations

import os
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from slidep import ErrorCode, SlidepSystemError, SlidepUserError, cli_error
from slidep.cli.loader import load_pages
from slidep.logging_setup import get_logger
from slidep.render import RenderOptions, render_deck
from slidep.validate import validate_deck

# watchdog 延迟导入：未安装 serve 依赖时仍可使用 DaemonCore（仅无文件监听）
try:
    from watchdog.events import FileSystemEventHandler
    _HAS_WATCHDOG = True
except ImportError:
    _HAS_WATCHDOG = False
    # fallback 基类：watchdog 未安装时 _DaemonHandler 不可实例化，但不影响模块导入
    class FileSystemEventHandler:  # type: ignore[no-redef]
        pass

log = get_logger("daemon")

#: 去抖窗口（毫秒）：事件后等待此时间内无新事件才触发编译
DEBOUNCE_MS = 300

#: 监听目录名
WATCH_DIRS = ("pages", "resources")

#: 忽略的文件后缀（输出文件自身变更不触发重编译）
IGNORE_SUFFIXES = {".pptx", ".tmp", ".pyc", ".log"}

#: 编译事件队列最大长度（供预览服务消费）
EVENT_QUEUE_MAX = 100


@dataclass
class CompileEvent:
    """一次编译事件。"""

    timestamp: float
    success: bool
    output_path: str
    error: Optional[str] = None
    duration_ms: float = 0.0
    trigger: str = "auto"  # "auto" | "manual"

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp,
            "success": self.success,
            "output_path": self.output_path,
            "error": self.error,
            "duration_ms": self.duration_ms,
            "trigger": self.trigger,
        }


class CompileQueue:
    """去抖编译队列：收集文件变更事件，300ms 去抖后触发一次编译。

    单线程消费：编译在独立工作线程中执行，避免并发写 .pptx。
    多次快速变更会被合并为一次编译（去抖）。
    """

    def __init__(
        self,
        compile_fn: Callable[[], CompileEvent],
        debounce_ms: int = DEBOUNCE_MS,
    ) -> None:
        self._compile_fn = compile_fn
        self._debounce_ms = debounce_ms
        self._cond = threading.Condition()
        self._pending: deque[str] = deque()  # 待处理变更的文件路径
        self._stop_flag = False
        self._worker: Optional[threading.Thread] = None
        self._compile_count = 0
        self._last_event: Optional[CompileEvent] = None

    def push(self, file_path: str) -> None:
        """入队一个文件变更事件。"""
        with self._cond:
            self._pending.append(file_path)
            self._cond.notify_all()

    def start(self) -> None:
        """启动工作线程。"""
        if self._worker is not None:
            return
        self._stop_flag = False
        self._worker = threading.Thread(target=self._run, name="slidep-daemon-worker", daemon=True)
        self._worker.start()

    def stop(self, timeout: float = 5.0) -> None:
        """停止工作线程。"""
        with self._cond:
            self._stop_flag = True
            self._cond.notify_all()
        if self._worker is not None:
            self._worker.join(timeout=timeout)
            self._worker = None

    def _run(self) -> None:
        """工作线程主循环：等待事件 → 去抖 → 编译。"""
        while True:
            with self._cond:
                # 等待第一个事件
                while not self._pending and not self._stop_flag:
                    self._cond.wait(timeout=1.0)
                if self._stop_flag:
                    return
                # 去抖：持续等待直到 debounce_ms 内无新事件
                # 每次 push 会 notify_all 唤醒 wait，若期间有新事件则重置等待
                while True:
                    prev_count = len(self._pending)
                    self._cond.wait(timeout=self._debounce_ms / 1000.0)
                    if self._stop_flag:
                        return
                    # 等待窗口内无新事件 → 去抖完成，跳出
                    if len(self._pending) == prev_count:
                        break
                # 清空 pending，准备编译
                self._pending.clear()

            # 执行编译（不持锁）
            try:
                event = self._compile_fn()
                self._compile_count += 1
                self._last_event = event
                if event.success:
                    log.info_ctx(
                        f"编译成功: {event.output_path} "
                        f"(trigger={event.trigger}, {event.duration_ms}ms)"
                    )
                else:
                    log.warn_ctx(
                        f"编译失败: {event.error} "
                        f"(trigger={event.trigger}, {event.duration_ms}ms)"
                    )
            except Exception as e:  # noqa: BLE001
                log.error_ctx(f"编译异常: {e}")
                self._last_event = CompileEvent(
                    timestamp=time.time(),
                    success=False,
                    output_path="",
                    error=str(e),
                    trigger="auto",
                )

    @property
    def compile_count(self) -> int:
        return self._compile_count

    @property
    def last_event(self) -> Optional[CompileEvent]:
        return self._last_event

    @property
    def pending_count(self) -> int:
        with self._cond:
            return len(self._pending)


class DaemonCore:
    """Daemon 核心：监听 → 去抖 → 编译 → 原子替换。

    用法：
        core = DaemonCore(project_dir, output_path)
        core.start()  # 启动监听 + 工作线程
        ...  # 主线程阻塞或做其他事
        core.stop()   # 优雅退出
    """

    def __init__(
        self,
        project_dir: str | Path,
        output_path: Optional[str] = None,
        *,
        debounce_ms: int = DEBOUNCE_MS,
        skip_lint: bool = False,
        on_compile: Optional[Callable[[CompileEvent], None]] = None,
    ) -> None:
        self._project = Path(project_dir).resolve()
        self._output_path = output_path or str(self._project / "dist" / f"{self._project.name}.pptx")
        self._skip_lint = skip_lint
        self._on_compile = on_compile

        # 编译队列
        self._queue = CompileQueue(self._do_compile, debounce_ms=debounce_ms)

        # watchdog observer（延迟初始化，避免 import 时依赖）
        self._observer = None
        self._stop_flag = threading.Event()
        self._started = False

        # 事件历史（供预览服务订阅）
        self._events: deque[CompileEvent] = deque(maxlen=EVENT_QUEUE_MAX)
        self._event_lock = threading.Lock()

    @property
    def output_path(self) -> str:
        return self._output_path

    @property
    def compile_count(self) -> int:
        return self._queue.compile_count

    @property
    def last_event(self) -> Optional[CompileEvent]:
        return self._queue.last_event

    @property
    def is_running(self) -> bool:
        return self._started and not self._stop_flag.is_set()

    def get_events(self, since: float = 0.0) -> list[CompileEvent]:
        """获取指定时间点之后的事件列表（供预览服务 SSE 消费）。"""
        with self._event_lock:
            return [e for e in self._events if e.timestamp > since]

    def trigger_manual_compile(self) -> CompileEvent:
        """手动触发一次编译（不经过去抖）。

        ``_do_compile`` 内部已把事件追加到 ``self._events``，此处不重复追加。
        """
        return self._do_compile()

    def start(self) -> None:
        """启动 daemon：初始化 watchdog 监听 + 编译队列。"""
        if self._started:
            return
        self._started = True
        self._stop_flag.clear()

        # 启动编译队列
        self._queue.start()

        # 初始化 watchdog（模块级已导入 FileSystemEventHandler，这里只需 Observer）
        if not _HAS_WATCHDOG:
            raise SlidepSystemError(
                ErrorCode.CLI_EXEC_FAILED,
                detail="watchdog 未安装",
                hint="安装 serve 依赖: pip install 'slidep[serve]'",
            )

        from watchdog.observers import Observer

        handler = _DaemonHandler(self._queue, self._project)
        self._observer = Observer()
        for sub in WATCH_DIRS:
            watch_dir = self._project / sub
            if watch_dir.is_dir():
                self._observer.schedule(handler, str(watch_dir), recursive=True)
        self._observer.start()

        log.info_ctx(f"Daemon 启动，监听 {self._project}")

        # 首次编译
        self.trigger_manual_compile()

    def stop(self, timeout: float = 5.0) -> None:
        """优雅退出。"""
        if not self._started:
            return
        self._stop_flag.set()
        if self._observer is not None:
            self._observer.stop()
            self._observer.join(timeout=timeout)
            self._observer = None
        self._queue.stop(timeout=timeout)
        self._started = False
        log.info_ctx("Daemon 已停止")

    def run(self) -> None:
        """阻塞运行直到收到停止信号（SIGINT/SIGTERM）。"""
        self.start()
        try:
            while not self._stop_flag.is_set():
                self._stop_flag.wait(timeout=1.0)
        except KeyboardInterrupt:
            pass
        finally:
            self.stop()

    def _do_compile(self) -> CompileEvent:
        """执行一次完整编译：load → lint → render → 原子替换。"""
        start = time.time()
        try:
            # 1. 加载页面
            slides = load_pages(self._project)

            # 2. lint 门禁（可跳过）
            if not self._skip_lint:
                report = validate_deck(slides)
                if report.error_count > 0:
                    error_msgs = [i.message for i in report.issues if i.level == "error"][:3]
                    return self._finish_event(
                        start, success=False,
                        error=f"lint 门禁未通过: {'; '.join(error_msgs)}",
                    )

            # 3. 渲染到临时文件 → 原子替换
            tmp_path = self._output_path + ".tmp"
            Path(tmp_path).parent.mkdir(parents=True, exist_ok=True)

            project_name = self._project.name
            opts = RenderOptions(project_name=project_name)
            render_deck(slides, tmp_path, options=opts)

            # 原子替换
            if os.path.exists(self._output_path):
                os.replace(tmp_path, self._output_path)
            else:
                os.rename(tmp_path, self._output_path)

            return self._finish_event(start, success=True)

        except SlidepUserError as e:
            return self._finish_event(start, success=False, error=str(e))
        except Exception as e:  # noqa: BLE001
            return self._finish_event(start, success=False, error=f"系统错误: {e}")

    def _finish_event(
        self, start: float, *, success: bool, error: Optional[str] = None,
    ) -> CompileEvent:
        """构建编译事件，追加到历史，并触发 on_compile 回调（供预览服务）。"""
        event = CompileEvent(
            timestamp=time.time(),
            success=success,
            output_path=self._output_path,
            error=error,
            duration_ms=round((time.time() - start) * 1000, 1),
            trigger="auto",
        )
        with self._event_lock:
            self._events.append(event)
        # 通知外部回调（预览服务的 SSE 推送）
        if self._on_compile is not None:
            try:
                self._on_compile(event)
            except Exception:  # noqa: BLE001
                pass
        return event


class _DaemonHandler(FileSystemEventHandler):
    """watchdog 事件处理器：过滤输出文件 → 入队。"""

    def __init__(self, queue: CompileQueue, project: Path) -> None:
        self._queue = queue
        self._project = project

    def _should_ignore(self, path: str) -> bool:
        """过滤输出文件与临时文件。"""
        p = Path(path)
        if p.suffix.lower() in IGNORE_SUFFIXES:
            return True
        # dist/ 目录下的变更忽略
        try:
            rel = p.resolve().relative_to(self._project)
            if rel.parts and rel.parts[0] == "dist":
                return True
        except (ValueError, RuntimeError):
            pass
        return False

    def _enqueue(self, event) -> None:
        if event.is_directory:
            return
        if self._should_ignore(event.src_path):
            return
        self._queue.push(event.src_path)

    def on_created(self, event) -> None:
        self._enqueue(event)

    def on_modified(self, event) -> None:
        self._enqueue(event)

    def on_moved(self, event) -> None:
        self._enqueue(event)
