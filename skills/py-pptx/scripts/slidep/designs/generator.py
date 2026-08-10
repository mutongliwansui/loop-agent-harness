"""参照风格生成（T5.1）：基于 StyleProfile 生成一次性风格包。

从 T2.3 的 ``StyleProfile``（素材解析结果）提取：
- 主色 → Palette
- 字号直方图 → FontSizeLadder（推断阶梯）
- 字体家族 → font_families

生成一个 ``id="referenced"`` 的 StylePack，作为「参照风格」使用。
"""

from __future__ import annotations

from typing import Any, Optional

from slidep.designs.models import (
    DesignTokens,
    FontSizeLadder,
    LayoutTemplate,
    Palette,
    StylePack,
)
from slidep.extract.models import StyleProfile


def _pick_palette(profile: StyleProfile) -> Palette:
    """从 StyleProfile 的主色列表推断色板。

    - 第 1 个色 → primary
    - 第 2 个色 → secondary
    - 第 3 个色 → accent（不足时用默认值）
    """
    colors = profile.dominant_colors or []
    ratios = profile.color_ratios or []

    # 按面积排序（dominant_colors 已按面积降序，但保险起见再排一次）
    if colors and ratios and len(colors) == len(ratios):
        paired = sorted(zip(colors, ratios), key=lambda x: -x[1])
        colors = [p[0] for p in paired]

    primary = colors[0] if len(colors) > 0 else "#1E293B"
    secondary = colors[1] if len(colors) > 1 else "#3B82F6"
    accent = colors[2] if len(colors) > 2 else "#F59E0B"

    return Palette(
        primary=primary,
        secondary=secondary,
        accent=accent,
        background="#FFFFFF",
        text="#1E293B",
        text_light="#64748B",
    )


def _infer_font_ladder(profile: StyleProfile) -> FontSizeLadder:
    """从字号直方图推断字号阶梯。

    策略：
    - 按字号降序排列
    - 最大字号 → hero_title 上限
    - 第二大字号 → title 上限
    - 中位字号 → body 范围
    - 最小字号 → caption 范围
    """
    hist = profile.font_size_histogram
    if not hist:
        return FontSizeLadder()

    # 解析字号并按降序排列
    sizes = sorted(
        (float(k) for k in hist.keys()),
        reverse=True,
    )

    if len(sizes) >= 4:
        # 最大 → hero, 第二 → title, 中间 → body, 最小 → caption
        hero_max = int(sizes[0])
        hero_min = max(int(sizes[0] * 0.8), 44)
        title_max = int(sizes[1])
        title_min = max(int(sizes[1] * 0.8), 28)
        body_max = int(sizes[len(sizes) // 2])
        body_min = max(int(body_max * 0.75), 16)
        caption_max = int(sizes[-1])
        caption_min = max(int(caption_max * 0.8), 11)
    elif len(sizes) == 3:
        hero_max = int(sizes[0])
        hero_min = max(int(sizes[0] * 0.8), 44)
        title_max = int(sizes[1])
        title_min = max(int(sizes[1] * 0.8), 28)
        body_max = int(sizes[2])
        body_min = max(int(body_max * 0.75), 16)
        caption_min, caption_max = 12, 16
    elif len(sizes) == 2:
        hero_max = int(sizes[0])
        hero_min = max(int(sizes[0] * 0.8), 44)
        title_max = max(int(sizes[0] * 0.7), 28)
        title_min = 28
        body_max = int(sizes[1])
        body_min = max(int(body_max * 0.75), 16)
        caption_min, caption_max = 12, 16
    else:
        # 只有一个字号
        s = int(sizes[0])
        if s >= 44:
            hero_min, hero_max = max(s - 8, 44), s + 8
            title_min, title_max = 32, 40
            body_min, body_max = 18, 24
            caption_min, caption_max = 12, 16
        else:
            hero_min, hero_max = 56, 72
            title_min, title_max = 32, 40
            body_min, body_max = max(s - 4, 16), min(s + 4, 24)
            caption_min, caption_max = 12, 16

    return FontSizeLadder(
        hero_title=(hero_min, hero_max),
        title=(title_min, title_max),
        body=(body_min, body_max),
        caption=(caption_min, caption_max),
    )


def _pick_font_families(profile: StyleProfile) -> list[str]:
    """从 StyleProfile 提取字体家族（最多 2 个）。"""
    families = profile.font_families[:2] if profile.font_families else []
    if not families:
        return ["Microsoft YaHei"]
    return families


def generate_from_profile(profile: StyleProfile) -> StylePack:
    """基于 StyleProfile 生成一次性参照风格包。

    Args:
        profile: 从素材（docx/pdf/pptx）提取的风格特征。

    Returns:
        ``id="referenced"`` 的 StylePack，可直接用于编译或导出 tokens.json。
    """
    palette = _pick_palette(profile)
    font_ladder = _infer_font_ladder(profile)
    font_families = _pick_font_families(profile)

    tokens = DesignTokens(
        palette=palette,
        font_size_ladder=font_ladder,
        font_families=font_families,
        layout_templates=[
            LayoutTemplate(page_type="cover", recommended_layout="center", description="参照风格：居中封面"),
            LayoutTemplate(page_type="content", recommended_layout="left-right", description="参照风格：左右布局"),
            LayoutTemplate(page_type="section", recommended_layout="left", description="参照风格：色块标题"),
            LayoutTemplate(page_type="ending", recommended_layout="center", description="参照风格：居中结束"),
        ],
        decorations=[],
        lint_overrides={
            "typography.size_ladder": font_ladder.to_params(),
        },
    )

    source_name = profile.source_path.rsplit("/", 1)[-1].rsplit("\\", 1)[-1] if profile.source_path else "素材"

    return StylePack(
        id="referenced",
        name="参照风格",
        description=f"基于素材「{source_name}」自动生成的参照风格包",
        tokens=tokens,
        keywords=[],
        soft_keywords=[],
    )


def export_tokens_json(pack: StylePack) -> dict[str, Any]:
    """导出风格包为 tokens.json 兼容的 dict。"""
    return pack.to_dict()
