"""DOCX 素材解析器（T2.3 的 DOCX Adapter）。

将 .docx 文件解析为统一的 ``ExtractedDocument``，与 PDF/PPTX Adapter 输出
同构，供风格分析（style_profile）与后续 PPT 生成消费。

基于 ``python-docx`` 实现，提取内容：
- 段落 / 标题 / 列表项（含字号、字体，来自 run.font）
- 内嵌图片（遍历 document.part.rels，保存到 image_dir，记录宽高与格式）
- 文档元数据（title / author / created 等，来自 core_properties）

错误处理统一走 ``slidep.io_error``：
- 文件不存在 -> ``ErrorCode.IO_FILE_NOT_FOUND``
- 提取失败     -> ``ErrorCode.IO_EXTRACTION_FAILED``
"""

from __future__ import annotations

import io
import os
import re
from typing import Optional

import docx
from docx.text.paragraph import Paragraph
from PIL import Image

from slidep import ErrorCode, SlidepError, io_error
from slidep.extract.models import ExtractedBlock, ExtractedDocument, ImageRef

__all__ = ["extract_docx"]

#: 匹配 "Heading 1" / "Heading 2" 等样式名，提取标题级别
_HEADING_RE = re.compile(r"^Heading\s+(\d+)$", re.IGNORECASE)


def _heading_level(style_name: str) -> int:
    """从段落样式名解析标题级别；非标题返回 0。

    - "Title"      -> 1
    - "Heading 1"  -> 1
    - "Heading 2"  -> 2
    - 其它         -> 0
    """
    if not style_name:
        return 0
    if style_name == "Title":
        return 1
    m = _HEADING_RE.match(style_name)
    if m:
        return int(m.group(1))
    return 0


def _is_list_style(style_name: str) -> bool:
    """判断是否为列表样式（List Bullet / List Number / List Paragraph ...）。"""
    if not style_name:
        return False
    parts = style_name.lower().split()
    return any(p == "list" for p in parts) or any(p.startswith("list") for p in parts)


def _first_run_font(paragraph: Paragraph) -> tuple[Optional[float], Optional[str]]:
    """从段落的 runs 中取首个有效的字号(pt)与字体名。

    python-docx 中 ``run.font.size`` 为 ``Length`` 或 ``None``，``.pt`` 取磅值。
    """
    font_size: Optional[float] = None
    font_name: Optional[str] = None
    for run in paragraph.runs:
        if font_size is None and run.font.size is not None:
            try:
                font_size = float(run.font.size.pt)
            except (AttributeError, TypeError, ValueError):
                font_size = None
        if font_name is None and run.font.name:
            font_name = run.font.name
        if font_size is not None and font_name is not None:
            break
    return font_size, font_name


def _ext_from_content_type(content_type: str) -> str:
    """从 content_type 推断图片扩展名（image/png -> png, image/jpeg -> jpeg）。"""
    if not content_type:
        return "bin"
    # image/png -> png ; image/jpeg -> jpeg ; image/x-emf -> emf ; image/svg+xml -> svg
    sub = content_type.split("/", 1)[-1]
    sub = sub.split("+", 1)[0]
    return sub.lower()


def _relative_folder(image_dir: str) -> str:
    """从 image_dir 推导相对于 ``extracted/`` 目录的子目录（用 ``/`` 分隔）。

    例：
        .../extracted/images -> "images"
        .../extracted/       -> ""
        .../work/images      -> "images"（无 extracted 段时回退取末尾目录名）
    """
    norm = image_dir.replace("\\", "/").rstrip("/")
    if not norm:
        return ""
    parts = [p for p in norm.split("/") if p]
    if "extracted" in parts:
        idx = parts.index("extracted")
        return "/".join(parts[idx + 1:])
    base = parts[-1] if parts else ""
    return base


def _read_image_size(blob: bytes) -> tuple[int, int]:
    """用 PIL 读取图片二进制，返回 (width, height)；失败返回 (0, 0)。"""
    try:
        with Image.open(io.BytesIO(blob)) as im:
            return int(im.width), int(im.height)
    except Exception:
        return 0, 0


