"""PDF 素材解析器（T2.3 的 PDF Adapter）。

将 .pdf 文件解析为统一的 ``ExtractedDocument``，与 DOCX/PPTX Adapter 输出
同构，供风格分析（style_profile）与后续 PPT 生成消费。

基于 ``PyMuPDF`` (fitz) 实现，提取内容：
- 文本块：来自 ``page.get_text("dict")`` 的 span，保留字号 / 字体名；
  同一行内字号相同的连续 span 合并为一个 block
- 标题级别推断：收集全部 span 字号，按 2pt 阈值聚类，最大的字号簇 → H1、
  次大 → H2，正文（出现字符最多的字号簇）与其余 → paragraph
- 内嵌图片：``page.get_images()`` + ``doc.extract_image(xref)``，
  非空 image_dir 时落盘（``img_p{page}_nnn.{ext}``），并用 PIL 读取宽高
- 元数据：page_count / title / author（来自 ``doc.metadata``）

错误处理统一走 ``slidep.io_error``：
- 文件不存在 -> ``ErrorCode.IO_FILE_NOT_FOUND``
- 提取失败     -> ``ErrorCode.IO_EXTRACTION_FAILED``

注意：纯扫描 PDF（无文本层）不会崩溃，返回空 blocks + 可能的内嵌图片。
"""

from __future__ import annotations

import io
import os
from typing import Any

import fitz  # PyMuPDF
from PIL import Image

from slidep import ErrorCode, SlidepError, io_error
from slidep.extract.models import ExtractedBlock, ExtractedDocument, ImageRef

__all__ = ["extract_pdf"]

#: 字号聚类阈值（pt）：相邻字号差小于该值视为同一级别
_SIZE_CLUSTER_THRESHOLD = 2.0

#: 字号量化精度（小数位）：用于聚类去重，消除浮点噪声
_SIZE_ROUND_DIGITS = 1


def _cluster_sizes(
    sorted_desc: list[float], threshold: float = _SIZE_CLUSTER_THRESHOLD
) -> list[list[float]]:
    """将降序排列的字号聚类：相邻元素差 < threshold 归为同一簇。

    输入需已去重并按降序排列；返回的簇列表保持降序。
    """
    clusters: list[list[float]] = []
    prev: float | None = None
    for size in sorted_desc:
        if prev is not None and abs(prev - size) < threshold:
            clusters[-1].append(size)
        else:
            clusters.append([size])
        prev = size
    return clusters


def _build_level_map(
    sizes: list[float], char_count: dict[float, int]
) -> dict[float, int]:
    """根据字号分布推断 {字号: 标题级别}。

    规则：
    - 字号去重降序后按 2pt 阈值聚类
    - 出现字符数最多的簇视为正文（paragraph，level 0）
    - 比正文大的簇按字号降序：最大 → H1（level 1）、次大 → H2（level 2），
      第 3+ 个标题簇及比正文小的簇 → paragraph（level 0）

    这样在常见「标题 + 正文」结构下，正文不会被误判为标题；
    单一字号文档则全部归为正文。
    """
    if not sizes:
        return {}
    unique = sorted(set(sizes), reverse=True)
    clusters = _cluster_sizes(unique)
    # 每个簇的累计字符数
    cluster_chars = [sum(char_count.get(s, 0) for s in cluster) for cluster in clusters]
    body_idx = cluster_chars.index(max(cluster_chars))

    level_map: dict[float, int] = {}
    heading_rank = 0
    for idx, cluster in enumerate(clusters):
        if idx < body_idx:
            # 比正文大的字号簇 → 标题（最大 → H1，次大 → H2）
            heading_rank += 1
            if heading_rank == 1:
                level = 1  # H1
            elif heading_rank == 2:
                level = 2  # H2
            else:
                level = 0  # 第 3+ 个标题簇按「其余 → paragraph」
        else:
            level = 0  # 正文及其以下字号 → paragraph
        for s in cluster:
            level_map[s] = level
    return level_map


