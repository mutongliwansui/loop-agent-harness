"""SVG 预览渲染器（T4.2）：布局结果 → SVG 矢量预览。

设计理念：
- 复用 ``layout_slide`` 的绝对坐标（1280×720 空间），直接映射到 SVG ``viewBox``
- 矢量优先：Box/Text/Table 生成原生 SVG 元素（缩放无失真）
- 栅格化组件（Chart/Icon/QRCode/CodeBlock/Math/Image）复用现有 PNG 渲染器，base64 嵌入 ``<image>``
- 复刻 ``master.py`` 的标题/页脚逻辑（按 page_type 分模板）

与 OOXML 渲染器的差异：
- 不依赖 python-pptx / lxml
- 不做 EMU 单位转换（直接用 px）
- SVG 组件（用户 markup）直接嵌入，无需解析转栅格
"""

from __future__ import annotations

import base64
import html
import io
import re
import uuid
from typing import Any, Optional
from xml.sax.saxutils import escape as xml_escape

from slidep.dsl.components import Slide
from slidep.dsl.styles import Color, Gradient
from slidep.layout import CANVAS_HEIGHT, CANVAS_WIDTH, LayoutNode, LayoutResult, layout_slide
from slidep.logging_setup import get_logger
from slidep.render.master import needs_footer

log = get_logger("preview.svg")

#: 富文本段落分隔
_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
#: 富文本内联 span
_SPAN_RE = re.compile(r'<span style=\{\{(.*?)\}\}>(.*?)</span>', re.DOTALL)

#: 不显示页脚的页类型
_NO_FOOTER_TYPES = {"cover", "section", "ending"}

#: 页面模板常量（对齐 master.py）
_TITLE_TOP = 44.0
_TITLE_LEFT = 48.0
_TITLE_H = 64.0
_TITLE_SIZE = 32.0
_COVER_TITLE_SIZE = 56.0
_ENDING_TITLE_SIZE = 44.0
_SECTION_TITLE_SIZE = 44.0
_FOOTER_Y = 682.0
_FOOTER_H = 26.0
_FOOTER_FONT_PT = 9.0
_FOOTER_COLOR = "#94A3B8"


# ================================================================ 公共入口

def render_slide_svg(
    slide: Slide,
    slide_idx: int,
    total: int,
    project_name: str = "",
    section_accent: str = "1E293B",
) -> str:
    """渲染单页幻灯片为 SVG 字符串。

    Args:
        slide: DSL Slide 对象
        slide_idx: 页索引（0-based）
        total: 总页数
        project_name: 页脚项目名
        section_accent: section 页色块颜色（hex6）

    Returns:
        完整的 ``<svg>...</svg>`` 字符串
    """
    # 布局
    layout = layout_slide(slide)

    # 构建 SVG
    parts: list[str] = []
    _emit_header(parts)
    _emit_background(parts, slide, section_accent)
    _emit_title(parts, slide, section_accent)
    _emit_content(parts, layout)
    _emit_footer(parts, slide, slide_idx, total, project_name)
    _emit_trailer(parts)
    return "\n".join(parts)


def render_slides_svg(
    slides: list[Slide],
    project_name: str = "",
    section_accent: str = "1E293B",
) -> list[str]:
    """渲染多页幻灯片为 SVG 字符串列表。"""
    total = len(slides)
    return [
        render_slide_svg(slide, i, total, project_name, section_accent)
        for i, slide in enumerate(slides)
    ]


# ================================================================ SVG 文档结构

def _emit_header(parts: list[str]) -> None:
    """SVG 文档头。"""
    parts.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'viewBox="0 0 {CANVAS_WIDTH:.0f} {CANVAS_HEIGHT:.0f}" '
        f'width="{CANVAS_WIDTH:.0f}" height="{CANVAS_HEIGHT:.0f}">'
    )
    parts.append(f'<rect width="{CANVAS_WIDTH:.0f}" height="{CANVAS_HEIGHT:.0f}" fill="#FFFFFF"/>')


