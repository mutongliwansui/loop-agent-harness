"""SVG 渲染器（T2.2）：轻量 SVG 解析 + matplotlib 基元 → PNG bytes。

支持元素：rect / circle / ellipse / line / polyline / polygon / path / text / g
支持属性：fill / stroke / stroke-width / opacity / font-size / font-family

不依赖 CairoSVG，纯 matplotlib 渲染（离线无外部依赖）。
"""

from __future__ import annotations

import io
import re
import xml.etree.ElementTree as ET
from typing import Optional

from slidep import ErrorCode, render_error

# matplotlib 惰性加载：未安装时模块可正常导入，仅在调用 render_svg_png 时报错
_mpl = None  # type: Optional[dict]


def _ensure_mpl():
    """延迟导入 matplotlib，返回模块字典。"""
    global _mpl
    if _mpl is not None:
        return _mpl
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.patches import Circle, Ellipse, FancyBboxPatch, PathPatch, Polygon, Rectangle
        from matplotlib.path import Path
    except ImportError:
        raise render_error(
            ErrorCode.RENDER_OOXML_FAILED,
            reason="matplotlib 未安装，SVG 渲染不可用。请安装：pip install matplotlib",
        )
    _mpl = {"plt": plt, "Circle": Circle, "Ellipse": Ellipse, "FancyBboxPatch": FancyBboxPatch,
            "PathPatch": PathPatch, "Polygon": Polygon, "Rectangle": Rectangle, "Path": Path}
    return _mpl


def _parse_color(value: str) -> Optional[str]:
    """SVG 颜色 → matplotlib 兼容色（hex 或 named）。"""
    if not value or value == "none":
        return None
    value = value.strip()
    if value.startswith("#"):
        return value
    _SVG_NAMED = {"white": "#FFFFFF", "black": "#000000", "red": "#FF0000",
                   "green": "#008000", "blue": "#0000FF", "yellow": "#FFFF00",
                   "gray": "#808080", "grey": "#808080", "orange": "#FFA500",
                   "purple": "#800080", "pink": "#FFC0CB", "brown": "#A52A2A",
                   "cyan": "#00FFFF", "magenta": "#FF00FF", "lime": "#00FF00",
                   "navy": "#000080", "teal": "#008080", "transparent": "none"}
    return _SVG_NAMED.get(value.lower(), value)


def _parse_float(value: str, default: float = 0.0) -> float:
    try:
        return float(value)
    except (ValueError, TypeError):
        return default


def _parse_svg_path(d: str):
    """将 SVG path data 解析为 matplotlib Path（复用 icon.py 的解析器）。"""
    Path = _ensure_mpl()["Path"]
    tokens = re.findall(r'[a-zA-Z]|-?\d*\.?\d+(?:[eE][+-]?\d+)?', d)
    if not tokens:
        return Path([(0, 0)])

    vertices: list[tuple[float, float]] = []
    codes: list[int] = []
    i = 0
    cur_x, cur_y = 0.0, 0.0
    start_x, start_y = 0.0, 0.0

    while i < len(tokens):
        cmd = tokens[i]
        i += 1
        if cmd in ("Z", "z"):
            vertices.append((start_x, start_y))
            codes.append(Path.CLOSEPOLY)
            cur_x, cur_y = start_x, start_y
            continue
        if cmd not in ("M", "L", "C", "Q", "A", "H", "V", "m", "l", "c", "q", "a", "h", "v"):
            continue

        is_relative = cmd.islower()
        cmd_upper = cmd.upper()

        while i < len(tokens) and not tokens[i].isalpha():
            if cmd_upper in ("M", "L", "m", "l"):
                x, y = float(tokens[i]), float(tokens[i + 1])
                i += 2
                if is_relative:
                    x += cur_x; y += cur_y
                vertices.append((x, y))
                codes.append(Path.MOVETO if (cmd_upper == "M" and len(vertices) == 1) else Path.LINETO)
                if cmd_upper == "M":
                    start_x, start_y = x, y
                    cmd_upper = "L"
                cur_x, cur_y = x, y
            elif cmd_upper in ("H", "h"):
                x = float(tokens[i]); i += 1
                if is_relative:
                    x += cur_x
                vertices.append((x, cur_y))
                codes.append(Path.LINETO)
                cur_x = x
            elif cmd_upper in ("V", "v"):
                y = float(tokens[i]); i += 1
                if is_relative:
                    y += cur_y
                vertices.append((cur_x, y))
                codes.append(Path.LINETO)
                cur_y = y
            elif cmd_upper in ("C", "c"):
                pts = [float(tokens[i + j]) for j in range(6)]
                i += 6
                if is_relative:
                    pts = [p + (cur_x if j % 2 == 0 else cur_y) for j, p in enumerate(pts)]
                vertices.extend([(pts[0], pts[1]), (pts[2], pts[3]), (pts[4], pts[5])])
                codes.extend([Path.CURVE4, Path.CURVE4, Path.CURVE4])
                cur_x, cur_y = pts[4], pts[5]
            elif cmd_upper in ("Q", "q"):
                pts = [float(tokens[i + j]) for j in range(4)]
                i += 4
                if is_relative:
                    pts = [p + (cur_x if j % 2 == 0 else cur_y) for j, p in enumerate(pts)]
                vertices.extend([(pts[0], pts[1]), (pts[2], pts[3])])
                codes.extend([Path.CURVE3, Path.CURVE3])
                cur_x, cur_y = pts[2], pts[3]
            elif cmd_upper in ("A", "a"):
                i += 5  # rx, ry, x-rot, large-arc, sweep
                x, y = float(tokens[i]), float(tokens[i + 1])
                i += 2
                if is_relative:
                    x += cur_x; y += cur_y
                vertices.append((x, y))
                codes.append(Path.LINETO)
                cur_x, cur_y = x, y
            else:
                break

    if not vertices:
        return Path([(0, 0)])
    return Path(vertices, codes)


