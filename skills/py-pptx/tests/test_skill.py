"""Skill 包装配与 AI 集成测试（T5.2）。

核验目标（对齐任务分解文档）：
1. Skill 包目录结构完整：SKILL.md + references/ + scripts/slidep/
2. SKILL.md 包含必需章节（任务路由/需求澄清/工作流/目录规范/页面命名/CLI/术语）
3. 方法论文档完整（create-from-scratch / create-from-material + 全部 component-*）
4. 面向用户术语约束（SKILL.md 中不暴露内部实现术语）
5. 页面命名规范（slide_{NN}_{描述}.py）+ CLI 唯一编译入口
6. 安装说明（pip install . 联网安装）
7. 端到端演练：5 页合规 deck → validate 通过 → build 产出 .pptx
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

import pytest

# Skill 包根目录 = py-pptx/
SKILL_ROOT = Path(__file__).resolve().parent.parent
REFERENCES_DIR = SKILL_ROOT / "references"
SCRIPTS_DIR = SKILL_ROOT / "scripts"


# ================================================================ Skill 包结构

class TestSkillPackageStructure:
    """Skill 包目录结构完整性。"""

    def test_skill_md_exists(self):
        """SKILL.md 存在。"""
        assert (SKILL_ROOT / "SKILL.md").exists(), "SKILL.md 不存在"

    def test_references_dir_exists(self):
        """references/ 目录存在。"""
        assert REFERENCES_DIR.is_dir(), "references/ 目录不存在"

    def test_scripts_dir_exists(self):
        """scripts/slidep/ 目录存在。"""
        assert (SCRIPTS_DIR / "slidep").is_dir(), "scripts/slidep/ 不存在"

    def test_pyproject_exists(self):
        """pyproject.toml 存在。"""
        assert (SKILL_ROOT / "pyproject.toml").exists()

    def test_rules_json_exists(self):
        """rules.json 存在且可加载。"""
        rules_path = SCRIPTS_DIR / "slidep" / "validate" / "rules.json"
        assert rules_path.exists()
        with open(rules_path, encoding="utf-8") as f:
            data = json.load(f)
        assert "rules" in data
        assert len(data["rules"]) >= 20


# ================================================================ SKILL.md 内容

class TestSkillMdContent:
    """SKILL.md 包含必需章节。"""

    @pytest.fixture(scope="class")
    @classmethod
    def skill_content(cls):
        return (SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8")

    def test_has_task_routing(self, skill_content):
        """包含任务路由（从零创建/基于素材创建）。"""
        assert "从零创建" in skill_content
        assert "基于素材创建" in skill_content

    def test_has_requirements_clarification(self, skill_content):
        """包含需求澄清规则。"""
        assert "需求澄清" in skill_content
        assert "听众" in skill_content
        assert "多少页" in skill_content

    def test_has_workflow(self, skill_content):
        """包含完整工作流。"""
        assert "意图对齐" in skill_content
        assert "内容规划" in skill_content
        assert "页面生成" in skill_content
        assert "编译" in skill_content
        assert "预览" in skill_content

    def test_has_directory_structure(self, skill_content):
        """包含目录结构说明。"""
        assert "STORY.md" in skill_content
        assert "DESIGN.md" in skill_content
        assert "pages/" in skill_content
        assert "dist/" in skill_content

    def test_has_page_naming(self, skill_content):
        """包含页面命名约束。"""
        assert "slide_{NN}" in skill_content or "slide_{NN}_{描述}" in skill_content
        assert "零填充" in skill_content

    def test_has_cli_commands(self, skill_content):
        """包含 CLI 命令说明。"""
        assert "slidep build" in skill_content
        assert "slidep validate" in skill_content
        assert "slidep serve" in skill_content
        assert "slidep version" in skill_content

    def test_has_terminology_constraint(self, skill_content):
        """包含术语约束（禁止暴露内部术语）。"""
        assert "术语" in skill_content or "禁止" in skill_content

    def test_has_install_instruction(self, skill_content):
        """包含安装说明（pip 联网安装）。"""
        assert "pip install" in skill_content

    def test_references_documents(self, skill_content):
        """SKILL.md 引用的文档都存在。"""
        # 提取 references/xxx.md 引用
        refs = re.findall(r"references/([a-z\-]+\.md)", skill_content)
        for ref in refs:
            assert (REFERENCES_DIR / ref).exists(), f"SKILL.md 引用的 references/{ref} 不存在"


# ================================================================ 方法论文档

class TestReferenceDocs:
    """方法论文档完整性。"""

    REQUIRED_REFS = [
        "story-principle.md",
        "design-principle.md",
        "create-from-scratch.md",
        "create-from-material.md",
        "component-slide.md",
        "component-text.md",
        "component-box.md",
        "component-chart.md",
        "component-image.md",
        "component-table.md",
        "component-faicon.md",
        "component-svg.md",
        "component-qrcode.md",
        "component-codeblock.md",
        "component-math.md",
    ]

    def test_all_references_exist(self):
        """全部必需方法论文档存在。"""
        for ref in self.REQUIRED_REFS:
            path = REFERENCES_DIR / ref
            assert path.exists(), f"缺失方法论文档: {ref}"

    def test_create_from_scratch_content(self):
        """create-from-scratch.md 包含工作流步骤。"""
        content = (REFERENCES_DIR / "create-from-scratch.md").read_text(encoding="utf-8")
        assert "需求澄清" in content
        assert "风格路由" in content
        assert "内容规划" in content
        assert "逐页生成" in content
        assert "校验" in content

    def test_create_from_material_content(self):
        """create-from-material.md 包含素材解析与风格参照。"""
        content = (REFERENCES_DIR / "create-from-material.md").read_text(encoding="utf-8")
        assert "素材解析" in content
        assert "风格" in content
        assert "style_profile" in content
        assert "内容复用" in content

    COMPONENT_CLASS = {
        "component-slide.md": "Slide",
        "component-text.md": "Text",
        "component-box.md": "Box",
        "component-chart.md": "Chart",
        "component-image.md": "Image",
        "component-table.md": "Table",
        "component-faicon.md": "FAIcon",
        "component-svg.md": "SVG",
        "component-qrcode.md": "QRCode",
        "component-codeblock.md": "CodeBlock",
        "component-math.md": "Math",
    }

    def test_component_refs_have_usage(self):
        """组件规范文档包含对应组件的用法示例。"""
        for ref, cls in self.COMPONENT_CLASS.items():
            content = (REFERENCES_DIR / ref).read_text(encoding="utf-8")
            assert cls in content, f"{ref} 缺少 {cls} 用法示例"


# ================================================================ 术语约束

class TestTerminology:
    """面向用户术语约束：SKILL.md 主体不暴露内部实现术语。"""

    def test_no_jargon_in_skill_md_body(self):
        """SKILL.md 主体（§1-§7, §9-§10）不出现内部术语。

        §8 术语约束表中列举这些词是允许的（用于声明禁止）。
        """
        content = (SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8")
        lines = content.split("\n")

        # 找到 §8 的行范围
        start_8 = None
        end_8 = None
        for i, line in enumerate(lines):
            if line.strip().startswith("## 8."):
                start_8 = i
            elif start_8 is not None and line.strip().startswith("## 9."):
                end_8 = i
                break

        # §8 之外的行
        if start_8 is not None and end_8 is not None:
            before = "\n".join(lines[:start_8])
            after = "\n".join(lines[end_8:])
            body = before + "\n" + after
        else:
            body = content

        # 这些术语在主体中不应出现（§8 表格中除外）
        forbidden = ["AST", "EMU", "lxml", "pydantic", "序列化"]
        for term in forbidden:
            assert term not in body, f"SKILL.md 主体中出现内部术语: {term}"


# ================================================================ 页面命名规范

class TestPageNamingConvention:
    """页面文件命名规范：slide_{NN}_{描述}.py。"""

    def test_valid_naming_sort_key(self):
        """合规命名正确解析页码用于排序。"""
        from slidep.cli.loader import _sort_key
        from pathlib import Path

        # slide_01_cover.py → sort_key (1, ...)
        assert _sort_key(Path("slide_01_cover.py"))[0] == 1
        assert _sort_key(Path("slide_02_toc.py"))[0] == 2
        assert _sort_key(Path("slide_10_ending.py"))[0] == 10

    def test_naming_pattern_matches(self):
        """slide_NN_ 前缀的文件名被正确识别。"""
        from slidep.cli.loader import _PAGE_RE

        assert _PAGE_RE.match("slide_01_cover.py") is not None
        assert _PAGE_RE.match("slide_02_toc.py") is not None
        assert _PAGE_RE.match("slide_10_ending.py") is not None
        # 无 slide_ 前缀不匹配
        assert _PAGE_RE.match("cover.py") is None
        assert _PAGE_RE.match("page_01.py") is None

    def test_naming_sorted(self, tmp_path):
        """页面按 NN 升序加载。"""
        pages_dir = tmp_path / "pages"
        pages_dir.mkdir()

        # 创建 3 页（乱序写入）
        for idx, desc in [(3, "ending"), (1, "cover"), (2, "content")]:
            (pages_dir / f"slide_{idx:02d}_{desc}.py").write_text(
                textwrap.dedent(f"""
                from slidep.dsl import Slide, Text
                slide = Slide(page_type="content", role="supporting", rhythm="valley",
                              title="{desc}", children=[Text("{desc}", style={{"fontSize": 56, "color": "#1E293B"}})])
                """),
                encoding="utf-8",
            )

        from slidep.cli.loader import load_pages
        slides = load_pages(str(tmp_path))
        assert len(slides) == 3
        # 验证按页码排序
        assert slides[0].title == "cover"
        assert slides[1].title == "content"
        assert slides[2].title == "ending"


# ================================================================ 端到端演练

class TestEndToEndWorkflow:
    """端到端演练：从页面文件到 .pptx 全流程。"""

    def _make_project(self, tmp_path: Path) -> Path:
        """创建一个 10 页合规项目（通过 lint 门禁）。"""
        project = tmp_path / "e2e_project"
        project.mkdir()
        pages_dir = project / "pages"
        pages_dir.mkdir()

        long_text = (
            "本季度核心业务实现了稳健增长各项关键指标均达到预期目标。"
            "产品矩阵持续完善用户活跃度显著提升客户满意度保持在高位。"
            "技术团队完成了多项关键架构升级系统稳定性和性能大幅提升。"
            "市场拓展方面新增合作客户超过五十家品牌影响力持续扩大。"
            "运营效率方面通过流程优化和自动化工具引入人效提升显著。"
            "团队建设方面引进了多位行业专家组织能力进一步增强。"
            "财务表现方面营收和利润均超额完成季度目标。"
            "下半年将继续聚焦核心业务加大创新投入深化客户关系。"
        )

        # 10 页 deck：cover + toc + section + 4 content + section + 1 hero content + ending
        # hero 页 = cover + hero content + ending = 3/10 = 30%（符合 20-30%）
        # 非对称 = 4 content + 1 hero content = 5/10 = 50%（>= 40%）
        pages = [
            (1, "cover", "cover", "hero", "peak", "#0F172A",
             "季度业务汇报", "2026 Q2", "#FFFFFF", None),
            (2, "toc", "toc", "transition", "transition", None,
             "目录", None, None, None),
            (3, "section", "section_q2", "transition", "transition", None,
             "Q2 概览", None, None, None),
            (4, "content", "revenue", "supporting", "valley", None,
             "营收增长", "营收 120 亿", "#0F172A", long_text),
            (5, "content", "product", "supporting", "valley", None,
             "产品进展", "核心产品线", "#0F172A", long_text),
            (6, "content", "customers", "supporting", "valley", None,
             "客户案例", "新增客户 50+", "#0F172A", long_text),
            (7, "content", "ops", "supporting", "valley", None,
             "运营效率", "人效提升 20%", "#0F172A", long_text),
            (8, "section", "section_h2", "transition", "transition", None,
             "下半年规划", None, None, None),
            (9, "content", "strategy", "hero", "peak", None,
             "战略目标", "增长 50%", "#0F172A", long_text),
            (10, "ending", "ending", "hero", "peak", "#0F172A",
             "谢谢", "感谢聆听", "#FFFFFF", None),
        ]

        for idx, ptype, desc, role, rhythm, bg, title, anchor_text, anchor_color, body_text in pages:
            children_parts = []
            if anchor_text:
                children_parts.append(
                    f'Text("{anchor_text}", style={{"fontSize": 56, "color": "{anchor_color}"}})'
                )
            if body_text:
                children_parts.append(
                    f'Text("{body_text}", style={{"fontSize": 18, "color": "#1E293B"}})'
                )

            if children_parts:
                children_code = f"children=[{', '.join(children_parts)}],"
            else:
                children_code = ""

            bg_code = f'background="{bg}",' if bg else ""

            # content 页用 justifyContent: flex-start（非对称）
            if ptype == "content":
                style_code = 'style={"justifyContent": "flex-start"},'
            else:
                style_code = ""

            code = textwrap.dedent(f"""
                from slidep.dsl import Slide, Text

                slide = Slide(
                    page_type="{ptype}",
                    role="{role}",
                    rhythm="{rhythm}",
                    title="{title}",
                    {bg_code}
                    {style_code}
                    {children_code}
                )
            """).strip()

            # 清理空行
            code = re.sub(r'\n\s*\n', '\n', code)

            (pages_dir / f"slide_{idx:02d}_{desc}.py").write_text(code, encoding="utf-8")

        return project

    def test_validate_passes(self, tmp_path):
        """10 页合规 deck 通过 validate（0 error）。"""
        from slidep.cli.loader import load_pages
        from slidep.validate import validate_deck

        project = self._make_project(tmp_path)
        slides = load_pages(str(project))
        assert len(slides) == 10

        report = validate_deck(slides)
        assert report.error_count == 0, (
            f"validate 有 error: "
            f"{[i.to_dict() for i in report.issues if i.level == 'error']}"
        )

    def test_build_produces_pptx(self, tmp_path):
        """10 页合规 deck build 产出 .pptx 文件。"""
        from slidep.cli.loader import load_pages
        from slidep.render import render_deck, RenderOptions

        project = self._make_project(tmp_path)
        slides = load_pages(str(project))

        output = project / "dist" / "e2e_project.pptx"
        output.parent.mkdir(parents=True, exist_ok=True)

        render_deck(slides, str(output), options=RenderOptions(project_name="e2e_project"))
        assert output.exists(), "build 未产出 .pptx"
        assert output.stat().st_size > 0, ".pptx 文件为空"

    def test_build_via_cli(self, tmp_path):
        """通过 CLI 命令 build 产出 .pptx。"""
        project = self._make_project(tmp_path)

        env = {**os.environ, "PYTHONPATH": str(SCRIPTS_DIR)}
        result = subprocess.run(
            [sys.executable, "-c",
             "import sys; sys.path.insert(0, r'" + str(SCRIPTS_DIR) + "'); "
             "from slidep.cli.main import app; app(['build', r'" + str(project) + "'])"],
            capture_output=True, text=True, timeout=60,
            cwd=str(SKILL_ROOT),
            env=env,
        )
        assert result.returncode == 0, f"slidep build 失败:\n{result.stderr}\n{result.stdout}"
        assert "构建成功" in result.stdout

        pptx_path = project / "dist" / "e2e_project.pptx"
        assert pptx_path.exists(), ".pptx 未生成"

    def test_validate_via_cli(self, tmp_path):
        """通过 CLI 命令 validate 通过。"""
        project = self._make_project(tmp_path)

        env = {**os.environ, "PYTHONPATH": str(SCRIPTS_DIR)}
        result = subprocess.run(
            [sys.executable, "-c",
             "import sys; sys.path.insert(0, r'" + str(SCRIPTS_DIR) + "'); "
             "from slidep.cli.main import app; app(['validate', '--project', r'" + str(project) + "'])"],
            capture_output=True, text=True, timeout=60,
            cwd=str(SKILL_ROOT),
            env=env,
        )
        assert result.returncode == 0, f"slidep validate 失败:\n{result.stderr}\n{result.stdout}"


# ================================================================ CLI 唯一入口

class TestCLISoloEntry:
    """CLI 作为唯一编译入口。"""

    def _run_cli(self, args: list[str]) -> subprocess.CompletedProcess:
        """运行 slidep CLI（避免 -m 模块的 sys.modules 警告）。"""
        env = {**os.environ, "PYTHONPATH": str(SCRIPTS_DIR)}
        return subprocess.run(
            [sys.executable, "-c",
             "import sys; sys.path.insert(0, r'" + str(SCRIPTS_DIR) + "'); "
             "from slidep.cli.main import app; app(" + repr(args) + ")"],
            capture_output=True, text=True, timeout=30,
            cwd=str(SKILL_ROOT),
            env=env,
        )

    def test_cli_has_build_command(self):
        """CLI 有 build 命令。"""
        result = self._run_cli(["build", "--help"])
        assert result.returncode == 0
        assert "build" in result.stdout.lower()

    def test_cli_has_validate_command(self):
        """CLI 有 validate 命令。"""
        result = self._run_cli(["validate", "--help"])
        assert result.returncode == 0

    def test_cli_version(self):
        """CLI version 命令输出版本号。"""
        result = self._run_cli(["version"])
        assert result.returncode == 0
        assert "slidep" in result.stdout

    def test_cli_exit_codes(self):
        """CLI 退出码约定：0 成功 / 1 用户错误 / 2 系统错误。"""
        # 0: version 成功
        result = self._run_cli(["version"])
        assert result.returncode == 0

        # 1: validate 不存在的目录（用户错误）
        result = self._run_cli(["validate", "--project", "/nonexistent/path"])
        assert result.returncode in (1, 2)