def _emit_trailer(parts: list[str]) -> None:
    """SVG 文档尾。"""
    parts.append("</svg>")


# ================================================================ 背景

def _emit_background(parts: list[str], slide: Slide, section_accent: str) -> None:
    """页面背景（纯色/渐变/section 色块）。"""
    if slide.page_type == "section":
        # section 全幅色块
        accent = _parse_hex(section_accent)
        parts.append(
            f'<rect x="0" y="0" width="{CANVAS_WIDTH:.0f}" height="{CANVAS_HEIGHT:.0f}" '
            f'fill="rgb({accent[0]},{accent[1]},{accent[2]})"/>'
        )
        return

    bg = slide.background
    if bg is None:
        return

    if isinstance(bg, Gradient):
        gid = f"bg_{uuid.uuid4().hex[:8]}"
        _emit_gradient_def(parts, gid, bg)
        parts.append(
            f'<rect x="0" y="0" width="{CANVAS_WIDTH:.0f}" height="{CANVAS_HEIGHT:.0f}" '
            f'fill="url(#{gid})"/>'
        )
    elif isinstance(bg, Color):
        parts.append(
            f'<rect x="0" y="0" width="{CANVAS_WIDTH:.0f}" height="{CANVAS_HEIGHT:.0f}" '
            f'fill="{_color_to_svg(bg)}" fill-opacity="{bg.a / 255:.3f}"/>'
        )


# ================================================================ 标题（master 层）

def _emit_title(parts: list[str], slide: Slide, section_accent: str) -> None:
    """按 page_type 渲染标题块（复刻 master.py render_title）。"""
    if not slide.title:
        return

    title = xml_escape(slide.title)
    pt = slide.page_type

    if pt == "cover":
        # 居中 hero
        parts.append(
            f'<text x="640" y="360" '
            f'font-size="{_COVER_TITLE_SIZE:.0f}" font-weight="bold" '
            f'text-anchor="middle" dominant-baseline="central" '
            f'font-family="sans-serif" fill="#FFFFFF">{title}</text>'
        )
    elif pt == "ending":
        parts.append(
            f'<text x="640" y="360" '
            f'font-size="{_ENDING_TITLE_SIZE:.0f}" font-weight="bold" '
            f'text-anchor="middle" dominant-baseline="central" '
            f'font-family="sans-serif" fill="#FFFFFF">{title}</text>'
        )
    elif pt == "section":
        # 白字在色块上，居中偏左
        parts.append(
            f'<text x="100" y="370" '
            f'font-size="{_SECTION_TITLE_SIZE:.0f}" font-weight="bold" '
            f'text-anchor="start" dominant-baseline="central" '
            f'font-family="sans-serif" fill="#FFFFFF">{title}</text>'
        )
    else:
        # toc / content：左上 A 区
        parts.append(
            f'<text x="{_TITLE_LEFT:.0f}" y="{_TITLE_TOP + _TITLE_H / 2:.0f}" '
            f'font-size="{_TITLE_SIZE:.0f}" font-weight="bold" '
            f'text-anchor="start" dominant-baseline="central" '
            f'font-family="sans-serif" fill="#1E293B">{title}</text>'
        )


# ================================================================ 内容区

def _emit_content(parts: list[str], layout: LayoutResult) -> None:
    """递归渲染布局树。"""
    _render_node_svg(parts, layout.root)


def _render_node_svg(parts: list[str], node: LayoutNode) -> None:
    """渲染单个布局节点（递归）。

    容器：先画背景，再递归子项。
    叶子：按 kind 分发到对应 SVG 渲染器。
    """
    rect = node.rect
    if rect is None:
        return

    kind = node.kind

    # 容器节点：画背景 + 递归
    if kind in ("slide", "box"):
        _render_box_svg(parts, node)
        for child in node.children:
            _render_node_svg(parts, child)
        return

    # 叶子节点分发
    renderer = _SVG_LEAF_RENDERERS.get(kind)
    if renderer is not None:
        renderer(parts, node)
    else:
        log.warn_ctx(f"未知组件类型: {kind}, 跳过")


