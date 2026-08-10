"""素材解析器核验测试（T2.3）。

核验目标（对齐任务分解文档）：
1. 三格式适配器（docx/pdf/pptx）提取字数、标题层级、图片数
2. 风格特征：主色 hex、字号直方图、9 宫格预览
3. 统一管线 extract_material：格式检测 → 适配器 → 输出文件
4. 边界：不支持的格式、不存在文件、无图片、纯扫描 PDF 不崩溃
5. 输出文件结构：content.json / style_profile.json / images/
"""

from __future__ import annotations

import io
import json
import os
import tempfile
from pathlib import Path

import pytest
from PIL import Image as PILImage

from slidep import ErrorCode, SlidepUserError
from slidep.extract import (
    ExtractedDocument,
    StyleProfile,
    detect_format,
    extract_material,
)
from slidep.extract.docx_adapter import extract_docx
from slidep.extract.pdf_adapter import extract_pdf
from slidep.extract.pptx_adapter import extract_pptx
from slidep.extract.style_profile import (
    build_style_profile,
    extract_dominant_colors,
    extract_font_families,
    extract_font_histogram,
    generate_9grid_preview,
)


# ================================================================ 测试夹具
@pytest.fixture
def tmp_workspace(tmp_path: Path) -> Path:
    """临时工作区：包含 extracted/ 子目录。"""
    out = tmp_path / "extracted"
    out.mkdir(exist_ok=True)
    return out


@pytest.fixture
def sample_docx(tmp_path: Path) -> Path:
    """生成含标题/段落/图片的测试 DOCX。"""
    import docx
    from docx.shared import Inches, Pt

    path = tmp_path / "sample.docx"
    doc = docx.Document()

    # 标题
    h = doc.add_heading("季度业务汇报", level=1)

    # 正文段落
    p = doc.add_paragraph("营收 120 亿，同比增长 34%。")
    p.runs[0].font.size = Pt(12)

    doc.add_heading("详细分析", level=2)
    doc.add_paragraph("第一部分内容。")
    doc.add_paragraph("第二部分内容。")

    # 列表项
    doc.add_paragraph("要点一", style="List Bullet")

    # 嵌入图片：用 PIL 生成纯色 PNG
    img_path = tmp_path / "embed.png"
    img = PILImage.new("RGB", (100, 80), color=(255, 0, 0))
    img.save(img_path)
    doc.add_picture(str(img_path), width=Inches(2))

    doc.save(str(path))
    return path


@pytest.fixture
def sample_pdf(tmp_path: Path) -> Path:
    """生成含标题/正文/图片的测试 PDF。"""
    import fitz

    path = tmp_path / "sample.pdf"
    doc = fitz.open()  # 新建空文档

    page = doc.new_page(width=595, height=842)  # A4

    # 插入文本：大字号标题 + 小字号正文
    page.insert_text((72, 80), "项目报告", fontsize=24, fontname="helv")
    page.insert_text((72, 120), "这是正文内容，描述项目进展。", fontsize=12, fontname="helv")
    page.insert_text((72, 140), "第二段正文内容。", fontsize=12, fontname="helv")

    # 插入图片：红色矩形
    img_path = tmp_path / "pdf_img.png"
    img = PILImage.new("RGB", (80, 60), color=(0, 0, 255))
    img.save(img_path)
    rect = fitz.Rect(72, 160, 152, 220)
    page.insert_image(rect, filename=str(img_path))

    doc.save(str(path))
    doc.close()
    return path


