"""页面母版：标题区 / 页脚 / 页类型模板（T1.3）。

三区母版（对齐 references/component-slide.md）：
- A 区（顶部 0-120px）：标题块
- B 区（48,120,1184,540）：内容区（布局引擎的 SLIDE_CONTENT_RECT）
- 页脚区（660-720px）：项目名 + 页码 NN/TOTAL，引擎自动生成

页类型模板：
- cover：标题居中 hero（56px），无页脚
- section：全幅色块 + 章节标题居中偏左，无页脚
- toc / content / ending：标题左上（32px），content/toc 显示页脚，ending 无页脚
"""

from __future__ import annotations

from typing import Optional

from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN
from pptx.util import Pt

from slidep.dsl.components import Slide
from slidep.render.advanced import remove_shadow
from slidep.render.units import emu, pt

TITLE_TOP_PX = 44.0  #: 左上标题区 y
TITLE_LEFT_PX = 48.0  #: 左上标题区 x（与 B 区左对齐）
TITLE_HEIGHT_PX = 64.0  #: 标题区高度
FOOTER_Y_PX = 682.0  #: 页脚基线 y
FOOTER_HEIGHT_PX = 26.0  #: 页脚高度
FOOTER_FONT_PT = 9.0
FOOTER_COLOR = "94A3B8"  #: slate-400
SECTION_TITLE_SIZE_PX = 44.0
TITLE_SIZE_PX = 32.0

#: 不显示页脚的页类型
_NO_FOOTER_TYPES = {"cover", "section", "ending"}
#: 居中标题（cover/ending）的标题字号
_CENTER_TITLE_SIZE_PX = 56.0
_ENDING_TITLE_SIZE_PX = 44.0


def _add_textbox(slide, x_px: float, y_px: float, w_px: float, h_px: float):
    box = slide.shapes.add_textbox(emu(x_px), emu(y_px), emu(w_px), emu(h_px))
    tf = box.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    return box, tf


def render_title(slide, page: Slide, *, is_cover: bool = False, is_section: bool = False,
                 section_accent: str = "1E293B") -> None:
    """按页类型渲染标题块。title 为 None 时跳过。"""
    if not page.title:
        return

    if is_cover:
        box, tf = _add_textbox(slide, 240, 300, 800, 120)
        tf.paragraphs[0].alignment = PP_ALIGN.CENTER
        p = tf.paragraphs[0]
        run = p.add_run()
        run.text = page.title
        run.font.size = Pt(pt(_CENTER_TITLE_SIZE_PX))
        run.font.bold = True
        return

    if page.page_type == "ending":
        # hero-center：标题居中（略小于封面）
        box, tf = _add_textbox(slide, 240, 300, 800, 100)
        tf.paragraphs[0].alignment = PP_ALIGN.CENTER
        p = tf.paragraphs[0]
        run = p.add_run()
        run.text = page.title
        run.font.size = Pt(pt(_ENDING_TITLE_SIZE_PX))
        run.font.bold = True
        return

    if is_section:
        # 全幅色块（左 1/4 强调条 + 主色块），标题居中偏左
        accent = _parse_rgb(section_accent)
        band = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, emu(0), emu(0), emu(1280), emu(720))
        band.fill.solid()
        band.fill.fore_color.rgb = RGBColor(*accent)
        band.line.fill.background()
        remove_shadow(band)
        box, tf = _add_textbox(slide, 100, 300, 1080, 140)
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.CENTER
        run = p.add_run()
        run.text = page.title
        run.font.size = Pt(pt(SECTION_TITLE_SIZE_PX))
        run.font.bold = True
        run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        return

    # toc / content / ending：左上 A 区
    box, tf = _add_textbox(slide, TITLE_LEFT_PX, TITLE_TOP_PX, 1184, TITLE_HEIGHT_PX)
    p = tf.paragraphs[0]
    run = p.add_run()
    run.text = page.title
    run.font.size = Pt(pt(TITLE_SIZE_PX))
    run.font.bold = True


def render_footer(slide, page_index: int, total: int, project_name: str = "") -> None:
    """页脚：左下项目名 + 右下页码 NN/TOTAL。cover/section/ending 不显示。"""
    if page_index + 1 > total or page_index + 1 <= 0:
        return
    # 页码
    num_text = f"{page_index + 1}/{total}"
    box, tf = _add_textbox(slide, 1280 - 48 - 120, FOOTER_Y_PX, 120, FOOTER_HEIGHT_PX)
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.RIGHT
    run = p.add_run()
    run.text = num_text
    run.font.size = Pt(FOOTER_FONT_PT)
    run.font.color.rgb = RGBColor(0x94, 0xA3, 0xB8)

    if project_name:
        box, tf = _add_textbox(slide, 48, FOOTER_Y_PX, 600, FOOTER_HEIGHT_PX)
        p = tf.paragraphs[0]
        run = p.add_run()
        run.text = project_name
        run.font.size = Pt(FOOTER_FONT_PT)
        run.font.color.rgb = RGBColor(0x94, 0xA3, 0xB8)


def _parse_rgb(hex_str: str) -> tuple[int, int, int]:
    h = hex_str.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def needs_footer(page_type: str) -> bool:
    return page_type not in _NO_FOOTER_TYPES
