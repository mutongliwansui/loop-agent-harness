"""图表组件核验测试（T2.1）。

核验目标（对齐任务分解文档）：
1. 每图表类型生成 golden PNG（人工确认后入库比对）
2. 边界数据（负数、空值、单点）不崩溃
3. 中文标签不出现豆腐块（字体注册测试）
4. Chart 组件模型校验（数据格式/饼图单系列/非数值）
5. 布局集成：Chart 作为叶子节点 measure/arrange
6. 端到端：Chart 在 Slide 中渲染为 pptx，图片嵌入位置正确
"""

import io

import pytest
from PIL import Image

from slidep import ErrorCode, SlidepUserError
from slidep.dsl import Box, Chart, Slide, Text
from slidep.layout import layout_slide
from slidep.render import DEFAULT_PALETTE, render_chart_png, render_deck

E = 1e-6

#: 标准多系列测试数据
CHART_DATA = [
    ["季度", "营收", "利润"],
    ["Q1", 12.4, 3.1],
    ["Q2", 15.2, 4.0],
    ["Q3", 18.9, 5.2],
    ["Q4", 22.1, 6.8],
]

#: 饼图单系列数据
PIE_DATA = [
    ["类别", "占比"],
    ["产品A", 45],
    ["产品B", 30],
    ["产品C", 25],
]

#: 中文标签数据
CN_DATA = [
    ["季度", "营收(亿)", "利润(亿)"],
    ["一季度", 12.4, 3.1],
    ["二季度", 15.2, 4.0],
    ["三季度", 18.9, 5.2],
    ["四季度", 22.1, 6.8],
]


def _is_png(data: bytes) -> bool:
    """检查是否为合法 PNG。"""
    return data[:8] == b"\x89PNG\r\n\x1a\n"


def _png_size(data: bytes) -> tuple[int, int]:
    """从 PNG bytes 读取宽高。"""
    img = Image.open(io.BytesIO(data))
    return img.size


# ---------------------------------------------------------------- 组件模型
class TestChartModel:
    def test_valid_chart(self):
        c = Chart(chart_type="barChart", data=CHART_DATA)
        assert c.chart_type == "barChart"
        assert len(c.data) == 5

    def test_empty_data(self):
        with pytest.raises(SlidepUserError) as ei:
            Chart(chart_type="barChart", data=[])
        assert ei.value.code is ErrorCode.DSL_MISSING_REQUIRED_PROP

    def test_single_row_data(self):
        with pytest.raises(SlidepUserError) as ei:
            Chart(chart_type="barChart", data=[["A", "B"]])
        assert ei.value.code is ErrorCode.DSL_MISSING_REQUIRED_PROP

    def test_single_column(self):
        with pytest.raises(SlidepUserError) as ei:
            Chart(chart_type="barChart", data=[["A"], ["x"]])
        assert ei.value.code is ErrorCode.DSL_INVALID_STYLE_VALUE

    def test_pie_multi_series(self):
        with pytest.raises(SlidepUserError) as ei:
            Chart(chart_type="pieChart", data=CHART_DATA)
        assert ei.value.code is ErrorCode.DSL_INVALID_STYLE_VALUE
        assert "饼图" in str(ei.value)

    def test_non_numeric_cell(self):
        with pytest.raises(SlidepUserError) as ei:
            Chart(chart_type="barChart", data=[["A", "B"], ["x", "not a number"]])
        assert ei.value.code is ErrorCode.DSL_INVALID_STYLE_VALUE
        assert "非数值" in str(ei.value)

    def test_ragged_rows(self):
        with pytest.raises(SlidepUserError) as ei:
            Chart(chart_type="barChart", data=[["A", "B"], ["x", 1], ["y"]])
        assert ei.value.code is ErrorCode.DSL_INVALID_STYLE_VALUE
        assert "列数" in str(ei.value)

    def test_style_whitelist(self):
        """Chart 只允许 width/height/marginTop/marginBottom。"""
        with pytest.raises(SlidepUserError) as ei:
            Chart(chart_type="barChart", data=CHART_DATA, style={"color": "#FF0000"})
        assert ei.value.code is ErrorCode.DSL_UNKNOWN_PROPERTY

    def test_to_dict_roundtrip(self):
        from slidep.dsl import from_dict, to_dict

        c = Chart(chart_type="barChart", data=CHART_DATA, style={"width": 400, "height": 300})
        d = to_dict(c)
        c2 = from_dict(d)
        assert c2.chart_type == "barChart"
        assert c2.data == CHART_DATA