# ================================================================ Box 容器

def _render_box_svg(parts: list[str], node: LayoutNode) -> None:
    """Box → SVG rect（背景 + 圆角）+ gradient defs。"""
    st = node.style
    rect = node.rect
    assert rect is not None

    if st.background is None and st.border_radius <= 0:
        return  # 无背景无圆角，跳过

    rx = f'rx="{st.border_radius:.1f}"' if st.border_radius > 0 else ""

    if st.background is None:
        # 仅有圆角，画透明 rect
        parts.append(
            f'<rect x="{rect.x:.1f}" y="{rect.y:.1f}" '
            f'width="{rect.width:.1f}" height="{rect.height:.1f}" '
            f'{rx} fill="none"/>'
        )
        return

    if isinstance(st.background, Gradient):
        gid = f"grad_{uuid.uuid4().hex[:8]}"
        _emit_gradient_def(parts, gid, st.background, rect)
        parts.append(
            f'<rect x="{rect.x:.1f}" y="{rect.y:.1f}" '
            f'width="{rect.width:.1f}" height="{rect.height:.1f}" '
            f'{rx} fill="url(#{gid})"/>'
        )
    elif isinstance(st.background, Color):
        parts.append(
            f'<rect x="{rect.x:.1f}" y="{rect.y:.1f}" '
            f'width="{rect.width:.1f}" height="{rect.height:.1f}" '
            f'{rx} fill="{_color_to_svg(st.background)}" '
            f'fill-opacity="{st.background.a / 255:.3f}"/>'
        )


# ================================================================ Text

def _render_text_svg(parts: list[str], node: LayoutNode) -> None:
    """Text → SVG <text> + <tspan>（富文本 span / 段落 / 样式）。"""
    st = node.style
    rect = node.rect
    assert rect is not None

    text = node.component.text  # type: ignore[attr-defined]
    paragraphs = _parse_rich_text(text)

    # 文本对齐 → text-anchor
    anchor_map = {"left": "start", "center": "middle", "right": "end"}
    anchor = anchor_map.get(st.text_align, "start")

    # x 坐标按对齐方式
    if anchor == "middle":
        x = rect.x + rect.width / 2
    elif anchor == "end":
        x = rect.x + rect.width
    else:
        x = rect.x

    # 行高
    line_h = st.font_size * st.line_height if st.line_height > 0 else st.font_size * 1.3
    font_family = _svg_font_family(st.font_weight)

    # 颜色
    color = _color_to_svg(st.color) if st.color else "#1E293B"

    # 渲染段落
    y = rect.y + st.font_size  # 首行基线
    for para in paragraphs:
        if not para or (len(para) == 1 and para[0][0] == ""):
            y += line_h
            continue

        # 段内多 span → tspan
        tspan_parts: list[str] = []
        for run_text, inline in para:
            run_style = _inline_style_str(inline, st, color)
            escaped = xml_escape(run_text)
            tspan_parts.append(f'<tspan {run_style}>{escaped}</tspan>')

        spacing = f'letter-spacing="{st.letter_spacing:.1f}"' if st.letter_spacing != 0 else ""
        parts.append(
            f'<text x="{x:.1f}" y="{y:.1f}" '
            f'font-family="{font_family}" '
            f'font-size="{st.font_size:.1f}" '
            f'text-anchor="{anchor}" '
            f'{spacing}>{"".join(tspan_parts)}</text>'
        )
        y += line_h


def _svg_font_family(weight: str) -> str:
    """字重 → SVG font-family（简化：bold 用同一字族但 font-weight=bold）。"""
    return "sans-serif"


