"""素材解析编排管线（T2.3）：统一入口，格式检测 → 适配器分发 → 输出。

对外暴露 ``extract_material``，接受任意支持的素材文件（docx/pdf/pptx），
自动检测格式、调用对应适配器提取内容，并生成风格特征，最终把结构化结果
与图片资源写入 ``output_dir``。

输出目录结构：
::

    <output_dir>/
    ├── content.json          # ExtractedDocument.to_dict()
    ├── style_profile.json    # StyleProfile.to_dict()
    ├── preview_grid.png      # 9 宫格预览（仅 pptx 源）
    └── images/               # 提取的图片（如有）

错误处理：文件不存在 / 不支持的格式 / 提取失败 → ``SlidepUserError``，
code 分别为 ``IO_FILE_NOT_FOUND`` / ``IO_FORMAT_UNSUPPORTED`` / ``IO_EXTRACTION_FAILED``。
"""

from __future__ import annotations

import json
import os
from typing import Optional

from slidep import ErrorCode, io_error
from slidep.extract.models import ExtractedDocument, StyleProfile

#: 支持的格式扩展名（小写，含点）
_SUPPORTED_FORMATS = {".docx", ".pdf", ".pptx"}

#: 扩展名 → 格式标识
_EXT_TO_FORMAT = {
    ".docx": "docx",
    ".pdf": "pdf",
    ".pptx": "pptx",
}


def detect_format(file_path: str) -> str:
    """根据文件扩展名检测素材格式。

    Args:
        file_path: 素材文件路径。

    Returns:
        格式标识：``"docx"`` / ``"pdf"`` / ``"pptx"``。

    Raises:
        SlidepUserError: 文件不存在或格式不支持。
    """
    if not os.path.isfile(file_path):
        raise io_error(ErrorCode.IO_FILE_NOT_FOUND, path=file_path)

    ext = os.path.splitext(file_path)[1].lower()
    fmt = _EXT_TO_FORMAT.get(ext)
    if fmt is None:
        supported = ", ".join(sorted(_SUPPORTED_FORMATS))
        raise io_error(
            ErrorCode.IO_FORMAT_UNSUPPORTED, path=file_path, supported=supported
        )
    return fmt


def _dispatch_extract(
    file_path: str, fmt: str, image_dir: str
) -> ExtractedDocument:
    """根据格式调用对应适配器。

    Args:
        file_path: 素材文件路径。
        fmt: 格式标识。
        image_dir: 图片输出目录。

    Returns:
        ExtractedDocument。

    Raises:
        SlidepUserError: 适配器调用失败（透传适配器内部错误码）。
    """
    if fmt == "docx":
        from slidep.extract.docx_adapter import extract_docx
        return extract_docx(file_path, image_dir)
    elif fmt == "pdf":
        from slidep.extract.pdf_adapter import extract_pdf
        return extract_pdf(file_path, image_dir)
    elif fmt == "pptx":
        from slidep.extract.pptx_adapter import extract_pptx
        return extract_pptx(file_path, image_dir)
    else:
        # 理论上不会到达：detect_format 已做校验
        supported = ", ".join(sorted(_SUPPORTED_FORMATS))
        raise io_error(
            ErrorCode.IO_FORMAT_UNSUPPORTED, path=file_path, supported=supported
        )


def extract_material(
    file_path: str,
    output_dir: str = "",
    extract_images: bool = True,
    build_style: bool = True,
) -> tuple[ExtractedDocument, Optional[StyleProfile]]:
    """统一入口：检测格式 → 调用适配器 → 生成风格特征 → 写出结果文件。

    Args:
        file_path: 素材文件路径（docx/pdf/pptx）。
        output_dir: 输出目录。非空时把 content.json、style_profile.json、
            图片、9 宫格预览写入此目录；为空则仅返回内存对象，不落盘。
        extract_images: 是否提取并落盘图片。``False`` 时适配器不落盘图片
            （ImageRef 仍含宽高/格式元信息，path 为空串）。
        build_style: 是否构建风格特征。``False`` 时返回 ``(doc, None)``，
            不执行主色提取等较重操作。

    Returns:
        ``(ExtractedDocument, StyleProfile | None)``。

    Raises:
        SlidepUserError: 文件不存在 / 格式不支持 / 提取失败。
    """
    # ---- 1. 格式检测 ----
    fmt = detect_format(file_path)

    # ---- 2. 准备输出目录 ----
    image_dir = ""
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
        if extract_images:
            image_dir = os.path.join(output_dir, "images")
    elif extract_images:
        # 无 output_dir 但要求提取图片：用临时目录
        image_dir = ""

    # ---- 3. 调用适配器 ----
    doc = _dispatch_extract(file_path, fmt, image_dir)

    # ---- 4. 风格特征 ----
    profile: Optional[StyleProfile] = None
    if build_style:
        from slidep.extract.style_profile import build_style_profile

        preview_output = None
        if output_dir and fmt == "pptx":
            preview_output = os.path.join(output_dir, "preview_grid.png")

        profile = build_style_profile(
            doc,
            image_base_dir=image_dir,
            pptx_path=file_path if fmt == "pptx" else None,
            preview_output=preview_output,
        )

    # ---- 5. 落盘 ----
    if output_dir:
        content_path = os.path.join(output_dir, "content.json")
        try:
            with open(content_path, "w", encoding="utf-8") as f:
                json.dump(doc.to_dict(), f, ensure_ascii=False, indent=2)
        except OSError as e:
            raise io_error(
                ErrorCode.IO_EXTRACTION_FAILED,
                path=file_path,
                reason=f"写入 content.json 失败：{e}",
            ) from e

        if profile is not None:
            profile_path = os.path.join(output_dir, "style_profile.json")
            try:
                with open(profile_path, "w", encoding="utf-8") as f:
                    json.dump(profile.to_dict(), f, ensure_ascii=False, indent=2)
            except OSError as e:
                raise io_error(
                    ErrorCode.IO_EXTRACTION_FAILED,
                    path=file_path,
                    reason=f"写入 style_profile.json 失败：{e}",
                ) from e

    return doc, profile