@pytest.fixture
def sample_pptx(tmp_path: Path) -> Path:
    """生成含标题/正文/图片的测试 PPTX。"""
    from pptx import Presentation
    from pptx.util import Inches, Pt, Emu

    path = tmp_path / "sample.pptx"
    prs = Presentation()
    prs.slide_width = Emu(12192000)  # 16:9
    prs.slide_height = Emu(6858000)

    slide_layout = prs.slide_layouts[5]  # blank

    # 第 1 页：标题 + 正文
    slide = prs.slides.add_slide(slide_layout)
    title = slide.shapes.add_textbox(Inches(1), Inches(0.5), Inches(8), Inches(1))
    title.text_frame.text = "封面标题"
    title.text_frame.paragraphs[0].runs[0].font.size = Pt(44)

    body = slide.shapes.add_textbox(Inches(1), Inches(2), Inches(8), Inches(2))
    body.text_frame.text = "这是正文内容"
    body.text_frame.paragraphs[0].runs[0].font.size = Pt(18)

    # 图片
    img_path = tmp_path / "pptx_img.png"
    img = PILImage.new("RGB", (200, 150), color=(0, 255, 0))
    img.save(img_path)
    slide.shapes.add_picture(str(img_path), Inches(1), Inches(4), Inches(2), Inches(1.5))

    # 第 2 页：纯文本
    slide2 = prs.slides.add_slide(slide_layout)
    t2 = slide2.shapes.add_textbox(Inches(1), Inches(1), Inches(8), Inches(1))
    t2.text_frame.text = "第二页标题"
    t2.text_frame.paragraphs[0].runs[0].font.size = Pt(32)

    prs.save(str(path))
    return path


# ================================================================ 格式检测
class TestDetectFormat:
    def test_detect_docx(self, sample_docx: Path):
        assert detect_format(str(sample_docx)) == "docx"

    def test_detect_pdf(self, sample_pdf: Path):
        assert detect_format(str(sample_pdf)) == "pdf"

    def test_detect_pptx(self, sample_pptx: Path):
        assert detect_format(str(sample_pptx)) == "pptx"

    def test_unsupported_format(self, tmp_path: Path):
        f = tmp_path / "x.txt"
        f.write_text("hello")
        with pytest.raises(SlidepUserError) as ei:
            detect_format(str(f))
        assert ei.value.code is ErrorCode.IO_FORMAT_UNSUPPORTED

    def test_file_not_found(self):
        with pytest.raises(SlidepUserError) as ei:
            detect_format("/nonexistent/file.docx")
        assert ei.value.code is ErrorCode.IO_FILE_NOT_FOUND

    def test_case_insensitive_ext(self, tmp_path: Path):
        f = tmp_path / "test.PDF"
        f.write_text("dummy")
        assert detect_format(str(f)) == "pdf"


# ================================================================ DOCX 适配器
class TestDocxAdapter:
    def test_extract_blocks(self, sample_docx: Path):
        doc = extract_docx(str(sample_docx))
        assert doc.source_format == "docx"
        assert doc.word_count > 0
        assert doc.heading_count >= 2  # H1 + H2
        assert doc.paragraph_count >= 2

    def test_heading_levels(self, sample_docx: Path):
        doc = extract_docx(str(sample_docx))
        headings = [b for b in doc.blocks if b.type == "heading"]
        levels = {b.level for b in headings}
        assert 1 in levels  # H1

    def test_extract_images(self, sample_docx: Path, tmp_path: Path):
        img_dir = tmp_path / "imgs"
        doc = extract_docx(str(sample_docx), str(img_dir))
        assert len(doc.images) >= 1
        # 图片落盘
        saved = list(img_dir.glob("*.png"))
        assert len(saved) >= 1
        # ImageRef 有宽高
        for img in doc.images:
            assert img.width > 0
            assert img.height > 0
            assert img.format

    def test_no_image_dir(self, sample_docx: Path):
        """不传 image_dir 时不落盘但结构完整。"""
        doc = extract_docx(str(sample_docx), "")
        assert len(doc.blocks) > 0
        # 不落盘但结构合法
        assert isinstance(doc, ExtractedDocument)

    def test_metadata(self, sample_docx: Path):
        doc = extract_docx(str(sample_docx))
        assert "paragraph_count" in doc.metadata

    def test_file_not_found(self):
        with pytest.raises(SlidepUserError) as ei:
            extract_docx("/nonexistent.docx")
        assert ei.value.code is ErrorCode.IO_FILE_NOT_FOUND

    def test_empty_docx(self, tmp_path: Path):
        """空 DOCX 不崩溃。"""
        import docx
        path = tmp_path / "empty.docx"
        docx.Document().save(str(path))
        doc = extract_docx(str(path))
        assert len(doc.blocks) == 0
        assert doc.word_count == 0


