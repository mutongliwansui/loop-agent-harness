"""OOXML 高级样式：python-pptx 不直接支持的填充效果（T1.3）。

- 线性渐变（角度映射 CSS linear-gradient）
- 半透明填充（alpha）
- 外阴影（outerShdw）

全部通过 lxml 直接 patch ``p:spPr`` 实现，样式映射集中在样式表（style_map 思想）。
"""

from __future__ import annotations

from typing import Optional

from pptx.dml.color import RGBColor
from pptx.oxml.ns import qn
from pptx.shapes.base import BaseShape

from slidep.dsl.styles import Color, Gradient

#: CSS linear-gradient 角度 → OOXML a:lin ang（1/60000 度，逆时针，0=右）。
#: OOXML ang = (90 - css_angle) mod 360。
DEG_TO_OXML = 60000


def _srgb_clr(parent, color: Color) -> None:
    el = parent.makeelement(qn("a:srgbClr"), {"val": f"{color.r:02X}{color.g:02X}{color.b:02X}"})
    parent.append(el)
    return el


def _set_alpha(rgb_el, alpha: int) -> None:
    """给 srgbClr 加 alpha 子元素（alpha 0-255，255=不透明）。"""
    if alpha >= 255:
        return
    a = rgb_el.makeelement(qn("a:alpha"), {"val": str(int(alpha / 255 * 100000))})
    rgb_el.append(a)


def apply_gradient(shape: BaseShape, gradient: Gradient, opacity: float = 1.0) -> None:
    """线性渐变填充。角度按 CSS linear-gradient 语义近似映射。opacity 乘到两端 stop。"""
    fill = shape.fill
    fill.gradient()
    stops = fill.gradient_stops
    stops[0].position = 0.0
    stops[0].color.rgb = RGBColor(gradient.start.r, gradient.start.g, gradient.start.b)
    stops[1].position = 1.0
    stops[1].color.rgb = RGBColor(gradient.end.r, gradient.end.g, gradient.end.b)

    grad_fill = fill._xPr.find(qn("a:gradFill"))
    if grad_fill is None:
        return
    lin = grad_fill.find(qn("a:lin"))
    if lin is None:
        lin = grad_fill.makeelement(qn("a:lin"), {})
        grad_fill.insert(0, lin)
    ooxml_angle = (90 - gradient.angle) % 360
    lin.set("ang", str(ooxml_angle * DEG_TO_OXML))

    # 渐变端点透明度（组件 opacity 与颜色自带 alpha 相乘）
    start_a = round(gradient.start.a * opacity)
    end_a = round(gradient.end.a * opacity)
    if start_a < 255:
        _apply_stop_alpha(grad_fill, 0, start_a)
    if end_a < 255:
        _apply_stop_alpha(grad_fill, 1, end_a)


def _apply_stop_alpha(grad_fill, stop_index: int, alpha: int) -> None:
    gs_lst = grad_fill.find(qn("a:gsLst"))
    if gs_lst is None:
        return
    stops = gs_lst.findall(qn("a:gs"))
    if stop_index < len(stops):
        srgb = stops[stop_index].find(qn("a:srgbClr"))
        if srgb is not None:
            _set_alpha(srgb, alpha)


def apply_solid_alpha(shape: BaseShape, alpha: int) -> None:
    """纯色填充透明度（alpha 0-255）。"""
    if alpha >= 255:
        return
    fill = shape.fill
    srgb = fill.fore_color._xFill.find(qn("a:srgbClr"))
    if srgb is not None:
        _set_alpha(srgb, alpha)


def apply_shadow(shape: BaseShape, *, blur_px: float = 9.0, dist_px: float = 4.0, alpha: int = 76) -> None:
    """默认外阴影（向下）。blur/dist 单位 px，alpha 0-255。"""
    sp_pr = shape._element.spPr
    effect_lst = sp_pr.makeelement(qn("a:effectLst"), {})
    # 移除已有 effectLst
    for old in sp_pr.findall(qn("a:effectLst")):
        sp_pr.remove(old)
    shadow = effect_lst.makeelement(
        qn("a:outerShdw"),
        {
            "blurRad": str(round(blur_px * 9525)),
            "dist": str(round(dist_px * 9525)),
            "dir": "5400000",  # 90°：向下
            "rotWithShape": "0",
        },
    )
    rgb = _srgb_clr(shadow, Color(0, 0, 0))
    _set_alpha(rgb, alpha)
    effect_lst.append(shadow)
    sp_pr.append(effect_lst)


def remove_shadow(shape: BaseShape) -> None:
    """关闭 python-pptx 默认阴影（shape 自带的 inherit 阴影）。"""
    shape.shadow.inherit = False


def patch_text_spacing(run, letter_spacing_px: Optional[float]) -> None:
    """给 run 的 rPr 设 spc（1/100 pt）。"""
    if not letter_spacing_px:
        return
    from .units import spc

    r_pr = run._r.get_or_add_rPr()
    r_pr.set("spc", str(spc(letter_spacing_px)))
