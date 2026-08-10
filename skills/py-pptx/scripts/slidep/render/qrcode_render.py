"""二维码渲染器（T2.2）：qrcode 库生成 → PIL → PNG bytes。

内联生成，不依赖网络。支持自定义尺寸与颜色。
"""

from __future__ import annotations

import io
from typing import Optional

import qrcode
from PIL import Image

from slidep import ErrorCode, render_error

#: 默认前景/背景色
_DEFAULT_FG = (21, 21, 21)  # #151515
_DEFAULT_BG = (255, 255, 255)  # #FFFFFF


def render_qrcode_png(
    value: str,
    width_px: float,
    height_px: float,
    fg_color: Optional[str] = None,
    bg_color: Optional[str] = None,
) -> bytes:
    """生成二维码 PNG bytes。

    Args:
        value: 待编码的文本或 URL
        width_px: 目标宽度
        height_px: 目标高度
        fg_color: 前景色 hex（如 "#000000"）
        bg_color: 背景色 hex

    Returns:
        PNG 图片字节流
    """
    try:
        qr = qrcode.QRCode(
            version=None,
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=10,
            border=2,
        )
        qr.add_data(value)
        qr.make(fit=True)
        qr_img = qr.make_image(
            fill_color=fg_color or "#151515",
            back_color=bg_color or "#FFFFFF",
        )
        pil_img = qr_img.convert("RGBA")
    except Exception as exc:  # noqa: BLE001
        raise render_error(
            ErrorCode.RENDER_OOXML_FAILED,
            reason=f"二维码生成失败: {exc}",
        ) from exc

    # 缩放到目标尺寸（保持正方形）
    target_size = max(int(min(width_px, height_px)), 32)
    pil_img = pil_img.resize((target_size, target_size), Image.NEAREST)

    buf = io.BytesIO()
    pil_img.save(buf, format="PNG")
    buf.seek(0)
    return buf.getvalue()
