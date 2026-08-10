"""DSL 样式系统：值解析与白名单校验（T1.1）。

- ``Color`` / ``Gradient`` / ``Percent``：样式值的规范化表示
- ``STYLE_WHITELIST``：按组件类型的允许样式键表（单一数据源）
- ``validate_style()``：白名单 + 值合法性校验，违规抛 ``SlidepUserError``

校验原则（对齐 references/component-box.md）：
- 未知样式属性 → 明确报错（含属性名），禁止静默忽略
- ``display: grid`` / ``calc()`` / ``flexWrap`` 等不支持的 CSS → 明确报错
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

from slidep import ErrorCode, dsl_error

# ---------------------------------------------------------------- 值类型

_HEX_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_GRADIENT_RE = re.compile(
    r"^linear-gradient\(\s*(\d{1,3})deg\s*,\s*(#[0-9a-fA-F]{3,8})\s*,\s*(#[0-9a-fA-F]{3,8})\s*\)$"
)

NAMED_COLORS: dict[str, tuple[int, int, int]] = {
    "black": (0, 0, 0),
    "white": (255, 255, 255),
    "red": (229, 72, 77),
    "green": (46, 160, 67),
    "blue": (24, 119, 242),
    "gray": (128, 128, 128),
    "transparent": (0, 0, 0, 0),
}


@dataclass(frozen=True)
class Color:
    """RGBA 颜色。#RGB/#RRGGBB/#RRGGBBAA 或内置命名色。"""

    r: int
    g: int
    b: int
    a: int = 255

    @property
    def hex6(self) -> str:
        return f"#{self.r:02x}{self.g:02x}{self.b:02x}"

    @property
    def hex8(self) -> str:
        return f"{self.hex6}{self.a:02x}"


@dataclass(frozen=True)
class Gradient:
    """线性渐变（仅 background 允许）。angle 单位 deg，默认 180。"""

    start: Color
    end: Color
    angle: int = 180


@dataclass(frozen=True)
class Percent:
    """百分比长度（相对父容器）。value 为 0-100 数值。"""

    value: float


@dataclass(frozen=True)
class Length:
    """px 长度。"""

    value: float


@dataclass(frozen=True)
class Margins:
    """四方向外边距（px）。margin 简写解析结果。"""

    top: float = 0.0
    right: float = 0.0
    bottom: float = 0.0
    left: float = 0.0


@dataclass(frozen=True)
class Border:
    """边框：宽度 + 颜色。style 固定 solid。"""

    width: float
    color: "Color"


@dataclass(frozen=True)
class BoxShadow:
    """外阴影（向下）：offset_x / offset_y / blur / alpha(0-255)。"""

    offset_x: float = 0.0
    offset_y: float = 4.0
    blur: float = 9.0
    alpha: int = 76


# ---------------------------------------------------------------- 解析函数

def parse_length(value: Any, prop: str) -> Length | Percent:
    """解析长度值：数值 / 'Npx' → Length；'N%' → Percent。"""
    if isinstance(value, (int, float)):
        if value < 0:
            raise dsl_error(ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=repr(value), reason="长度不能为负")
        return Length(float(value))
    if isinstance(value, str):
        s = value.strip()
        if s.endswith("%"):
            try:
                num = float(s[:-1])
            except ValueError:
                num = float("nan")
            if num != num or not (0 <= num <= 100):
                raise dsl_error(
                    ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=value, reason="百分比必须在 0-100 之间"
                )
            return Percent(num)
        if s.endswith("px"):
            try:
                num = float(s[:-2])
            except ValueError:
                num = float("nan")
            if num != num or num < 0:
                raise dsl_error(ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=value, reason="px 数值非法")
            return Length(num)
    raise dsl_error(ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=repr(value), reason="长度须为数值 / 'Npx' / 'N%'")


def _hex_to_color(hex_str: str) -> Color:
    h = hex_str.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    a = int(h[6:8], 16) if len(h) == 8 else 255
    return Color(r, g, b, a)


def parse_color(value: Any, prop: str) -> Color:
    """解析颜色：#hex / 命名色。"""
    if isinstance(value, str):
        s = value.strip()
        if _HEX_RE.match(s):
            return _hex_to_color(s)
        if s.lower() in NAMED_COLORS:
            t = NAMED_COLORS[s.lower()]
            return Color(*t) if len(t) == 3 else Color(*t)
    raise dsl_error(ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=repr(value), reason="颜色须为 #hex 或内置命名色")


def parse_background(value: Any, prop: str) -> Color | Gradient:
    """解析背景：纯色或 linear-gradient。"""
    if isinstance(value, str):
        m = _GRADIENT_RE.match(value.strip())
        if m:
            return Gradient(_hex_to_color(m.group(2)), _hex_to_color(m.group(3)), int(m.group(1)))
    return parse_color(value, prop)