def _relative_folder(image_dir: str) -> str:
    """从 image_dir 推导相对于 ``extracted/`` 目录的子目录（用 ``/`` 分隔）。

    例：
        .../extracted/pdf_doc/images -> "pdf_doc/images"
        .../extracted/               -> ""
        .../work/images              -> "images"（无 extracted 段时回退取末尾目录名）
    """
    norm = image_dir.replace("\\", "/").rstrip("/")
    if not norm:
        return ""
    parts = [p for p in norm.split("/") if p]
    if "extracted" in parts:
        idx = parts.index("extracted")
        return "/".join(parts[idx + 1:])
    return parts[-1] if parts else ""


def _read_image_size(
    blob: bytes, fallback: tuple[int, int] = (0, 0)
) -> tuple[int, int]:
    """用 PIL 读取图片二进制宽高；失败回退到 fallback。"""
    try:
        with Image.open(io.BytesIO(blob)) as im:
            return int(im.width), int(im.height)
    except Exception:
        return int(fallback[0]), int(fallback[1])


def _collect_spans(
    doc: fitz.Document,
) -> tuple[list[list[dict]], list[float], dict[float, int]]:
    """遍历全部页面，收集带字体信息的 span。

    返回 (all_lines, all_size_keys, size_char_count)：
    - all_lines: 每个元素是一行内的 span 列表（已剔除空文本 span）
    - all_size_keys: 全部 span 的量化字号（用于聚类）
    - size_char_count: {量化字号: 累计字符数}
    """
    all_lines: list[list[dict]] = []
    all_size_keys: list[float] = []
    size_char_count: dict[float, int] = {}

    for page_index in range(doc.page_count):
        page = doc.load_page(page_index)
        try:
            text_dict = page.get_text("dict")
        except Exception:
            text_dict = {"blocks": []}
        for block in text_dict.get("blocks", []):
            if block.get("type", 0) != 0:  # 0=文本块，1=图片块
                continue
            for line in block.get("lines", []):
                spans_in_line: list[dict] = []
                for span in line.get("spans", []):
                    text = span.get("text", "") or ""
                    if not text.strip():  # 空文本 span 跳过
                        continue
                    size_raw = float(span.get("size", 0.0))
                    size_key = round(size_raw, _SIZE_ROUND_DIGITS)
                    font = span.get("font", "") or ""
                    spans_in_line.append(
                        {
                            "text": text,
                            "size": size_raw,
                            "size_key": size_key,
                            "font": font,
                            "page": page_index,
                        }
                    )
                    all_size_keys.append(size_key)
                    size_char_count[size_key] = (
                        size_char_count.get(size_key, 0) + len(text)
                    )
                if spans_in_line:
                    all_lines.append(spans_in_line)
    return all_lines, all_size_keys, size_char_count


def _build_blocks(
    all_lines: list[list[dict]], level_map: dict[float, int]
) -> list[ExtractedBlock]:
    """合并同一行内字号相同的连续 span 为一个 block，并标注标题级别。"""
    blocks: list[ExtractedBlock] = []
    for line in all_lines:
        merged: list[dict] = []
        for span in line:
            if merged and merged[-1]["size_key"] == span["size_key"]:
                merged[-1]["text"] += span["text"]
            else:
                merged.append(
                    {
                        "text": span["text"],
                        "size": span["size"],
                        "size_key": span["size_key"],
                        "font": span["font"],
                        "page": span["page"],
                    }
                )
        for m in merged:
            text = m["text"].strip()
            if not text:
                continue
            level = level_map.get(m["size_key"], 0)
            blocks.append(
                ExtractedBlock(
                    type="heading" if level > 0 else "paragraph",
                    text=text,
                    level=level,
                    page=m["page"],
                    font_size=m["size"],
                    font_name=m["font"] or None,
                )
            )
    return blocks


