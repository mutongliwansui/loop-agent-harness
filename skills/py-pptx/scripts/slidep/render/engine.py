"""OOXML 渲染器核心（T1.3 + T2.2）：布局结果 → .pptx。

渲染管线：``render_deck(slides)`` → 对每页 ``layout_slide`` → 背景 → 标题块 →
children（B 区 flex 结果逐节点渲染）→ 页脚 → 备注 → 保存。

组件映射（对齐 references/component-*.md）：
- Slide → 全画布背景（纯色/渐变）+ 标题块 + 页脚（master.py）
- Box   → 矩形 shape（仅当有 background/borderRadius），支持渐变/圆角
- Text  → 文本框，支持字号/字重/行高/字距/对齐/富文本 span
- Chart → matplotlib PNG → 嵌入图片（T2.1）
- Image → Pillow objectFit → PNG → 嵌入图片（T2.2）
- Table → python-pptx 原生表格 + 斑马纹 + 表头样式（T2.2）
- FAIcon → matplotlib PathPatch → PNG → 嵌入图片（T2.2）
- SVG   → 轻量 SVG 解析 + matplotlib 基元 → PNG → 嵌入图片（T2.2）
- QRCode → qrcode 库 → PNG → 嵌入图片（T2.2）
- CodeBlock → 语法高亮 + Pillow → PNG → 嵌入图片（T2.2）
- Math   → matplotlib mathtext LaTeX → PNG → 嵌入图片（T2.2）
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Pt

from slidep import ErrorCode, render_error
from slidep.dsl.components import Slide, Text
from slidep.dsl.styles import Color, Gradient
from slidep.layout import LayoutNode, LayoutResult, layout_slide
from slidep.render import advanced, master
from slidep.render.units import SLIDE_H_EMU, SLIDE_W_EMU, emu, pt

_ALIGN_MAP = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT}

#: 富文本：段落分隔（<br /> 独立标签；\n 兼容）
_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
#: 富文本：内联样式 span（<span style={{key:"value",...}}>text</span>，不支持嵌套）
_SPAN_RE = re.compile(r'<span style=\{\{(.*?)\}\}>(.*?)</span>', re.DOTALL)


@dataclass
class RenderOptions:
    """渲染选项。"""

    project_name: str = ""  #: 页脚左下角项目名
    footer: bool = True  #: 是否渲染页脚
    section_accent: str = "1E293B"  #: section 页全幅色块颜色
    notes: Optional[dict[int, str]] = None  #: 页索引(0-based) → 演讲备注


# ---------------------------------------------------------------- 富文本解析

def _parse_span_style(s: str) -> dict[str, Any]:
    """解析 span 的 style 对象：key:"value" 逗号分隔。支持 color/fontWeight/fontSize。"""
    style: dict[str, Any] = {}
    for part in s.split(","):
        if ":" not in part:
            continue
        k, v = part.split(":", 1)
        k = k.strip().strip('"').strip("'")  # 键与值都允许带引号（对齐 preview 路径）
        v = v.strip().strip('"').strip("'")
        if k in ("color", "fontWeight"):
            style[k] = v
        elif k == "fontSize":
            try:
                style[k] = float(v)
            except ValueError:
                pass
    return style


def _parse_rich_text(text: str) -> list[list[tuple[str, dict[str, Any]]]]:
    """富文本 → 段落列表。每段是 (run_text, inline_style) 序列。"""
    paragraphs = _BR_RE.split(text)
    out: list[list[tuple[str, dict[str, Any]]]] = []
    for para in paragraphs:
        runs: list[tuple[str, dict[str, Any]]] = []
        pos = 0
        for m in _SPAN_RE.finditer(para):
            if m.start() > pos:
                runs.append((para[pos : m.start()], {}))
            runs.append((m.group(2), _parse_span_style(m.group(1))))
            pos = m.end()
        if pos < len(para):
            runs.append((para[pos:], {}))
        if not runs:
            runs.append(("", {}))
        out.append(runs)
    return out


# ---------------------------------------------------------------- 节点渲染

def _render_box_shape(pptx_slide, node: LayoutNode) -> None:
    """Box → 矩形 shape（有背景/圆角/边框时渲染，支持 border/boxShadow/opacity）。"""
    st = node.style
    if st.background is None and st.border_radius <= 0 and st.border is None:
        return
    rect = node.rect
    assert rect is not None

    rounded = st.border_radius > 0
    shape_type = MSO_SHAPE.ROUNDED_RECTANGLE if rounded else MSO_SHAPE.RECTANGLE
    shape = pptx_slide.shapes.add_shape(shape_type, emu(rect.x), emu(rect.y), emu(rect.width), emu(rect.height))

    if st.border is not None:
        shape.line.color.rgb = RGBColor(st.border.color.r, st.border.color.g, st.border.color.b)
        shape.line.width = Pt(pt(st.border.width))
    else:
        shape.line.fill.background()  # 无边框

    if st.box_shadow is not None:
        advanced.apply_shadow(
            shape,
            blur_px=st.box_shadow.blur,
            dist_px=st.box_shadow.offset_y,
            alpha=st.box_shadow.alpha,
        )
    else:
        advanced.remove_shadow(shape)  # 关闭默认阴影

    if rounded:
        radius = min(st.border_radius, min(rect.width, rect.height) / 2)
        shape.adjustments[0] = radius / min(rect.width, rect.height) if rect.width and rect.height else 0.0

    if st.background is not None:
        if isinstance(st.background, Gradient):
            advanced.apply_gradient(shape, st.background, st.opacity)
        else:
            shape.fill.solid()
            shape.fill.fore_color.rgb = RGBColor(
                st.background.r, st.background.g, st.background.b
            )
            advanced.apply_solid_alpha(shape, round(st.background.a * st.opacity))


def _render_text(pptx_slide, node: LayoutNode) -> None:
    """Text → 文本框（富文本 span / 段落 / 样式）。"""
    st = node.style
    rect = node.rect
    assert rect is not None

    # 文本测量为估算值，实际渲染可能略宽；增加缓冲防止末字换行
    _w_buf = max(rect.width * 0.05, 4.0)
    if st.text_align == "center":
        _tx = rect.x - _w_buf / 2
    elif st.text_align == "right":
        _tx = rect.x - _w_buf
    else:
        _tx = rect.x
    box = pptx_slide.shapes.add_textbox(emu(_tx), emu(rect.y), emu(rect.width + _w_buf), emu(rect.height))
    tf = box.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = MSO_ANCHOR.TOP

    text = node.component.text  # type: ignore[attr-defined]
    paragraphs = _parse_rich_text(text)
    for p_idx, para in enumerate(paragraphs):
        p = tf.paragraphs[0] if p_idx == 0 else tf.add_paragraph()
        p.alignment = _ALIGN_MAP.get(st.text_align, PP_ALIGN.LEFT)
        if st.line_height > 0:
            p.line_spacing = st.line_height
        for run_text, inline in para:
            run = p.add_run()
            run.text = run_text
            run.font.size = Pt(pt(float(inline.get("fontSize", st.font_size))))
            if inline.get("fontWeight") == "bold" or st.font_weight == "bold":
                run.font.bold = True
            color = inline.get("color")
            if color:
                c = Color(*_hex_rgb(color)) if isinstance(color, str) else None
                if c is not None:
                    run.font.color.rgb = RGBColor(c.r, c.g, c.b)
            elif st.color is not None:
                run.font.color.rgb = RGBColor(st.color.r, st.color.g, st.color.b)
            advanced.patch_text_spacing(run, st.letter_spacing)


def _render_chart(pptx_slide, node: LayoutNode) -> None:
    """Chart → python-pptx 原生图表（可编辑）。"""
    from slidep.render.chart import add_native_chart

    rect = node.rect
    assert rect is not None
    chart = node.component  # type: ignore[attr-defined]
    add_native_chart(
        pptx_slide,
        chart_type=chart.chart_type,
        data=chart.data,
        x=emu(rect.x), y=emu(rect.y),
        cx=emu(rect.width), cy=emu(rect.height),
        title=chart.title,
    )


def _render_image(pptx_slide, node: LayoutNode) -> None:
    """Image → Pillow 加载 + objectFit → PNG → 嵌入 pptx 图片。"""
    import io

    from slidep.render.image import render_image_png

    rect = node.rect
    assert rect is not None
    comp = node.component  # type: ignore[attr-defined]
    png_bytes = render_image_png(
        src=comp.src,
        object_fit=comp.object_fit,
        width_px=rect.width,
        height_px=rect.height,
        border_radius=node.style.border_radius,
    )
    pptx_slide.shapes.add_picture(
        io.BytesIO(png_bytes),
        emu(rect.x), emu(rect.y), emu(rect.width), emu(rect.height),
    )


def _render_table(pptx_slide, node: LayoutNode) -> None:
    """Table → python-pptx 原生表格（保留可编辑性）。"""
    from slidep.render.table_render import render_table

    rect = node.rect
    assert rect is not None
    comp = node.component  # type: ignore[attr-defined]
    render_table(pptx_slide, comp.data, comp.header, comp.zebra, rect)


def _render_icon(pptx_slide, node: LayoutNode) -> None:
    """FAIcon → matplotlib PathPatch → PNG → 嵌入 pptx 图片。"""
    import io

    from slidep.render.icon import render_icon_png

    rect = node.rect
    assert rect is not None
    comp = node.component  # type: ignore[attr-defined]
    color_hex = node.style.color.hex6 if node.style.color is not None else None
    png_bytes = render_icon_png(
        name=comp.name,
        width_px=rect.width,
        height_px=rect.height,
        color=color_hex,
    )
    pptx_slide.shapes.add_picture(
        io.BytesIO(png_bytes),
        emu(rect.x), emu(rect.y), emu(rect.width), emu(rect.height),
    )


def _render_svg(pptx_slide, node: LayoutNode) -> None:
    """SVG → 轻量解析 + matplotlib 基元 → PNG → 嵌入 pptx 图片。"""
    import io

    from slidep.render.svg_render import render_svg_png

    rect = node.rect
    assert rect is not None
    comp = node.component  # type: ignore[attr-defined]
    png_bytes = render_svg_png(
        markup=comp.markup,
        width_px=rect.width,
        height_px=rect.height,
    )
    pptx_slide.shapes.add_picture(
        io.BytesIO(png_bytes),
        emu(rect.x), emu(rect.y), emu(rect.width), emu(rect.height),
    )


def _render_qrcode(pptx_slide, node: LayoutNode) -> None:
    """QRCode → qrcode 库 → PNG → 嵌入 pptx 图片。"""
    import io

    from slidep.render.qrcode_render import render_qrcode_png

    rect = node.rect
    assert rect is not None
    comp = node.component  # type: ignore[attr-defined]
    png_bytes = render_qrcode_png(
        value=comp.value,
        width_px=rect.width,
        height_px=rect.height,
    )
    pptx_slide.shapes.add_picture(
        io.BytesIO(png_bytes),
        emu(rect.x), emu(rect.y), emu(rect.width), emu(rect.height),
    )


def _render_codeblock(pptx_slide, node: LayoutNode) -> None:
    """CodeBlock → 语法高亮 + Pillow → PNG → 嵌入 pptx 图片。"""
    import io

    from slidep.render.codeblock import render_codeblock_png

    rect = node.rect
    assert rect is not None
    comp = node.component  # type: ignore[attr-defined]
    png_bytes = render_codeblock_png(
        code=comp.code,
        language=comp.language,
        width_px=rect.width,
        height_px=rect.height,
    )
    pptx_slide.shapes.add_picture(
        io.BytesIO(png_bytes),
        emu(rect.x), emu(rect.y), emu(rect.width), emu(rect.height),
    )


def _render_math(pptx_slide, node: LayoutNode) -> None:
    """Math → matplotlib mathtext LaTeX → PNG → 嵌入 pptx 图片。"""
    import io

    from slidep.render.math_render import render_math_png

    rect = node.rect
    assert rect is not None
    comp = node.component  # type: ignore[attr-defined]
    color_hex = node.style.color.hex6 if node.style.color is not None else None
    png_bytes = render_math_png(
        latex=comp.latex,
        width_px=rect.width,
        height_px=rect.height,
        color=color_hex,
    )
    pptx_slide.shapes.add_picture(
        io.BytesIO(png_bytes),
        emu(rect.x), emu(rect.y), emu(rect.width), emu(rect.height),
    )


#: 叶子节点 kind → 渲染函数分发表
_LEAF_RENDERERS: dict[str, Any] = {
    "text": _render_text,
    "chart": _render_chart,
    "image": _render_image,
    "table": _render_table,
    "icon": _render_icon,
    "svg": _render_svg,
    "qrcode": _render_qrcode,
    "codeblock": _render_codeblock,
    "math": _render_math,
}


def _render_node(pptx_slide, node: LayoutNode) -> None:
    """递归渲染一个布局节点。叶子节点直接渲染；容器节点先画背景再递归子项。

    子项按 zIndex 稳定排序渲染：后渲染的 shape 在上层（zIndex 大者置顶）。
    """
    renderer = _LEAF_RENDERERS.get(node.kind)
    if renderer is not None:
        renderer(pptx_slide, node)
        return
    # 容器节点（box/slide）：先画背景形状，再递归子项
    _render_box_shape(pptx_slide, node)
    for child in sorted(node.children, key=lambda c: (c.style.z_index, c.id)):
        _render_node(pptx_slide, child)


# ---------------------------------------------------------------- 页面

def _render_background(pptx_slide, root_style) -> None:
    """Slide 背景：全画布矩形（纯色/渐变/透明度统一路径）。"""
    bg = root_style.background
    if bg is None:
        return
    shape = pptx_slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE, emu(0), emu(0), emu(1280), emu(720)
    )
    shape.line.fill.background()
    advanced.remove_shadow(shape)
    if isinstance(bg, Gradient):
        advanced.apply_gradient(shape, bg)
    else:
        shape.fill.solid()
        shape.fill.fore_color.rgb = RGBColor(bg.r, bg.g, bg.b)
        advanced.apply_solid_alpha(shape, bg.a)


def _title_in_children(page: Slide) -> bool:
    """children 树中是否已包含与 title 相同的 Text（避免标题重复渲染）。

    递归搜索所有层级，因为 title 文本可能嵌套在 Box 等容器组件内。
    """
    if not page.title:
        return False
    title = page.title.strip()
    return _find_text_in_children(page.children, title)


def _find_text_in_children(children: list, target: str) -> bool:
    """递归搜索 children 树中是否存在文本内容匹配的 Text 组件。

    归一化比较：去除所有空白字符（含换行、空格、制表符）后判断是否相等，
    以处理用户在 Text 中插入换行符等排版需要的情况。
    """
    normalized_target = re.sub(r"\s+", "", target)
    for child in children:
        if isinstance(child, Text):
            normalized = re.sub(r"\s+", "", child.text)
            if normalized == normalized_target:
                return True
        sub = getattr(child, "children", None)
        if sub and _find_text_in_children(sub, target):
            return True
    return False


def _render_slide(prs: Presentation, page: Slide, idx: int, total: int, options: RenderOptions) -> None:
    """单个页面：布局 → 背景 → 标题 → children → 页脚 → 备注。"""
    result = layout_slide(page)
    root = result.root

    pptx_slide = prs.slides.add_slide(prs.slide_layouts[6])  # blank
    _render_background(pptx_slide, root.style)

    is_cover = page.page_type == "cover"
    is_section = page.page_type == "section"
    if not _title_in_children(page):
        master.render_title(
            pptx_slide, page,
            is_cover=is_cover, is_section=is_section,
            section_accent=options.section_accent,
        )

    for child in sorted(root.children, key=lambda c: (c.style.z_index, c.id)):
        _render_node(pptx_slide, child)

    if options.footer and master.needs_footer(page.page_type):
        master.render_footer(pptx_slide, idx, total, options.project_name)

    if options.notes and idx in options.notes:
        notes_slide = pptx_slide.notes_slide
        notes_slide.notes_text_frame.text = options.notes[idx]


# ---------------------------------------------------------------- 入口

def render_deck(
    slides: list[Slide],
    output_path: Optional[str] = None,
    *,
    options: Optional[RenderOptions] = None,
) -> Presentation:
    """渲染整份 PPT。slides 为 Slide 组件列表；output_path 非空时保存文件。

    返回已生成的 :class:`Presentation`（供测试检查与后续 save）。
    """
    opts = options or RenderOptions()
    prs = Presentation()
    prs.slide_width = SLIDE_W_EMU
    prs.slide_height = SLIDE_H_EMU

    total = len(slides)
    for idx, page in enumerate(slides):
        _render_slide(prs, page, idx, total, opts)

    if output_path:
        try:
            prs.save(output_path)
        except Exception as exc:  # noqa: BLE001
            raise render_error(
                ErrorCode.RENDER_OOXML_FAILED,
                reason=f"{exc}",
                file=output_path,
                hint="检查输出目录是否可写、文件名是否合法",
            ) from exc
    return prs


def _hex_rgb(hex_str: str) -> tuple[int, int, int]:
    h = hex_str.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) >= 6:
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return 0, 0, 0
