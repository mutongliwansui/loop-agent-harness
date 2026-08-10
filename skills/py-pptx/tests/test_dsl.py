"""DSL 组件模型核验测试（T1.1）。

核验目标（对齐任务分解文档）：
1. 组件树 序列化→反序列化 round-trip 一致
2. 非法 style（display:grid / calc() / 未知属性）断言报错且信息含属性名
3. 嵌套层级深度边界测试（深度计算正确、超深构造不崩）
4. 值合法性：枚举/颜色/长度/渐变/字重
5. 组件结构约束：Slide 嵌套禁止、Text 无 children、未知组件类型
"""

import pytest

from slidep import ErrorCode, SlidepError, SlidepUserError
from slidep.dsl import (
    Box,
    Color,
    Gradient,
    Percent,
    Slide,
    Text,
    components,
    count_nodes,
    from_dict,
    max_depth,
    parse_background,
    parse_color,
    parse_length,
    to_dict,
    validate_style,
    walk,
)


def make_deck() -> Slide:
    """标准测试树：封面 + 内容页结构。"""
    return Slide(
        page_type="cover",
        role="hero",
        rhythm="peak",
        background="#0F172A",
        title="季度业务汇报",
        children=[
            Box(
                style={"flexDirection": "row", "gap": 24, "justifyContent": "center", "alignItems": "center"},
                children=[
                    Text("营收 120 亿", style={"fontSize": 64, "fontWeight": "bold", "color": "#FFFFFF"}),
                    Text("同比增长 34%", style={"fontSize": 28, "color": "#94A3B8"}),
                ],
            ),
            Box(style={"marginTop": 40, "padding": "16px", "background": "#1E293B", "borderRadius": 12}),
        ],
    )


# ---------------------------------------------------------------- round-trip
class TestRoundTrip:
    def test_dict_roundtrip(self):
        tree = make_deck()
        data = to_dict(tree)
        restored = from_dict(data)
        assert to_dict(restored) == data, "序列化→反序列化→序列化不一致"
        assert isinstance(restored, Slide)
        assert isinstance(restored.children[0], Box)
        assert isinstance(restored.children[0].children[0], Text)

    def test_background_merged_into_style(self):
        tree = make_deck()
        assert tree.style["background"] == "#0F172A"
        assert to_dict(tree)["style"]["background"] == "#0F172A"

    def test_to_dict_excludes_none(self):
        tree = Slide(children=[Text("hi")])
        data = to_dict(tree)
        assert "title" not in data
        assert "background" not in data

    def test_nested_roundtrip_deep(self):
        tree = Slide(children=[Box(children=[Box(children=[Text("deep")])])])
        assert to_dict(from_dict(to_dict(tree))) == to_dict(tree)