def _render_element(ax, elem: ET.Element, parent_offset: tuple[float, float] = (0, 0)) -> None:
    """递归渲染一个 SVG 元素。"""
    m = _ensure_mpl()
    Circle = m["Circle"]
    Ellipse = m["Ellipse"]
    FancyBboxPatch = m["FancyBboxPatch"]
    PathPatch = m["PathPatch"]
    Polygon = m["Polygon"]
    Rectangle = m["Rectangle"]
    Path = m["Path"]
    tag = elem.tag.split("}")[-1]  # 去掉命名空间
    ox, oy = parent_offset

    # 处理 <g> 变换（仅支持 translate）
    if tag == "g":
        transform = elem.get("transform", "")
        m = re.search(r"translate\(([\d.]+)[\s,]+([\d.]+)\)", transform)
        gox, goy = (float(m.group(1)), float(m.group(2))) if m else (0.0, 0.0)
        for child in elem:
            _render_element(ax, child, (ox + gox, oy + goy))
        return

    fill = _parse_color(elem.get("fill", "black"))
    stroke = _parse_color(elem.get("stroke", "none"))
    sw = _parse_float(elem.get("stroke-width", "1"), 1.0)
    opacity = _parse_float(elem.get("opacity", "1"), 1.0)

    kw: dict = {}
    if fill is not None:
        kw["facecolor"] = fill
    else:
        kw["facecolor"] = "none"
    if stroke is not None:
        kw["edgecolor"] = stroke
        kw["linewidth"] = sw
    else:
        kw["edgecolor"] = "none"
    if opacity < 1.0:
        kw["alpha"] = opacity

    if tag == "rect":
        x = _parse_float(elem.get("x", "0")) + ox
        y = _parse_float(elem.get("y", "0")) + oy
        w = _parse_float(elem.get("width", "0"))
        h = _parse_float(elem.get("height", "0"))
        rx = _parse_float(elem.get("rx", "0"))
        if rx > 0:
            patch = FancyBboxPatch((x, y), w, h, boxstyle=f"round,pad=0,rounding_size={rx}", **kw)
        else:
            patch = Rectangle((x, y), w, h, **kw)
        ax.add_patch(patch)

    elif tag == "circle":
        cx = _parse_float(elem.get("cx", "0")) + ox
        cy = _parse_float(elem.get("cy", "0")) + oy
        r = _parse_float(elem.get("r", "0"))
        ax.add_patch(Circle((cx, cy), r, **kw))

    elif tag == "ellipse":
        cx = _parse_float(elem.get("cx", "0")) + ox
        cy = _parse_float(elem.get("cy", "0")) + oy
        rx = _parse_float(elem.get("rx", "0"))
        ry = _parse_float(elem.get("ry", "0"))
        ax.add_patch(Ellipse((cx, cy), rx * 2, ry * 2, **kw))

    elif tag == "line":
        x1 = _parse_float(elem.get("x1", "0")) + ox
        y1 = _parse_float(elem.get("y1", "0")) + oy
        x2 = _parse_float(elem.get("x2", "0")) + ox
        y2 = _parse_float(elem.get("y2", "0")) + oy
        color = stroke or "#000000"
        ax.plot([x1, x2], [y1, y2], color=color, linewidth=sw, alpha=opacity,
                solid_capstyle="round")

    elif tag in ("polyline", "polygon"):
        points_str = elem.get("points", "")
        pts = [float(v) for v in re.findall(r"-?\d*\.?\d+", points_str)]
        if len(pts) >= 2:
            pts_pairs = [(pts[i] + ox, pts[i + 1] + oy) for i in range(0, len(pts) - 1, 2)]
            closed = tag == "polygon"
            ax.add_patch(Polygon(pts_pairs, closed=closed, **kw))

    elif tag == "path":
        d = elem.get("d", "")
        path = _parse_svg_path(d)
        # 偏移 g 的 translate
        if ox or oy:
            verts = [(v[0] + ox, v[1] + oy) for v in path.vertices]
            path = Path(verts, path.codes)
        ax.add_patch(PathPatch(path, **kw))

    elif tag == "text":
        x = _parse_float(elem.get("x", "0")) + ox
        y = _parse_float(elem.get("y", "0")) + oy
        font_size = _parse_float(elem.get("font-size", "14"), 14.0)
        text = elem.text or ""
        color = fill or "#000000"
        ax.text(x, y, text, fontsize=font_size, color=color, ha="left", va="bottom")


