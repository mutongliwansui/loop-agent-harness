"""CLI e2e 测试（T3.2）：build / validate / serve / version。

核验目标（对齐任务分解文档）：
1. e2e：3 页示例项目一条命令产出 pptx
2. 故意写错页（语法错/违规）→ 报告定位到页与行
3. 退出码断言（0 成功 / 1 校验失败 / 2 系统错误）
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from typer.testing import CliRunner

from slidep import __version__
from slidep.cli.loader import load_pages, load_single_page
from slidep.cli.main import app

runner = CliRunner()


# ================================================================ 辅助：构造项目

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
    """构造合规的 5 页项目（1 cover + 3 content + 1 ending），lint 全通过。"""
    pages = tmp_path / "pages"
    pages.mkdir()

    # P0: cover (hero)
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


def _write_syntax_error_project(tmp_path: Path) -> Path:
    """构造含语法错误的页面文件。"""
    pages = tmp_path / "pages"
    pages.mkdir()
    (pages / "slide_01_bad.py").write_text(
        "from slidep.dsl import Slide\n"
        "slide = Slide(  # 缺少右括号\n"
        "    page_type='content'\n"
        "    children=[]\n"  # 缺逗号
        "\n",
        encoding="utf-8",
    )
    return tmp_path


def _write_violation_project(tmp_path: Path) -> Path:
    """构造 lint 违规的页面（字体家族超限）。"""
    pages = tmp_path / "pages"
    pages.mkdir()
    (pages / "slide_01_violation.py").write_text(
        "from slidep.dsl import Slide, Text\n"
        "slide = Slide(\n"
        "    page_type='content',\n"
        "    children=[\n"
        "        Text('A', style={'fontFamily': 'Arial', 'fontSize': 20}),\n"
        "        Text('B', style={'fontFamily': 'SimSun', 'fontSize': 20}),\n"
        "        Text('C', style={'fontFamily': 'Times', 'fontSize': 20}),\n"
        "    ],\n"
        ")\n",
        encoding="utf-8",
    )
    return tmp_path


def _write_no_slide_attr_project(tmp_path: Path) -> Path:
    """构造缺少 slide 变量的页面文件。"""
    pages = tmp_path / "pages"
    pages.mkdir()
    (pages / "slide_01_empty.py").write_text(
        "# 忘记定义 slide 变量\n"
        "x = 42\n",
        encoding="utf-8",
    )
    return tmp_path


# ================================================================ version / help
class TestBasicCommands:
    def test_version_output(self):
        result = runner.invoke(app, ["version"])
        assert result.exit_code == 0
        assert __version__ in result.stdout

    def test_help_output(self):
        result = runner.invoke(app, ["--help"])
        assert result.exit_code == 0
        assert "build" in result.stdout
        assert "validate" in result.stdout
        assert "serve" in result.stdout

    def test_no_args_shows_help(self):
        result = runner.invoke(app, [])
        assert result.exit_code in (0, 2)
        assert "build" in result.stdout

    def test_serve_status_no_daemon(self):
        """serve --action status 在无 daemon 时返回 exit 0。"""
        result = runner.invoke(app, ["serve", ".", "--action", "status"])
        assert result.exit_code == 0
        assert "未运行" in result.stdout


# ================================================================ build 命令
class TestBuild:
    def test_build_valid_project(self, tmp_path):
        """e2e：5 页合规项目一条命令产出 pptx。"""
        project = _write_valid_project(tmp_path)
        result = runner.invoke(app, ["build", str(project)])
        assert result.exit_code == 0, f"stdout: {result.stdout}\nstderr: {result.output}"
        pptx_path = project / "dist" / f"{project.name}.pptx"
        assert pptx_path.exists(), f"pptx 未生成: {pptx_path}"
        assert pptx_path.stat().st_size > 0

    def test_build_custom_filename(self, tmp_path):
        """--filename 指定输出名。"""
        project = _write_valid_project(tmp_path)
        result = runner.invoke(app, ["build", str(project), "--filename", "custom"])
        assert result.exit_code == 0
        assert (project / "dist" / "custom.pptx").exists()

    def test_build_no_lint(self, tmp_path):
        """--no-lint 跳过门禁仍能产出 pptx。"""
        project = _write_violation_project(tmp_path)
        result = runner.invoke(app, ["build", str(project), "--no-lint"])
        assert result.exit_code == 0
        assert (project / "dist" / f"{project.name}.pptx").exists()

    def test_build_lint_failure_exit_1(self, tmp_path):
        """lint 违规 → exit 1，不产出 pptx。"""
        project = _write_violation_project(tmp_path)
        result = runner.invoke(app, ["build", str(project)])
        assert result.exit_code == 1
        assert not (project / "dist").exists() or not (project / "dist" / f"{project.name}.pptx").exists()

    def test_build_syntax_error_exit_1(self, tmp_path):
        """语法错误 → exit 1，定位到文件。"""
        project = _write_syntax_error_project(tmp_path)
        result = runner.invoke(app, ["build", str(project)])
        assert result.exit_code == 1
        assert "slide_01_bad" in result.output

    def test_build_no_pages_dir(self, tmp_path):
        """无 pages/ 目录 → exit 1。"""
        result = runner.invoke(app, ["build", str(tmp_path)])
        assert result.exit_code == 1

    def test_build_no_slide_attr(self, tmp_path):
        """页面文件无 slide 变量 → exit 1。"""
        project = _write_no_slide_attr_project(tmp_path)
        result = runner.invoke(app, ["build", str(project)])
        assert result.exit_code == 1
        assert "slide" in result.output.lower()


# ================================================================ validate 命令
class TestValidate:
    def test_validate_valid_project(self, tmp_path):
        """合规项目全量校验 exit 0。"""
        project = _write_valid_project(tmp_path)
        result = runner.invoke(app, ["validate", "--project", str(project)])
        assert result.exit_code == 0, f"stdout: {result.stdout}"
        assert "校验完成" in result.stdout or "校验通过" in result.stdout

    def test_validate_single_file(self, tmp_path):
        """单页文件校验。"""
        project = _write_valid_project(tmp_path)
        single = project / "pages" / "slide_01_cover.py"
        result = runner.invoke(app, ["validate", str(single)])
        assert result.exit_code == 0

    def test_validate_violation_exit_1(self, tmp_path):
        """lint 违规 → exit 1。"""
        project = _write_violation_project(tmp_path)
        result = runner.invoke(app, ["validate", "--project", str(project)])
        assert result.exit_code == 1
        assert "字体" in result.stdout or "font" in result.stdout.lower()

    def test_validate_strict_warning_fails(self, tmp_path):
        """--strict 下 warning 也导致 exit 1。"""
        # 构造只有 warning（hero 占比不合规）的 deck
        pages = tmp_path / "pages"
        pages.mkdir()
        # 10 页全 supporting → hero 占比 0%（warning）
        for i in range(10):
            (pages / f"slide_{i+1:02d}_p.py").write_text(
                "from slidep.dsl import Slide, Text\n"
                f"slide = Slide(page_type='content', children=[Text('x{i}', style={{'fontSize': 20}})])\n",
                encoding="utf-8",
            )
        result = runner.invoke(app, ["validate", "--project", str(tmp_path), "--strict"])
        assert result.exit_code == 1

    def test_validate_file_not_found(self, tmp_path):
        """不存在的文件 → exit 1。"""
        result = runner.invoke(app, ["validate", str(tmp_path / "nonexistent.py")])
        assert result.exit_code == 1


# ================================================================ 页面加载器
class TestLoader:
    def test_load_pages_sorted(self, tmp_path):
        """页面按 NN 升序加载。"""
        project = _write_valid_project(tmp_path)
        slides = load_pages(project)
        assert len(slides) == 5
        # cover 的标题应为「季度报告」
        assert slides[0].title == "季度报告"
        assert slides[4].title == "谢谢"

    def test_load_single_page(self, tmp_path):
        """单页加载。"""
        project = _write_valid_project(tmp_path)
        single = project / "pages" / "slide_01_cover.py"
        slides = load_single_page(single)
        assert len(slides) == 1
        assert slides[0].page_type == "cover"

    def test_load_pages_missing_dir(self, tmp_path):
        """pages/ 不存在 → SlidepUserError。"""
        from slidep import SlidepUserError

        with pytest.raises(SlidepUserError):
            load_pages(tmp_path)

    def test_load_single_page_not_found(self, tmp_path):
        """文件不存在 → SlidepUserError。"""
        from slidep import SlidepUserError

        with pytest.raises(SlidepUserError):
            load_single_page(tmp_path / "no.py")

    def test_load_syntax_error(self, tmp_path):
        """语法错 → SlidepUserError（含 lineno）。"""
        from slidep import SlidepUserError

        project = _write_syntax_error_project(tmp_path)
        with pytest.raises(SlidepUserError) as exc_info:
            load_pages(project)
        assert exc_info.value.lineno is not None

    def test_load_no_slide_attr(self, tmp_path):
        """无 slide 变量 → SlidepUserError。"""
        from slidep import SlidepUserError

        project = _write_no_slide_attr_project(tmp_path)
        with pytest.raises(SlidepUserError):
            load_pages(project)

    def test_slides_list_attr(self, tmp_path):
        """支持 slides: list[Slide] 多页文件。"""
        pages = tmp_path / "pages"
        pages.mkdir()
        (pages / "slide_01_multi.py").write_text(
            "from slidep.dsl import Slide, Text\n"
            "slides = [\n"
            "    Slide(page_type='cover', children=[Text('A', style={'fontSize': 20})]),\n"
            "    Slide(page_type='ending', children=[Text('B', style={'fontSize': 20})]),\n"
            "]\n",
            encoding="utf-8",
        )
        slides = load_pages(tmp_path)
        assert len(slides) == 2
        assert slides[0].page_type == "cover"
        assert slides[1].page_type == "ending"


# ================================================================ 退出码约定
class TestExitCodes:
    def test_exit_0_success(self, tmp_path):
        """成功构建 exit 0。"""
        project = _write_valid_project(tmp_path)
        result = runner.invoke(app, ["build", str(project)])
        assert result.exit_code == 0

    def test_exit_1_user_error(self, tmp_path):
        """用户错误（lint 违规）exit 1。"""
        project = _write_violation_project(tmp_path)
        result = runner.invoke(app, ["build", str(project)])
        assert result.exit_code == 1

    def test_exit_1_syntax_error(self, tmp_path):
        """用户错误（语法错）exit 1。"""
        project = _write_syntax_error_project(tmp_path)
        result = runner.invoke(app, ["build", str(project)])
        assert result.exit_code == 1
