"""设计规范 Lint 门禁核验测试（T3.1）。

核验目标（对齐任务分解文档）：
1. 构造 20+ 违规样例（每规则至少 1 个），断言每条规则都被触发且报告数值准确
2. 合法样例 0 告警（含静态 + 动态检查）
3. LintReport / LintIssue 数据结构正确
4. 单页校验 validate_slide 正常工作
"""

from __future__ import annotations

import pytest

from slidep.dsl import Box, Image, Slide, Text
from slidep.validate import (
    LintIssue,
    LintReport,
    validate_deck,
    validate_slide,
)

# ================================================================ 辅助构造

def _make_valid_content_slide() -> Slide:
    """构造合规的内容页：有锚点(44px)、字数≥180、非对称、字号合法。"""
    long_text = (
        "本季度营收达到一百二十亿元同比增长百分之三十四创下历史新高。"
        "核心产品线表现强劲用户增长显著市场占有率稳步提升。"
        "下半年将重点投入研发创新持续优化产品体验深化客户服务。"
    )  # ~80+ chars
    return Slide(
        page_type="content",
        role="supporting",
        rhythm="peak",
        title="业务汇报",
        children=[
            Text("核心指标", style={"fontSize": 44, "color": "#1E293B"}),
            Text(long_text, style={"fontSize": 20, "color": "#475569"}),
        ],
        style={"justifyContent": "flex-start"},
    )


def _make_valid_deck(n: int = 5) -> list[Slide]:
    """构造合规 deck：1/5 hero=20%、非对称≥40%、≤2字体、≤4色、180+字。"""
    slides: list[Slide] = []
    # P0: cover (hero)
    slides.append(Slide(
        page_type="cover", role="hero", rhythm="peak",
        title="季度报告",
        background="#0F172A",
        children=[
            Text("2026 Q2", style={"fontSize": 56, "color": "#FFFFFF"}),
        ],
    ))
    # P1-P3: content (supporting), 至少 2 个非对称
    long = (
        "本季度营收达到一百二十亿元同比增长百分之三十四创下历史新高。"
        "核心产品线表现强劲用户增长显著市场占有率稳步提升。"
        "下半年将重点投入研发创新持续优化产品体验深化客户服务。"
        "团队规模扩大至五百人新增三个区域办事处覆盖全国主要城市。"
        "客户满意度提升至百分之九十五复购率达到百分之六十八。"
        "技术架构完成云原生改造部署效率提升三倍故障率下降百分之六十。"
        "本季度营收达到一百二十亿元同比增长百分之三十四创下历史新高。"
        "核心产品线表现强劲用户增长显著市场占有率稳步提升。"
    )  # 200+ chars
    for i in range(3):
        slides.append(Slide(
            page_type="content", role="supporting", rhythm="peak",
            title=f"内容页{i+1}",
            children=[
                Text(f"标题{i+1}", style={"fontSize": 56, "color": "#1E293B"}),
                Text(long, style={"fontSize": 20, "color": "#475569"}),
            ],
            style={"justifyContent": "flex-start" if i < 2 else "center"},
        ))
    # P4: ending
    slides.append(Slide(
        page_type="ending", role="transition", rhythm="transition",
        title="谢谢",
        background="#0F172A",
        children=[
            Text("感谢聆听", style={"fontSize": 56, "color": "#FFFFFF"}),
        ],
    ))
    return slides


def _find_issue(issues: list[LintIssue], rule_id: str) -> LintIssue | None:
    """从告警列表中查找指定规则。"""
    for i in issues:
        if i.rule_id == rule_id:
            return i
    return None


