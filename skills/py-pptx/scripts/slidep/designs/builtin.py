"""内置风格包（T5.1）：academic / business / government / general 四套。

每套风格包包含完整的 DesignTokens（色板 + 字号 + 版式 + lint 覆盖），
序列化后即 ``designs/{id}/tokens.json``。
"""

from __future__ import annotations

from slidep.designs.models import (
    DecorationItem,
    DesignTokens,
    FontSizeLadder,
    LayoutTemplate,
    Palette,
    StylePack,
)


# ================================================================ 学术风格

_academic = StylePack(
    id="academic",
    name="学术",
    description="严谨克制，适合论文答辩、学术报告、研究汇报。冷色系为主，低饱和度，强调层次与留白。",
    keywords=[
        "论文", "答辩", "学术", "研究", "论文答辩", "学位",
        "科研", "课题", "学术报告", "研究汇报", "实验室",
        "review", "paper", "thesis", "research",
    ],
    soft_keywords=["报告", "汇报", "分析", "数据", "统计"],
    tokens=DesignTokens(
        palette=Palette(
            primary="#1E40AF",
            secondary="#3B82F6",
            accent="#F59E0B",
            background="#F8FAFC",
            text="#0F172A",
            text_light="#475569",
        ),
        font_size_ladder=FontSizeLadder(
            hero_title=(48, 64),
            title=(28, 36),
            body=(16, 22),
            caption=(11, 14),
        ),
        font_families=["SimSun", "Times New Roman"],
        layout_templates=[
            LayoutTemplate(page_type="cover", recommended_layout="center", description="封面居中，标题 + 作者 + 机构"),
            LayoutTemplate(page_type="content", recommended_layout="left-right", description="左文右图，数据驱动"),
            LayoutTemplate(page_type="section", recommended_layout="left", description="左对齐色块标题"),
            LayoutTemplate(page_type="ending", recommended_layout="center", description="致谢页居中"),
        ],
        decorations=[
            DecorationItem(
                name="academic-divider",
                type="shape",
                style={"background": "#1E40AF", "height": "3px", "width": "60px"},
            ),
        ],
        lint_overrides={
            "typography.size_ladder": {
                "hero_title": [48, 64],
                "title": [28, 36],
                "body": [16, 22],
                "caption": [11, 14],
            },
            "typography.min_body_chars": {"min": 200},
            "layout.max_whitespace_ratio": {"max": 0.40},
            "color.max_theme_colors": {"max": 5},
        },
    ),
)


# ================================================================ 商务风格

_business = StylePack(
    id="business",
    name="商务",
    description="专业稳健，适合季度汇报、商业计划、项目总结。深蓝主色，几何感强，信息密度高。",
    keywords=[
        "商业", "商务", "季度", "汇报", "项目", "产品",
        "市场", "营收", "增长", "战略", "商业计划", "项目总结",
        "business", "quarterly", "report", "strategy",
    ],
    soft_keywords=["总结", "计划", "方案", "目标", "团队"],
    tokens=DesignTokens(
        palette=Palette(
            primary="#0F172A",
            secondary="#334155",
            accent="#3B82F6",
            background="#FFFFFF",
            text="#1E293B",
            text_light="#64748B",
        ),
        font_size_ladder=FontSizeLadder(
            hero_title=(56, 72),
            title=(32, 40),
            body=(18, 24),
            caption=(12, 16),
        ),
        font_families=["Microsoft YaHei"],
        layout_templates=[
            LayoutTemplate(page_type="cover", recommended_layout="center", description="深色背景，大标题居中"),
            LayoutTemplate(page_type="content", recommended_layout="asymmetric", description="非对称布局，左标题右内容"),
            LayoutTemplate(page_type="section", recommended_layout="left", description="色块条 + 章节标题"),
            LayoutTemplate(page_type="ending", recommended_layout="center", description="深色背景致谢"),
        ],
        decorations=[
            DecorationItem(
                name="business-accent-bar",
                type="shape",
                style={"background": "#3B82F6", "height": "4px", "width": "100%"},
            ),
            DecorationItem(
                name="business-corner",
                type="shape",
                style={"background": "#0F172A", "width": "120px", "height": "120px", "borderRadius": "0 0 0 100%"},
            ),
        ],
        lint_overrides={
            "typography.min_body_chars": {"min": 180},
            "layout.asymmetric_min_ratio": {"min": 0.5},
        },
    ),
)