# ================================================================ PDF 适配器
class TestPdfAdapter:
    def test_extract_blocks(self, sample_pdf: Path):
        doc = extract_pdf(str(sample_pdf))
        assert doc.source_format == "pdf"
        assert doc.word_count > 0
        # PDF 有标题（大字号）和正文（小字号）
        assert doc.heading_count >= 1
        assert doc.paragraph_count >= 1

    def test_page_count(self, sample_pdf: Path):
        doc = extract_pdf(str(sample_pdf))
        assert doc.metadata.get("page_count") == 1

    def test_extract_images(self, sample_pdf: Path, tmp_path: Path):
        img_dir = tmp_path / "pdf_imgs"
        doc = extract_pdf(str(sample_pdf), str(img_dir))
        assert len(doc.images) >= 1
        saved = list(img_dir.glob("*.png"))
        assert len(saved) >= 1

    def test_no_image_dir(self, sample_pdf: Path):
        doc = extract_pdf(str(sample_pdf), "")
        assert len(doc.blocks) > 0

    def test_file_not_found(self):
        with pytest.raises(SlidepUserError) as ei:
            extract_pdf("/nonexistent.pdf")
        assert ei.value.code is ErrorCode.IO_FILE_NOT_FOUND

    def test_scanned_pdf_no_text(self, tmp_path: Path):
        """纯图片 PDF（无文本层）不崩溃，blocks 可能为空。"""
        import fitz
        path = tmp_path / "scanned.pdf"
        doc = fitz.open()
        page = doc.new_page(width=200, height=200)
        # 只插入图片，无文本
        img_path = tmp_path / "scan.png"
        PILImage.new("RGB", (100, 100), color=(128, 128, 128)).save(str(img_path))
        page.insert_image(fitz.Rect(0, 0, 200, 200), filename=str(img_path))
        doc.save(str(path))
        doc.close()

        extracted = extract_pdf(str(path))
        assert isinstance(extracted, ExtractedDocument)
        # 无文本但不应崩溃
        assert extracted.source_format == "pdf"

    def test_heading_inference(self, sample_pdf: Path):
        """PDF 标题级别推断：大字号应被标为 heading。"""
        doc = extract_pdf(str(sample_pdf))
        headings = [b for b in doc.blocks if b.type == "heading"]
        if headings:
            # 标题的字号应比正文大
            body_sizes = [b.font_size for b in doc.blocks if b.type == "paragraph" and b.font_size]
            heading_sizes = [b.font_size for b in headings if b.font_size]
            if body_sizes and heading_sizes:
                assert max(heading_sizes) > max(body_sizes)


# ================================================================ PPTX 适配器
class TestPptxAdapter:
    def test_extract_blocks(self, sample_pptx: Path):
        doc = extract_pptx(str(sample_pptx))
        assert doc.source_format == "pptx"
        assert doc.word_count > 0
        assert doc.heading_count >= 1
        assert doc.paragraph_count >= 1

    def test_slide_count(self, sample_pptx: Path):
        doc = extract_pptx(str(sample_pptx))
        assert doc.metadata.get("slide_count") == 2

    def test_slide_dimensions(self, sample_pptx: Path):
        doc = extract_pptx(str(sample_pptx))
        assert doc.metadata.get("slide_width") == 1280  # 12192000 EMU / 9525
        assert doc.metadata.get("slide_height") == 720

    def test_extract_images(self, sample_pptx: Path, tmp_path: Path):
        img_dir = tmp_path / "pptx_imgs"
        doc = extract_pptx(str(sample_pptx), str(img_dir))
        assert len(doc.images) >= 1
        saved = list(img_dir.glob("*.png"))
        assert len(saved) >= 1
        for img in doc.images:
            assert img.width > 0
            assert img.height > 0

    def test_no_image_dir(self, sample_pptx: Path):
        doc = extract_pptx(str(sample_pptx), "")
        assert len(doc.blocks) > 0

    def test_page_index(self, sample_pptx: Path):
        """blocks 的 page 字段对应幻灯片索引。"""
        doc = extract_pptx(str(sample_pptx))
        pages = {b.page for b in doc.blocks}
        assert 0 in pages  # 第一页
        assert 1 in pages  # 第二页

    def test_file_not_found(self):
        with pytest.raises(SlidepUserError) as ei:
            extract_pptx("/nonexistent.pptx")
        assert ei.value.code is ErrorCode.IO_FILE_NOT_FOUND

    def test_empty_pptx(self, tmp_path: Path):
        """空 PPTX（无幻灯片内容）不崩溃。"""
        from pptx import Presentation
        path = tmp_path / "empty.pptx"
        prs = Presentation()
        prs.save(str(path))
        doc = extract_pptx(str(path))
        assert doc.metadata.get("slide_count") == 0