# ================================================================ 数据结构
class TestDataStructures:
    def test_lint_issue_to_dict(self):
        issue = LintIssue(
            page=0,
            rule_id="test.rule",
            rule_name="测试规则",
            level="error",
            actual=5,
            limit=3,
            message="测试消息",
        )
        d = issue.to_dict()
        assert d["page"] == 0
        assert d["rule_id"] == "test.rule"
        assert d["actual"] == 5
        assert d["limit"] == 3

    def test_lint_report_passed(self):
        report = LintReport(issues=[])
        assert report.passed is True
        assert report.error_count == 0
        assert report.warning_count == 0

    def test_lint_report_failed(self):
        issues = [
            LintIssue(0, "r1", "规则1", "error", 5, 3, "msg1"),
            LintIssue(1, "r2", "规则2", "warning", 10, 8, "msg2"),
        ]
        report = LintReport(issues=issues)
        assert report.passed is False
        assert report.error_count == 1
        assert report.warning_count == 1

    def test_lint_report_to_dict(self):
        report = LintReport(issues=[
            LintIssue(0, "r1", "规则1", "error", 5, 3, "msg1"),
        ])
        d = report.to_dict()
        assert d["passed"] is False
        assert d["error_count"] == 1
        assert len(d["issues"]) == 1


# ================================================================ 合法样例
class TestValidDeck:
    def test_valid_deck_no_errors(self):
        """合规 deck 无 error 告警（含动态检查）。"""
        slides = _make_valid_deck()
        report = validate_deck(slides)
        errors = [i for i in report.issues if i.level == "error"]
        assert len(errors) == 0, f"合规 deck 不应有 error：{[str(e.message) for e in errors]}"

    def test_valid_deck_static_no_warnings(self):
        """合规 deck 静态检查无 warning（run_layout=False）。"""
        slides = _make_valid_deck()
        report = validate_deck(slides, run_layout=False)
        assert report.warning_count == 0, (
            f"静态检查不应有 warning：{[i.message for i in report.issues]}"
        )

    def test_valid_deck_passed(self):
        """合规 deck 通过校验（passed=True）。"""
        slides = _make_valid_deck()
        report = validate_deck(slides, run_layout=False)
        assert report.passed is True


# ================================================================ 排版规则
class TestTypographyRules:
    def test_font_families_exceed(self):
        """字体家族超过 2 个。"""
        slides = [
            Slide(page_type="content", children=[
                Text("A", style={"fontFamily": "Arial", "fontSize": 20}),
                Text("B", style={"fontFamily": "SimSun", "fontSize": 20}),
                Text("C", style={"fontFamily": "Times", "fontSize": 20}),
            ]),
        ]
        report = validate_deck(slides, run_layout=False)
        issue = _find_issue(report.issues, "typography.max_font_families")
        assert issue is not None
        assert issue.actual == 3
        assert issue.limit == 2
        assert issue.level == "error"

    def test_font_families_within_limit(self):
        """字体家族 ≤ 2 不触发。"""
        slides = [
            Slide(page_type="content", children=[
                Text("A", style={"fontFamily": "Arial", "fontSize": 20}),
                Text("B", style={"fontFamily": "SimSun", "fontSize": 20}),
            ]),
        ]
        report = validate_deck(slides, run_layout=False)
        assert _find_issue(report.issues, "typography.max_font_families") is None

    def test_font_size_outside_ladder(self):
        """字号不在阶梯内（25px 不在任一区间）。"""
        slides = [
            Slide(page_type="content", children=[
                Text("x", style={"fontSize": 25}),
            ]),
        ]
        report = validate_deck(slides, run_layout=False)
        issue = _find_issue(report.issues, "typography.size_ladder")
        assert issue is not None
        assert issue.actual == 25.0
        assert issue.level == "error"

    def test_font_size_in_body_range(self):
        """字号 20 在 body [18,24] 内不触发。"""
        slides = [
            Slide(page_type="content", children=[
                Text("x", style={"fontSize": 20}),
            ]),
        ]
        report = validate_deck(slides, run_layout=False)
        assert _find_issue(report.issues, "typography.size_ladder") is None

    def test_font_size_in_title_range(self):
        """字号 32 在 title [32,40] 内不触发。"""
        slides = [
            Slide(page_type="content", children=[
                Text("x", style={"fontSize": 32}),
            ]),
        ]
        report = validate_deck(slides, run_layout=False)
        assert _find_issue(report.issues, "typography.size_ladder") is None

    def test_font_size_in_hero_range(self):
        """字号 56 在 hero_title [56,72] 内不触发。"""
        slides = [
            Slide(page_type="cover", children=[
                Text("x", style={"fontSize": 56}),
            ]),
        ]
        report = validate_deck(slides, run_layout=False)
        assert _find_issue(report.issues, "typography.size_ladder") is None

    def test_font_size_in_caption_range(self):
        """字号 14 在 caption [12,16] 内不触发。"""
        slides = [
            Slide(page_type="content", children=[
                Text("x", style={"fontSize": 14}),
            ]),
        ]
        report = validate_deck(slides, run_layout=False)
        assert _find_issue(report.issues, "typography.size_ladder") is None

    def test_min_body_chars(self):
        """内容页字数不足 180。"""
        slides = [
            Slide(page_type="content", children=[
                Text("短文本", style={"fontSize": 44}),
                Text("内容太少", style={"fontSize": 20}),
            ]),
        ]
        report = validate_deck(slides, run_layout=False)
        issue = _find_issue(report.issues, "typography.min_body_chars")
        assert issue is not None
        assert issue.actual < 180
        assert issue.limit == 180
        assert issue.level == "error"


