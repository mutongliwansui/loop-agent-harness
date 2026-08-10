"""数学公式渲染器（T2.2）：matplotlib mathtext LaTeX 公式 → PNG bytes。

matplotlib mathtext 支持 LaTeX 子集（上下标、分数、根号、希腊字母、矩阵等），
无需外部 LaTeX 安装。公式可带或不带 $ 包裹。
"""

from __future__ import annotations

import io
from typing import Optional

from slidep import ErrorCode, render_error

#: 默认公式颜色
_DEFAULT_COLOR = "#1E293B"


def render_math_png(
    latex: str,
    width_px: float,
    height_px: float,
    color: Optional[str] = None,
) -> bytes:
    """渲染 LaTeX 公式为 PNG bytes。

    Args:
        latex: LaTeX 公式（如 r'$E=mc^2$' 或 r'E=mc^2'）
        width_px: 目标宽度
        height_px: 目标高度
        color: 公式颜色 hex

    Returns:
        PNG 图片字节流
    """
    # 确保 $ 包裹（mathtext 语法要求）
    formula = latex.strip()
    if not formula.startswith("$"):
        formula = f"${formula}$"

    dpi = 150
    fig_w = max(width_px / dpi, 1.0)
    fig_h = max(height_px / dpi, 0.5)

    text_color = color or _DEFAULT_COLOR

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        raise render_error(
            ErrorCode.RENDER_OOXML_FAILED,
            reason="matplotlib 未安装，公式渲染不可用。请安装：pip install matplotlib",
        )

    try:
        fig, ax = plt.subplots(figsize=(fig_w, fig_h), dpi=dpi)
        fig.patch.set_alpha(0)
        ax.set_facecolor("none")
        ax.axis("off")

        ax.text(
            0.5, 0.5, formula,
            fontsize=16,
            color=text_color,
            ha="center", va="center",
            transform=ax.transAxes,
        )

        buf = io.BytesIO()
        fig.savefig(buf, format="png", transparent=True, bbox_inches="tight", pad_inches=0.05)
        plt.close(fig)
        buf.seek(0)
        return buf.getvalue()
    except Exception as exc:  # noqa: BLE001
        plt.close("all")
        raise render_error(
            ErrorCode.RENDER_OOXML_FAILED,
            reason=f"公式渲染失败: {exc}（mathtext 语法不支持，请检查 LaTeX 公式）",
        ) from exc
