"""图片渲染器（T2.2）：Pillow 加载 + objectFit 裁剪 + 圆角处理 → PNG bytes。

objectFit:
- cover: 裁剪填充（保持比例，裁掉溢出部分）
- contain: 等比缩放留白（保持比例，居中放置在目标框内）

borderRadius: 圆角裁剪（通过 alpha mask 实现）
"""

from __future__ import annotations

import io
import os
from typing import Optional

from PIL import Image, ImageDraw

from slidep import ErrorCode, SlidepUserError, render_error

#: 图片搜索路径（按优先级尝试）
_IMAGE_SEARCH_DIRS = ["resources/images", "resources", "."]


def _resolve_image_path(src: str) -> str:
    """解析图片路径：绝对路径直接用；相对路径按搜索目录查找。"""
    if os.path.isabs(src) and os.path.isfile(src):
        return src
    for d in _IMAGE_SEARCH_DIRS:
        candidate = os.path.join(d, src)
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    # 最后检查绝对路径是否存在（给出明确错误）
    if os.path.isabs(src):
        if not os.path.isfile(src):
            raise render_error(ErrorCode.RENDER_IMAGE_MISSING, path=src)
        return src
    raise render_error(ErrorCode.RENDER_IMAGE_MISSING, path=src)


def _fit_cover(img: Image.Image, target_w: int, target_h: int) -> Image.Image:
    """objectFit=cover: 裁剪填充。"""
    src_w, src_h = img.size
    src_ratio = src_w / src_h
    target_ratio = target_w / target_h

    if src_ratio > target_ratio:
        # 源图更宽 → 按高度缩放，裁掉左右
        new_w = int(src_h * target_ratio)
        left = (src_w - new_w) // 2
        img = img.crop((left, 0, left + new_w, src_h))
    elif src_ratio < target_ratio:
        # 源图更高 → 按宽度缩放，裁掉上下
        new_h = int(src_w / target_ratio)
        top = (src_h - new_h) // 2
        img = img.crop((0, top, src_w, top + new_h))
    return img.resize((target_w, target_h), Image.LANCZOS)


def _fit_contain(img: Image.Image, target_w: int, target_h: int) -> Image.Image:
    """objectFit=contain: 等比缩放居中，透明背景。"""
    src_w, src_h = img.size
    src_ratio = src_w / src_h
    target_ratio = target_w / target_h

    if src_ratio > target_ratio:
        new_w = target_w
        new_h = int(target_w / src_ratio)
    else:
        new_h = target_h
        new_w = int(target_h * src_ratio)

    resized = img.resize((new_w, new_h), Image.LANCZOS)
    canvas = Image.new("RGBA", (target_w, target_h), (255, 255, 255, 0))
    offset_x = (target_w - new_w) // 2
    offset_y = (target_h - new_h) // 2
    canvas.paste(resized, (offset_x, offset_y), resized if resized.mode == "RGBA" else None)
    return canvas


def _apply_rounded_corners(img: Image.Image, radius: float) -> Image.Image:
    """给图片加圆角（通过 alpha mask）。"""
    if radius <= 0:
        return img
    w, h = img.size
    radius = min(radius, min(w, h) / 2)
    img = img.convert("RGBA")
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, w, h), radius=radius, fill=255)
    img.putalpha(mask)
    return img


def render_image_png(
    src: str,
    object_fit: str,
    width_px: float,
    height_px: float,
    border_radius: float = 0.0,
) -> bytes:
    """加载图片并按 objectFit 处理，返回 PNG bytes。

    Args:
        src: 图片路径（相对路径在 resources/images/ 查找）
        object_fit: "cover" 或 "contain"
        width_px: 目标宽度
        height_px: 目标高度
        border_radius: 圆角半径（px）

    Returns:
        PNG 图片字节流
    """
    path = _resolve_image_path(src)
    target_w = max(int(width_px), 1)
    target_h = max(int(height_px), 1)

    try:
        img = Image.open(path)
    except Exception as exc:  # noqa: BLE001
        raise render_error(
            ErrorCode.RENDER_IMAGE_MISSING,
            path=src,
            hint=f"无法打开图片文件: {exc}",
        ) from exc

    # 转换为 RGBA 以统一处理
    if img.mode != "RGBA":
        img = img.convert("RGBA")

    if object_fit == "cover":
        img = _fit_cover(img, target_w, target_h)
    else:
        img = _fit_contain(img, target_w, target_h)

    if border_radius > 0:
        img = _apply_rounded_corners(img, border_radius)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf.getvalue()