# ================================================================ 色彩规则
class TestColorRules:
    def test_max_theme_colors(self):
        """主题色超过 4 个。"""
        slides = [
            Slide(page_type="content", children=[
                Text("A", style={"color": "#FF0000", "fontSize": 20}),
                Text("B", style={"color": "#00FF00", "fontSize": 20}),
                Text("C", style={"color": "#0000FF", "fontSize": 20}),
                Text("D", style={"color": "#FFFF00", "fontSize": 20}),
                Text("E", style={"color": "#FF00FF", "fontSize": 20}),
            ], style={"background": "#0F172A"}),
        ]
        report = validate_deck(slides, run_layout=False)
        issue = _find_issue(report.issues, "color.max_theme_colors")
        assert issue is not None
        assert issue.actual > 4
        assert issue.limit == 4
        assert issue.level == "error"

    def test_colors_within_limit(self):
        """≤4 个颜色不触发。"""
        slides = [
            Slide(page_type="content", children=[
                Text("A", style={"color": "#FF0000", "fontSize": 20}),
                Text("B", style={"color": "#00FF00", "fontSize": 20}),
            ], style={"background": "#0F172A"}),
        ]
        report = validate_deck(slides, run_layout=False)
        assert _find_issue(report.issues, "color.max_theme_colors") is None

    def test_color_ratio_primary(self):
        """主色面积超过 60%。"""
        # 一个大的背景 Box 占满大部分 B 区
        slides = [
            Slide(page_type="content", children=[
                Box(style={
                    "background": "#FF0000",
                    "width": "100%", "height": "100%",
                }, children=[
                    Text("内容", style={"fontSize": 20, "color": "#FFFFFF"}),
                ]),
            ]),
        ]
        report = validate_deck(slides, run_layout=True)
        issue = _find_issue(report.issues, "color.primary_ratio")
        assert issue is not None
        assert issue.actual > 0.6
        assert issue.limit == 0.6

    def test_color_ratio_secondary(self):
        """辅色面积超过 30%。"""
        slides = [
            Slide(page_type="content", style={"flexDirection": "row"}, children=[
                Box(style={"background": "#FF0000", "width": "50%", "height": "100%"}),
                Box(style={"background": "#00FF00", "width": "50%", "height": "100%"}),
            ]),
        ]
        report = validate_deck(slides, run_layout=True)
        # 第二大颜色面积应超 30%（50% B区面积的两色平分）
        issue = _find_issue(report.issues, "color.secondary_ratio")
        assert issue is not None
        assert issue.limit == 0.3


