"""风格特征提取（T2.3）：从 ExtractedDocument + 图片 → StyleProfile。

量化维度：
- 主色提取：k-means 聚类采样像素（用 Pillow quantize 近似），输出 hex + 面积占比
- 字号层级直方图：统计各字号出现频次，推断标题/正文字号
- 字体家族：按使用频率降序排列
- 9 宫格预览图：从 pptx 的前 9 页生成缩略图网格（PNG）
"""

from __future__ import annotations

import io
import os
from collections import Counter
from typing import Optional

from PIL import Image, ImageDraw

from slidep.extract.models import ExtractedDocument, ImageRef, StyleProfile


# ---------------------------------------------------------------- 主色提取

def extract_dominant_colors(
    images: list[ImageRef],
    base_dir: str = "",
    n_colors: int = 6,
    sample_size: int = 100,
) -> tuple[list[str], list[float]]:
    """从图片列表中提取主色（k-means 近似 via Pillow quantize）。

    Args:
        images: 图片引用列表
        base_dir: 图片所在的基础目录（ImageRef.path 相对于此）
        n_colors: 提取的主色数量
        sample_size: 采样缩放尺寸（越小越快）

    Returns:
        (hex_colors, ratios) — hex 列表与对应面积占比（0-100）
    """
    if not images:
        return [], []

    # 合并所有图片的采样像素
    all_pixels: list[tuple[int, int, int]] = []

    for img_ref in images:
        full_path = os.path.join(base_dir, img_ref.path) if base_dir else img_ref.path
        if not os.path.isfile(full_path):
            continue
        try:
            img = Image.open(full_path).convert("RGB")
            # 缩小以加速
            img.thumbnail((sample_size, sample_size))
            all_pixels.extend(list(img.get_flattened_data() if hasattr(img, "get_flattened_data") else img.getdata()))
        except Exception:  # noqa: BLE001
            continue

    if not all_pixels:
        return [], []

    # 用 Pillow quantize 做 k-means 近似
    combined = Image.new("RGB", (len(all_pixels), 1))
    combined.putdata(all_pixels)
    quantized = combined.quantize(colors=n_colors, method=Image.FASTOCTREE)

    palette = quantized.getpalette()[: n_colors * 3]
    pixel_counts = Counter(quantized.get_flattened_data() if hasattr(quantized, "get_flattened_data") else quantized.getdata())

    total = sum(pixel_counts.values())
    if total == 0:
        return [], []

    colors_hex: list[str] = []
    ratios: list[float] = []

    for i in range(n_colors):
        r, g, b = palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]
        count = pixel_counts.get(i, 0)
        if count == 0:
            continue
        hex_color = f"#{r:02X}{g:02X}{b:02X}"
        ratio = round(count / total * 100, 1)
        colors_hex.append(hex_color)
        ratios.append(ratio)

    # 按面积降序
    paired = sorted(zip(colors_hex, ratios), key=lambda x: -x[1])
    colors_hex = [p[0] for p in paired]
    ratios = [p[1] for p in paired]

    return colors_hex, ratios


# ---------------------------------------------------------------- 字号直方图

def extract_font_histogram(doc: ExtractedDocument) -> dict[str, int]:
    """统计字号出现频次，返回 {字号字符串: 次数}。"""
    counter: Counter[str] = Counter()
    for block in doc.blocks:
        if block.font_size is not None and block.font_size > 0:
            # 量化到整数 pt，避免浮点噪声
            size_key = str(round(block.font_size))
            counter[size_key] += 1
    return dict(counter.most_common())


def extract_font_families(doc: ExtractedDocument) -> list[str]:
    """提取字体家族列表（按使用频率降序）。"""
    counter: Counter[str] = Counter()
    for block in doc.blocks:
        if block.font_name:
            counter[block.font_name] += 1
    return [name for name, _ in counter.most_common()]


# ---------------------------------------------------------------- 9 宫格预览

