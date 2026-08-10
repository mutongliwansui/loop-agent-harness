"""风格包数据模型（T5.1）：设计 token 的结构化定义。

层级关系：
- ``StylePack``：完整风格包 = 元信息 + 设计 token + 路由关键词 + lint 覆盖
- ``DesignTokens``：设计 token 集合 = 色板 + 字号阶梯 + 版式模板 + 装饰白名单
- ``RoutingResult``：路由结果（命中/软降级/无命中）

序列化约定：所有模型支持 ``to_dict()`` / ``from_dict()``，可写入 ``tokens.json``。
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


# ================================================================ 色板

class Palette(BaseModel):
    """色板：主色 / 辅色 / 强调色 / 背景色 / 文字色。

    所有颜色为 hex6 格式（``#RRGGBB``），由 lint 校验数量上限。
    """

    primary: str = Field(description="主色（占比最大）")
    secondary: str = Field(description="辅色")
    accent: str = Field(description="强调色")
    background: str = Field(default="#FFFFFF", description="页面背景色")
    text: str = Field(default="#1E293B", description="默认文字色")
    text_light: str = Field(default="#64748B", description="辅助文字色")

    def all_colors(self) -> list[str]:
        """返回全部颜色列表（用于 lint 校验）。"""
        return [self.primary, self.secondary, self.accent, self.background, self.text, self.text_light]

    def theme_colors(self) -> list[str]:
        """仅主题色（主/辅/强调），用于 lint 的 max_theme_colors 检查。"""
        return [self.primary, self.secondary, self.accent]


# ================================================================ 字号阶梯

class FontSizeLadder(BaseModel):
    """字号阶梯：各级字号的范围约束。

    与 ``rules.json`` 的 ``typography.size_ladder`` 参数一一对应，
    风格包可覆盖默认阶梯。
    """

    hero_title: tuple[int, int] = Field(default=(56, 72), description="封面/hero 页标题字号范围")
    title: tuple[int, int] = Field(default=(32, 40), description="内容页标题字号范围")
    body: tuple[int, int] = Field(default=(18, 24), description="正文字号范围")
    caption: tuple[int, int] = Field(default=(12, 16), description="说明文字字号范围")

    def to_params(self) -> dict[str, list[int]]:
        """转为 rules.json 的 params 格式。"""
        return {
            "hero_title": list(self.hero_title),
            "title": list(self.title),
            "body": list(self.body),
            "caption": list(self.caption),
        }


# ================================================================ 版式模板

class LayoutTemplate(BaseModel):
    """版式模板：描述该风格的典型页面布局。

    供 AI 生成页面时参考（非硬约束），描述各 page_type 的推荐布局。
    """

    page_type: str = Field(description="页面类型: cover/toc/content/section/ending")
    recommended_layout: str = Field(description="推荐布局描述，如 'center' / 'left-right' / 'asymmetric'")
    description: str = Field(default="", description="布局说明")


# ================================================================ 装饰白名单

class DecorationItem(BaseModel):
    """装饰元素白名单条目。"""

    name: str = Field(description="装饰名称，如 'divider-line' / 'corner-accent'")
    type: str = Field(description="装饰类型: shape / gradient / pattern")
    style: dict[str, Any] = Field(default_factory=dict, description="装饰样式（DSL 兼容）")


# ================================================================ 设计 Token

class DesignTokens(BaseModel):
    """设计 token 集合：色板 + 字号 + 版式 + 装饰 + lint 覆盖。

    这是风格包的核心内容，序列化为 ``tokens.json``。
    """

    palette: Palette = Field(description="色板")
    font_size_ladder: FontSizeLadder = Field(default_factory=FontSizeLadder, description="字号阶梯")
    font_families: list[str] = Field(default=["Microsoft YaHei"], description="推荐字体家族（最多 2 个）")
    layout_templates: list[LayoutTemplate] = Field(
        default_factory=list,
        description="版式模板（各 page_type 的推荐布局）",
    )
    decorations: list[DecorationItem] = Field(
        default_factory=list,
        description="装饰白名单（允许使用的装饰元素）",
    )
    lint_overrides: dict[str, dict[str, Any]] = Field(
        default_factory=dict,
        description="lint 规则覆盖：{rule_id: {param_name: new_value}}",
    )

    def to_dict(self) -> dict[str, Any]:
        """序列化为 JSON 兼容 dict。"""
        return self.model_dump()


# ================================================================ 风格包

class StylePack(BaseModel):
    """完整风格包：元信息 + 设计 token + 路由关键词。

    序列化为 ``designs/{id}/tokens.json``。
    """

    id: str = Field(description="风格包 id（如 'academic' / 'business'）")
    name: str = Field(description="风格包中文名")
    description: str = Field(default="", description="风格包描述")
    tokens: DesignTokens = Field(description="设计 token 集合")
    keywords: list[str] = Field(
        default_factory=list,
        description="路由关键词（命中这些词时选中此风格包）",
    )
    soft_keywords: list[str] = Field(
        default_factory=list,
        description="软降级关键词（部分命中时软降级到此风格）",
    )

    def to_dict(self) -> dict[str, Any]:
        """序列化为 JSON 兼容 dict（可写入 tokens.json）。"""
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "keywords": self.keywords,
            "soft_keywords": self.soft_keywords,
            "tokens": self.tokens.to_dict(),
        }


# ================================================================ 路由结果

class RoutingResult(BaseModel):
    """关键词路由结果。

    三态：
    - ``matched``：完全命中（关键词匹配），结构层 + 常量层生效
    - ``soft_match``：软降级（软关键词部分匹配），仅结构层生效
    - ``no_match``：无命中，使用通用风格
    """

    status: str = Field(description="路由状态: matched / soft_match / no_match")
    pack: Optional[StylePack] = Field(default=None, description="命中的风格包")
    matched_keywords: list[str] = Field(default_factory=list, description="匹配到的关键词")
    score: float = Field(default=0.0, description="匹配得分（0-1）")

    @property
    def is_matched(self) -> bool:
        return self.status == "matched"

    @property
    def is_soft_match(self) -> bool:
        return self.status == "soft_match"

    @property
    def is_no_match(self) -> bool:
        return self.status == "no_match"