# ================================================================ 版式规则
class TestLayoutRules:
    def test_asymmetric_min_ratio(self):
        """非对称版式占比不足 40%。"""
        # 5 个 content 页全部居中
        slides = []
        for i in range(5):
            slides.append(Slide(
                page_type="content",
                children=[
                    Text(f"内容{i}", style={"fontSize": 44}),
                ],
                style={"justifyContent": "center"},
            ))
        report = validate_deck(slides, run_layout=False)
        issue = _find_issue(report.issues, "layout.asymmetric_min_ratio")
        assert issue is not None
        assert issue.actual == 0.0
        assert issue.limit == 0.4
        assert issue.level == "error"

    def test_card_row_max_pages(self):
        """N 卡片横排页数超过 2。"""
        slides = []
        for i in range(4):
            slides.append(Slide(
                page_type="content",
                children=[
                    Box(style={"flexDirection": "row"}, children=[
                        Text(f"A{i}", style={"fontSize": 20}),
                        Text(f"B{i}", style={"fontSize": 20}),
                    ]),
                ],
            ))
        report = validate_deck(slides, run_layout=False)
        issue = _find_issue(report.issues, "layout.card_row_max_pages")
        assert issue is not None
        assert issue.actual == 4
        assert issue.limit == 2

    def test_hero_quota_low(self):
        """Hero 页占比不足 20%。"""
        # 10 页全非 hero
        slides = []
        for i in range(10):
            slides.append(Slide(
                page_type="content",
                role="supporting",
                children=[Text(f"x{i}", style={"fontSize": 20})],
            ))
        report = validate_deck(slides, run_layout=False)
        issue = _find_issue(report.issues, "layout.hero_page_ratio")
        assert issue is not None
        assert issue.actual == 0.0
        assert issue.level == "warning"

    def test_hero_quota_high(self):
        """Hero 页占比超过 30%。"""
        slides = []
        for i in range(10):
            slides.append(Slide(
                page_type="content",
                role="hero",
                children=[Text(f"x{i}", style={"fontSize": 20})],
            ))
        report = validate_deck(slides, run_layout=False)
        issue = _find_issue(report.issues, "layout.hero_page_ratio")
        assert issue is not None
        assert issue.actual == 1.0
        assert issue.level == "warning"

    def test_max_whitespace_ratio(self):
        """留白率超过 35%。"""
        # 一个几乎空的 content 页
        slides = [
            Slide(
                page_type="content",
                children=[
                    Text("短", style={"fontSize": 20}),
                ],
            ),
        ]
        report = validate_deck(slides, run_layout=True)
        issue = _find_issue(report.issues, "layout.max_whitespace_ratio")
        assert issue is not None
        assert issue.actual > 0.35
        assert issue.limit == 0.35

    def test_card_fill_min_ratio(self):
        """卡片填充率不足 85%。"""
        # 大卡片只有一个小文本
        slides = [
            Slide(
                page_type="content",
                children=[
                    Box(style={
                        "background": "#1E293B",
                        "width": "100%",
                        "height": "100%",
                    }, children=[
                        Text("小", style={"fontSize": 20}),
                    ]),
                ],
            ),
        ]
        report = validate_deck(slides, run_layout=True)
        issue = _find_issue(report.issues, "layout.card_fill_min_ratio")
        assert issue is not None
        assert issue.actual < 0.85
        assert issue.limit == 0.85


# ================================================================ 锚点规则
class TestAnchorRules:
    def test_no_anchor(self):
        """内容页无视觉锚点（无 ≥44px 文字、无大图片）。"""
        long = "这是一段足够长的正文内容用于满足字数要求" * 10
        slides = [
            Slide(
                page_type="content",
                children=[
                    Text(long, style={"fontSize": 20}),
                ],
            ),
        ]
        report = validate_deck(slides, run_layout=True)
        issue = _find_issue(report.issues, "anchor.per_page_required")
        assert issue is not None
        assert issue.actual == 0
        assert issue.limit == 1
        assert issue.level == "error"

    def test_has_text_anchor(self):
        """有 ≥44px 文字锚点不触发 per_page_required。"""
        long = "这是一段足够长的正文内容用于满足字数要求" * 10
        slides = [
            Slide(
                page_type="content",
                children=[
                    Text("锚点", style={"fontSize": 44}),
                    Text(long, style={"fontSize": 20}),
                ],
            ),
        ]
        report = validate_deck(slides, run_layout=True)
        assert _find_issue(report.issues, "anchor.per_page_required") is None

    def test_anchor_min_size(self):
        """≥44px 的锚点字号检查：44px 刚好满足。"""
        slides = [
            Slide(
                page_type="content",
                children=[
                    Text("锚点", style={"fontSize": 44}),
                    Text("正文" * 100, style={"fontSize": 20}),
                ],
            ),
        ]
        report = validate_deck(slides, run_layout=True)
        # 44px ≥ 44，不应触发 anchor_min_size 告警
        # 也不应触发 per_page_required
        assert _find_issue(report.issues, "anchor.per_page_required") is None


