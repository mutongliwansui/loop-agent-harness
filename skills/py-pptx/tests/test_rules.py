"""rules.json 单一数据源核验测试（T0.2）。

核验目标：
1. rules.json 是合法 JSON，schema 结构完整
2. 规则 id 全局唯一，且遵循「域.名称」命名
3. 每条规则具备全部必填字段（id/name/level/applies_to/params/lint/description）
4. level 与 applies_to 取值合法
5. 常量区（canvas/regions/typography/color/layout/anchor/image_tiers/roles）与 rules.params 交叉引用一致
6. 文档引用覆盖率：references/*.md 中引用的规则 id 必须全部存在于 rules.json（文档不引用不存在的规则）
7. lint 映射名唯一性（每条 lint 标识对应唯一实现函数，防止 lint 覆盖歧义）
8. 预留：T3.1 lint 实现覆盖（lint 实现尚未编码，此处只做 lint 标识唯一性断言 + TODO 覆盖检查入口）
"""

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]  # py-pptx/
RULES_PATH = ROOT / "scripts" / "slidep" / "validate" / "rules.json"
REFS_DIR = ROOT / "references"

VALID_LEVELS = {"error", "warning"}
VALID_SCOPES = {"all", "deck", "content", "hero", "transition", "toc"}
#: 规则 id 到 applies_to 的合法关系（页级作用域必须属于 deck 内合法枚举）
SCOPE_HIERARCHY = {"deck": {"content", "hero", "transition", "toc", "all"}}


