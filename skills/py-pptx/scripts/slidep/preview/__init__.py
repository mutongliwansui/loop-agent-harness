"""预览层（T4.2）：SVG 矢量预览 + HTTP 服务 + SSE 实时推送。

公共 API：
- ``render_slide_svg`` / ``render_slides_svg``：布局结果 → SVG 字符串
- ``PreviewServer``：FastAPI HTTP 服务（画廊 + SSE 自动刷新）

无 LibreOffice 依赖：纯 SVG 矢量预览，速度更快且无需安装额外软件。
"""

from .server import PreviewServer
from .svg_renderer import render_slide_svg, render_slides_svg

__all__ = [
    "render_slide_svg",
    "render_slides_svg",
    "PreviewServer",
]