def _inline_style_str(inline: dict[str, Any], st: Any, default_color: str) -> str:
    """内联 span 样式 → SVG 属性字符串。"""
    attrs: list[str] = []
    if "fontSize" in inline:
        attrs.append(f'font-size="{inline["fontSize"]:.1f}"')
    if inline.get("fontWeight") == "bold" or st.font_weight == "bold":
        attrs.append('font-weight="bold"')
    if "color" in inline:
        c = _parse_hex(inline["color"])
        if c:
            attrs.append(f'fill="rgb({c[0]},{c[1]},{c[2]})"')
    else:
        attrs.append(f'fill="{default_color}"')
    return " ".join(attrs)


# ================================================================ Image

def _render_image_svg(parts: list[str], node: LayoutNode) -> None:
    """Image → base64 PNG 嵌入 <image>。"""
    rect = node.rect
    assert rect is not None
    comp = node.component  # type: ignore[attr-defined]

    try:
        from slidep.render.image import render_image_png

        png_bytes = render_image_png(
            src=comp.src,
            width_px=int(rect.width),
            height_px=int(rect.height),
            object_fit=comp.object_fit,
        )
        b64 = base64.b64encode(png_bytes).decode("ascii")
        # borderRadius clip
        st = node.style
        clip = ""
        if hasattr(st, "border_radius") and st.border_radius > 0:
            clip_id = f"clip_{uuid.uuid4().hex[:8]}"
            parts.append(
                f'<clipPath id="{clip_id}">'
                f'<rect x="{rect.x:.1f}" y="{rect.y:.1f}" '
                f'width="{rect.width:.1f}" height="{rect.height:.1f}" '
                f'rx="{st.border_radius:.1f}"/></clipPath>'
            )
            clip = f'clip-path="url(#{clip_id})"'

        parts.append(
            f'<image x="{rect.x:.1f}" y="{rect.y:.1f}" '
            f'width="{rect.width:.1f}" height="{rect.height:.1f}" '
            f'xlink:href="data:image/png;base64,{b64}" {clip}/>'
        )
    except Exception as e:  # noqa: BLE001
        _emit_placeholder(parts, rect, f"Image: {e}")


# ================================================================ Chart

def _render_chart_svg(parts: list[str], node: LayoutNode) -> None:
    """Chart → matplotlib PNG → base64 <image>。"""
    rect = node.rect
    assert rect is not None
    comp = node.component  # type: ignore[attr-defined]

    try:
        from slidep.render.chart import render_chart_png

        png_bytes = render_chart_png(
            chart_type=comp.chart_type,
            data=comp.data,
            width_px=rect.width,
            height_px=rect.height,
            title=comp.title,
        )
        b64 = base64.b64encode(png_bytes).decode("ascii")
        parts.append(
            f'<image x="{rect.x:.1f}" y="{rect.y:.1f}" '
            f'width="{rect.width:.1f}" height="{rect.height:.1f}" '
            f'xlink:href="data:image/png;base64,{b64}"/>'
        )
    except Exception as e:  # noqa: BLE001
        _emit_placeholder(parts, rect, f"Chart: {e}")


# ================================================================ Table