def render_svg_png(
    markup: str,
    width_px: float,
    height_px: float,
) -> bytes:
    """渲染 SVG 字符串为 PNG bytes。

    Args:
        markup: SVG 标记字符串
        width_px: 目标宽度
        height_px: 目标高度

    Returns:
        PNG 图片字节流
    """
    try:
        root = ET.fromstring(markup)
    except ET.ParseError as exc:
        raise render_error(
            ErrorCode.RENDER_OOXML_FAILED,
            reason=f"SVG 解析失败: {exc}",
        ) from exc

    # viewBox 决定坐标空间
    view_box = root.get("viewBox", root.get("viewbox", ""))
    if view_box:
        parts = [float(v) for v in re.findall(r"-?\d*\.?\d+", view_box)]
        if len(parts) >= 4:
            vb_x, vb_y, vb_w, vb_h = parts[:4]
        else:
            vb_x, vb_y, vb_w, vb_h = 0, 0, width_px, height_px
    else:
        vb_w = _parse_float(root.get("width", str(width_px)), width_px)
        vb_h = _parse_float(root.get("height", str(height_px)), height_px)
        vb_x, vb_y = 0, 0

    dpi = 150
    fig_w = max(width_px / dpi, 0.5)
    fig_h = max(height_px / dpi, 0.5)

    m = _ensure_mpl()
    plt = m["plt"]

    try:
        fig, ax = plt.subplots(figsize=(fig_w, fig_h), dpi=dpi)
        fig.patch.set_alpha(0)
        ax.set_facecolor("none")
        ax.set_xlim(vb_x, vb_x + vb_w)
        ax.set_ylim(vb_y + vb_h, vb_y)  # SVG y 轴向下
        ax.set_aspect("equal")
        ax.axis("off")

        for child in root:
            _render_element(ax, child)

        buf = io.BytesIO()
        fig.savefig(buf, format="png", transparent=True, bbox_inches="tight", pad_inches=0.05)
        plt.close(fig)
        buf.seek(0)
        return buf.getvalue()
    except Exception as exc:  # noqa: BLE001
        plt.close("all")
        raise render_error(
            ErrorCode.RENDER_OOXML_FAILED,
            reason=f"SVG 渲染失败: {exc}",
        ) from exc
