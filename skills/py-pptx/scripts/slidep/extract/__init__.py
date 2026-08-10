"""素材解析模块（T2.3）：从 docx/pdf/pptx 提取内容、图片与风格特征。

公共 API：
- ``extract_material``：统一入口（格式检测 → 适配器 → 风格特征 → 输出）
- ``detect_format``：格式检测
- ``extract_docx`` / ``extract_pdf`` / ``extract_pptx``：单格式适配器
- ``build_style_profile``：风格特征构建
- 数据模型：``ExtractedDocument`` / ``ExtractedBlock`` / ``ImageRef`` / ``StyleProfile``
"""

from slidep.extract.models import (
    ExtractedBlock,
    ExtractedDocument,
    ImageRef,
    StyleProfile,
)
from slidep.extract.pipeline import detect_format, extract_material

__all__ = [
    # 数据模型
    "ExtractedDocument",
    "ExtractedBlock",
    "ImageRef",
    "StyleProfile",
    # 管线
    "extract_material",
    "detect_format",
]
