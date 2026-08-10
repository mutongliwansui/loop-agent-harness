"""文本测量：字符宽度估算 + 换行计算（T1.2）。

MVP 采用确定性启发式测量（无字体文件依赖，可稳定 golden 测试）：

- CJK 字符宽度 ≈ fontSize
- ASCII/数字宽度 ≈ fontSize × 0.55
- 空格宽度 ≈ fontSize × 0.3
- letterSpacing 逐字符累加

后续可替换为 fontTools 字体度量（保持接口不变）：
``measure_text(text, width_limit, font_size, line_height, letter_spacing) -> TextMeasure``
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass

ASCII_W_RATIO = 0.55
SPACE_W_RATIO = 0.30
CJK_W_RATIO = 1.0

#: 允许换行的字符边界
_WORD_BREAK_CHARS = {" ", "\u3000", "-", "/", "，", "。", "、", "；", "："}


def _char_width(ch: str, font_size: float) -> float:
    """估算单个字符宽度（含 letterSpacing 由调用方叠加）。"""
    if ch in (" ", "\u3000"):
        return font_size * SPACE_W_RATIO
    if unicodedata.east_asian_width(ch) in ("W", "F") or ord(ch) > 0x2E7F:
        return font_size * CJK_W_RATIO
    return font_size * ASCII_W_RATIO


def text_width(text: str, font_size: float, letter_spacing: float = 0.0) -> float:
    """单行文本宽度（不换行）。"""
    if not text:
        return 0.0
    return sum(_char_width(ch, font_size) for ch in text) + letter_spacing * (len(text) - 1)


@dataclass(frozen=True)
class TextMeasure:
    """测量结果：实际宽 / 高 / 行数。"""

    width: float
    height: float
    lines: int

    @property
    def line_height(self) -> float:
        return self.height / self.lines if self.lines else 0.0


def measure_text(
    text: str,
    width_limit: float,
    font_size: float,
    line_height: float = 1.3,
    letter_spacing: float = 0.0,
) -> TextMeasure:
    """在给定宽度限制内测量文本（自动换行）。

    width_limit <= 0 视为不限制（单行测量）。
    换行策略：贪心填充，断点优先空格/全角标点；无断点的长词强制截断。
    """
    if not text:
        return TextMeasure(width=0.0, height=font_size * line_height, lines=1)

    if width_limit is None or width_limit <= 0:
        return TextMeasure(
            width=text_width(text, font_size, letter_spacing),
            height=font_size * line_height,
            lines=1,
        )

    lines: list[str] = []
    remaining = text
    # 逐词填充
    while remaining:
        # 找最长可放入一行的前缀（按断点切）
        line, rest = _fit_line(remaining, width_limit, font_size, letter_spacing)
        lines.append(line)
        remaining = rest

    max_line_width = max(text_width(ln, font_size, letter_spacing) for ln in lines)
    return TextMeasure(
        width=max_line_width,
        height=font_size * line_height * len(lines),
        lines=len(lines),
    )


def _fit_line(text: str, width_limit: float, font_size: float, letter_spacing: float) -> tuple[str, str]:
    """取最长可放入一行前缀。

    贪心按字符推进；断点字符（空格/全角标点）优先作为切分点；
    无断点（长词）时按字符宽度强制截断；单字符超宽时硬切。
    """
    if text_width(text, font_size, letter_spacing) <= width_limit:
        return text, ""

    acc = ""
    last_break_end = 0  # 最后一个断点字符之后的位置
    for i, ch in enumerate(text):
        if text_width(acc + ch, font_size, letter_spacing) > width_limit and acc:
            break
        acc += ch
        if ch in _WORD_BREAK_CHARS:
            last_break_end = i + 1

    # 有断点 → 在断点处切（去除尾部空格）
    if last_break_end > 0 and last_break_end < len(text):
        line = text[:last_break_end].rstrip()
        return line, text[last_break_end:]

    # 无断点 → 按字符贪心前缀
    return acc, text[len(acc):]