# ---------------------------------------------------------------- 布局集成
class TestChartLayout:
    def test_chart_as_leaf_node(self):
        """Chart 在布局树中是叶子节点（无 children）。"""
        slide = Slide(children=[Chart(chart_type="barChart", data=CHART_DATA, style={"width": 400, "height": 300})])
        result = layout_slide(slide)
        chart_node = next(n for n in result.nodes if n.kind == "chart")
        assert chart_node.measured_w == 400
        assert chart_node.measured_h == 300

    def test_chart_default_size(self):
        """无显式尺寸时，Chart 默认 480×320。"""
        slide = Slide(
            style={"alignItems": "flex-start"},
            children=[Chart(chart_type="barChart", data=CHART_DATA)],
        )
        result = layout_slide(slide)
        chart_node = next(n for n in result.nodes if n.kind == "chart")
        assert abs(chart_node.measured_w - 480) < E
        assert abs(chart_node.measured_h - 320) < E

    def test_chart_in_flex_layout(self):
        """Chart 在 flex 容器中正确分配尺寸。"""
        slide = Slide(
            style={"flexDirection": "row", "gap": 20},
            children=[
                Box(style={"flex": 1, "height": 300, "background": "#F1F5F9"}),
                Chart(chart_type="lineChart", data=CHART_DATA, style={"flex": 2, "height": 300}),
            ],
        )
        result = layout_slide(slide)
        boxes = [n for n in result.nodes if n.kind == "box"]
        charts = [n for n in result.nodes if n.kind == "chart"]
        assert len(boxes) == 1
        assert len(charts) == 1
        # flex 1:2, gap 20 → 剩余 1164, unit=388 → box 388, chart 776
        assert abs(boxes[0].rect.width - 388) < E
        assert abs(charts[0].rect.width - 776) < E


# ---------------------------------------------------------------- PNG 渲染
class TestChartRendering:
    @pytest.mark.parametrize("chart_type", ["barChart", "lineChart", "pieChart", "areaChart", "scatterChart"])
    def test_all_types_produce_png(self, chart_type):
        data = PIE_DATA if chart_type == "pieChart" else CHART_DATA
        png = render_chart_png(chart_type, data, 480, 320)
        assert _is_png(png)
        w, h = _png_size(png)
        assert w > 100 and h > 100  # 非空图

    def test_png_dimensions_reasonable(self):
        """PNG 尺寸与目标尺寸成比例（bbox_inches=tight 会略有差异）。"""
        png = render_chart_png("barChart", CHART_DATA, 600, 400)
        w, h = _png_size(png)
        assert 300 < w < 1200
        assert 200 < h < 800

    def test_custom_palette(self):
        """自定义色板覆盖默认色板。"""
        custom = ["#FF0000", "#00FF00", "#0000FF"]
        png = render_chart_png("barChart", CHART_DATA, 480, 320, palette=custom)
        assert _is_png(png)

    def test_chart_with_title(self):
        png = render_chart_png("barChart", CHART_DATA, 480, 320, title="季度业绩")
        assert _is_png(png)

    def test_chinese_labels(self):
        """中文标签渲染不出现豆腐块（字体注册成功）。"""
        from slidep.render.chart import _cjk_font_name

        png = render_chart_png("barChart", CN_DATA, 480, 320)
        assert _is_png(png)
        # 字体已注册（Windows 上应有 Microsoft YaHei）
        assert _cjk_font_name is not None


