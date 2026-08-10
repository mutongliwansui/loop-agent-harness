"""素材解析数据模型（T2.3）：统一的结构化文档对象。

所有 Adapter（docx/pdf/pptx）输出统一的 ``ExtractedDocument``，
供风格分析（style_profile）与后续 PPT 生成消费。

层级约定：
- heading level 0 = 正文段落
- heading level 1 = 一级标题（H1）
- heading level 2 = 二级标题（H2），以此类推
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class ImageRef:
    """提取的图片引用。"""

    path: str  #: 相对路径（相对于 extracted/ 目录）
    width: int
    height: int
    format: str  #: 图片格式（"png" / "jpeg" / "gif" 等）
    source_page: int = 0  #: 来源页码（0-based）


@dataclass
class ExtractedBlock:
    """文本块：标题或段落。"""

    type: str  #: "heading" | "paragraph" | "list_item"
    text: str
    level: int = 0  #: heading 级别（0=正文，1=H1，2=H2...）
    page: int = 0  #: 来源页码/幻灯片号（0-based）
    font_size: Optional[float] = None  #: 原始字号（pt），用于风格分析
    font_name: Optional[str] = None  #: 原始字体名


@dataclass
class ExtractedDocument:
    """从素材中提取的完整文档对象。"""

    source_path: str
    source_format: str  #: "docx" | "pdf" | "pptx"
    blocks: list[ExtractedBlock] = field(default_factory=list)
    images: list[ImageRef] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    #: metadata 常用键：title, author, page_count, slide_count, created

    @property
    def word_count(self) -> int:
        """全部文本块的字符总数（不含空白）。"""
        return sum(len(b.text.replace(" ", "").replace("\n", "")) for b in self.blocks)

    @property
    def heading_count(self) -> int:
        """标题块数量。"""
        return sum(1 for b in self.blocks if b.type == "heading")

    @property
    def paragraph_count(self) -> int:
        """正文段落数量。"""
        return sum(1 for b in self.blocks if b.type == "paragraph")

    def to_dict(self) -> dict[str, Any]:
        """序列化为 JSON 兼容 dict。"""
        return {
            "source_path": self.source_path,
            "source_format": self.source_format,
            "metadata": self.metadata,
            "word_count": self.word_count,
            "heading_count": self.heading_count,
            "paragraph_count": self.paragraph_count,
            "image_count": len(self.images),
            "blocks": [
                {
                    "type": b.type,
                    "text": b.text,
                    "level": b.level,
                    "page": b.page,
                    "font_size": b.font_size,
                    "font_name": b.font_name,
                }
                for b in self.blocks
            ],
            "images": [
                {
                    "path": img.path,
                    "width": img.width,
                    "height": img.height,
                    "format": img.format,
                    "source_page": img.source_page,
                }
                for img in self.images
            ],
        }


@dataclass
class StyleProfile:
    """风格特征量化结果，供 T5.1 风格系统消费。

    所有字段均可序列化为 JSON，写入 ``style_profile.json``。
    """

    source_path: str
    source_format: str
    #: k-means 主色（hex 列表，按面积降序，最多 8 色）
    dominant_colors: list[str] = field(default_factory=list)
    #: 各主色的面积占比（0-100，与 dominant_colors 一一对应）
    color_ratios: list[float] = field(default_factory=list)
    #: 字号层级直方图：{字号(pt): 出现次数}
    font_size_histogram: dict[str, int] = field(default_factory=dict)
    #: 字体家族列表（按使用频率降序）
    font_families: list[str] = field(default_factory=list)
    #: 9 宫格预览图路径（相对于 extracted/ 目录）
    preview_grid_path: Optional[str] = None
    #: 页数/幻灯片数
    page_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        """序列化为 JSON 兼容 dict。"""
        return {
            "source_path": self.source_path,
            "source_format": self.source_format,
            "dominant_colors": self.dominant_colors,
            "color_ratios": self.color_ratios,
            "font_size_histogram": self.font_size_histogram,
            "font_families": self.font_families,
            "preview_grid_path": self.preview_grid_path,
            "page_count": self.page_count,
        }
