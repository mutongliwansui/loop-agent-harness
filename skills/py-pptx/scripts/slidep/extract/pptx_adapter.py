"""PPTX 素材解析适配器（T2.3）：从 .pptx 提取文本块与图片，输出 ExtractedDocument。

适配 python-pptx：遍历幻灯片 → 形状 → 标题/正文文本块 + 图片提取，
metadata 提取画布尺寸（EMU→px），供风格分析（style_profile）与 PPT 再生成消费。

提取规则：
- 标题占位符（placeholder_format.idx == 0 或 type == PP_PLACEHOLDER.TITLE）
  → ExtractedBlock(type="heading", level=1)
- 正文文本框每个段落一个 ExtractedBlock(type="paragraph")；
  若段落字号 ≥ 28pt 视为二级标题 → type="heading", level=2
- 无 placeholder 的文本框：同样按字号（≥28pt）判定是否为标题
- 图片形状（shape_type == MSO_SHAPE_TYPE.PICTURE）→ ImageRef，可选落盘

错误处理（slidep 统一错误码）：
- 文件不存在 → io_error(ErrorCode.IO_FILE_NOT_FOUND, path=...)
- 提取失败 → io_error(ErrorCode.IO_EXTRACTION_FAILED, path=..., reason=...)
"""

from __future__ import annotations

import io
import os
from typing import Any, Optional

from PIL import Image
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE, PP_PLACEHOLDER

from slidep import ErrorCode, io_error
from slidep.extract.models import ExtractedBlock, ExtractedDocument, ImageRef

#: EMU → px 换算系数（1px @96dpi = 9525 EMU）
_EMU_PER_PX = 9525

#: 视为标题的字号阈值（pt）：≥该值且非占位符的段落视为二级标题
_TITLE_FONT_SIZE_THRESHOLD = 28.0

#: content_type → 图片格式扩展名映射
_CONTENT_TYPE_EXT: dict[str, str] = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "image/x-emf": "emf",
    "image/x-wmf": "wmf",
    "image/svg+xml": "svg",
}


def _emu_to_px(emu_value: int | None) -> int:
    """EMU → px（96dpi）。空值返回 0。"""
    if not emu_value:
        return 0
    return round(emu_value / _EMU_PER_PX)


def _detect_format(content_type: str) -> str:
    """从 content_type 推断图片格式扩展名，未知类型退化为 '/' 后段，最终回退 png。"""
    if not content_type:
        return "png"
    ext = _CONTENT_TYPE_EXT.get(content_type)
    if ext:
        return ext
    tail = content_type.split("/")[-1]
    return tail or "png"


def _is_title_placeholder(shape: Any) -> bool:
    """判断 shape 是否为标题占位符（idx == 0 或 type == TITLE）。"""
    if not getattr(shape, "is_placeholder", False):
        return False
    try:
        ph = shape.placeholder_format
    except Exception:
        return False
    if ph is None:
        return False
    # idx == 0 通常对应标题占位符
    if getattr(ph, "idx", None) == 0:
        return True
    # 显式类型为 TITLE
    ph_type = getattr(ph, "type", None)
    try:
        return ph_type == PP_PLACEHOLDER.TITLE
    except Exception:
        return False


def _extract_paragraph(paragraph: Any) -> tuple[str, Optional[float], Optional[str]]:
    """从段落提取：拼接文本、首个有效字号(pt)、首个有效字体名。

    优先从 run 累加文本并取首个 run 的字号/字体；无 run 时退化为 paragraph.text。
    """
    texts: list[str] = []
    font_size: Optional[float] = None
    font_name: Optional[str] = None
    for run in paragraph.runs:
        run_text = run.text or ""
        if run_text:
            texts.append(run_text)
        # 取首个有效字号/字体作为段落代表
        if font_size is None and run.font.size is not None:
            try:
                font_size = run.font.size.pt
            except Exception:
                font_size = None
        if font_name is None and run.font.name:
            font_name = run.font.name
    text = "".join(texts)
    if not text:
        # 无 run 的段落（直接设置 text）：用 paragraph.text 兜底
        try:
            text = paragraph.text or ""
        except Exception:
            text = ""
    return text, font_size, font_name


def _relative_image_path(image_dir: str, filename: str) -> str:
    """构造相对于 extracted/ 目录的图片路径。

    image_dir 末级目录名作为相对前缀，例如 image_dir=".../extracted/images"
    与 filename="img_slide01_pic001.png" → "images/img_slide01_pic001.png"。
    image_dir 为空时返回空串（不落盘场景）。
    """
    if not image_dir:
        return ""
    leaf = os.path.basename(os.path.normpath(image_dir))
    if not leaf:
        return filename
    return f"{leaf}/{filename}"