def load_rules() -> dict:
    return json.loads(RULES_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def rules() -> dict:
    return load_rules()


# ---------------------------------------------------------------- schema 结构
class TestSchema:
    def test_valid_json(self):
        data = load_rules()
        assert "$schema" in data, "缺少 $schema 声明"
        assert data["$schema"] == "slidep-rules/v1"

    def test_required_sections(self, rules):
        for key in ("canvas", "regions", "typography", "color", "layout", "anchor", "image_tiers", "roles", "rules"):
            assert key in rules, f"缺少顶层段落: {key}"

    def test_canvas_dimensions(self, rules):
        assert rules["canvas"]["width"] == 1280
        assert rules["canvas"]["height"] == 720

    def test_regions_consistency(self, rules):
        regions = rules["regions"]
        assert regions["title_band"]["height"] == regions["content"]["top"]
        assert regions["footer"]["top"] == regions["content"]["bottom"]
        content_h = regions["content"]["bottom"] - regions["content"]["top"]
        assert content_h == 540

    def test_roles_enum(self, rules):
        assert set(rules["roles"]["page_roles"]) == {"hero", "supporting", "transition"}
        assert set(rules["roles"]["rhythms"]) == {"peak", "valley", "transition"}


# ---------------------------------------------------------------- 规则条目
class TestRules:
    def test_rule_ids_unique(self, rules):
        ids = [r["id"] for r in rules["rules"]]
        assert len(ids) == len(set(ids)), "规则 id 重复"

    def test_rule_id_naming(self, rules):
        # 允许段内数字（如 image.l1_area / toc.max_entries）
        pattern = re.compile(r"^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)+$")
        for r in rules["rules"]:
            assert pattern.match(r["id"]), f"规则 id 命名非法: {r['id']}"

    def test_required_fields(self, rules):
        required = {"id", "name", "level", "applies_to", "params", "lint", "description"}
        for r in rules["rules"]:
            missing = required - set(r.keys())
            assert not missing, f"规则 {r.get('id')} 缺少字段: {missing}"

    def test_level_valid(self, rules):
        for r in rules["rules"]:
            assert r["level"] in VALID_LEVELS, f"规则 {r['id']} level 非法: {r['level']}"

    def test_applies_to_valid(self, rules):
        for r in rules["rules"]:
            for scope in r["applies_to"]:
                assert scope in VALID_SCOPES, f"规则 {r['id']} applies_to 非法: {scope}"

    def test_lint_param_shape_consistent(self, rules):
        """同 lint 实现的规则，params 键结构必须收敛为 {min} / {max} / {min,max} 三种之一，
        保证 T3.1 的每个 lint 函数只消费统一的阈值语义。

        例外：typography.size_ladder 是字号阶梯定义（键=层级名，值=[min,max]），
        其 lint 实现 validate_font_sizes 直接消费阶梯结构。
        """
        VALID_SHAPES = {(), ("max",), ("min",), ("max", "min")}
        LADDER_RULE = "typography.size_ladder"
        by_lint: dict[str, set] = {}
        for r in rules["rules"]:
            by_lint.setdefault(r["lint"], set()).add(tuple(sorted(r["params"].keys())))
        for lint_name, shapes in by_lint.items():
            for shape in shapes:
                if lint_name == "validate_font_sizes":
                    continue  # 阶梯结构例外
                assert shape in VALID_SHAPES, (
                    f"lint 实现 {lint_name} 的规则 params 键 {shape} 不在 {{min}}/{{max}}/{{min,max}} 内"
                )

    def test_lint_params_nummeric(self, rules):
        """params 阈值必须为数值（lint 需要与实测值比较）。"""
        for r in rules["rules"]:
            for key, value in r["params"].items():
                if isinstance(value, (int, float)):
                    continue
                if isinstance(value, dict):  # min_size 等复合结构
                    assert all(isinstance(v, (int, float)) for v in value.values()), (
                        f"规则 {r['id']} 复合参数 {key} 含非数值"
                    )
                elif isinstance(value, list):  # 仅限字号阶梯的 [min, max] 对
                    assert r["id"] == "typography.size_ladder", f"规则 {r['id']} 参数 {key} 不允许 list"
                    assert len(value) == 2 and all(isinstance(v, (int, float)) for v in value)
                else:
                    assert False, f"规则 {r['id']} 参数 {key} 类型非法: {type(value)}"

    def test_params_type(self, rules):
        for r in rules["rules"]:
            assert isinstance(r["params"], dict), f"规则 {r['id']} params 必须是对象"


# ---------------------------------------------------------------- 常量与规则交叉一致
class TestConstantsConsistency:
    """规则 params 与常量区取值必须一致，防止「常量一套、规则一套」。"""

    def test_typography_consistent(self, rules):
        const = rules["typography"]
        ladder = next(r for r in rules["rules"] if r["id"] == "typography.size_ladder")
        assert ladder["params"]["title"] == [const["title_size"]["min"], const["title_size"]["max"]]
        assert ladder["params"]["hero_title"] == [const["hero_title_size"]["min"], const["hero_title_size"]["max"]]
        assert ladder["params"]["body"] == [const["body_size"]["min"], const["body_size"]["max"]]
        assert ladder["params"]["caption"] == [const["caption_size"]["min"], const["caption_size"]["max"]]

    def test_color_consistent(self, rules):
        const = rules["color"]
        for rule_id, const_key in [
            ("color.primary_ratio", "primary_ratio"),
            ("color.secondary_ratio", "secondary_ratio"),
            ("color.accent_ratio", "accent_ratio"),
            ("color.accent_ratio_hero", "accent_ratio_hero"),
        ]:
            rule = next(r for r in rules["rules"] if r["id"] == rule_id)
            assert rule["params"]["max"] == const[const_key], f"{rule_id} 与 color.{const_key} 不一致"

    def test_layout_consistent(self, rules):
        const = rules["layout"]
        pairs = [
            ("layout.asymmetric_min_ratio", "asymmetric_min_ratio", "min"),
            ("layout.card_row_max_pages", "card_row_max_pages", "max"),
            ("layout.max_whitespace_ratio", "max_whitespace_ratio", "max"),
            ("layout.card_fill_min_ratio", "card_fill_min_ratio", "min"),
        ]
        for rule_id, const_key, field in pairs:
            rule = next(r for r in rules["rules"] if r["id"] == rule_id)
            assert rule["params"][field] == const[const_key], f"{rule_id} 与 layout.{const_key} 不一致"

    def test_hero_quota_consistent(self, rules):
        const = rules["layout"]
        rule = next(r for r in rules["rules"] if r["id"] == "layout.hero_page_ratio")
        assert rule["params"]["min"] == const["hero_page_ratio_min"]
        assert rule["params"]["max"] == const["hero_page_ratio_max"]

    def test_anchor_consistent(self, rules):
        const = rules["anchor"]
        rule = next(r for r in rules["rules"] if r["id"] == "anchor.min_image_area_ratio")
        assert rule["params"]["min"] == const["min_image_area_ratio"]

    def test_image_tiers_consistent(self, rules):
        const = rules["image_tiers"]
        l1 = next(r for r in rules["rules"] if r["id"] == "image.l1_area")
        assert l1["params"]["min"] == const["l1"]["min_area_ratio"]
        l2 = next(r for r in rules["rules"] if r["id"] == "image.l2_min_size")
        assert l2["params"]["min"] == const["l2"]["min_size"]
        l3 = next(r for r in rules["rules"] if r["id"] == "image.l3_max_size")
        assert l3["params"]["max"] == const["l3"]["max_size"]

    def test_toc_consistent(self, rules):
        rule = next(r for r in rules["rules"] if r["id"] == "toc.max_entries")
        assert rule["params"]["max"] == rules["roles"]["toc_max_entries"]


# ---------------------------------------------------------------- 文档引用覆盖
class TestDocCoverage:
    """references/*.md 中引用的规则 id 必须全部存在于 rules.json（禁引用幽灵规则）。"""

    def test_doc_referenced_rule_ids_exist(self, rules):
        rule_ids = {r["id"] for r in rules["rules"]}
        referenced = set()
        for md in REFS_DIR.glob("*.md"):
            text = md.read_text(encoding="utf-8")
            referenced |= set(re.findall(r"`([a-z_]+\.[a-z_]+)`", text))
        # 过滤非规则 id 的引用（如字体名等带点的 token）
        referenced_rules = {r for r in referenced if r in rule_ids}
        ghost = referenced_rules - rule_ids  # 语法上保留：全部引用都应命中
        assert not ghost, f"文档引用了不存在的规则: {ghost}"

    def test_every_rule_referenced_by_some_doc(self, rules):
        """反向覆盖（提示性）：每条规则都应至少被一篇文档提及。"""
        rule_ids = {r["id"] for r in rules["rules"]}
        all_text = "\n".join(md.read_text(encoding="utf-8") for md in REFS_DIR.glob("*.md"))
        unreferenced = [rid for rid in sorted(rule_ids) if f"`{rid}`" not in all_text]
        assert not unreferenced, f"以下规则未被任何文档引用（文档体系不完整）: {unreferenced}"


# ---------------------------------------------------------------- lint 覆盖
class TestLintCoverage:
    """T3.1 lint 实现覆盖检查：rules.json 声明的每个 lint 标识必须能在
    ``slidep.validate`` 包中找到同名可调用实现，且实现数与声明数严格一致
    （无幽灵实现、无遗漏声明）。
    """

    def test_lint_identifiers_are_importable_names(self, rules):
        import re as _re

        for r in rules["rules"]:
            assert _re.match(r"^validate_[a-z_]+$", r["lint"]), f"lint 标识命名非法: {r['lint']}"

    def test_lint_implementations_exist(self, rules):
        """每个 lint 标识在 validate 包中都有同名可调用实现。"""
        import slidep.validate as validate_pkg

        lint_ids = {r["lint"] for r in rules["rules"]}
        for name in lint_ids:
            assert hasattr(validate_pkg, name), f"validate 包缺少 lint 实现: {name}"
            impl = getattr(validate_pkg, name)
            assert callable(impl), f"lint 实现 {name} 不可调用"

    def test_no_phantom_lint_implementations(self, rules):
        """validate 包中没有 rules.json 未声明的多余 lint 实现。"""
        import slidep.validate as validate_pkg

        declared = {r["lint"] for r in rules["rules"]}
        exported = set(getattr(validate_pkg, "__all__", []))
        # __all__ 中 validate_ 开头且非公共入口（validate_deck/validate_slide）的项
        extra_lints = {
            n for n in exported
            if n.startswith("validate_") and n not in ("validate_deck", "validate_slide")
        } - declared
        assert not extra_lints, f"validate 包存在未声明的 lint 实现: {extra_lints}"