def _render_table_svg(parts: list[str], node: LayoutNode) -> None:
    """Table → SVG 矩形 + 文本网格。"""
    rect = node.rect
    assert rect is not None
    comp = node.component  # type: ignore[attr-defined]
    data = comp.data
    if not data:
        return

    rows = len(data)
    cols = max(len(r) for r in data) if data else 0
    cell_w = rect.width / cols if cols else 0
    cell_h = rect.height / rows if rows else 0

    # 表头背景
    if comp.header:
        parts.append(
            f'<rect x="{rect.x:.1f}" y="{rect.y:.1f}" '
            f'width="{rect.width:.1f}" height="{cell_h:.1f}" '
            f'fill="#F1F5F9"/>'
        )

    # 斑马纹
    if comp.zebra:
        for i in range(1, rows, 2):
            parts.append(
                f'<rect x="{rect.x:.1f}" y="{rect.y + i * cell_h:.1f}" '
                f'width="{rect.width:.1f}" height="{cell_h:.1f}" '
                f'fill="#F8FAFC"/>'
            )

    # 网格线
    stroke = 'stroke="#E2E8F0" stroke-width="0.5"'
    for i in range(cols + 1):
        x = rect.x + i * cell_w
        parts.append(
            f'<line x1="{x:.1f}" y1="{rect.y:.1f}" '
            f'x2="{x:.1f}" y2="{rect.bottom:.1f}" {stroke}/>'
        )
    for i in range(rows + 1):
        y = rect.y + i * cell_h
        parts.append(
            f'<line x1="{rect.x:.1f}" y1="{y:.1f}" '
            f'x2="{rect.right:.1f}" y2="{y:.1f}" {stroke}/>'
        )

    # 单元格文本
    font_size = min(cell_h * 0.4, 14.0)
    for r, row in enumerate(data):
        for c, cell_text in enumerate(row):
            if c >= cols:
                break
            cx = rect.x + c * cell_w + cell_w / 2
            cy = rect.y + r * cell_h + cell_h / 2
            weight = 'font-weight="bold"' if (comp.header and r == 0) else ""
            color = "#1E293B" if (comp.header and r == 0) else "#475569"
            parts.append(
                f'<text x="{cx:.1f}" y="{cy:.1f}" '
                f'font-size="{font_size:.1f}" font-family="sans-serif" '
                f'text-anchor="middle" dominant-baseline="central" '
                f'{weight} fill="{color}">{xml_escape(str(cell_text))}</text>'
            )


# ================================================================ FAIcon

def _render_icon_svg(parts: list[str], node: LayoutNode) -> None:
    """FAIcon → matplotlib PNG → base64 <image>。"""
    rect = node.rect
    assert rect is not None
    comp = node.component  # type: ignore[attr-defined]

    try:
        from slidep.render.icon import render_icon_png

        st = node.style
        color = _color_to_svg(st.color) if st.color else "#1E293B"
        hex_color = st.color.hex6 if st.color else "#1E293B"

        png_bytes = render_icon_png(
            name=comp.name,
            width_px=int(rect.width),
            height_px=int(rect.height),
            color=hex_color,
        )
        b64 = base64.b64encode(png_bytes).decode("ascii")
        parts.append(
            f'<image x="{rect.x:.1f}" y="{rect.y:.1f}" '
            f'width="{rect.width:.1f}" height="{rect.height:.1f}" '
            f'xlink:href="data:image/png;base64,{b64}"/>'
        )
    except Exception as e:  # noqa: BLE001
        _emit_placeholder(parts, rect, f"Icon: {e}")


# ================================================================ SVG（用户提供的 markup）

def _render_svg_component_svg(parts: list[str], node: LayoutNode) -> None:
    """SVG 组件 → 直接嵌入用户 markup（外层 g + transform）。"""
    rect = node.rect
    assert rect is not None
    comp = node.component  # type: ignore[attr-defined]
    markup = comp.markup

    # 提取 viewBox 尺寸（如果有的话）
    # 直接嵌入，用 g + translate 定位
    parts.append(
        f'<g transform="translate({rect.x:.1f},{rect.y:.1f})">'
    )
    # 尝试提取原始 SVG 的 width/height/viewBox 来缩放
    # 简单策略：直接嵌入 markup 内容（strip 外层 <svg> 标签）
    inner = _strip_svg_wrapper(markup)
    parts.append(inner)
    parts.append("</g>")


def _strip_svg_wrapper(markup: str) -> str:
    """剥离 <svg> 外层标签，保留内部元素。"""
    # 匹配 <svg ...>...</svg>
    m = re.search(r"<svg[^>]*>(.*)</svg>", markup, re.DOTALL | re.IGNORECASE)
    if m:
        return m.group(1).strip()
    return markup


