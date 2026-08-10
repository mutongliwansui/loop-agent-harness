"""渲染层：OOXML 渲染器（T1.3 + T2.2）。

公共入口：``render_deck(slides, output_path, options=...)``

组件渲染器：
- Box/Text/Chart → engine.py（T1.3）
- Image/Table/FAIcon/SVG/QRCode/CodeBlock/Math → 各自模块（T2.2）

matplotlib 为可选依赖：
- 未安装时 slidep.render 可正常导入，Chart/Table/Image/QRCode/Text/Box 正常工作
- FAIcon/SVG/CodeBlock/Math 的 PNG 渲染需要 matplotlib，缺失时调用报错
"""

from .advanced import apply_gradient, apply_shadow, apply_solid_alpha, patch_text_spacing, remove_shadow
from .chart import DEFAULT_PALETTE, add_native_chart
from .engine import RenderOptions, render_deck
from .image import render_image_png
from .master import needs_footer, render_footer, render_title
from .qrcode_render import render_qrcode_png
from .table_render import render_table
from .units import PX_TO_EMU, SLIDE_H_EMU, SLIDE_W_EMU, emu, pt, spc

__all__ = [
    "render_deck",
    "RenderOptions",
    # Chart
    "add_native_chart",
    "DEFAULT_PALETTE",
    # 媒体组件
    "render_image_png",
    "render_table",
    "render_qrcode_png",
    # 高级样式
    "apply_gradient",
    "apply_shadow",
    "apply_solid_alpha",
    "patch_text_spacing",
    "remove_shadow",
    "render_title",
    "render_footer",
    "needs_footer",
    # 单位转换
    "emu",
    "pt",
    "spc",
    "PX_TO_EMU",
    "SLIDE_W_EMU",
    "SLIDE_H_EMU",
]


def __getattr__(name: str):
    """延迟导入 matplotlib 依赖的组件（PEP 562）。"""
    if name == "render_chart_png":
        from .chart import render_chart_png
        return render_chart_png
    if name == "render_icon_png":
        from .icon import ICONS, render_icon_png
        return render_icon_png
    if name == "ICONS":
        from .icon import ICONS
        return ICONS
    if name == "render_svg_png":
        from .svg_render import render_svg_png
        return render_svg_png
    if name == "render_codeblock_png":
        from .codeblock import render_codeblock_png
        return render_codeblock_png
    if name == "render_math_png":
        from .math_render import render_math_png
        return render_math_png
    raise AttributeError(f"module 'slidep.render' has no attribute {name!r}")
