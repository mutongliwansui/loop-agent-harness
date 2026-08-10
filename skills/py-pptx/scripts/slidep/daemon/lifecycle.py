"""Daemon 生命周期管理（T4.1）：start/stop/status + PID 文件 + 信号处理。

设计：
- ``DaemonManager`` 管理 daemon 子进程的启动/停止/状态查询
- PID 文件存于 ``.slidep/daemon.pid``（项目目录下），含 PID + 启动时间 + 输出路径
- ``start``：检查 PID 文件 → 已运行则报错 → 否则 fork 子进程 + 写 PID
- ``stop``：读 PID → 发 SIGTERM → 等 5s → 仍存活则 SIGKILL → 清理 PID 文件
- ``status``：读 PID 文件 + 检查进程存活 + 返回结构化状态
- 信号处理：子进程注册 SIGTERM/SIGINT → 优雅退出 ``DaemonCore.stop()``

Windows 限制：
- Windows 无 SIGTERM/SIGKILL，用 ``subprocess.terminate()``（SIGTERM 等价）
- ``os.kill(pid, 0)`` 检查进程存活，Windows 上用 ``psutil`` fallback
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

from slidep import ErrorCode, SlidepSystemError, SlidepUserError, cli_error
from slidep.logging_setup import get_logger

log = get_logger("daemon.lifecycle")

#: PID 文件目录名（项目目录下）
PID_DIR = ".slidep"

#: PID 文件名
PID_FILE = "daemon.pid"

#: 停止超时（秒）：发 SIGTERM 后等待进程退出的最长时间
STOP_TIMEOUT = 5.0


@dataclass
class DaemonStatus:
    """Daemon 状态结构。"""

    running: bool
    pid: Optional[int] = None
    start_time: Optional[float] = None
    output_path: Optional[str] = None
    project_dir: Optional[str] = None
    uptime_seconds: Optional[float] = None

    def to_dict(self) -> dict:
        d = asdict(self)
        if self.start_time is not None:
            d["start_time"] = self.start_time
        if self.uptime_seconds is not None:
            d["uptime_seconds"] = round(self.uptime_seconds, 1)
        return d


def _pid_file_path(project_dir: str | Path) -> Path:
    """获取 PID 文件路径。"""
    return Path(project_dir).resolve() / PID_DIR / PID_FILE


def _read_pid_file(project_dir: str | Path) -> Optional[dict]:
    """读取 PID 文件，不存在返回 None。"""
    pid_path = _pid_file_path(project_dir)
    if not pid_path.is_file():
        return None
    try:
        return json.loads(pid_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _write_pid_file(project_dir: str | Path, pid: int, output_path: str) -> None:
    """写入 PID 文件。"""
    pid_path = _pid_file_path(project_dir)
    pid_path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "pid": pid,
        "start_time": time.time(),
        "output_path": output_path,
        "project_dir": str(Path(project_dir).resolve()),
    }
    pid_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _remove_pid_file(project_dir: str | Path) -> None:
    """删除 PID 文件。"""
    pid_path = _pid_file_path(project_dir)
    if pid_path.is_file():
        try:
            pid_path.unlink()
        except OSError:
            pass


def _is_process_alive(pid: int) -> bool:
    """检查进程是否存活（跨平台）。

    Windows 注意：``os.kill(pid, 0)`` 会调用 ``TerminateProcess`` 终止进程，
    不能用于存活检测。改用 ``ctypes`` 的 ``OpenProcess`` + ``GetExitCodeProcess``。
    """
    if sys.platform == "win32":
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            if kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return exit_code.value == STILL_ACTIVE
            return False
        finally:
            kernel32.CloseHandle(handle)
    else:
        try:
            os.kill(pid, 0)
            return True
        except (OSError, ProcessLookupError):
            return False


def _terminate_process(pid: int, timeout: float = STOP_TIMEOUT) -> bool:
    """终止进程：先 SIGTERM，超时后 SIGKILL。Windows 上用 taskkill。

    返回前会轮询等待进程真正退出（避免 os.kill(pid,0) 延迟）。
    """
    if not _is_process_alive(pid):
        return True

    # Windows 不支持 SIGTERM，用 taskkill /T /F（强制终止进程树）
    if sys.platform == "win32":
        try:
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                          capture_output=True, timeout=timeout)
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass
    else:
        try:
            os.kill(pid, signal.SIGTERM)
        except (OSError, ProcessLookupError):
            pass

        # 等待退出
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not _is_process_alive(pid):
                return True
            time.sleep(0.1)

        # 强制 SIGKILL
        if _is_process_alive(pid):
            try:
                os.kill(pid, signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass

    # 轮询等待进程退出（Windows 上 taskkill 后进程退出有延迟）
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not _is_process_alive(pid):
            return True
        time.sleep(0.1)

    return not _is_process_alive(pid)


class DaemonManager:
    """Daemon 生命周期管理：start/stop/status。

    子进程模式：``start`` fork 一个 Python 子进程，执行
    ``python -m slidep.daemon._runner <project> <output>``，子进程内
    注册信号处理 + 运行 ``DaemonCore.run()``。
    """

    def __init__(self, project_dir: str | Path) -> None:
        self._project = Path(project_dir).resolve()

    @property
    def project_dir(self) -> Path:
        return self._project

    def status(self) -> DaemonStatus:
        """查询 daemon 状态。"""
        data = _read_pid_file(self._project)
        if data is None:
            return DaemonStatus(running=False)

        pid = data.get("pid")
        start_time = data.get("start_time")
        output_path = data.get("output_path")
        project_dir = data.get("project_dir")

        if pid is None or not _is_process_alive(pid):
            # 进程已死，清理过期 PID 文件
            _remove_pid_file(self._project)
            return DaemonStatus(running=False)

        uptime = time.time() - start_time if start_time else None
        return DaemonStatus(
            running=True,
            pid=pid,
            start_time=start_time,
            output_path=output_path,
            project_dir=project_dir,
            uptime_seconds=uptime,
        )

    def start(
        self,
        output_path: Optional[str] = None,
        *,
        skip_lint: bool = False,
        debounce_ms: int = 300,
        port: int = 8000,
    ) -> DaemonStatus:
        """启动 daemon 子进程。

        Args:
            port: 预览服务端口（0=不启动预览服务）。

        Returns:
            启动后的状态。

        Raises:
            SlidepUserError: daemon 已在运行。
        """
        # 检查是否已运行
        current = self.status()
        if current.running:
            raise cli_error(
                ErrorCode.CLI_DAEMON_STATE,
                detail=f"Daemon 已在运行 (PID={current.pid})",
                hint="先执行 slidep serve --stop 停止现有 daemon",
            )

        # 解析输出路径
        if output_path is None:
            output_path = str(self._project / "dist" / f"{self._project.name}.pptx")

        # 启动子进程
        cmd = [
            sys.executable, "-m", "slidep.daemon._runner",
            str(self._project),
            output_path,
            "--skip-lint" if skip_lint else "--no-skip-lint",
            "--debounce-ms", str(debounce_ms),
            "--port", str(port),
        ]
        # 使用 CREATE_NO_WINDOW 避免弹出控制台窗口（Windows）
        creationflags = 0
        if sys.platform == "win32":
            creationflags = subprocess.CREATE_NO_WINDOW

        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )

        # 等待进程启动并写 PID 文件（子进程自己写）
        # 父进程也写一份，确保能立即查询到
        _write_pid_file(self._project, proc.pid, output_path)

        # 给子进程一点时间初始化
        time.sleep(0.5)

        if proc.poll() is not None:
            # 子进程立即退出，说明启动失败
            _remove_pid_file(self._project)
            raise SlidepSystemError(
                ErrorCode.CLI_EXEC_FAILED,
                detail="Daemon 子进程启动后立即退出",
                hint="检查页面文件是否有语法错误或 lint 违规",
            )

        log.info_ctx(f"Daemon 已启动 (PID={proc.pid})")
        return self.status()

    def stop(self, timeout: float = STOP_TIMEOUT) -> bool:
        """停止 daemon。

        Returns:
            True 表示成功停止，False 表示进程可能仍存活。
        """
        data = _read_pid_file(self._project)
        if data is None:
            return True

        pid = data.get("pid")
        if pid is None:
            _remove_pid_file(self._project)
            return True

        stopped = _terminate_process(pid, timeout=timeout)
        _remove_pid_file(self._project)

        if stopped:
            log.info_ctx(f"Daemon 已停止 (PID={pid})")
        else:
            log.warn_ctx(f"Daemon 进程 {pid} 可能未完全停止")

        return stopped

    def restart(self, **kwargs) -> DaemonStatus:
        """重启 daemon。"""
        self.stop()
        time.sleep(0.5)
        return self.start(**kwargs)