# ================================================================ QRCode

def _render_qrcode_svg(parts: list[str], node: LayoutNode) -> None:
    """QRCode → PNG → base64 <image>。"""
    rect = node.rect
    assert rect is not None
    comp = node.component  # type: ignore[attr-defined]

    try:
        from slidep.render.qrcode_render import render_qrcode_png

        png_bytes = render_qrcode_png(
            value=comp.value,
            width_px=int(rect.width),
            height_px=int(rect.height),
        )
        b64 = base64.b64encode(png_bytes).decode("ascii")
        parts.append(
            f'<image x="{rect.x:.1f}" y="{rect.y:.1f}" '
            f'width="{rect.width:.1f}" height="{rect.height:.1f}" '
            f'xlink:href="data:image/png;base64,{b64}"/>'
        )
    except Exception as e:  # noqa: BLE001
        _emit_placeholder(parts, rect, f"QR: {e}")


# ================================================================ CodeBlock

def _render_codeblock_svg(parts: list[str], node: LayoutNode) -> None:
    """CodeBlock → PNG → base64 <image>。"""
    rect = node.rect
    assert rect is not None
    comp = node.component  # type: ignore[attr-defined]

    try:
        from slidep.render.codeblock import render_codeblock_png

        png_bytes = render_codeblock_png(
            code=comp.code,
            language=comp.language,
            width_px=int(rect.width),
            height_px=int(rect.height),
        )
        b64 = base64.b64encode(png_bytes).decode("ascii")
        parts.append(
            f'<image x="{rect.x:.1f}" y="{rect.y:.1f}" '
            f'width="{rect.width:.1f}" height="{rect.height:.1f}" '
            f'xlink:href="data:image/png;base64,{b64}"/>'
        )
    except Exception as e:  # noqa: BLE001
        _emit_placeholder(parts, rect, f"Code: {e}")


# ================================================================ Math

def _render_math_svg(parts: list[str], node: LayoutNode) -> None:
    """Math → matplotlib mathtext PNG → base64 <image>。"""
    rect = node.rect
    assert rect is not None
    comp = node.component  # type: ignore[attr-defined]

    try:
        from slidep.render.math_render import render_math_png

        st = node.style
        color = st.color.hex6 if st.color else "#1E293B"

        png_bytes = render_math_png(
            latex=comp.latex,
            width_px=int(rect.width),
            height_px=int(rect.height),
            color=color,
        )
        b64 = base64.b64encode(png_bytes).decode("ascii")
        parts.append(
            f'<image x="{rect.x:.1f}" y="{rect.y:.1f}" '
            f'width="{rect.width:.1f}" height="{rect.height:.1f}" '
            f'xlink:href="data:image/png;base64,{b64}"/>'
        )
    except Exception as e:  # noqa: BLE001
        _emit_placeholder(parts, rect, f"Math: {e}")


# ================================================================ 叶子分发表

_SVG_LEAF_RENDERERS = {
    "text": _render_text_svg,
    "chart": _render_chart_svg,
    "image": _render_image_svg,
    "table": _render_table_svg,
    "icon": _render_icon_svg,
    "svg": _render_svg_component_svg,
    "qrcode": _render_qrcode_svg,
    "codeblock": _render_codeblock_svg,
    "math": _render_math_svg,
}


# ================================================================ 页脚

