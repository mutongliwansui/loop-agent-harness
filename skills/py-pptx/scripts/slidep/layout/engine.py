"""Flexbox 布局引擎（T1.2）：组件树 → 绝对坐标。

两遍算法：
1. ``measure``（自底向上）：计算每个节点的固有尺寸（intrinsic size）
2. ``arrange``（自顶向下）：在已知容器内分配坐标，产出 bounding box

支持子集（对齐 references/component-box.md）：
- flexDirection: row / column；gap；justifyContent；alignItems（含 stretch）
- flex: 正整数（主轴剩余空间按权重分配）
- width/height：px 或 %（百分比相对父容器内容区）
- padding；position: absolute（top/left/right/bottom）
- Text 自动换行（显式或拉伸宽度下）

布局容器：Slide 的 children 布局在 B 区（48,120,1184,540），页脚/标题由 render 层生成。
溢出检测：任何节点 rect 超出画布（0,0,1280,720）→ LAYOUT_OVERFLOW（错误定位到节点类型）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import count
from typing import Any, Optional

from slidep import ErrorCode, layout_error
from slidep.dsl import Box, Chart, FAIcon, Image, Math, QRCode, SVG, Slide, Table, Text
from slidep.dsl.styles import (
    Border,
    BoxShadow,
    Color,
    Gradient,
    Length,
    Margins,
    Percent,
    parse_background,
    parse_border,
    parse_box_shadow,
    parse_color,
    parse_length,
    parse_margin,
)
from .text_measure import measure_text

CANVAS_WIDTH = 1280.0
CANVAS_HEIGHT = 720.0
CONTENT_TOP = 120.0
CONTENT_BOTTOM = 660.0
CONTENT_PAD_X = 48.0


@dataclass(frozen=True)
class Rect:
    """轴对齐包围盒。"""

    x: float
    y: float
    width: float
    height: float

    @property
    def right(self) -> float:
        return self.x + self.width

    @property
    def bottom(self) -> float:
        return self.y + self.height

    def __repr__(self) -> str:
        return f"Rect(x={self.x:.1f}, y={self.y:.1f}, w={self.width:.1f}, h={self.height:.1f})"


#: Slide children 布局容器（B 区）
SLIDE_CONTENT_RECT = Rect(CONTENT_PAD_X, CONTENT_TOP, CANVAS_WIDTH - 2 * CONTENT_PAD_X, CONTENT_BOTTOM - CONTENT_TOP)
CANVAS_RECT = Rect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)


@dataclass
class ResolvedStyle:
    """解析后的样式（引擎内部表示）。"""

    flex_direction: str = "column"
    gap: float = 0.0
    justify_content: str = "flex-start"
    align_items: str = "stretch"
    flex: int = 0
    width: Optional[Length | Percent] = None
    height: Optional[Length | Percent] = None
    min_width: Optional[Length | Percent] = None
    max_width: Optional[Length | Percent] = None
    min_height: Optional[Length | Percent] = None
    max_height: Optional[Length | Percent] = None
    padding: float = 0.0
    margin_top: float = 0.0
    margin_bottom: float = 0.0
    margin_left: float = 0.0
    margin_right: float = 0.0
    background: Optional[Color | Gradient] = None
    border_radius: float = 0.0
    border: Optional[Border] = None
    box_shadow: Optional[BoxShadow] = None
    opacity: float = 1.0
    z_index: int = 0
    position: str = "static"
    top: Optional[float] = None
    left: Optional[float] = None
    right: Optional[float] = None
    bottom: Optional[float] = None

    # Text 专属
    font_size: float = 18.0
    font_weight: str = "normal"
    line_height: float = 1.3
    letter_spacing: float = 0.0
    text_align: str = "left"
    color: Optional[Color] = None

    @property
    def border_w(self) -> float:
        return self.border.width if self.border is not None else 0.0

    @property
    def is_relative(self) -> bool:
        return self.position == "relative"


def _resolve_style(component) -> ResolvedStyle:
    """组件 style dict → ResolvedStyle（复用 styles.py 解析函数）。"""
    s = component.style
    st = ResolvedStyle()
    if "flexDirection" in s:
        st.flex_direction = s["flexDirection"]
    if "gap" in s:
        v = parse_length(s["gap"], "gap")
        st.gap = v.value if isinstance(v, Length) else 0.0
    if "justifyContent" in s:
        st.justify_content = s["justifyContent"]
    if "alignItems" in s:
        st.align_items = s["alignItems"]
    if "flex" in s:
        st.flex = int(s["flex"])
    if "width" in s:
        st.width = parse_length(s["width"], "width")
    if "height" in s:
        st.height = parse_length(s["height"], "height")
    for prop, attr in (
        ("minWidth", "min_width"), ("maxWidth", "max_width"),
        ("minHeight", "min_height"), ("maxHeight", "max_height"),
    ):
        if prop in s:
            st.__setattr__(attr, parse_length(s[prop], prop))
    if "padding" in s:
        v = parse_length(s["padding"], "padding")
        st.padding = v.value if isinstance(v, Length) else 0.0
    # margin 简写优先解析，显式单边覆盖
    if "margin" in s:
        m: Margins = parse_margin(s["margin"], "margin")
        st.margin_top, st.margin_right, st.margin_bottom, st.margin_left = m.top, m.right, m.bottom, m.left
    for prop, attr in (
        ("marginTop", "margin_top"), ("marginBottom", "margin_bottom"),
        ("marginLeft", "margin_left"), ("marginRight", "margin_right"),
    ):
        if prop in s:
            v = parse_length(s[prop], prop)
            st.__setattr__(attr, v.value if isinstance(v, Length) else 0.0)
    if "background" in s:
        st.background = parse_background(s["background"], "background")
    if "borderRadius" in s:
        v = parse_length(s["borderRadius"], "borderRadius")
        st.border_radius = v.value if isinstance(v, Length) else 0.0
    if "border" in s:
        st.border = parse_border(s["border"], "border")
    if "boxShadow" in s:
        st.box_shadow = parse_box_shadow(s["boxShadow"], "boxShadow")
    if "opacity" in s:
        st.opacity = float(s["opacity"])
    if "zIndex" in s:
        st.z_index = int(s["zIndex"])
    if "position" in s:
        st.position = s["position"]
    for prop, attr in (("top", "top"), ("left", "left"), ("right", "right"), ("bottom", "bottom")):
        if prop in s:
            v = parse_length(s[prop], prop)
            st.__setattr__(attr, v.value if isinstance(v, Length) else 0.0)
    # color 对 Text/FAIcon/Math 有效
    if "color" in s:
        st.color = parse_color(s["color"], "color")
    if isinstance(component, Text):
        st.font_size = float(s.get("fontSize", 18))
        st.font_weight = s.get("fontWeight", "normal")
        st.line_height = float(s.get("lineHeight", 1.3))
        st.letter_spacing = float(s.get("letterSpacing", 0.0))
        st.text_align = s.get("textAlign", "left")
    return st


@dataclass
class LayoutNode:
    """布局树节点：组件 + 解析样式 + 计算结果。"""

    id: int
    component: Box | Text | Slide
    kind: str  # "slide" | "box" | "text"
    style: ResolvedStyle
    children: list["LayoutNode"] = field(default_factory=list)
    parent: Optional["LayoutNode"] = None
    # measure 结果（固有尺寸，不含拉伸）
    measured_w: float = 0.0
    measured_h: float = 0.0
    # arrange 结果
    rect: Optional[Rect] = None
    # 文本缓存
    _text_lines: Optional[list[str]] = None

    @property
    def label(self) -> str:
        _labels = {
            "text": lambda: f"Text({self.component.text[:12]!r})",
            "chart": lambda: f"Chart({self.component.chart_type})",
            "image": lambda: f"Image({self.component.src[:20]!r})",
            "table": lambda: f"Table({len(self.component.data)}×{len(self.component.data[0]) if self.component.data else 0})",
            "icon": lambda: f"FAIcon({self.component.name!r})",
            "svg": lambda: "SVG",
            "qrcode": lambda: f"QRCode({self.component.value[:12]!r})",
            "codeblock": lambda: f"CodeBlock({self.component.language})",
            "math": lambda: f"Math({self.component.latex[:20]!r})",
        }
        fn = _labels.get(self.kind)
        if fn:
            return fn()
        return "Box" if self.kind == "box" else "Slide"


def build_tree(component: Box | Text | Slide, parent: Optional[LayoutNode] = None, ids: Optional[Iterator[int]] = None) -> LayoutNode:
    """组件树 → 布局树（解析样式、分配 id、建立父子链）。"""
    if ids is None:
        ids = iter(count())
    _kind_map = {
        "Slide": "slide", "Box": "box", "Text": "text", "Chart": "chart",
        "Image": "image", "Table": "table", "FAIcon": "icon",
        "SVG": "svg", "QRCode": "qrcode", "CodeBlock": "codeblock", "Math": "math",
    }
    kind = _kind_map[component.type]
    node = LayoutNode(id=next(ids), component=component, kind=kind, style=_resolve_style(component), parent=parent)
    for child in getattr(component, "children", []):
        cnode = build_tree(child, parent=node, ids=ids)
        node.children.append(cnode)
    return node


def flatten(node: LayoutNode) -> list[LayoutNode]:
    """按 id 顺序摊平。"""
    out: list[LayoutNode] = []

    def _walk(n: LayoutNode) -> None:
        out.append(n)
        for c in n.children:
            _walk(c)

    _walk(node)
    out.sort(key=lambda n: n.id)
    return out


# ---------------------------------------------------------------- measure

def _resolve_dim(value: Optional[Length | Percent], container_len: float) -> Optional[float]:
    """解析长度：Length → 数值；Percent → container_len × pct；None → None。"""
    if value is None:
        return None
    if isinstance(value, Percent):
        return container_len * value.value / 100.0
    return value.value


#: 叶子节点类型 → 默认尺寸 (w, h)
_LEAF_DEFAULT_SIZES: dict[str, tuple[float, float]] = {
    "chart": (480.0, 320.0),
    "image": (400.0, 300.0),
    "table": (600.0, 300.0),
    "icon": (48.0, 48.0),
    "svg": (400.0, 300.0),
    "qrcode": (200.0, 200.0),
    "codeblock": (600.0, 400.0),
    "math": (400.0, 100.0),
}

#: 全部叶子节点 kind 集合（不含 text，text 单独处理）
_LEAF_KINDS = set(_LEAF_DEFAULT_SIZES.keys())


def _clamp_measure(value: float, minv: Optional[Length | Percent], maxv: Optional[Length | Percent]) -> float:
    """measure 阶段夹取：仅 Length 生效（Percent 在容器尺寸未知时跳过）。"""
    if minv is not None and isinstance(minv, Length) and value < minv.value:
        value = minv.value
    if maxv is not None and isinstance(maxv, Length) and value > maxv.value:
        value = maxv.value
    return value


def measure(node: LayoutNode) -> None:
    """自底向上计算固有尺寸（后序遍历）。"""
    st = node.style

    if node.kind == "text":
        text = node.component.text  # type: ignore[attr-defined]
        width_limit: Optional[float] = None
        explicit_w = _resolve_dim(st.width, 0.0)
        if explicit_w is not None and explicit_w > 0:
            width_limit = explicit_w
        m = measure_text(text, width_limit or 0.0, st.font_size, st.line_height, st.letter_spacing)
        node.measured_w = explicit_w if explicit_w is not None else m.width
        node.measured_h = m.height
        node._text_lines = None  # arrange 时按最终宽度重新测量
        return

    if node.kind in _LEAF_KINDS:
        # 叶子节点：尺寸由显式 width/height 决定，缺省取组件默认值
        default_w, default_h = _LEAF_DEFAULT_SIZES[node.kind]
        explicit_w = _resolve_dim(st.width, 0.0)
        explicit_h = _resolve_dim(st.height, 0.0)
        node.measured_w = explicit_w if explicit_w is not None else default_w
        node.measured_h = explicit_h if explicit_h is not None else default_h
        return

    # 容器：先 measure children
    for child in node.children:
        measure(child)

    if st.flex_direction == "row":
        content_w = sum(c.measured_w + c.style.margin_left + c.style.margin_right for c in node.children)
        content_w += st.gap * max(len(node.children) - 1, 0)
        content_h = max(
            (c.measured_h + c.style.margin_top + c.style.margin_bottom for c in node.children), default=0.0
        )
    else:  # column
        content_h = sum(c.measured_h + c.style.margin_top + c.style.margin_bottom for c in node.children)
        content_h += st.gap * max(len(node.children) - 1, 0)
        content_w = max(
            (c.measured_w + c.style.margin_left + c.style.margin_right for c in node.children), default=0.0
        )

    explicit_w = _resolve_dim(st.width, 0.0)
    explicit_h = _resolve_dim(st.height, 0.0)
    extra = 2 * (st.padding + st.border_w)
    node.measured_w = _clamp_measure(
        explicit_w if explicit_w is not None else content_w + extra, st.min_width, st.max_width
    )
    node.measured_h = _clamp_measure(
        explicit_h if explicit_h is not None else content_h + extra, st.min_height, st.max_height
    )


# ---------------------------------------------------------------- arrange

def _text_measure(node: LayoutNode, width_limit: float) -> tuple[float, float, int]:
    """在指定宽度下测量文本（换行）。"""
    text = node.component.text  # type: ignore[attr-defined]
    m = measure_text(text, width_limit, node.style.font_size, node.style.line_height, node.style.letter_spacing)
    return m.width, m.height, m.lines


def _check_overflow(node: LayoutNode) -> None:
    """节点 rect 超出画布 → LAYOUT_OVERFLOW（分配点统一检查）。"""
    assert node.rect is not None
    r = node.rect
    if r.right > CANVAS_WIDTH + 0.01 or r.bottom > CANVAS_HEIGHT + 0.01 or r.x < -0.01 or r.y < -0.01:
        exceed = max(r.right - CANVAS_WIDTH, r.bottom - CANVAS_HEIGHT, -r.x, -r.y, 0.0)
        raise layout_error(
            ErrorCode.LAYOUT_OVERFLOW,
            node=node.label,
            exceed=round(exceed, 1),
            canvas=720,
        )


def _clamp_dim(
    value: float,
    minv: Optional[Length | Percent],
    maxv: Optional[Length | Percent],
    container_len: float,
) -> float:
    """arrange 阶段夹取尺寸：Length 直接取，Percent 相对 container_len。"""
    if minv is not None:
        lo = minv.value if isinstance(minv, Length) else container_len * minv.value / 100.0
        if value < lo:
            value = lo
    if maxv is not None:
        hi = maxv.value if isinstance(maxv, Length) else container_len * maxv.value / 100.0
        if value > hi:
            value = hi
    return value


def arrange(node: LayoutNode, rect: Rect) -> None:
    """自顶向下分配坐标。rect 为节点的内容盒（不含 margin）。"""
    node.rect = rect
    st = node.style
    inset = st.padding + st.border_w
    content_rect = Rect(
        rect.x + inset,
        rect.y + inset,
        max(rect.width - 2 * inset, 0.0),
        max(rect.height - 2 * inset, 0.0),
    )

    static = [c for c in node.children if c.style.position != "absolute"]
    absolutes = [c for c in node.children if c.style.position == "absolute"]

    if static:
        _arrange_children(node, static, content_rect)

    # absolute 子项：相对父 padding box（rect 内缩 border）定位
    b = st.border_w
    abs_rect = Rect(rect.x + b, rect.y + b, max(rect.width - 2 * b, 0.0), max(rect.height - 2 * b, 0.0))
    for child in absolutes:
        _arrange_absolute(child, abs_rect)

    # 递归 static 子项（absolute 子项内部也要排）
    for child in static:
        if child.kind != "text" and child.rect is not None:
            arrange(child, child.rect)
    for child in absolutes:
        if child.kind != "text" and child.rect is not None:
            arrange(child, child.rect)


def _arrange_children(parent: LayoutNode, children: list[LayoutNode], content: Rect) -> None:
    """主轴 + 交叉轴分配。"""
    st = parent.style
    is_row = st.flex_direction == "row"
    main_len = content.width if is_row else content.height
    cross_len = content.height if is_row else content.width
    gap = st.gap

    def m_main(c: LayoutNode) -> float:
        return c.style.margin_left + c.style.margin_right if is_row else c.style.margin_top + c.style.margin_bottom

    def m_start(c: LayoutNode) -> float:
        return c.style.margin_left if is_row else c.style.margin_top

    def m_end(c: LayoutNode) -> float:
        return c.style.margin_right if is_row else c.style.margin_bottom

    def m_cross(c: LayoutNode) -> float:
        return c.style.margin_top + c.style.margin_bottom if is_row else c.style.margin_left + c.style.margin_right

    def m_cross_start(c: LayoutNode) -> float:
        return c.style.margin_top if is_row else c.style.margin_left

    # ---- 1. 计算各子项主轴尺寸 ----
    sizes: list[float] = []
    flex_sum = 0
    fixed_sum = 0.0
    for i, c in enumerate(children):
        explicit = _resolve_dim(c.style.width if is_row else c.style.height, main_len)
        if c.style.flex > 0 and explicit is None:
            flex_sum += c.style.flex
            sizes.append(0.0)
        elif explicit is not None:
            sizes.append(explicit)
            fixed_sum += explicit
        else:
            sizes.append(c.measured_w if is_row else c.measured_h)
            fixed_sum += sizes[-1]

    fixed_sum += sum(m_main(c) for c in children) + gap * max(len(children) - 1, 0)
    remaining = main_len - fixed_sum
    if flex_sum and remaining > 0:
        unit = remaining / flex_sum
        for i, c in enumerate(children):
            if c.style.flex > 0 and _resolve_dim(c.style.width if is_row else c.style.height, main_len) is None:
                sizes[i] = unit * c.style.flex
    for i, c in enumerate(children):
        if c.style.flex > 0 and sizes[i] <= 0:
            sizes[i] = 0.0
    # 主轴尺寸 clamp（min/max）
    for i, c in enumerate(children):
        sizes[i] = _clamp_dim(
            sizes[i],
            c.style.min_width if is_row else c.style.min_height,
            c.style.max_width if is_row else c.style.max_height,
            main_len,
        )

    # ---- 2. 主轴起点 ----
    total = sum(sizes[i] + m_main(children[i]) for i in range(len(children))) + gap * max(len(children) - 1, 0)
    free = main_len - total
    justify = st.justify_content
    offset = 0.0
    extra_gap = 0.0
    if justify == "flex-end":
        offset = max(free, 0.0)
    elif justify == "center":
        offset = max(free, 0.0) / 2
    elif justify == "space-between" and len(children) > 1:
        extra_gap = max(free, 0.0) / (len(children) - 1)
    elif justify == "space-around":
        extra_gap = max(free, 0.0) / len(children)
        offset = extra_gap / 2

    # ---- 3. 逐子项定位 ----
    cursor = offset
    for i, c in enumerate(children):
        size = sizes[i]
        cursor += m_start(c)

        # 交叉轴尺寸（row：垂直方向；column：水平方向）
        explicit_cross = _resolve_dim(c.style.height if is_row else c.style.width, cross_len)
        cross_size = explicit_cross
        if cross_size is None:
            if st.align_items == "stretch":
                cross_size = max(cross_len - m_cross(c), 0.0)
            else:
                cross_size = c.measured_h if is_row else c.measured_w
        # 交叉轴尺寸 clamp（min/max）
        cross_size = _clamp_dim(
            cross_size,
            c.style.min_height if is_row else c.style.min_width,
            c.style.max_height if is_row else c.style.max_width,
            cross_len,
        )

        # 交叉轴起点（绝对坐标）
        cross_base = content.y if is_row else content.x
        avail = max(cross_len - m_cross(c), 0.0)
        if st.align_items in ("flex-start", "stretch"):
            cross_pos = cross_base + m_cross_start(c)
        elif st.align_items == "flex-end":
            cross_pos = cross_base + m_cross_start(c) + (avail - cross_size)
        else:  # center
            cross_pos = cross_base + m_cross_start(c) + (avail - cross_size) / 2

        # 主轴起点（绝对坐标）
        main_pos = (content.x if is_row else content.y) + cursor

        if is_row:
            x, y, w = main_pos, cross_pos, size
            box_h = cross_size
        else:
            x, y, w = cross_pos, main_pos, cross_size
            box_h = size

        if c.kind == "text":
            # 文本：宽度已知，高度按换行重测
            _, h, _ = _text_measure(c, w)
            c.rect = Rect(x, y, w, h)
            c.measured_h = h
            size = h  # 更新主轴尺寸，确保 cursor 按实际高度推进
        else:
            c.rect = Rect(x, y, w, box_h)

        # relative：相对自身原位偏移（top/left 优先于 bottom/right）
        if c.style.is_relative:
            ox = c.style.left if c.style.left is not None else (-c.style.right if c.style.right is not None else 0.0)
            oy = c.style.top if c.style.top is not None else (-c.style.bottom if c.style.bottom is not None else 0.0)
            if ox or oy:
                c.rect = Rect(c.rect.x + ox, c.rect.y + oy, c.rect.width, c.rect.height)

        cursor += size + m_end(c) + gap + extra_gap

        # 分配点统一检查溢出（覆盖 Text / absolute / stretch 拉伸 / relative 偏移等所有路径）
        _check_overflow(c)


def _arrange_absolute(node: LayoutNode, container: Rect) -> None:
    """absolute 子项：top/left/right/bottom 相对父 padding box。"""
    st = node.style
    w = _resolve_dim(st.width, container.width) or node.measured_w
    h = _resolve_dim(st.height, container.height) or node.measured_h

    if st.left is not None:
        x = container.x + st.left
    elif st.right is not None:
        x = container.right - w - st.right
    else:
        x = container.x
    if st.top is not None:
        y = container.y + st.top
    elif st.bottom is not None:
        y = container.bottom - h - st.bottom
    else:
        y = container.y

    node.rect = Rect(x, y, w, h)
    _check_overflow(node)


# ---------------------------------------------------------------- 入口

@dataclass
class LayoutResult:
    """布局结果：根节点 + 摊平节点表 + 画布。"""

    root: LayoutNode
    nodes: list[LayoutNode]
    canvas: Rect = CANVAS_RECT

    def rect_of(self, node_id: int) -> Rect:
        for n in self.nodes:
            if n.id == node_id:
                assert n.rect is not None
                return n.rect
        raise KeyError(node_id)


def layout_slide(slide: Slide) -> LayoutResult:
    """Slide → 布局结果。children 布局于 B 区容器（Slide 自身按 flex 规则分配）。"""
    root = build_tree(slide)
    measure(root)
    root.rect = CANVAS_RECT
    content_rect = SLIDE_CONTENT_RECT

    static = [c for c in root.children if c.style.position != "absolute"]
    absolutes = [c for c in root.children if c.style.position == "absolute"]

    # Slide 本身是 flex 容器：children 经 _arrange_children 分配（支持 flexDirection 等）
    if static:
        _arrange_children(root, static, content_rect)
    for child in absolutes:
        _arrange_absolute(child, CANVAS_RECT)

    # 递归 static/absolute 子项内部
    for child in static + absolutes:
        if child.kind != "text" and child.rect is not None:
            arrange(child, child.rect)

    return LayoutResult(root=root, nodes=flatten(root))


def layout_node(component: Box | Text, container: Rect) -> LayoutResult:
    """通用入口（测试/组件库用）：任意组件在指定容器内布局。"""
    root = build_tree(component)
    measure(root)
    root.rect = container
    arrange(root, container)
    return LayoutResult(root=root, nodes=flatten(root))