# ---------------------------------------------------------------- 非法 style
class TestInvalidStyle:
    @pytest.mark.parametrize("style,prop", [
        ({"display": "grid"}, "display"),
        ({"display": "block"}, "display"),
    ])
    def test_display_not_flex(self, style, prop):
        with pytest.raises(SlidepUserError) as ei:
            Box(style=style)
        assert "display" in str(ei.value), "错误信息必须含属性名"
        assert ei.value.code is ErrorCode.DSL_INVALID_STYLE_VALUE

    def test_calc_expression(self):
        with pytest.raises(SlidepUserError) as ei:
            Box(style={"width": "calc(100% - 40px)"})
        assert "width" in str(ei.value)
        assert ei.value.code is ErrorCode.DSL_INVALID_STYLE_VALUE

    @pytest.mark.parametrize("prop", ["flexWrap", "float", "gridTemplate"])
    def test_unknown_property(self, prop):
        with pytest.raises(SlidepUserError) as ei:
            Box(style={prop: "x"})
        assert prop in str(ei.value), "错误信息必须含属性名"
        assert ei.value.code is ErrorCode.DSL_UNKNOWN_PROPERTY

    def test_unknown_property_on_text(self):
        """Text 不允许 Box 专属属性（padding/flexDirection 等）。"""
        with pytest.raises(SlidepUserError) as ei:
            Text("x", style={"padding": 8})
        assert "padding" in str(ei.value)
        assert ei.value.code is ErrorCode.DSL_UNKNOWN_PROPERTY

    def test_invalid_enum(self):
        with pytest.raises(SlidepUserError) as ei:
            Box(style={"flexDirection": "diagonal"})
        assert "flexDirection" in str(ei.value)
        assert "diagonal" in str(ei.value)

    def test_invalid_color(self):
        with pytest.raises(SlidepUserError) as ei:
            Text("x", style={"color": "not-a-color"})
        assert "color" in str(ei.value)

    def test_invalid_font_weight_numeric(self):
        with pytest.raises(SlidepUserError):
            Text("x", style={"fontWeight": "800"})

    def test_negative_length(self):
        with pytest.raises(SlidepUserError) as ei:
            Box(style={"gap": -10})
        assert "gap" in str(ei.value)

    def test_bad_percent(self):
        with pytest.raises(SlidepUserError):
            Box(style={"width": "120%"})

    def test_flex_must_be_positive_int(self):
        with pytest.raises(SlidepUserError):
            Box(style={"flex": 0})

    def test_var_expression_banned(self):
        with pytest.raises(SlidepUserError) as ei:
            Box(style={"width": "var(--x)"})
        assert "var(" in str(ei.value)

    def test_invalid_border(self):
        """border 缺颜色 → 报错。"""
        with pytest.raises(SlidepUserError) as ei:
            Box(style={"border": "2px"})
        assert "border" in str(ei.value)

    def test_border_only_solid(self):
        with pytest.raises(SlidepUserError):
            Box(style={"border": "2px dashed #3B82F6"})

    def test_invalid_box_shadow(self):
        with pytest.raises(SlidepUserError) as ei:
            Box(style={"boxShadow": "4px"})
        assert "boxShadow" in str(ei.value)

    def test_opacity_out_of_range(self):
        with pytest.raises(SlidepUserError) as ei:
            Box(style={"opacity": 1.5})
        assert "opacity" in str(ei.value)

    def test_zindex_not_int(self):
        with pytest.raises(SlidepUserError) as ei:
            Box(style={"zIndex": 1.5})
        assert "zIndex" in str(ei.value)

    def test_margin_too_many_values(self):
        with pytest.raises(SlidepUserError):
            Box(style={"margin": "1px 2px 3px 4px 5px"})

    def test_margin_percent_banned(self):
        with pytest.raises(SlidepUserError):
            Box(style={"margin": "10%"})

    def test_position_relative_is_valid_enum(self):
        """relative 已加入 position 枚举，构造不报错。"""
        box = Box(style={"position": "relative", "top": 10})
        assert box.style["position"] == "relative"


# ---------------------------------------------------------------- 合法样式
class TestValidStyle:
    def test_length_strings(self):
        box = Box(style={"width": "50%", "height": 320, "gap": "12px", "padding": "16px"})
        assert box.style["width"] == "50%"  # 原值保留，解析在 render 层消费

    def test_gradient_background(self):
        box = Box(style={"background": "linear-gradient(135deg, #0F172A, #1E293B)"})
        assert box.style["background"].startswith("linear-gradient")

    def test_named_color(self):
        text = Text("x", style={"color": "white"})
        assert text.style["color"] == "white"

    def test_display_flex_accepted(self):
        box = Box(style={"display": "flex"})
        assert box.style["display"] == "flex"

    def test_margin_shorthand(self):
        """margin 简写 1/2/4 值均合法。"""
        assert Box(style={"margin": "12px"}).style["margin"] == "12px"
        assert Box(style={"margin": "10px 20px"}).style["margin"] == "10px 20px"
        assert Box(style={"margin": "1 2 3 4"}).style["margin"] == "1 2 3 4"

    def test_border_valid(self):
        box = Box(style={"border": "2px solid #3B82F6"})
        assert box.style["border"] == "2px solid #3B82F6"

    def test_box_shadow_valid(self):
        assert Box(style={"boxShadow": "4px 4px 12px 76"}).style["boxShadow"] == "4px 4px 12px 76"
        assert Box(style={"boxShadow": "0 4px 8px rgba(0,0,0,0.3)"}).style["boxShadow"] == "0 4px 8px rgba(0,0,0,0.3)"

    def test_opacity_valid(self):
        box = Box(style={"opacity": 0.5})
        assert box.style["opacity"] == 0.5

    def test_zindex_negative_allowed(self):
        box = Box(style={"zIndex": -1})
        assert box.style["zIndex"] == -1

    def test_min_max_valid(self):
        box = Box(style={"minWidth": 200, "maxWidth": "80%", "minHeight": 100, "maxHeight": 500})
        assert box.style["minWidth"] == 200

    def test_hex3_color_accepted(self):
        Text("x", style={"color": "#FFF"})

    def test_hex8_color_accepted(self):
        Text("x", style={"color": "#0F172A80"})

    def test_font_size_number(self):
        Text("x", style={"fontSize": 20})

    def test_validate_style_direct(self):
        validate_style("Box", {"flexDirection": "row"})  # 不抛异常即通过


