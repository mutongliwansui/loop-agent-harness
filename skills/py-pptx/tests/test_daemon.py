"""Daemon 热更新测试（T4.1）。

核验目标（对齐任务分解文档）：
1. e2e：启动 → 修改页面文件 → 断言 .pptx 修改时间戳变化且可被 python-pptx 打开
2. 连续快速修改 10 次 → 只触发 ≤3 次编译（去抖生效）
3. start/stop/status 状态机正确

测试策略：
- CompileQueue 去抖逻辑用单元测试（不依赖 watchdog，mock compile_fn）
- DaemonCore 编译逻辑用集成测试（需要 watchdog，跳过未安装环境）
- DaemonManager 生命周期用集成测试（fork 子进程）
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

# 检查 watchdog 是否安装
try:
    import watchdog  # noqa: F401
    HAS_WATCHDOG = True
except ImportError:
    HAS_WATCHDOG = False


# ================================================================ 合规页面构造
VALID_LONG_TEXT = (
    "本季度营收达到一百二十亿元同比增长百分之三十四创下历史新高。"
    "核心产品线表现强劲用户增长显著市场占有率稳步提升。"
    "下半年将重点投入研发创新持续优化产品体验深化客户服务。"
    "团队规模扩大至五百人新增三个区域办事处覆盖全国主要城市。"
    "客户满意度提升至百分之九十五复购率达到百分之六十八。"
    "技术架构完成云原生改造部署效率提升三倍故障率下降百分之六十。"
    "本季度营收达到一百二十亿元同比增长百分之三十四创下历史新高。"
    "核心产品线表现强劲用户增长显著市场占有率稳步提升。"
)


def _write_valid_project(tmp_path: Path) -> Path:
    """构造合规的 5 页项目。"""
    pages = tmp_path / "pages"
    pages.mkdir()
    (pages / "slide_01_cover.py").write_text(
        "from slidep.dsl import Slide, Text\n"
        "slide = Slide(\n"
        "    page_type='cover', role='hero', rhythm='peak',\n"
        "    title='季度报告', background='#0F172A',\n"
        "    children=[Text('2026 Q2', style={'fontSize': 56, 'color': '#FFFFFF'})],\n"
        ")\n",
        encoding="utf-8",
    )
    long_var = 'LONG = ' + repr(VALID_LONG_TEXT)
    for i in range(3):
        jc = "'flex-start'" if i < 2 else "'center'"
        (pages / f"slide_0{i+2}_content.py").write_text(
            f"from slidep.dsl import Slide, Text\n"
            f"{long_var}\n"
            f"slide = Slide(\n"
            f"    page_type='content', role='supporting', rhythm='peak',\n"
            f"    title='内容页{i+1}',\n"
            f"    children=[\n"
            f"        Text('标题{i+1}', style={{'fontSize': 56, 'color': '#1E293B'}}),\n"
            f"        Text(LONG, style={{'fontSize': 20, 'color': '#475569'}}),\n"
            f"    ],\n"
            f"    style={{'justifyContent': {jc}}},\n"
            f")\n",
            encoding="utf-8",
        )
    (pages / "slide_05_ending.py").write_text(
        "from slidep.dsl import Slide, Text\n"
        "slide = Slide(\n"
        "    page_type='ending', role='transition', rhythm='transition',\n"
        "    title='谢谢', background='#0F172A',\n"
        "    children=[Text('感谢聆听', style={'fontSize': 56, 'color': '#FFFFFF'})],\n"
        ")\n",
        encoding="utf-8",
    )
    return tmp_path


# ================================================================ CompileEvent 数据结构
class TestCompileEvent:
    def test_to_dict(self):
        from slidep.daemon import CompileEvent

        event = CompileEvent(
            timestamp=1234567890.0,
            success=True,
            output_path="/tmp/test.pptx",
            duration_ms=100.5,
        )
        d = event.to_dict()
        assert d["success"] is True
        assert d["output_path"] == "/tmp/test.pptx"
        assert d["duration_ms"] == 100.5
        assert d["timestamp"] == 1234567890.0

    def test_failure_event(self):
        from slidep.daemon import CompileEvent

        event = CompileEvent(
            timestamp=time.time(),
            success=False,
            output_path="/tmp/test.pptx",
            error="lint 门禁未通过",
        )
        d = event.to_dict()
        assert d["success"] is False
        assert d["error"] == "lint 门禁未通过"


# ================================================================ CompileQueue 去抖
class TestCompileQueueDebounce:
    """去抖逻辑单元测试（不依赖 watchdog）。"""

    def test_single_event_triggers_one_compile(self):
        from slidep.daemon import CompileQueue

        results = []

        def mock_compile():
            results.append(time.time())
            from slidep.daemon import CompileEvent
            return CompileEvent(
                timestamp=time.time(), success=True,
                output_path="test.pptx", duration_ms=10.0,
            )

        queue = CompileQueue(mock_compile, debounce_ms=50)
        queue.start()
        try:
            queue.push("file1.py")
            time.sleep(0.3)  # 等待去抖 + 编译
            assert len(results) == 1
        finally:
            queue.stop()

    def test_rapid_10_changes_few_compiles(self):
        """连续快速修改 10 次 → 只触发 ≤3 次编译（去抖生效）。"""
        from slidep.daemon import CompileQueue

        results = []

        def mock_compile():
            results.append(time.time())
            from slidep.daemon import CompileEvent
            return CompileEvent(
                timestamp=time.time(), success=True,
                output_path="test.pptx", duration_ms=10.0,
            )

        # 50ms 去抖窗口
        queue = CompileQueue(mock_compile, debounce_ms=50)
        queue.start()
        try:
            # 10 次快速 push（间隔 10ms，全部在去抖窗口内）
            for i in range(10):
                queue.push(f"file_{i}.py")
                time.sleep(0.01)
            # 等待去抖 + 编译完成
            time.sleep(0.5)
            # 去抖生效：10 次变更只触发 ≤3 次编译
            assert len(results) <= 3, f"去抖未生效：触发了 {len(results)} 次编译"
            assert len(results) >= 1, "应至少触发一次编译"
        finally:
            queue.stop()

    def test_stop_graceful(self):
        from slidep.daemon import CompileQueue

        queue = CompileQueue(lambda: CompileEvent(
            timestamp=time.time(), success=True,
            output_path="x", duration_ms=1,
        ), debounce_ms=10)
        queue.start()
        queue.stop(timeout=2.0)
        assert queue._worker is None

    def test_pending_count(self):
        from slidep.daemon import CompileQueue

        queue = CompileQueue(lambda: None, debounce_ms=10000)  # 长去抖，不触发编译
        queue.start()
        try:
            queue.push("a.py")
            queue.push("b.py")
            time.sleep(0.1)
            assert queue.pending_count >= 2
        finally:
            queue.stop()


# ================================================================ DaemonCore 编译
@pytest.mark.skipif(not HAS_WATCHDOG, reason="watchdog 未安装")
class TestDaemonCore:
    def test_manual_compile_success(self, tmp_path):
        """手动编译产出 pptx。"""
        from slidep.daemon import DaemonCore

        project = _write_valid_project(tmp_path)
        output = str(project / "dist" / "test.pptx")

        core = DaemonCore(project, output, skip_lint=True)
        event = core.trigger_manual_compile()

        assert event.success is True
        assert event.error is None
        assert Path(output).exists()
        assert Path(output).stat().st_size > 0

    def test_manual_compile_pptx_openable(self, tmp_path):
        """编译产出的 pptx 能被 python-pptx 打开。"""
        from pptx import Presentation

        from slidep.daemon import DaemonCore

        project = _write_valid_project(tmp_path)
        output = str(project / "dist" / "test.pptx")

        core = DaemonCore(project, output, skip_lint=True)
        core.trigger_manual_compile()

        # python-pptx 打开
        prs = Presentation(output)
        assert len(prs.slides) == 5

    def test_compile_failure_no_pages(self, tmp_path):
        """无 pages 目录 → 编译失败事件。"""
        from slidep.daemon import DaemonCore

        output = str(tmp_path / "dist" / "test.pptx")
        core = DaemonCore(tmp_path, output, skip_lint=True)
        event = core.trigger_manual_compile()

        assert event.success is False
        assert event.error is not None

    def test_compile_failure_lint_violation(self, tmp_path):
        """lint 违规 → 编译失败事件（不产出 pptx）。"""
        from slidep.daemon import DaemonCore

        pages = tmp_path / "pages"
        pages.mkdir()
        (pages / "slide_01_bad.py").write_text(
            "from slidep.dsl import Slide, Text\n"
            "slide = Slide(page_type='content', children=[\n"
            "    Text('A', style={'fontFamily': 'F1', 'fontSize': 20}),\n"
            "    Text('B', style={'fontFamily': 'F2', 'fontSize': 20}),\n"
            "    Text('C', style={'fontFamily': 'F3', 'fontSize': 20}),\n"
            "])\n",
            encoding="utf-8",
        )
        output = str(tmp_path / "dist" / "test.pptx")
        core = DaemonCore(tmp_path, output, skip_lint=False)
        event = core.trigger_manual_compile()

        assert event.success is False
        assert "lint" in event.error.lower() or "字体" in event.error

    def test_atomic_replace(self, tmp_path):
        """编译成功后 .pptx.tmp 不残留（原子替换）。"""
        from slidep.daemon import DaemonCore

        project = _write_valid_project(tmp_path)
        output = str(project / "dist" / "test.pptx")

        core = DaemonCore(project, output, skip_lint=True)
        core.trigger_manual_compile()

        assert Path(output).exists()
        assert not Path(output + ".tmp").exists()

    def test_events_history(self, tmp_path):
        """编译事件历史可查询。"""
        from slidep.daemon import DaemonCore

        project = _write_valid_project(tmp_path)
        output = str(project / "dist" / "test.pptx")

        core = DaemonCore(project, output, skip_lint=True)
        t0 = time.time()
        core.trigger_manual_compile()

        events = core.get_events(since=t0)
        assert len(events) == 1
        assert events[0].success is True


# ================================================================ DaemonManager 生命周期
class TestDaemonManager:
    def test_status_no_daemon(self, tmp_path):
        """无 daemon 运行时 status 返回 running=False。"""
        from slidep.daemon import DaemonManager

        manager = DaemonManager(tmp_path)
        status = manager.status()
        assert status.running is False

    def test_start_stop_lifecycle(self, tmp_path):
        """start → status(running) → stop → status(not running)。"""
        from slidep.daemon import DaemonManager

        project = _write_valid_project(tmp_path)
        manager = DaemonManager(project)

        # start
        status = manager.start(skip_lint=True)
        try:
            assert status.running is True
            assert status.pid is not None

            # status
            status2 = manager.status()
            assert status2.running is True
            assert status2.pid == status.pid
        finally:
            # stop
            stopped = manager.stop()
            assert stopped is True

        # status after stop
        status3 = manager.status()
        assert status3.running is False

    def test_double_start_error(self, tmp_path):
        """重复启动 → SlidepUserError。"""
        from slidep import SlidepUserError
        from slidep.daemon import DaemonManager

        project = _write_valid_project(tmp_path)
        manager = DaemonManager(project)

        try:
            manager.start(skip_lint=True)
            with pytest.raises(SlidepUserError):
                manager.start(skip_lint=True)
        finally:
            manager.stop()

    def test_stop_when_not_running(self, tmp_path):
        """未运行时 stop 不报错。"""
        from slidep.daemon import DaemonManager

        manager = DaemonManager(tmp_path)
        assert manager.stop() is True

    def test_pid_file_cleanup(self, tmp_path):
        """stop 后 PID 文件被清理。"""
        from slidep.daemon import DaemonManager
        from slidep.daemon.lifecycle import _pid_file_path

        project = _write_valid_project(tmp_path)
        manager = DaemonManager(project)

        try:
            manager.start(skip_lint=True)
            assert _pid_file_path(project).exists()
        finally:
            manager.stop()

        assert not _pid_file_path(project).exists()


# ================================================================ CLI serve 命令
class TestServeCLI:
    def test_serve_status_no_daemon(self, tmp_path):
        """serve --action status（无 daemon）→ exit 0。"""
        from typer.testing import CliRunner
        from slidep.cli.main import app

        runner = CliRunner()
        result = runner.invoke(app, ["serve", str(tmp_path), "--action", "status"])
        assert result.exit_code == 0
        assert "未运行" in result.stdout

    def test_serve_start_stop(self, tmp_path):
        """serve --action start → status → stop。"""
        from typer.testing import CliRunner
        from slidep.cli.main import app

        runner = CliRunner()
        project = _write_valid_project(tmp_path)

        # start
        result = runner.invoke(app, ["serve", str(project), "--action", "start", "--no-lint"])
        assert result.exit_code == 0, f"start failed: {result.output}"
        assert "Daemon 已启动" in result.stdout

        try:
            # status
            result2 = runner.invoke(app, ["serve", str(project), "--action", "status"])
            assert result2.exit_code == 0
            assert "运行中" in result2.stdout
        finally:
            # stop
            result3 = runner.invoke(app, ["serve", str(project), "--action", "stop"])
            assert result3.exit_code == 0
            assert "已停止" in result3.stdout


# ================================================================ e2e：文件变更触发重编译
@pytest.mark.skipif(not HAS_WATCHDOG, reason="watchdog 未安装")
class TestFileChangeE2E:
    def test_modify_triggers_recompile(self, tmp_path):
        """启动 daemon → 修改页面文件 → .pptx 时间戳变化。"""
        from slidep.daemon import DaemonCore

        project = _write_valid_project(tmp_path)
        output = str(project / "dist" / "test.pptx")

        core = DaemonCore(project, output, skip_lint=True)
        core.start()

        try:
            # 首次编译完成
            assert Path(output).exists()
            mtime1 = os.path.getmtime(output)
            initial_count = core.compile_count

            # 等待 watcher 生效
            time.sleep(1.5)

            # 修改页面文件
            page_file = project / "pages" / "slide_01_cover.py"
            original = page_file.read_text(encoding="utf-8")
            page_file.write_text(
                original.replace("2026 Q2", "2026 Q3"),
                encoding="utf-8",
            )
            # 触摸文件确保 mtime 变化
            os.utime(page_file, None)

            # 轮询等待重编译完成（最多 10s）
            deadline = time.time() + 10.0
            recompiled = False
            while time.time() < deadline:
                if core.compile_count > initial_count:
                    recompiled = True
                    break
                time.sleep(0.3)

            assert recompiled, "文件变更未触发重编译"

            # 等待编译写入完成
            time.sleep(0.5)

            # 验证 pptx 更新
            mtime2 = os.path.getmtime(output)
            assert mtime2 > mtime1, f"pptx 未更新: {mtime1} -> {mtime2}"
        finally:
            core.stop()

    def test_rapid_changes_debounce(self, tmp_path):
        """连续快速修改 10 次 → 编译次数 ≤3。"""
        from slidep.daemon import DaemonCore

        project = _write_valid_project(tmp_path)
        output = str(project / "dist" / "test.pptx")

        core = DaemonCore(project, output, skip_lint=True, debounce_ms=300)
        core.start()

        try:
            initial_count = core.compile_count

            # 连续快速修改 10 次（间隔 50ms，全部在 300ms 去抖窗口内）
            page_file = project / "pages" / "slide_01_cover.py"
            for i in range(10):
                content = page_file.read_text(encoding="utf-8")
                page_file.write_text(
                    content.replace("2026 Q2", f"2026 Q2 v{i}"),
                    encoding="utf-8",
                )
                os.utime(page_file, None)
                time.sleep(0.05)

            # 等待去抖 + 编译完成
            time.sleep(2.0)

            final_count = core.compile_count
            compile_times = final_count - initial_count
            # 10 次快速修改应触发 ≤3 次编译（去抖 + 首次编译）
            assert compile_times <= 3, f"去抖未生效：触发了 {compile_times} 次编译"
        finally:
            core.stop()