# ================================================================ 政务风格

_government = StylePack(
    id="government",
    name="政务",
    description="庄重规范，适合政府工作报告、政策解读、年终总结。红金配色，对称庄重，结构化强。",
    keywords=[
        "政务", "政府", "政策", "工作", "年终", "工作报告",
        "政策解读", "政府工作报告", "机关", "单位", "部门",
        "government", "policy", "official",
    ],
    soft_keywords=["总结", "报告", "规划", "建设", "发展"],
    tokens=DesignTokens(
        palette=Palette(
            primary="#991B1B",
            secondary="#DC2626",
            accent="#F59E0B",
            background="#FFFBEB",
            text="#1C1917",
            text_light="#78716C",
        ),
        font_size_ladder=FontSizeLadder(
            hero_title=(52, 68),
            title=(30, 38),
            body=(18, 24),
            caption=(12, 16),
        ),
        font_families=["SimHei", "FangSong"],
        layout_templates=[
            LayoutTemplate(page_type="cover", recommended_layout="center", description="红金配色，居中对齐，庄重"),
            LayoutTemplate(page_type="content", recommended_layout="left-right", description="左标题右内容，对称结构"),
            LayoutTemplate(page_type="section", recommended_layout="center", description="红色色块居中标题"),
            LayoutTemplate(page_type="ending", recommended_layout="center", description="居中致谢"),
        ],
        decorations=[
            DecorationItem(
                name="gov-header-bar",
                type="shape",
                style={"background": "#991B1B", "height": "8px", "width": "100%"},
            ),
            DecorationItem(
                name="gov-seal-accent",
                type="shape",
                style={"background": "#F59E0B", "borderRadius": "50%", "width": "48px", "height": "48px"},
            ),
        ],
        lint_overrides={
            "typography.size_ladder": {
                "hero_title": [52, 68],
                "title": [30, 38],
                "body": [18, 24],
                "caption": [12, 16],
            },
            "layout.asymmetric_min_ratio": {"min": 0.3},
            "color.primary_ratio": {"max": 0.65},
        },
    ),
)


# ================================================================ 通用风格

_general = StylePack(
    id="general",
    name="通用",
    description="均衡适配，适合大多数场景的默认风格。中性色系，布局灵活，无强风格倾向。",
    keywords=["通用", "默认", "普通", "general", "default"],
    soft_keywords=[],
    tokens=DesignTokens(
        palette=Palette(
            primary="#1E293B",
            secondary="#3B82F6",
            accent="#F59E0B",
            background="#FFFFFF",
            text="#1E293B",
            text_light="#64748B",
        ),
        font_size_ladder=FontSizeLadder(),
        font_families=["Microsoft YaHei"],
        layout_templates=[
            LayoutTemplate(page_type="cover", recommended_layout="center", description="居中封面"),
            LayoutTemplate(page_type="content", recommended_layout="left-right", description="左右布局"),
            LayoutTemplate(page_type="section", recommended_layout="left", description="色块标题"),
            LayoutTemplate(page_type="ending", recommended_layout="center", description="居中结束"),
        ],
        decorations=[],
        lint_overrides={},
    ),
)


# ================================================================ 注册表

BUILTIN_PACKS: list[StylePack] = [_academic, _business, _government, _general]

_PACK_MAP: dict[str, StylePack] = {p.id: p for p in BUILTIN_PACKS}


def get_builtin_pack(pack_id: str) -> StylePack | None:
    """按 id 获取内置风格包。"""
    return _PACK_MAP.get(pack_id)


def list_builtin_packs() -> list[StylePack]:
    """列出全部内置风格包。"""
    return list(BUILTIN_PACKS)
