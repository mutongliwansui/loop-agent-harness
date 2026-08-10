"""风格包体系测试（T5.1）。

核验目标（对齐任务分解文档）：
1. 路由单测：命中/软降级/无命中各 3+ 用例
2. 每风格生成 10 页样例全量通过 T3.1 lint
3. 同风格两批生成 → 视觉 token 一致

测试策略：
- 数据模型：Palette / FontSizeLadder / DesignTokens / StylePack 序列化
- 路由：命中/软降级/无命中/多关键词/大小写/英文混合
- lint 覆盖：apply_overrides 合并 rules.json、参数级覆盖
- 参照风格：从 StyleProfile 生成、色板/字号/字体提取
- 内置风格包：4 套 pack 完整性（id/name/keywords/tokens）
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from slidep.designs import (
    BUILTIN_PACKS,
    DesignTokens,
    FontSizeLadder,
    Palette,
    RoutingResult,
    StylePack,
    apply_overrides,
    export_tokens_json,
    generate_from_profile,
    get_effective_font_ladder,
    get_effective_params,
    get_effective_palette,
    get_pack,
    list_packs,
    route_query,
)
from slidep.extract.models import StyleProfile


# ================================================================ 数据模型

class TestPalette:
    """Palette 数据模型测试。"""

    def test_palette_creation(self):
        """Palette 基本创建。"""
        p = Palette(
            primary="#1E40AF",
            secondary="#3B82F6",
            accent="#F59E0B",
        )
        assert p.primary == "#1E40AF"
        assert p.background == "#FFFFFF"
        assert p.text == "#1E293B"

    def test_all_colors(self):
        """all_colors 返回全部 6 色。"""
        p = Palette(primary="#000000", secondary="#111111", accent="#222222")
        assert len(p.all_colors()) == 6
        assert "#000000" in p.all_colors()

    def test_theme_colors(self):
        """theme_colors 仅返回主题色（主/辅/强调）。"""
        p = Palette(primary="#000000", secondary="#111111", accent="#222222")
        assert len(p.theme_colors()) == 3
        assert p.theme_colors() == ["#000000", "#111111", "#222222"]


class TestFontSizeLadder:
    """FontSizeLadder 测试。"""

    def test_default_ladder(self):
        """默认字号阶梯与 rules.json 一致。"""
        ladder = FontSizeLadder()
        assert ladder.hero_title == (56, 72)
        assert ladder.title == (32, 40)
        assert ladder.body == (18, 24)
        assert ladder.caption == (12, 16)

    def test_to_params(self):
        """to_params 转 rules.json 格式。"""
        ladder = FontSizeLadder(hero_title=(48, 64), title=(28, 36), body=(16, 22), caption=(11, 14))
        params = ladder.to_params()
        assert params["hero_title"] == [48, 64]
        assert params["title"] == [28, 36]
        assert params["body"] == [16, 22]
        assert params["caption"] == [11, 14]


class TestStylePackSerialization:
    """StylePack 序列化测试。"""

    def test_to_dict_and_from_dict(self):
        """StylePack to_dict → 可序列化为 JSON。"""
        pack = BUILTIN_PACKS[0]  # academic
        d = pack.to_dict()
        assert d["id"] == "academic"
        assert "tokens" in d
        assert "keywords" in d

        # JSON 序列化
        json_str = json.dumps(d, ensure_ascii=False)
        assert "academic" in json_str

    def test_tokens_to_dict(self):
        """DesignTokens to_dict 可序列化。"""
        pack = BUILTIN_PACKS[0]
        tokens_dict = pack.tokens.to_dict()
        assert "palette" in tokens_dict
        assert "font_size_ladder" in tokens_dict
        assert "lint_overrides" in tokens_dict


# ================================================================ 内置风格包

class TestBuiltinPacks:
    """内置风格包完整性测试。"""

    def test_four_packs_exist(self):
        """4 套内置风格包存在。"""
        assert len(BUILTIN_PACKS) == 4
        ids = [p.id for p in BUILTIN_PACKS]
        assert "academic" in ids
        assert "business" in ids
        assert "government" in ids
        assert "general" in ids

    def test_each_pack_has_required_fields(self):
        """每套风格包有完整字段。"""
        for pack in BUILTIN_PACKS:
            assert pack.id, f"pack {pack} 缺少 id"
            assert pack.name, f"pack {pack.id} 缺少 name"
            assert pack.tokens is not None, f"pack {pack.id} 缺少 tokens"
            assert pack.tokens.palette is not None
            assert pack.tokens.font_size_ladder is not None
            assert len(pack.tokens.font_families) >= 1

    def test_each_pack_has_keywords(self):
        """非 general 风格包必须有关键词。"""
        for pack in BUILTIN_PACKS:
            if pack.id == "general":
                continue
            assert len(pack.keywords) >= 3, f"pack {pack.id} 关键词不足 3 个"

    def test_get_pack_by_id(self):
        """get_pack 按 id 查找。"""
        pack = get_pack("academic")
        assert pack is not None
        assert pack.id == "academic"

    def test_get_pack_not_found(self):
        """get_pack 不存在的 id 返回 None。"""
        assert get_pack("nonexistent") is None

    def test_list_packs(self):
        """list_packs 返回全部风格包。"""
        packs = list_packs()
        assert len(packs) == 4

    def test_pack_palette_colors_valid(self):
        """每套风格包的色板颜色是 hex6 格式。"""
        import re
        hex_re = re.compile(r"^#[0-9A-Fa-f]{6}$")
        for pack in BUILTIN_PACKS:
            for color in pack.tokens.palette.all_colors():
                assert hex_re.match(color), f"pack {pack.id} 颜色 {color} 不是 hex6"

    def test_pack_font_families_max_two(self):
        """每套风格包字体家族不超过 2 个。"""
        for pack in BUILTIN_PACKS:
            assert len(pack.tokens.font_families) <= 2, f"pack {pack.id} 字体家族超过 2 个"

    def test_pack_has_layout_templates(self):
        """每套风格包有版式模板。"""
        for pack in BUILTIN_PACKS:
            assert len(pack.tokens.layout_templates) >= 3, f"pack {pack.id} 版式模板不足 3 个"


# ================================================================ 路由测试

class TestRouteQuery:
    """关键词路由测试：命中/软降级/无命中。"""

    # ---- 命中（matched）----

    @pytest.mark.parametrize("query,expected_id", [
        ("论文答辩：基于深度学习的图像识别研究", "academic"),
        ("学术报告：量子计算前沿进展", "academic"),
        ("科研课题年度总结", "academic"),
        ("季度业务汇报：Q2 营收增长分析", "business"),
        ("商业计划书：新产品市场策略", "business"),
        ("项目总结：技术团队季度回顾", "business"),
        ("政府工作报告：年度发展回顾", "government"),
        ("政策解读：新基建规划方向", "government"),
        ("年终工作总结：机关单位建设成果", "government"),
    ])
    def test_matched(self, query, expected_id):
        """命中：query 包含风格包关键词。"""
        result = route_query(query)
        assert result.is_matched, f"query={query} 未命中，status={result.status}"
        assert result.pack is not None
        assert result.pack.id == expected_id, f"query={query} 期望 {expected_id}，实际 {result.pack.id}"
        assert len(result.matched_keywords) >= 1
        assert result.score > 0

    def test_matched_english(self):
        """英文关键词命中。"""
        result = route_query("research paper review on deep learning")
        assert result.is_matched
        assert result.pack.id == "academic"

    def test_matched_case_insensitive(self):
        """关键词大小写不敏感。"""
        result = route_query("BUSINESS Strategy Report")
        assert result.is_matched
        assert result.pack.id == "business"

    # ---- 软降级（soft_match）----

    @pytest.mark.parametrize("query,expected_id", [
        ("数据分析与统计报告", "academic"),  # "分析" + "数据" + "统计" → academic soft
        ("团队目标规划方案", "business"),  # "团队" + "目标" + "方案" → business soft
        ("发展规划与建设报告", "government"),  # "规划" + "建设" + "发展" → government soft
    ])
    def test_soft_match(self, query, expected_id):
        """软降级：query 仅命中 soft_keywords。"""
        result = route_query(query)
        assert result.is_soft_match, f"query={query} 不是 soft_match，status={result.status}"
        assert result.pack is not None
        assert result.pack.id == expected_id, f"query={query} 期望 {expected_id}，实际 {result.pack.id}"
        assert len(result.matched_keywords) >= 1

    def test_soft_match_does_not_trigger_on_hard_keywords(self):
        """硬关键词命中时不会走软匹配。"""
        # "论文" 是 academic 的硬关键词，不会走 soft
        result = route_query("论文答辩")
        assert result.is_matched
        assert not result.is_soft_match

    # ---- 无命中（no_match）----

    @pytest.mark.parametrize("query", [
        ("天气预报"),
        ("美食菜谱分享"),
        ("旅游攻略"),
        ("abcdefg"),
        (""),
    ])
    def test_no_match(self, query):
        """无命中：返回通用风格包。"""
        result = route_query(query)
        assert result.is_no_match
        assert result.pack is not None
        assert result.pack.id == "general"
        assert result.score == 0.0

    # ---- 路由逻辑 ----

    def test_multiple_packs_match_takes_highest_score(self):
        """多风格包同时命中时取 score 最高的。"""
        # "汇报" 在 academic 和 business 都有，但 business 有 "季度" "商务" 更强
        result = route_query("季度汇报")
        assert result.is_matched
        # business 有 "季度" 和 "汇报" 两个硬关键词
        assert result.pack.id == "business"

    def test_routing_result_properties(self):
        """RoutingResult 属性正确。"""
        matched = RoutingResult(status="matched", pack=BUILTIN_PACKS[0])
        assert matched.is_matched
        assert not matched.is_soft_match
        assert not matched.is_no_match

        soft = RoutingResult(status="soft_match", pack=BUILTIN_PACKS[0])
        assert not soft.is_matched
        assert soft.is_soft_match

        none = RoutingResult(status="no_match", pack=BUILTIN_PACKS[3])
        assert none.is_no_match


# ================================================================ lint 覆盖

class TestLintOverrides:
    """风格包与 lint 联动测试。"""

    def _load_rules(self) -> dict:
        """加载 rules.json。"""
        rules_path = Path(__file__).parent.parent / "scripts" / "slidep" / "validate" / "rules.json"
        with open(rules_path, encoding="utf-8") as f:
            return json.load(f)

    def test_apply_overrides_matched(self):
        """matched 状态时覆盖 lint 参数。"""
        rules = self._load_rules()
        result = route_query("论文答辩")

        merged = apply_overrides(rules, result)

        # academic 覆盖了 typography.min_body_chars 的 min 为 200
        for rule in merged["rules"]:
            if rule["id"] == "typography.min_body_chars":
                assert rule["params"]["min"] == 200
                break
        else:
            pytest.fail("未找到 typography.min_body_chars 规则")

    def test_apply_overrides_soft_match_no_change(self):
        """soft_match 状态不覆盖 lint 参数。"""
        rules = self._load_rules()
        result = route_query("数据分析报告")  # soft_match → academic

        merged = apply_overrides(rules, result)

        # 不应覆盖
        for rule in merged["rules"]:
            if rule["id"] == "typography.min_body_chars":
                assert rule["params"]["min"] == 180  # 原始值
                break

    def test_apply_overrides_no_match_no_change(self):
        """no_match 状态不覆盖 lint 参数。"""
        rules = self._load_rules()
        result = route_query("天气预报")

        merged = apply_overrides(rules, result)
        assert merged == rules  # 无变化

    def test_apply_overrides_does_not_mutate_original(self):
        """apply_overrides 不修改原始 rules。"""
        rules = self._load_rules()
        original = copy.deepcopy(rules)
        result = route_query("论文答辩")

        apply_overrides(rules, result)

        assert rules == original, "原始 rules 被修改了"

    def test_apply_overrides_size_ladder(self):
        """academic 风格覆盖字号阶梯。"""
        rules = self._load_rules()
        result = route_query("学术报告")

        merged = apply_overrides(rules, result)

        for rule in merged["rules"]:
            if rule["id"] == "typography.size_ladder":
                assert rule["params"]["hero_title"] == [48, 64]
                assert rule["params"]["body"] == [16, 22]
                break

    def test_get_effective_params(self):
        """get_effective_params 获取有效参数。"""
        rules = self._load_rules()
        academic = get_pack("academic")

        params = get_effective_params(rules, academic, "typography.min_body_chars")
        assert params["min"] == 200

        # 无风格包 → 原始值
        params_default = get_effective_params(rules, None, "typography.min_body_chars")
        assert params_default["min"] == 180

    def test_get_effective_palette(self):
        """get_effective_palette 获取有效色板。"""
        academic = get_pack("academic")
        palette = get_effective_palette(academic)
        assert palette["primary"] == "#1E40AF"

        # None → 默认色板
        palette_default = get_effective_palette(None)
        assert palette_default["primary"] == "#1E293B"

    def test_get_effective_font_ladder(self):
        """get_effective_font_ladder 获取有效字号阶梯。"""
        academic = get_pack("academic")
        ladder = get_effective_font_ladder(academic)
        assert ladder["hero_title"] == [48, 64]

        # None → 默认
        ladder_default = get_effective_font_ladder(None)
        assert ladder_default["hero_title"] == [56, 72]


# ================================================================ 参照风格生成

class TestGenerateFromProfile:
    """基于 StyleProfile 生成参照风格包测试。"""

    def _make_profile(self, **kwargs) -> StyleProfile:
        """构造测试用 StyleProfile。"""
        defaults = {
            "source_path": "test.docx",
            "source_format": "docx",
            "dominant_colors": ["#FF0000", "#00FF00", "#0000FF"],
            "color_ratios": [50.0, 30.0, 20.0],
            "font_size_histogram": {"28": 10, "18": 50, "12": 5},
            "font_families": ["SimSun", "Microsoft YaHei"],
        }
        defaults.update(kwargs)
        return StyleProfile(**defaults)

    def test_generate_basic(self):
        """基本生成：id/name/tokens 完整。"""
        profile = self._make_profile()
        pack = generate_from_profile(profile)

        assert pack.id == "referenced"
        assert pack.name == "参照风格"
        assert pack.tokens is not None

    def test_generate_palette_from_colors(self):
        """主色列表 → Palette。"""
        profile = self._make_profile(
            dominant_colors=["#FF0000", "#00FF00", "#0000FF"],
            color_ratios=[50.0, 30.0, 20.0],
        )
        pack = generate_from_profile(profile)
        assert pack.tokens.palette.primary == "#FF0000"
        assert pack.tokens.palette.secondary == "#00FF00"
        assert pack.tokens.palette.accent == "#0000FF"

    def test_generate_palette_fewer_colors(self):
        """主色不足时用默认值补齐。"""
        profile = self._make_profile(
            dominant_colors=["#FF0000"],
            color_ratios=[100.0],
        )
        pack = generate_from_profile(profile)
        assert pack.tokens.palette.primary == "#FF0000"
        assert pack.tokens.palette.secondary == "#3B82F6"  # 默认
        assert pack.tokens.palette.accent == "#F59E0B"  # 默认

    def test_generate_font_ladder(self):
        """字号直方图 → FontSizeLadder。"""
        profile = self._make_profile(
            font_size_histogram={"28": 10, "18": 50, "12": 5},
        )
        pack = generate_from_profile(profile)
        ladder = pack.tokens.font_size_ladder
        # 最大字号 28 → hero 或 title
        assert ladder.hero_title[1] >= 28

    def test_generate_font_families(self):
        """字体家族提取（最多 2 个）。"""
        profile = self._make_profile(
            font_families=["SimSun", "Microsoft YaHei", "Arial"],
        )
        pack = generate_from_profile(profile)
        assert pack.tokens.font_families == ["SimSun", "Microsoft YaHei"]

    def test_generate_font_families_empty(self):
        """无字体家族时用默认值。"""
        profile = self._make_profile(font_families=[])
        pack = generate_from_profile(profile)
        assert pack.tokens.font_families == ["Microsoft YaHei"]

    def test_generate_has_lint_overrides(self):
        """生成的风格包有 lint_overrides（字号阶梯）。"""
        profile = self._make_profile()
        pack = generate_from_profile(profile)
        assert "typography.size_ladder" in pack.tokens.lint_overrides

    def test_generate_empty_profile(self):
        """空 StyleProfile 也能生成（用默认值）。"""
        profile = StyleProfile(source_path="empty.pdf", source_format="pdf")
        pack = generate_from_profile(profile)
        assert pack.id == "referenced"
        assert pack.tokens.palette.primary == "#1E293B"  # 默认
        assert pack.tokens.font_families == ["Microsoft YaHei"]

    def test_export_tokens_json(self):
        """导出 tokens.json 兼容格式。"""
        profile = self._make_profile()
        pack = generate_from_profile(profile)
        d = export_tokens_json(pack)

        assert d["id"] == "referenced"
        assert "tokens" in d
        # JSON 可序列化
        json_str = json.dumps(d, ensure_ascii=False)
        assert "referenced" in json_str


# ================================================================ 10 页样例 lint

class TestStylePackLintPass:
    """每风格生成 10 页样例全量通过 T3.1 lint。

    核验目标②：每风格生成 10 页样例全量通过 lint。
    """

    def _make_10_slides_academic(self):
        """学术风格 10 页。"""
        from slidep.dsl import Slide, Text

        long_text = (
            "本研究针对基于深度学习的图像识别技术进行了系统性探索与实验验证。"
            "通过在多个公开数据集上的对比实验，验证了所提出方法的有效性和鲁棒性。"
            "实验结果表明，改进后的模型在准确率和推理速度上均有显著提升。"
            "具体而言，在 ImageNet 数据集上，Top-1 准确率提升了三个百分点。"
            "同时推理速度相比基线方法提升了约两倍，满足了实时应用的需求。"
            "本研究的贡献在于提出了一种新颖的注意力机制模块。"
            "该模块能够有效捕获全局上下文信息，增强特征表达能力。"
        )
        slides = [
            Slide(
                page_type="cover", role="hero", rhythm="peak",
                title="深度学习图像识别研究",
                background="#F8FAFC",
                children=[Text("2026 学术报告", style={"fontSize": 56, "color": "#1E40AF"})],
            ),
            Slide(
                page_type="toc", role="transition", rhythm="transition",
                title="目录",
                children=[
                    Text("1. 研究背景", style={"fontSize": 20, "color": "#0F172A"}),
                    Text("2. 方法设计", style={"fontSize": 20, "color": "#0F172A"}),
                    Text("3. 实验结果", style={"fontSize": 20, "color": "#0F172A"}),
                    Text("4. 结论与展望", style={"fontSize": 20, "color": "#0F172A"}),
                ],
            ),
            Slide(
                page_type="section", role="transition", rhythm="transition",
                title="研究背景",
                children=[],
            ),
        ]
        for i in range(4):
            slides.append(Slide(
                page_type="content", role="supporting", rhythm="valley",
                title=f"研究内容{i+1}",
                style={"justifyContent": "flex-start"},
                children=[
                    Text(f"核心发现{i+1}", style={"fontSize": 56, "color": "#1E40AF"}),
                    Text(long_text, style={"fontSize": 18, "color": "#0F172A"}),
                ],
            ))
        slides.append(Slide(
            page_type="section", role="transition", rhythm="transition",
            title="实验结果",
            children=[],
        ))
        slides.append(Slide(
            page_type="content", role="hero", rhythm="peak",
            title="关键实验结论",
            style={"justifyContent": "flex-start"},
            children=[
                Text("准确率提升 3%", style={"fontSize": 56, "color": "#1E40AF"}),
                Text(long_text, style={"fontSize": 18, "color": "#0F172A"}),
            ],
        ))
        slides.append(Slide(
            page_type="ending", role="transition", rhythm="transition",
            title="致谢",
            background="#F8FAFC",
            children=[Text("感谢聆听", style={"fontSize": 56, "color": "#1E40AF"})],
        ))
        return slides

    def _make_10_slides_business(self):
        """商务风格 10 页。"""
        from slidep.dsl import Slide, Text

        long_text = (
            "本季度营收达到一百二十亿元同比增长百分之三十四创下历史新高。"
            "核心产品线表现强劲用户增长显著市场占有率稳步提升。"
            "下半年将重点投入研发创新持续优化产品体验深化客户服务。"
            "团队规模扩大至五百人新增三个区域办事处覆盖全国主要城市。"
            "客户满意度提升至百分之九十五复购率达到百分之六十八。"
            "技术架构完成云原生改造部署效率提升三倍故障率下降百分之六十。"
            "本季度营收达到一百二十亿元同比增长百分之三十四创下历史新高。"
            "核心产品线表现强劲用户增长显著市场占有率稳步提升。"
        )
        slides = [
            Slide(
                page_type="cover", role="hero", rhythm="peak",
                title="季度业务汇报",
                background="#0F172A",
                children=[Text("2026 Q2", style={"fontSize": 56, "color": "#FFFFFF"})],
            ),
            Slide(
                page_type="toc", role="transition", rhythm="transition",
                title="目录",
                children=[
                    Text("1. 季度概览", style={"fontSize": 20, "color": "#1E293B"}),
                    Text("2. 业务增长", style={"fontSize": 20, "color": "#1E293B"}),
                    Text("3. 产品进展", style={"fontSize": 20, "color": "#1E293B"}),
                    Text("4. 下半年规划", style={"fontSize": 20, "color": "#1E293B"}),
                ],
            ),
            Slide(
                page_type="section", role="transition", rhythm="transition",
                title="季度概览",
                children=[],
            ),
        ]
        for i in range(4):
            slides.append(Slide(
                page_type="content", role="supporting", rhythm="valley",
                title=f"业务板块{i+1}",
                style={"justifyContent": "flex-start"},
                children=[
                    Text(f"核心指标{i+1}", style={"fontSize": 56, "color": "#0F172A"}),
                    Text(long_text, style={"fontSize": 18, "color": "#1E293B"}),
                ],
            ))
        slides.append(Slide(
            page_type="section", role="transition", rhythm="transition",
            title="下半年规划",
            children=[],
        ))
        slides.append(Slide(
            page_type="content", role="hero", rhythm="peak",
            title="战略目标",
            style={"justifyContent": "flex-start"},
            children=[
                Text("营收翻倍", style={"fontSize": 56, "color": "#0F172A"}),
                Text(long_text, style={"fontSize": 18, "color": "#1E293B"}),
            ],
        ))
        slides.append(Slide(
            page_type="ending", role="transition", rhythm="transition",
            title="谢谢",
            background="#0F172A",
            children=[Text("感谢聆听", style={"fontSize": 56, "color": "#FFFFFF"})],
        ))
        return slides

    def _make_10_slides_government(self):
        """政务风格 10 页。"""
        from slidep.dsl import Slide, Text

        long_text = (
            "今年以来全市上下深入贯彻落实新发展理念，统筹推进经济社会高质量发展。"
            "经济总量稳步增长，产业结构持续优化，民生保障水平不断提升。"
            "全年地区生产总值达到五千八百亿元，同比增长百分之六点八。"
            "规模以上工业增加值增长百分之七点二，服务业增加值占比达到百分之五十六。"
            "城镇新增就业八万六千人，居民人均可支配收入增长百分之五点五。"
            "重点项目建设顺利推进，全年完成固定资产投资两千四百亿元。"
            "科技创新能力持续增强，新增高新技术企业一百二十家。"
            "生态环境质量持续改善，PM2.5 浓度下降百分之十二。"
        )
        slides = [
            Slide(
                page_type="cover", role="hero", rhythm="peak",
                title="年度工作报告",
                background="#FFFBEB",
                children=[Text("2026 年度总结", style={"fontSize": 56, "color": "#991B1B"})],
            ),
            Slide(
                page_type="toc", role="transition", rhythm="transition",
                title="目录",
                children=[
                    Text("1. 经济发展", style={"fontSize": 20, "color": "#1C1917"}),
                    Text("2. 民生改善", style={"fontSize": 20, "color": "#1C1917"}),
                    Text("3. 城市建设", style={"fontSize": 20, "color": "#1C1917"}),
                    Text("4. 明年规划", style={"fontSize": 20, "color": "#1C1917"}),
                ],
            ),
            Slide(
                page_type="section", role="transition", rhythm="transition",
                title="经济发展",
                children=[],
            ),
        ]
        for i in range(4):
            slides.append(Slide(
                page_type="content", role="supporting", rhythm="valley",
                title=f"工作领域{i+1}",
                style={"justifyContent": "flex-start"},
                children=[
                    Text(f"重点工作{i+1}", style={"fontSize": 56, "color": "#991B1B"}),
                    Text(long_text, style={"fontSize": 18, "color": "#1C1917"}),
                ],
            ))
        slides.append(Slide(
            page_type="section", role="transition", rhythm="transition",
            title="明年规划",
            children=[],
        ))
        slides.append(Slide(
            page_type="content", role="hero", rhythm="peak",
            title="发展目标",
            style={"justifyContent": "flex-start"},
            children=[
                Text("GDP 增长 7%", style={"fontSize": 56, "color": "#991B1B"}),
                Text(long_text, style={"fontSize": 18, "color": "#1C1917"}),
            ],
        ))
        slides.append(Slide(
            page_type="ending", role="transition", rhythm="transition",
            title="谢谢",
            background="#FFFBEB",
            children=[Text("感谢聆听", style={"fontSize": 56, "color": "#991B1B"})],
        ))
        return slides

    def _make_10_slides_general(self):
        """通用风格 10 页。"""
        from slidep.dsl import Slide, Text

        long_text = (
            "本季度核心业务实现了稳健增长，各项关键指标均达到预期目标。"
            "产品矩阵持续完善，用户活跃度显著提升，客户满意度保持在高位。"
            "技术团队完成了多项关键架构升级，系统稳定性和性能大幅提升。"
            "市场拓展方面，新增合作客户超过五十家，品牌影响力持续扩大。"
            "运营效率方面，通过流程优化和自动化工具引入，人效提升百分之二十。"
            "团队建设方面，引进了多位行业专家，组织能力进一步增强。"
            "财务表现方面，营收和利润均超额完成季度目标。"
            "下半年将继续聚焦核心业务，加大创新投入，深化客户关系。"
        )
        slides = [
            Slide(
                page_type="cover", role="hero", rhythm="peak",
                title="项目总结",
                background="#FFFFFF",
                children=[Text("2026 年度", style={"fontSize": 56, "color": "#1E293B"})],
            ),
            Slide(
                page_type="toc", role="transition", rhythm="transition",
                title="目录",
                children=[
                    Text("1. 概览", style={"fontSize": 20, "color": "#1E293B"}),
                    Text("2. 成果", style={"fontSize": 20, "color": "#1E293B"}),
                    Text("3. 分析", style={"fontSize": 20, "color": "#1E293B"}),
                    Text("4. 展望", style={"fontSize": 20, "color": "#1E293B"}),
                ],
            ),
            Slide(
                page_type="section", role="transition", rhythm="transition",
                title="概览",
                children=[],
            ),
        ]
        for i in range(4):
            slides.append(Slide(
                page_type="content", role="supporting", rhythm="valley",
                title=f"板块{i+1}",
                style={"justifyContent": "flex-start"},
                children=[
                    Text(f"核心内容{i+1}", style={"fontSize": 56, "color": "#1E293B"}),
                    Text(long_text, style={"fontSize": 18, "color": "#1E293B"}),
                ],
            ))
        slides.append(Slide(
            page_type="section", role="transition", rhythm="transition",
            title="展望",
            children=[],
        ))
        slides.append(Slide(
            page_type="content", role="hero", rhythm="peak",
            title="关键目标",
            style={"justifyContent": "flex-start"},
            children=[
                Text("增长 50%", style={"fontSize": 56, "color": "#1E293B"}),
                Text(long_text, style={"fontSize": 18, "color": "#1E293B"}),
            ],
        ))
        slides.append(Slide(
            page_type="ending", role="transition", rhythm="transition",
            title="谢谢",
            background="#FFFFFF",
            children=[Text("感谢聆听", style={"fontSize": 56, "color": "#1E293B"})],
        ))
        return slides

    def test_academic_10_slides_lint(self):
        """学术风格 10 页通过 lint（无 error）。"""
        from slidep.validate import validate_deck

        slides = self._make_10_slides_academic()
        assert len(slides) == 10
        report = validate_deck(slides)
        assert report.error_count == 0, f"学术风格 lint 有 error: {[i.to_dict() for i in report.issues if i.level == 'error']}"

    def test_business_10_slides_lint(self):
        """商务风格 10 页通过 lint（无 error）。"""
        from slidep.validate import validate_deck

        slides = self._make_10_slides_business()
        assert len(slides) == 10
        report = validate_deck(slides)
        assert report.error_count == 0, f"商务风格 lint 有 error: {[i.to_dict() for i in report.issues if i.level == 'error']}"

    def test_government_10_slides_lint(self):
        """政务风格 10 页通过 lint（无 error）。"""
        from slidep.validate import validate_deck

        slides = self._make_10_slides_government()
        assert len(slides) == 10
        report = validate_deck(slides)
        assert report.error_count == 0, f"政务风格 lint 有 error: {[i.to_dict() for i in report.issues if i.level == 'error']}"

    def test_general_10_slides_lint(self):
        """通用风格 10 页通过 lint（无 error）。"""
        from slidep.validate import validate_deck

        slides = self._make_10_slides_general()
        assert len(slides) == 10
        report = validate_deck(slides)
        assert report.error_count == 0, f"通用风格 lint 有 error: {[i.to_dict() for i in report.issues if i.level == 'error']}"


# ================================================================ 同风格 token 一致性

class TestStyleConsistency:
    """核验目标③：同风格两批生成 → 视觉 token 一致。"""

    def test_same_pack_tokens_consistent(self):
        """同一风格包多次获取的 tokens 完全一致。"""
        pack1 = get_pack("academic")
        pack2 = get_pack("academic")

        assert pack1.tokens.to_dict() == pack2.tokens.to_dict()

    def test_route_same_query_same_result(self):
        """同一 query 多次路由结果一致。"""
        r1 = route_query("季度业务汇报")
        r2 = route_query("季度业务汇报")

        assert r1.status == r2.status
        assert r1.pack.id == r2.pack.id
        assert r1.matched_keywords == r2.matched_keywords
        assert r1.score == r2.score

    def test_different_packs_different_tokens(self):
        """不同风格包的 tokens 不同。"""
        academic = get_pack("academic")
        business = get_pack("business")

        assert academic.tokens.to_dict() != business.tokens.to_dict()
        assert academic.tokens.palette.primary != business.tokens.palette.primary