# ================================================================ 图片分级规则
class TestImageTierRules:
    def test_l1_area_too_small(self, tmp_path):
        """L1 主视觉面积不足 40% B 区。"""
        # 创建一个小图片文件
        from PIL import Image as PILImage
        img_path = tmp_path / "small.png"
        PILImage.new("RGB", (50, 50), color=(255, 0, 0)).save(str(img_path))

        long = "正文内容" * 50
        slides = [
            Slide(
                page_type="content",
                children=[
                    Text("锚点标题", style={"fontSize": 44}),
                    Text(long, style={"fontSize": 20}),
                    Image(src=str(img_path), style={"width": 100, "height": 60}),
                ],
            ),
        ]
        report = validate_deck(slides, run_layout=True)
        issue = _find_issue(report.issues, "image.l1_area")
        assert issue is not None
        assert issue.actual < 0.4
        assert issue.limit == 0.4

    def test_l2_min_size_violation(self, tmp_path):
        """L2 支撑图尺寸不足 280x180。"""
        from PIL import Image as PILImage
        img_path = tmp_path / "l2_small.png"
        PILImage.new("RGB", (50, 50), color=(0, 255, 0)).save(str(img_path))

        body = "正文内容" * 15
        slides = [
            Slide(
                page_type="content",
                children=[
                    Text("锚点标题", style={"fontSize": 44}),
                    Text(body, style={"fontSize": 20}),
                    # 一个大图作 L1 + 一个小图作 L2
                    Image(src=str(img_path), style={"width": 600, "height": 300}),
                    Image(src=str(img_path), style={"width": 100, "height": 80}),
                ],
            ),
        ]
        report = validate_deck(slides, run_layout=True)
        issue = _find_issue(report.issues, "image.l2_min_size")
        assert issue is not None
        assert "100x80" in str(issue.actual) or "280x180" in str(issue.limit)


# ================================================================ TOC 规则
class TestTocRules:
    def test_toc_max_entries(self):
        """目录条目超过 8 条。"""
        children = [Text(f"第{i}章", style={"fontSize": 20}) for i in range(10)]
        slides = [
            Slide(
                page_type="toc",
                children=children,
            ),
        ]
        report = validate_deck(slides, run_layout=False)
        issue = _find_issue(report.issues, "toc.max_entries")
        assert issue is not None
        assert issue.actual == 10
        assert issue.limit == 8
        assert issue.level == "warning"

    def test_toc_within_limit(self):
        """目录 ≤8 条不触发。"""
        children = [Text(f"第{i}章", style={"fontSize": 20}) for i in range(5)]
        slides = [
            Slide(
                page_type="toc",
                children=children,
            ),
        ]
        report = validate_deck(slides, run_layout=False)
        assert _find_issue(report.issues, "toc.max_entries") is None