def _save_image_blob(blob: bytes, dest_path: str) -> None:
    """将图片二进制写入目标路径（自动创建父目录）。"""
    parent = os.path.dirname(dest_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(dest_path, "wb") as f:
        f.write(blob)


def extract_pptx(file_path: str, image_dir: str = "") -> ExtractedDocument:
    """从 PPTX 文件提取文本块与图片，返回 ExtractedDocument。

    Args:
        file_path: PPTX 文件路径。
        image_dir: 图片输出目录；非空时图片落盘，文件名
            ``img_slide{NN}_pic{NNN}.{ext}``，ImageRef.path 记录相对于
            extracted/ 的路径。为空则不落盘（仅记录宽高/格式）。

    Returns:
        ExtractedDocument：source_format="pptx"，metadata 含
        slide_count / slide_width(px) / slide_height(px)。

    Raises:
        SlidepUserError: 文件不存在（IO_FILE_NOT_FOUND）或
            打开/提取失败（IO_EXTRACTION_FAILED）。
    """
    # ---- 文件存在性检查 ----
    if not os.path.isfile(file_path):
        raise io_error(ErrorCode.IO_FILE_NOT_FOUND, path=file_path)

    # ---- 打开 PPTX ----
    try:
        prs = Presentation(file_path)
    except Exception as exc:
        raise io_error(
            ErrorCode.IO_EXTRACTION_FAILED,
            path=file_path,
            reason=f"无法打开 PPTX 文件: {exc}",
        ) from exc

    doc = ExtractedDocument(
        source_path=file_path,
        source_format="pptx",
        metadata={},
    )

    # ---- metadata：画布尺寸（EMU→px）+ 幻灯片数 ----
    doc.metadata["slide_count"] = len(prs.slides)
    doc.metadata["slide_width"] = _emu_to_px(prs.slide_width)
    doc.metadata["slide_height"] = _emu_to_px(prs.slide_height)

    # ---- 遍历幻灯片（page 索引从 0 开始）----
    pic_counter = 0  # 全局图片序号（NNN）
    for page_idx, slide in enumerate(prs.slides):
        for shape in slide.shapes:
            # ---- 图片形状 ----
            if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                try:
                    image = shape.image
                    blob = image.blob
                    content_type = getattr(image, "content_type", "") or ""
                    fmt = _detect_format(content_type)
                    # 用 PIL 读取像素宽高
                    try:
                        with Image.open(io.BytesIO(blob)) as img:
                            width, height = img.size
                    except Exception:
                        width, height = 0, 0
                    pic_counter += 1
                    rel_path = ""
                    if image_dir:
                        fname = f"img_slide{page_idx + 1:02d}_pic{pic_counter:03d}.{fmt}"
                        abs_path = os.path.join(image_dir, fname)
                        try:
                            _save_image_blob(blob, abs_path)
                            rel_path = _relative_image_path(image_dir, fname)
                        except Exception:
                            rel_path = ""
                    doc.images.append(
                        ImageRef(
                            path=rel_path,
                            width=width,
                            height=height,
                            format=fmt,
                            source_page=page_idx,
                        )
                    )
                except Exception:
                    # 单张图片异常不影响整体提取
                    continue
                continue

            # ---- 文本形状 ----
            if not shape.has_text_frame:
                continue

            is_title = _is_title_placeholder(shape)
            for para in shape.text_frame.paragraphs:
                text, font_size, font_name = _extract_paragraph(para)
                text = (text or "").strip()
                if not text:
                    continue  # 跳过空段落

                if is_title:
                    doc.blocks.append(
                        ExtractedBlock(
                            type="heading",
                            text=text,
                            level=1,
                            page=page_idx,
                            font_size=font_size,
                            font_name=font_name,
                        )
                    )
                elif font_size is not None and font_size >= _TITLE_FONT_SIZE_THRESHOLD:
                    # 无 title placeholder 的文本框：按字号判定为二级标题
                    doc.blocks.append(
                        ExtractedBlock(
                            type="heading",
                            text=text,
                            level=2,
                            page=page_idx,
                            font_size=font_size,
                            font_name=font_name,
                        )
                    )
                else:
                    doc.blocks.append(
                        ExtractedBlock(
                            type="paragraph",
                            text=text,
                            level=0,
                            page=page_idx,
                            font_size=font_size,
                            font_name=font_name,
                        )
                    )

    return doc