def _parse_side(value: Any, prop: str) -> float:
    """单个边值：数值 / 'Npx' / 纯数字字符串（不允许百分比）。"""
    if isinstance(value, str) and re.fullmatch(r"\d+(?:\.\d+)?", value.strip()):
        value = float(value.strip())
    v = parse_length(value, prop)
    if isinstance(v, Percent):
        raise dsl_error(ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=repr(value), reason="margin 不允许百分比")
    return v.value


def parse_margin(value: Any, prop: str) -> Margins:
    """margin 简写：1/2/3/4 个值（top, right, bottom, left）。"""
    if isinstance(value, str) and value.strip() and " " in value.strip():
        parts = [p for p in value.strip().split() if p]
    else:
        parts = [value]
    if len(parts) not in (1, 2, 3, 4):
        raise dsl_error(ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=repr(value), reason="margin 须为 1-4 个值")
    sides = [_parse_side(p, prop) for p in parts]
    if len(sides) == 1:
        t = r = b = l = sides[0]
    elif len(sides) == 2:
        t, r, b, l = sides[0], sides[1], sides[0], sides[1]
    elif len(sides) == 3:
        t, r, b, l = sides[0], sides[1], sides[2], sides[1]
    else:
        t, r, b, l = sides
    return Margins(top=t, right=r, bottom=b, left=l)


def parse_border(value: Any, prop: str) -> Border:
    """border 简写：'<width>px solid <color>'。width 必填，style 可选（固定 solid）。"""
    if not isinstance(value, str):
        raise dsl_error(ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=repr(value), reason="border 须为字符串")
    tokens = value.strip().split()
    if len(tokens) < 2:
        raise dsl_error(ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=value, reason="border 须为 '<width>px <color>' 格式")
    width = _parse_side(tokens[0], prop)
    color = parse_color(tokens[-1], prop)
    if len(tokens) == 3 and tokens[1] != "solid":
        raise dsl_error(ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=value, reason="border 仅支持 solid 样式")
    return Border(width=width, color=color)


def parse_box_shadow(value: Any, prop: str) -> BoxShadow:
    """boxShadow 简写：'<offsetX>px <offsetY>px <blur>px <alpha 0-255 | rgba()>'。

    例：'4px 4px 12px 76'、'0 4px 8px rgba(0,0,0,0.3)'。offsetX 在 OOXML 中近似忽略。
    """
    if not isinstance(value, str):
        raise dsl_error(ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=repr(value), reason="boxShadow 须为字符串")
    tokens = value.strip().split()
    if len(tokens) < 3 or len(tokens) > 4:
        raise dsl_error(ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=value, reason="boxShadow 须为 '<x>px <y>px <blur>px [alpha]'")
    try:
        nums = [float(t.replace("px", "")) for t in tokens[:3]]
    except ValueError:
        raise dsl_error(ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=value, reason="boxShadow 前三项须为 px 数值") from None
    if any(n < 0 for n in nums):
        raise dsl_error(ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=value, reason="boxShadow 数值不能为负")
    alpha: int = 76
    if len(tokens) == 4:
        last = tokens[3]
        m = re.match(r"^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$", last)
        if m:
            a = float(m.group(4))
            if not (0 <= a <= 1):
                raise dsl_error(ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=value, reason="rgba alpha 须在 0-1")
            alpha = round(a * 255)
        else:
            try:
                alpha = int(float(last.replace("px", "")))
            except ValueError:
                raise dsl_error(ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=value, reason="boxShadow alpha 须为 0-255 数值或 rgba()") from None
            if not (0 <= alpha <= 255):
                raise dsl_error(ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=value, reason="boxShadow alpha 须在 0-255")
    return BoxShadow(offset_x=nums[0], offset_y=nums[1], blur=nums[2], alpha=alpha)


# ---------------------------------------------------------------- 白名单与枚举

#: 组件类型 → 允许的样式键（集中管理，与 references/component-*.md 对齐）
_BOX_LAYOUT_KEYS = {
    "width", "height", "marginTop", "marginBottom", "marginLeft", "marginRight", "margin",
    "padding", "flexDirection", "gap", "justifyContent", "alignItems", "flex",
    "minWidth", "maxWidth", "minHeight", "maxHeight",
    "background", "borderRadius", "border", "boxShadow", "opacity", "zIndex",
    "position", "top", "left", "right", "bottom",
}

