"""校验层：设计规范 lint 门禁（T3.1）。

公共 API：
- ``validate_deck(slides) -> LintReport``：全量校验
- ``validate_slide(slide) -> list[LintIssue]``：单页校验
- ``LintReport`` / ``LintIssue``：结果数据结构
- 10 个 check 函数（与 rules.json lint 标识一一对应）
"""

from slidep.validate.lint import (
    LintIssue,
    LintReport,
    validate_anchor,
    validate_color_palette,
    validate_color_ratio,
    validate_deck,
    validate_density,
    validate_font_families,
    validate_font_sizes,
    validate_hero_quota,
    validate_image_tiers,
    validate_layout_diversity,
    validate_nesting_depth,
    validate_slide,
    validate_toc,
)

__all__ = [
    # 数据结构
    "LintIssue",
    "LintReport",
    # 公共入口
    "validate_deck",
    "validate_slide",
    # check 函数（与 rules.json lint 标识一一对应）
    "validate_font_families",
    "validate_font_sizes",
    "validate_density",
    "validate_anchor",
    "validate_color_palette",
    "validate_color_ratio",
    "validate_layout_diversity",
    "validate_hero_quota",
    "validate_image_tiers",
    "validate_toc",
    "validate_nesting_depth",
]