def _extract_images(doc: fitz.Document, image_dir: str) -> list[ImageRef]:
    """提取全部页面内嵌图片；image_dir 非空时落盘并记录相对于 extracted/ 的路径。

    单张图片异常不影响整体提取（跳过该图片）。
    """
    images: list[ImageRef] = []
    rel_folder = _relative_folder(image_dir) if image_dir else ""

    # image_dir 非空时预先创建目录；失败则本轮不落盘（仅记录元信息）
    can_save = False
    if image_dir:
        try:
            os.makedirs(image_dir, exist_ok=True)
            can_save = True
        except Exception:
            can_save = False

    for page_index in range(doc.page_count):
        page = doc.load_page(page_index)
        try:
            img_list = page.get_images(full=True)
        except Exception:
            img_list = []
        for img_idx, img_info in enumerate(img_list):
            xref = img_info[0]
            try:
                extracted = doc.extract_image(xref)
            except Exception:
                continue
            blob = extracted.get("image")
            if not blob:
                continue
            ext = (extracted.get("ext") or "bin").lower()
            fallback = (
                int(extracted.get("width", 0) or 0),
                int(extracted.get("height", 0) or 0),
            )
            width, height = _read_image_size(blob, fallback=fallback)
            fname = f"img_p{page_index}_{img_idx:03d}.{ext}"
            rel_path = ""
            if can_save:
                try:
                    with open(os.path.join(image_dir, fname), "wb") as f:
                        f.write(blob)
                    rel_path = f"{rel_folder}/{fname}" if rel_folder else fname
                except Exception:
                    rel_path = ""
            images.append(
                ImageRef(
                    path=rel_path,
                    width=width,
                    height=height,
                    format=ext,
                    source_page=page_index,
                )
            )
    return images


def _extract_metadata(doc: fitz.Document) -> dict[str, Any]:
    """提取元数据：page_count / title / author（来自 doc.metadata）。"""
    meta = doc.metadata or {}
    return {
        "page_count": doc.page_count,
        "title": meta.get("title") or "",
        "author": meta.get("author") or "",
    }


def extract_pdf(file_path: str, image_dir: str = "") -> ExtractedDocument:
    """解析 .pdf 文件为 ``ExtractedDocument``。

    Args:
        file_path: .pdf 文件路径。
        image_dir: 图片保存目录（位于 extracted/ 之下亦可）；非空时图片落盘为
            ``img_p{page}_nnn.{ext}``，``ImageRef.path`` 记录相对于 extracted/
            的路径；为空则不落盘（仅记录宽高 / 格式）。

    Returns:
        ``ExtractedDocument``，``source_format="pdf"``，metadata 含
        page_count / title / author。

    Raises:
        SlidepUserError: 文件不存在（IO_FILE_NOT_FOUND）或提取失败（IO_EXTRACTION_FAILED）。
    """
    if not os.path.exists(file_path):
        raise io_error(ErrorCode.IO_FILE_NOT_FOUND, path=file_path)

    try:
        doc = fitz.open(file_path)
    except Exception as exc:
        raise io_error(
            ErrorCode.IO_EXTRACTION_FAILED, path=file_path, reason=f"无法打开 PDF：{exc}"
        ) from exc

    try:
        all_lines, all_size_keys, size_char_count = _collect_spans(doc)
        level_map = _build_level_map(all_size_keys, size_char_count)
        blocks = _build_blocks(all_lines, level_map)
        images = _extract_images(doc, image_dir)
        metadata = _extract_metadata(doc)
        return ExtractedDocument(
            source_path=file_path,
            source_format="pdf",
            blocks=blocks,
            images=images,
            metadata=metadata,
        )
    except SlidepError:
        # 内部已构造的 io_error 原样抛出，保留 code/path/reason
        raise
    except Exception as exc:
        raise io_error(
            ErrorCode.IO_EXTRACTION_FAILED, path=file_path, reason=str(exc)
        ) from exc
    finally:
        doc.close()