STYLE_WHITELIST: dict[str, set[str]] = {
    # Slide 本身是 flex 容器：允许布局属性（对标 tencent-pptx 的 Slide style）
    "Slide": _BOX_LAYOUT_KEYS | {"flexDirection", "gap", "justifyContent", "alignItems", "flex", "padding"},
    "Box": _BOX_LAYOUT_KEYS,
    "Text": {
        "width", "height", "marginTop", "marginBottom",
        "fontSize", "fontWeight", "fontFamily", "color", "textAlign", "lineHeight", "letterSpacing",
    },
    "Chart": {"width", "height", "marginTop", "marginBottom", "flex"},
    # T2.2 媒体组件：均为叶子节点，共用布局基础键 + 各自特有键
    "Image": {"width", "height", "marginTop", "marginBottom", "flex", "borderRadius"},
    "Table": {"width", "height", "marginTop", "marginBottom", "flex"},
    "FAIcon": {"width", "height", "marginTop", "marginBottom", "flex", "color"},
    "SVG": {"width", "height", "marginTop", "marginBottom", "flex"},
    "QRCode": {"width", "height", "marginTop", "marginBottom", "flex"},
    "CodeBlock": {"width", "height", "marginTop", "marginBottom", "flex"},
    "Math": {"width", "height", "marginTop", "marginBottom", "flex", "color"},
}

_ENUMS: dict[str, set[str]] = {
    "flexDirection": {"row", "column"},
    "justifyContent": {"flex-start", "center", "flex-end", "space-between", "space-around"},
    "alignItems": {"flex-start", "center", "flex-end", "stretch"},
    "textAlign": {"left", "center", "right"},
    "position": {"static", "relative", "absolute"},
    "fontWeight": {"normal", "bold"},
}

_NUMERIC_PROPS = {
    "gap", "marginTop", "marginBottom", "marginLeft", "marginRight", "padding", "borderRadius",
    "top", "left", "right", "bottom", "letterSpacing",
}

#: 不支持的 CSS 特征 → 报错（对齐 component-box.md 的禁止清单）
_BANNED_FRAGMENTS = ("calc(", "var(", "!important")

_NUMERIC_ONLY_PROPS = (
    _NUMERIC_PROPS
    | {"width", "height", "fontSize", "flex", "lineHeight"}
    | {"minWidth", "maxWidth", "minHeight", "maxHeight", "zIndex"}
)


def _validate_value(prop: str, value: Any) -> None:
    """按属性类型校验值合法性。"""
    if prop in _NUMERIC_ONLY_PROPS:
        if prop == "flex":
            if not isinstance(value, int) or value < 1:
                raise dsl_error(
                    ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=repr(value), reason="flex 须为正整数"
                )
            return
        if prop == "zIndex":
            if not isinstance(value, int):
                raise dsl_error(
                    ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=repr(value), reason="zIndex 须为整数"
                )
            return
        if prop == "lineHeight":
            if not isinstance(value, (int, float)) or value < 1.0:
                raise dsl_error(
                    ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=repr(value), reason="lineHeight 须 ≥ 1.0"
                )
            return
        if prop == "fontSize":
            if not isinstance(value, (int, float)) or value <= 0:
                raise dsl_error(
                    ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=repr(value), reason="fontSize 须为正数"
                )
            return
        parse_length(value, prop)
        return

    if prop in _ENUMS:
        if value not in _ENUMS[prop]:
            raise dsl_error(
                ErrorCode.DSL_INVALID_STYLE_VALUE,
                prop=prop, value=repr(value),
                reason=f"允许值: {sorted(_ENUMS[prop])}",
            )
        return

    if prop == "margin":
        parse_margin(value, prop)
        return
    if prop == "border":
        parse_border(value, prop)
        return
    if prop == "boxShadow":
        parse_box_shadow(value, prop)
        return
    if prop == "opacity":
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not (0 <= value <= 1):
            raise dsl_error(
                ErrorCode.DSL_INVALID_STYLE_VALUE, prop=prop, value=repr(value), reason="opacity 须在 0-1 之间"
            )
        return

    if prop == "color":
        parse_color(value, prop)
        return
    if prop == "background":
        parse_background(value, prop)
        return


def validate_style(component: str, style: dict[str, Any]) -> None:
    """白名单 + 值校验。display 仅允许 'flex'；出现 calc() 等特征直接报错。"""
    for key, value in style.items():
        if isinstance(value, str) and any(b in value for b in _BANNED_FRAGMENTS):
            raise dsl_error(
                ErrorCode.DSL_INVALID_STYLE_VALUE,
                prop=key, value=value,
                reason="不支持 calc()/var()/!important 表达式",
            )

        if key == "display":
            if value != "flex":
                raise dsl_error(
                    ErrorCode.DSL_INVALID_STYLE_VALUE,
                    prop=key, value=repr(value), reason="仅支持 display: flex",
                )
            continue  # display: flex 是默认值，允许但不进入白名单

        if key not in STYLE_WHITELIST[component]:
            raise dsl_error(ErrorCode.DSL_UNKNOWN_PROPERTY, prop=key, component=component)

        _validate_value(key, value)