# ================================================================ 风格特征
class TestStyleProfile:
    def test_dominant_colors(self, tmp_path: Path):
        """从纯色图片提取主色。"""
        # 纯红色图片
        img_path = tmp_path / "red.png"
        PILImage.new("RGB", (100, 100), color=(255, 0, 0)).save(str(img_path))
        from slidep.extract.models import ImageRef
        images = [ImageRef(path="red.png", width=100, height=100, format="png")]
        colors, ratios = extract_dominant_colors(images, base_dir=str(tmp_path))
        assert len(colors) > 0
        # 主色应接近 #FF0000
        assert "#FF0000" in colors

    def test_dominant_colors_empty(self):
        """无图片时返回空。"""
        colors, ratios = extract_dominant_colors([])
        assert colors == []
        assert ratios == []

    def test_font_histogram(self, sample_pptx: Path):
        doc = extract_pptx(str(sample_pptx))
        hist = extract_font_histogram(doc)
        assert isinstance(hist, dict)
        # PPTX 中有 44pt 和 18pt 字号
        if hist:
            sizes = [int(k) for k in hist.keys()]
            assert max(sizes) >= 18

    def test_font_families(self, sample_pptx: Path):
        doc = extract_pptx(str(sample_pptx))
        families = extract_font_families(doc)
        assert isinstance(families, list)

    def test_build_style_profile(self, sample_pptx: Path, tmp_path: Path):
        doc = extract_pptx(str(sample_pptx), str(tmp_path / "imgs"))
        preview = str(tmp_path / "preview.png")
        profile = build_style_profile(
            doc,
            image_base_dir=str(tmp_path / "imgs"),
            pptx_path=str(sample_pptx),
            preview_output=preview,
        )
        assert isinstance(profile, StyleProfile)
        assert profile.source_format == "pptx"
        assert profile.page_count == 2
        assert isinstance(profile.dominant_colors, list)
        assert isinstance(profile.font_size_histogram, dict)
        assert isinstance(profile.font_families, list)

    def test_9grid_preview(self, sample_pptx: Path, tmp_path: Path):
        """9 宫格预览图正确生成。"""
        out = str(tmp_path / "grid.png")
        result = generate_9grid_preview(str(sample_pptx), out)
        assert result is not None
        assert os.path.isfile(out)
        # 验证是合法 PNG
        with PILImage.open(out) as img:
            assert img.format == "PNG"
            assert img.width > 0 and img.height > 0

    def test_9grid_preview_empty_pptx(self, tmp_path: Path):
        """空 PPTX 生成预览返回 None。"""
        from pptx import Presentation
        path = tmp_path / "empty.pptx"
        Presentation().save(str(path))
        out = str(tmp_path / "grid_empty.png")
        result = generate_9grid_preview(str(path), out)
        assert result is None

    def test_style_profile_serialization(self, sample_docx: Path):
        doc = extract_docx(str(sample_docx))
        profile = build_style_profile(doc)
        d = profile.to_dict()
        assert "dominant_colors" in d
        assert "font_size_histogram" in d
        assert "font_families" in d
        assert "page_count" in d
        # 可 JSON 序列化
        json.dumps(d, ensure_ascii=False)


