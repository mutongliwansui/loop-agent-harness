"""Daemon 层：热更新守护进程（T4.1）。

公共 API：
- ``DaemonCore``：核心引擎（监听 + 去抖 + 编译 + 原子替换）
- ``DaemonManager``：生命周期管理（start/stop/status + PID 文件）
- ``DaemonStatus``：状态结构
- ``CompileEvent`` / ``CompileQueue``：编译事件与去抖队列
"""

from .core import (
    CompileEvent,
    CompileQueue,
    DaemonCore,
    DEBOUNCE_MS,
    EVENT_QUEUE_MAX,
    IGNORE_SUFFIXES,
    WATCH_DIRS,
)
from .lifecycle import DaemonManager, DaemonStatus, PID_DIR, PID_FILE, STOP_TIMEOUT

__all__ = [
    # 核心引擎
    "DaemonCore",
    "CompileQueue",
    "CompileEvent",
    "DEBOUNCE_MS",
    "WATCH_DIRS",
    "IGNORE_SUFFIXES",
    "EVENT_QUEUE_MAX",
    # 生命周期
    "DaemonManager",
    "DaemonStatus",
    "PID_DIR",
    "PID_FILE",
    "STOP_TIMEOUT",
]
