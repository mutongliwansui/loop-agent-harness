"""单位换算：布局像素坐标 → OOXML EMU（T1.3）。

画布固定 1280×720px，输出 16:9 幻灯片（13.3333×7.5 in）。
1px = 13.3333in / 1280 = 1/96 in = 9525 EMU（与 96dpi 一致）。
"""

from __future__ import annotations

#: 每像素的 EMU 数（1280px / 13.3333in × 914400 EMU/in）
PX_TO_EMU = 914400 * (13 + 1 / 3) / 1280  # == 9525.0
#: 幻灯片尺寸（EMU）：16:9 = 13.3333in × 7.5in = 12192000 × 6858000
SLIDE_W_EMU = 12_192_000
SLIDE_H_EMU = 6_858_000


def emu(value: float) -> int:
    """px → EMU（四舍五入到整数）。"""
    return round(value * PX_TO_EMU)


def pt(value: float) -> float:
    """px → pt（1px @96dpi = 0.75pt）。"""
    return value * 72 / 96


def spc(value: float) -> int:
    """letterSpacing px → OOXML spc（1/100 pt）。"""
    return round(pt(value) * 100)