# ================================================================ 统一管线
class TestPipeline:
    def test_extract_docx_pipeline(self, sample_docx: Path, tmp_workspace: Path):
        doc, profile = extract_material(str(sample_docx), str(tmp_workspace))
        assert isinstance(doc, ExtractedDocument)
        assert doc.source_format == "docx"
        assert profile is not None
        # 输出文件存在
        assert (tmp_workspace / "content.json").is_file()
        assert (tmp_workspace / "style_profile.json").is_file()

    def test_extract_pdf_pipeline(self, sample_pdf: Path, tmp_workspace: Path):
        doc, profile = extract_material(str(sample_pdf), str(tmp_workspace))
        assert isinstance(doc, ExtractedDocument)
        assert doc.source_format == "pdf"
        assert profile is not None

    def test_extract_pptx_pipeline(self, sample_pptx: Path, tmp_workspace: Path):
        doc, profile = extract_material(str(sample_pptx), str(tmp_workspace))
        assert isinstance(doc, ExtractedDocument)
        assert doc.source_format == "pptx"
        assert profile is not None
        # pptx 源应生成 9 宫格预览
        assert (tmp_workspace / "preview_grid.png").is_file()

    def test_no_output_dir(self, sample_docx: Path):
        """无 output_dir 时只返回内存对象。"""
        doc, profile = extract_material(str(sample_docx), "")
        assert isinstance(doc, ExtractedDocument)
        assert profile is not None

    def test_no_style(self, sample_docx: Path, tmp_workspace: Path):
        doc, profile = extract_material(
            str(sample_docx), str(tmp_workspace), build_style=False
        )
        assert isinstance(doc, ExtractedDocument)
        assert profile is None
        assert (tmp_workspace / "content.json").is_file()
        assert not (tmp_workspace / "style_profile.json").is_file()

    def test_no_images(self, sample_docx: Path, tmp_workspace: Path):
        doc, profile = extract_material(
            str(sample_docx), str(tmp_workspace), extract_images=False
        )
        assert isinstance(doc, ExtractedDocument)
        # 图片不落盘
        assert not (tmp_workspace / "images").exists() or not list((tmp_workspace / "images").glob("*"))

    def test_content_json_structure(self, sample_pptx: Path, tmp_workspace: Path):
        extract_material(str(sample_pptx), str(tmp_workspace))
        with open(tmp_workspace / "content.json", encoding="utf-8") as f:
            data = json.load(f)
        assert data["source_format"] == "pptx"
        assert "blocks" in data
        assert "images" in data
        assert "word_count" in data
        assert "heading_count" in data
        assert data["word_count"] > 0

    def test_style_profile_json_structure(self, sample_pptx: Path, tmp_workspace: Path):
        extract_material(str(sample_pptx), str(tmp_workspace))
        with open(tmp_workspace / "style_profile.json", encoding="utf-8") as f:
            data = json.load(f)
        assert data["source_format"] == "pptx"
        assert "dominant_colors" in data
        assert "font_size_histogram" in data
        assert "page_count" in data

    def test_unsupported_format(self, tmp_path: Path):
        f = tmp_path / "x.csv"
        f.write_text("a,b,c")
        with pytest.raises(SlidepUserError) as ei:
            extract_material(str(f))
        assert ei.value.code is ErrorCode.IO_FORMAT_UNSUPPORTED

    def test_file_not_found(self):
        with pytest.raises(SlidepUserError) as ei:
            extract_material("/nonexistent.docx")
        assert ei.value.code is ErrorCode.IO_FILE_NOT_FOUND

    def test_image_dir_created(self, sample_docx: Path, tmp_workspace: Path):
        """output_dir 不存在时自动创建。"""
        out = tmp_workspace / "sub" / "dir"
        extract_material(str(sample_docx), str(out))
        assert (out / "content.json").is_file()


# ================================================================ 序列化
class TestSerialization:
    def test_extracted_document_to_dict(self, sample_docx: Path):
        doc = extract_docx(str(sample_docx))
        d = doc.to_dict()
        assert d["source_format"] == "docx"
        assert d["word_count"] == doc.word_count
        assert d["heading_count"] == doc.heading_count
        assert len(d["blocks"]) == len(doc.blocks)
        assert len(d["images"]) == len(doc.images)

    def test_style_profile_to_dict(self, sample_pptx: Path):
        doc = extract_pptx(str(sample_pptx))
        profile = build_style_profile(doc)
        d = profile.to_dict()
        assert d["source_format"] == "pptx"
        assert isinstance(d["dominant_colors"], list)
        assert isinstance(d["font_size_histogram"], dict)

    def test_json_roundtrip(self, sample_docx: Path):
        doc = extract_docx(str(sample_docx))
        d = doc.to_dict()
        # 可序列化
        s = json.dumps(d, ensure_ascii=False)
        restored = json.loads(s)
        assert restored["source_format"] == d["source_format"]
        assert restored["word_count"] == d["word_count"]
