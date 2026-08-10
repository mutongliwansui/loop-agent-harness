"""风格包体系（T5.1）：多视觉文化分支 + 关键词路由 + lint 联动。

公共 API：
- ``DesignTokens`` / ``StylePack`` / ``RoutingResult``：数据模型
- ``BUILTIN_PACKS``：内置风格包（academic / business / government / general）
- ``route_query``：关键词路由（query → 命中/软降级/无命中三态）
- ``apply_overrides``：风格包 → lint 规则覆盖
- ``generate_from_profile``：基于 StyleProfile 生成一次性风格包

设计：
- 风格 = 设计 token 集合 + 覆盖规则
- 路由表独立 JSON（场景关键词 ↔ 风格包）
- 「完全命中 → 结构层+常量层生效；软降级 → 仅结构层生效」的两层模型
"""

from .models import DecorationItem, DesignTokens, FontSizeLadder, LayoutTemplate, Palette, RoutingResult, StylePack
from .router import BUILTIN_PACKS, get_pack, list_packs, route_query
from .overrides import apply_overrides, get_effective_font_ladder, get_effective_params, get_effective_palette
from .generator import export_tokens_json, generate_from_profile

__all__ = [
    "DesignTokens",
    "StylePack",
    "Palette",
    "FontSizeLadder",
    "LayoutTemplate",
    "DecorationItem",
    "RoutingResult",
    "BUILTIN_PACKS",
    "route_query",
    "get_pack",
    "list_packs",
    "apply_overrides",
    "get_effective_params",
    "get_effective_palette",
    "get_effective_font_ladder",
    "generate_from_profile",
    "export_tokens_json",
]