def _extract_metadata(doc: docx.Document) -> dict:
    """从 core_properties 提取元数据（title / author / created 等）。"""
    cp = doc.core_properties
    meta: dict = {}
    for key in ("title", "author", "subject", "keywords", "comments", "category"):
        val = getattr(cp, key, None)
        if val:
            meta[key] = val
    for key in ("created", "modified"):
        val = getattr(cp, key, None)
        if val:
            try:
                meta[key] = val.isoformat()
            except (AttributeError, ValueError):
                meta[key] = str(val)
    return meta


def extract_docx(file_path: str, image_dir: str = "") -> ExtractedDocument:
    """解析 .docx 文件为 ``ExtractedDocument``。

    Args:
        file_path: .docx 文件路径。
        image_dir: 图片保存目录（相对于 extracted/ 的子目录亦可）；
                   为空则不落盘，但图片关系仍会被遍历并记录元信息。

    Returns:
        ``ExtractedDocument``，``source_format="docx"``。

    Raises:
        SlidepUserError: 文件不存在（IO_FILE_NOT_FOUND）或提取失败（IO_EXTRACTION_FAILED）。
    """
    if not os.path.exists(file_path):
        raise io_error(ErrorCode.IO_FILE_NOT_FOUND, path=file_path)

    try:
        doc = docx.Document(file_path)
    except Exception as e:
        raise io_error(
            ErrorCode.IO_EXTRACTION_FAILED, path=file_path, reason=f"无法打开 docx：{e}"
        ) from e

    try:
        # ---- 1. 段落 / 标题 / 列表项 ----
        blocks: list[ExtractedBlock] = []
        for para in doc.paragraphs:
            text = para.text or ""
            if not text.strip():
                continue
            style_name = para.style.name if para.style else ""
            level = _heading_level(style_name)
            if level > 0:
                btype = "heading"
            elif _is_list_style(style_name):
                btype = "list_item"
            else:
                btype = "paragraph"
            font_size, font_name = _first_run_font(para)
            blocks.append(ExtractedBlock(
                type=btype,
                text=text.strip(),
                level=level,
                page=0,
                font_size=font_size,
                font_name=font_name,
            ))

        # ---- 2. 内嵌图片（遍历 document.part.rels，type 为 image）----
        images: list[ImageRef] = []
        if image_dir:
            try:
                os.makedirs(image_dir, exist_ok=True)
            except OSError as e:
                raise io_error(
                    ErrorCode.IO_EXTRACTION_FAILED,
                    path=file_path,
                    reason=f"无法创建图片目录 {image_dir}：{e}",
                ) from e
            rel_folder = _relative_folder(image_dir)

            idx = 0
            for rel in doc.part.rels.values():
                ctype = getattr(rel.target_part, "content_type", "") or ""
                if not ctype.startswith("image/"):
                    continue
                idx += 1
                ext = _ext_from_content_type(ctype)
                fname = f"img_{idx:03d}.{ext}"
                blob = rel.target_part.blob
                width, height = _read_image_size(blob)
                save_path = os.path.join(image_dir, fname)
                try:
                    with open(save_path, "wb") as f:
                        f.write(blob)
                except OSError as e:
                    raise io_error(
                        ErrorCode.IO_EXTRACTION_FAILED,
                        path=file_path,
                        reason=f"写入图片 {save_path} 失败：{e}",
                    ) from e
                rel_path = f"{rel_folder}/{fname}" if rel_folder else fname
                images.append(ImageRef(
                    path=rel_path,
                    width=width,
                    height=height,
                    format=ext,
                    source_page=0,
                ))

        # ---- 3. 元数据 ----
        metadata = _extract_metadata(doc)
        metadata.setdefault("paragraph_count", len(blocks))

        return ExtractedDocument(
            source_path=file_path,
            source_format="docx",
            blocks=blocks,
            images=images,
            metadata=metadata,
        )
    except SlidepError:
        # 内部已构造的 io_error 原样抛出，保留 code/path/reason
        raise
    except Exception as e:
        raise io_error(
            ErrorCode.IO_EXTRACTION_FAILED, path=file_path, reason=str(e)
        ) from e