def generate_9grid_preview(
    pptx_path: str,
    output_path: str,
    cell_size: tuple[int, int] = (240, 135),
    gap: int = 8,
    bg_color: str = "#F8FAFC",
) -> Optional[str]:
    """从 pptx 生成 9 宫格预览图（前 9 页缩略图）。

    每页渲染为简化缩略图：背景色 + 标题文字 + 主要色块。
    输出为 3×3 网格 PNG。

    Args:
        pptx_path: pptx 文件路径
        output_path: 输出 PNG 路径
        cell_size: 每格尺寸 (w, h)
        gap: 格间距
        bg_color: 画布背景色

    Returns:
        输出文件路径，失败返回 None
    """
    try:
        from pptx import Presentation
        from pptx.dml.color import RGBColor
        from pptx.enum.shapes import MSO_SHAPE_TYPE
    except ImportError:
        return None

    try:
        prs = Presentation(pptx_path)
    except Exception:  # noqa: BLE001
        return None

    slides = list(prs.slides)
    n_slides = len(slides)
    if n_slides == 0:
        return None

    # 取前 9 页
    n_cells = min(n_slides, 9)
    cols = 3
    rows = (n_cells + cols - 1) // cols

    cell_w, cell_h = cell_size
    canvas_w = cols * cell_w + (cols + 1) * gap
    canvas_h = rows * cell_h + (rows + 1) * gap

    canvas = Image.new("RGB", (canvas_w, canvas_h), bg_color)
    draw = ImageDraw.Draw(canvas)

    # 背景色调色板（轮转）
    slide_colors = [
        "#4F46E5", "#0EA5E9", "#10B981", "#F59E0B",
        "#EF4444", "#8B5CF6", "#EC4899", "#14B8A6", "#6366F1",
    ]

    for idx in range(n_cells):
        slide = slides[idx]
        row = idx // cols
        col = idx % cols
        x = gap + col * (cell_w + gap)
        y = gap + row * (cell_h + gap)

        # 尝试提取幻灯片背景色
        bg = slide_colors[idx % len(slide_colors)]
        title_text = ""

        for shape in slide.shapes:
            # 获取标题
            if shape.has_text_frame:
                text = shape.text_frame.text.strip()
                if text and not title_text:
                    title_text = text[:30]  # 截断
            # 尝试获取背景色
            try:
                if hasattr(shape, "fill") and shape.fill.type is not None:
                    fill_color = shape.fill.fore_color
                    if hasattr(fill_color, "rgb") and fill_color.rgb is not None:
                        rgb = fill_color.rgb
                        bg = f"#{rgb}"
            except Exception:  # noqa: BLE001
                pass

        # 绘制单元格背景
        draw.rectangle([x, y, x + cell_w, y + cell_h], fill=bg)

        # 绘制页码
        draw.text((x + 8, y + cell_h - 20), f"P{idx + 1}", fill="#FFFFFF")

        # 绘制标题（简化）
        if title_text:
            # 白色文字
            try:
                from PIL import ImageFont
                font = ImageFont.load_default()
            except Exception:  # noqa: BLE001
                font = None
            # 简单截断显示
            display = title_text[:20] + ("..." if len(title_text) > 20 else "")
            draw.text((x + 8, y + 8), display, fill="#FFFFFF", font=font)

    try:
        canvas.save(output_path, format="PNG")
        return output_path
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------- 入口

def build_style_profile(
    doc: ExtractedDocument,
    image_base_dir: str = "",
    pptx_path: Optional[str] = None,
    preview_output: Optional[str] = None,
) -> StyleProfile:
    """从 ExtractedDocument 构建 StyleProfile。

    Args:
        doc: 已提取的文档对象
        image_base_dir: 图片所在基础目录
        pptx_path: 如果是 pptx 源文件，用于生成 9 宫格预览
        preview_output: 9 宫格预览图输出路径

    Returns:
        StyleProfile 对象
    """
    # 主色提取
    colors, ratios = extract_dominant_colors(doc.images, image_base_dir)

    # 字号直方图
    font_hist = extract_font_histogram(doc)

    # 字体家族
    font_families = extract_font_families(doc)

    # 9 宫格预览
    preview_path = None
    if pptx_path and preview_output:
        result = generate_9grid_preview(pptx_path, preview_output)
        if result:
            preview_path = os.path.basename(preview_output)

    page_count = doc.metadata.get("page_count") or doc.metadata.get("slide_count", 0)

    return StyleProfile(
        source_path=doc.source_path,
        source_format=doc.source_format,
        dominant_colors=colors,
        color_ratios=ratios,
        font_size_histogram=font_hist,
        font_families=font_families,
        preview_grid_path=preview_path,
        page_count=page_count,
    )