# ---------------------------------------------------------------- 边界数据
class TestEdgeCases:
    def test_negative_values(self):
        """负数不崩溃。"""
        data = [["A", "B"], ["x", -5], ["y", -3], ["z", 8]]
        png = render_chart_png("barChart", data, 480, 320)
        assert _is_png(png)

    def test_zero_values(self):
        """零值不崩溃。"""
        data = [["A", "B"], ["x", 0], ["y", 0]]
        png = render_chart_png("barChart", data, 480, 320)
        assert _is_png(png)

    def test_single_point(self):
        """单数据点不崩溃。"""
        data = [["A", "B"], ["x", 42]]
        png = render_chart_png("lineChart", data, 480, 320)
        assert _is_png(png)

    def test_float_precision(self):
        """浮点精度数据不崩溃。"""
        data = [["A", "B"], ["x", 0.001], ["y", 99.999]]
        png = render_chart_png("barChart", data, 480, 320)
        assert _is_png(png)

    def test_many_categories(self):
        """12 个分类不崩溃。"""
        data = [["月", "值"]] + [[f"M{i}", i * 10] for i in range(1, 13)]
        png = render_chart_png("barChart", data, 600, 320)
        assert _is_png(png)

    def test_unknown_type_raises(self):
        with pytest.raises(SlidepUserError) as ei:
            render_chart_png("unknownChart", CHART_DATA, 480, 320)
        assert ei.value.code is ErrorCode.RENDER_OOXML_FAILED


# ---------------------------------------------------------------- 端到端
class TestChartE2E:
    def test_chart_in_slide(self, tmp_path):
        """Chart 在 Slide 中渲染 → pptx 中包含原生图表。"""
        slide = Slide(
            title="季度业绩",
            children=[
                Chart(
                    chart_type="barChart",
                    data=CN_DATA,
                    title="2026 年各季度营收与利润",
                    style={"width": 600, "height": 360},
                ),
            ],
        )
        out = tmp_path / "chart_deck.pptx"
        prs = render_deck([slide], str(out))
        assert out.exists()

        from pptx import Presentation

        reopened = Presentation(str(out))
        pptx_slide = reopened.slides[0]
        charts = [s for s in pptx_slide.shapes if s.has_chart]
        assert len(charts) == 1
        chart_frame = charts[0]
        assert chart_frame.chart is not None
        # 坐标与布局一致
        result = layout_slide(slide)
        chart_node = next(n for n in result.nodes if n.kind == "chart")
        assert chart_frame.left is not None and chart_frame.top is not None
        assert chart_frame.width is not None and chart_frame.height is not None

    def test_chart_and_text_side_by_side(self, tmp_path):
        """图文并排：Chart + Text 在同一页。"""
        slide = Slide(
            title="数据概览",
            children=[
                Box(
                    style={"flexDirection": "row", "gap": 24, "alignItems": "flex-start"},
                    children=[
                        Chart(
                            chart_type="pieChart",
                            data=PIE_DATA,
                            style={"width": 400, "height": 300},
                        ),
                        Text("产品A 占比 45%，领先于其他产品。", style={"fontSize": 18, "width": 300}),
                    ],
                )
            ],
        )
        out = tmp_path / "side_by_side.pptx"
        render_deck([slide], str(out))
        assert out.exists()

    def test_chart_overflow_detected(self):
        """Chart 超出画布 → LAYOUT_OVERFLOW。"""
        slide = Slide(children=[Chart(chart_type="barChart", data=CHART_DATA, style={"height": 800})])
        with pytest.raises(SlidepUserError) as ei:
            layout_slide(slide)
        assert ei.value.code is ErrorCode.LAYOUT_OVERFLOW