# ---------------------------------------------------------------- 深度边界
class TestDepth:
    def test_max_depth_flat(self):
        assert max_depth(make_deck()) == 2

    def test_max_depth_nested(self):
        tree = Slide(children=[Box(children=[Box(children=[Box(children=[Text("x")])])])])
        assert max_depth(tree) == 4

    def test_walk_depths(self):
        tree = Slide(children=[Box(children=[Text("a"), Text("b")]), Text("c")])
        depths = {node.text if isinstance(node, Text) else node.type: d for node, d in walk(tree)}
        assert depths["Slide"] == 0
        assert depths["Box"] == 1
        assert depths["a"] == 2 and depths["b"] == 2
        assert depths["c"] == 1

    def test_deep_nesting_no_crash(self):
        """100 层嵌套构造与遍历不崩溃（pydantic 递归模型）。"""
        node = Text("leaf")
        for _ in range(100):
            node = Box(children=[node])
        tree = Slide(children=[node])
        assert max_depth(tree) == 101  # 100 层 Box + Slide 根
        assert count_nodes(tree) == 102

    def test_components_filter(self):
        tree = make_deck()
        texts = list(components(tree, Text))
        boxes = list(components(tree, Box))
        assert len(texts) == 2
        assert len(boxes) == 2

    def test_count_nodes(self):
        assert count_nodes(make_deck()) == 5


# ---------------------------------------------------------------- 组件结构约束
class TestStructure:
    def test_slide_cannot_nest_slide(self):
        """Slide 作为 children 在类型层（union 判别）即被拒绝。"""
        with pytest.raises(Exception) as ei:
            Slide(children=[Slide()])
        assert "Slide" in str(ei.value)

    def test_box_cannot_contain_slide(self):
        with pytest.raises(Exception) as ei:
            Box(children=[Slide()])
        assert "Slide" in str(ei.value)

    def test_text_has_no_children(self):
        t = Text("hi")
        assert not hasattr(t, "children")

    def test_unknown_component_in_from_dict(self):
        with pytest.raises(SlidepUserError) as ei:
            from_dict({"type": "UnknownWidget"})
        assert ei.value.code is ErrorCode.DSL_UNKNOWN_COMPONENT

    def test_extra_field_forbidden(self):
        with pytest.raises(Exception):
            Text("hi", extra_field=1)  # pydantic extra=forbid

    def test_page_type_enum(self):
        with pytest.raises(Exception):
            Slide(page_type="banner")


# ---------------------------------------------------------------- 解析函数
class TestParsers:
    def test_parse_length_types(self):
        from slidep.dsl.styles import Length as L

        assert isinstance(parse_length(10, "w"), L)
        assert isinstance(parse_length("50%", "w"), Percent)

    def test_parse_color_values(self):
        c = parse_color("#FF0000", "color")
        assert c == Color(255, 0, 0)
        c8 = parse_color("#FF000080", "color")
        assert c8.a == 128
        c3 = parse_color("#F00", "color")
        assert c3.hex6 == "#ff0000"

    def test_parse_gradient(self):
        g = parse_background("linear-gradient(90deg, #000000, #FFFFFF)", "background")
        assert isinstance(g, Gradient)
        assert g.angle == 90
        assert g.start == Color(0, 0, 0) and g.end == Color(255, 255, 255)