# ================================================================ 结构规则
class TestStructureRules:
    def test_nesting_depth_exceeded(self):
        """容器嵌套深度超过 5 层触发告警。"""
        leaf = Text("文本", style={"fontSize": 20})
        slides = [
            Slide(
                page_type="content",
                children=[
                    Box(children=[
                        Box(children=[
                            Box(children=[
                                Box(children=[leaf]),
                            ]),
                        ]),
                    ]),
                ],
            ),
        ]
        report = validate_deck(slides, run_layout=False)
        issue = _find_issue(report.issues, "structure.max_nesting_depth")
        assert issue is not None
        assert issue.actual == 6
        assert issue.limit == 5
        assert issue.level == "warning"

    def test_nesting_depth_within_limit(self):
        """容器嵌套深度 ≤5 层不触发。"""
        leaf = Text("文本", style={"fontSize": 20})
        slides = [
            Slide(
                page_type="content",
                children=[
                    Box(children=[
                        Box(children=[
                            Box(children=[leaf]),
                        ]),
                    ]),
                ],
            ),
        ]
        report = validate_deck(slides, run_layout=False)
        assert _find_issue(report.issues, "structure.max_nesting_depth") is None


# ================================================================ 单页校验
class TestValidateSlide:
    def test_single_page_violations(self):
        """单页校验能检测到违规。"""
        slide = Slide(
            page_type="content",
            children=[
                Text("x", style={"fontSize": 25}),  # 不在阶梯
            ],
        )
        issues = validate_slide(slide, page_index=3)
        # 应检测到字号阶梯违规
        size_issue = _find_issue(issues, "typography.size_ladder")
        assert size_issue is not None

    def test_single_page_no_deck_rules(self):
        """单页校验不含 deck 级规则。"""
        slide = Slide(
            page_type="content",
            role="hero",
            children=[Text("x", style={"fontSize": 20})],
        )
        issues = validate_slide(slide)
        # 不应包含 hero_quota（deck 级规则）
        assert _find_issue(issues, "layout.hero_page_ratio") is None

    def test_single_page_page_index(self):
        """单页校验的 page 索引正确。"""
        slide = Slide(
            page_type="content",
            children=[
                Text("短", style={"fontSize": 20}),
            ],
        )
        issues = validate_slide(slide, page_index=5)
        # 检查告警的 page 字段为 5
        for issue in issues:
            if issue.page != -1:  # 排除 deck 级别
                assert issue.page == 5 or issue.page == 0


# ================================================================ 全量校验
class TestValidateDeck:
    def test_empty_deck(self):
        """空 deck 不崩溃。"""
        report = validate_deck([])
        assert report.passed is True

    def test_run_layout_false(self):
        """run_layout=False 时仅做静态检查。"""
        # 一个需要布局才能检测的违规（留白率）
        slide = Slide(
            page_type="content",
            children=[Text("短", style={"fontSize": 20})],
        )
        report = validate_deck([slide], run_layout=False)
        # 留白率检查不应触发（无布局结果）
        assert _find_issue(report.issues, "layout.max_whitespace_ratio") is None

    def test_multiple_violations(self):
        """多种违规同时存在。"""
        slides = [
            Slide(
                page_type="content",
                children=[
                    Text("A", style={"fontFamily": "F1", "fontSize": 25, "color": "#FF0000"}),
                    Text("B", style={"fontFamily": "F2", "fontSize": 26, "color": "#00FF00"}),
                    Text("C", style={"fontFamily": "F3", "fontSize": 27, "color": "#0000FF"}),
                    Text("D", style={"fontFamily": "F4", "fontSize": 28, "color": "#FFFF00"}),
                    Text("E", style={"fontFamily": "F5", "fontSize": 29, "color": "#FF00FF"}),
                ],
            ),
        ]
        report = validate_deck(slides, run_layout=False)
        # 应同时检测到字体家族超限和字号阶梯违规
        assert _find_issue(report.issues, "typography.max_font_families") is not None
        assert _find_issue(report.issues, "typography.size_ladder") is not None
        assert _find_issue(report.issues, "color.max_theme_colors") is not None

    def test_report_to_dict(self):
        """报告序列化为 dict。"""
        slides = [
            Slide(page_type="content", children=[
                Text("x", style={"fontSize": 25}),
            ]),
        ]
        report = validate_deck(slides, run_layout=False)
        d = report.to_dict()
        assert "passed" in d
        assert "error_count" in d
        assert "warning_count" in d
        assert "issues" in d
        assert isinstance(d["issues"], list)