def _emit_footer(parts: list[str], slide: Slide, idx: int, total: int, project_name: str) -> None:
    """页脚：页码 + 项目名（cover/section/ending 不显示）。"""
    if not needs_footer(slide.page_type):
        return

    # 页码
    num_text = f"{idx + 1}/{total}"
    parts.append(
        f'<text x="{CANVAS_WIDTH - 48:.0f}" y="{_FOOTER_Y + _FOOTER_H / 2:.0f}" '
        f'font-size="{_FOOTER_FONT_PT:.1f}" font-family="sans-serif" '
        f'text-anchor="end" dominant-baseline="central" '
        f'fill="{_FOOTER_COLOR}">{num_text}</text>'
    )

    # 项目名
    if project_name:
        parts.append(
            f'<text x="{_TITLE_LEFT:.0f}" y="{_FOOTER_Y + _FOOTER_H / 2:.0f}" '
            f'font-size="{_FOOTER_FONT_PT:.1f}" font-family="sans-serif" '
            f'text-anchor="start" dominant-baseline="central" '
            f'fill="{_FOOTER_COLOR}">{xml_escape(project_name)}</text>'
        )


# ================================================================ 工具函数

def _color_to_svg(color: Optional[Color]) -> str:
    """Color → SVG fill 字符串。"""
    if color is None:
        return "#1E293B"
    return f"rgb({color.r},{color.g},{color.b})"


def _parse_hex(hex_str: str) -> Optional[tuple[int, int, int]]:
    """hex 字符串 → (r, g, b)。"""
    h = hex_str.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) < 6:
        return None
    try:
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except ValueError:
        return None


def _emit_gradient_def(parts: list[str], gid: str, grad: Gradient, rect: Optional[Any] = None) -> None:
    """渐变 → SVG <defs><linearGradient>。"""
    if rect is not None:
        x1, y1, x2, y2 = rect.x, rect.y, rect.x + rect.width, rect.y
    else:
        x1, y1, x2, y2 = 0, 0, CANVAS_WIDTH, 0

    angle_rad = grad.angle * 3.14159265 / 180
    dx = abs(CANVAS_WIDTH) * 0.01  # 简化：用 canvas 宽度做方向投影
    x2 = x1 + dx * abs(__import__("math").cos(angle_rad))
    y2 = y1 + dx * abs(__import__("math").sin(angle_rad))

    start = grad.start
    end = grad.end
    parts.append(
        f'<defs><linearGradient id="{gid}" '
        f'x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
        f'gradientUnits="userSpaceOnUse">'
        f'<stop offset="0%" stop-color="rgb({start.r},{start.g},{start.b})" '
        f'stop-opacity="{start.a / 255:.3f}"/>'
        f'<stop offset="100%" stop-color="rgb({end.r},{end.g},{end.b})" '
        f'stop-opacity="{end.a / 255:.3f}"/>'
        f'</linearGradient></defs>'
    )


def _emit_placeholder(parts: list[str], rect: Any, msg: str) -> None:
    """占位符（渲染失败时）。"""
    parts.append(
        f'<rect x="{rect.x:.1f}" y="{rect.y:.1f}" '
        f'width="{rect.width:.1f}" height="{rect.height:.1f}" '
        f'fill="#FEF2F2" stroke="#EF4444" stroke-width="1" stroke-dasharray="4"/>'
    )
    parts.append(
        f'<text x="{rect.x + rect.width / 2:.1f}" y="{rect.y + rect.height / 2:.1f}" '
        f'font-size="12" font-family="sans-serif" text-anchor="middle" '
        f'dominant-baseline="central" fill="#DC2626">{xml_escape(msg[:50])}</text>'
    )


# ================================================================ 富文本解析（复刻 engine.py）

def _parse_span_style(s: str) -> dict[str, Any]:
    """解析 span 的 style 对象。"""
    style: dict[str, Any] = {}
    for part in s.split(","):
        if ":" not in part:
            continue
        k, v = part.split(":", 1)
        k = k.strip().strip('"').strip("'")  # strip quotes from key too
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
                runs.append((para[pos: m.start()], {}))
            runs.append((m.group(2), _parse_span_style(m.group(1))))
            pos = m.end()
        if pos < len(para):
            runs.append((para[pos:], {}))
        if not runs:
            runs.append(("", {}))
        out.append(runs)
    return out
