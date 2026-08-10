"""OOXML 渲染器核验测试（T1.3）。

核验目标（对齐任务分解文档）：
1. 生成文件可被 python-pptx 重新打开，断言每元素坐标/尺寸/文本与布局结果一致
2. 文本样式：字号/字重/行高/字距/对齐/富文本 span
3. 高级样式：渐变填充/半透明/阴影（lxml patch OOXML）
4. 页脚母版（页码 NN/TOTAL）+ 封面/目录/内容/结束页 + 演讲备注
5. 生成的 pptx 通过 python-pptx 无异常遍历全部 shape
"""

import pytest
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.oxml.ns import qn

from slidep import ErrorCode, SlidepUserError
from slidep.dsl import Box, Slide, Text
from slidep.layout import layout_slide
from slidep.render import (
    PX_TO_EMU,
    RenderOptions,
    apply_shadow,
    emu,
    pt,
    render_deck,
    spc,
)

E = 1e-6


def _shape_rect(shape):
    return (shape.left, shape.top, shape.width, shape.height)


def _find_texts(slide):
    """页内全部文本框文本（含段落 run 拼接）。"""
    out = []
    for shape in slide.shapes:
        if shape.shape_type == MSO_SHAPE_TYPE.TEXT_BOX or shape.has_text_frame:
            t = shape.text_frame.text
            if t.strip():
                out.append(t)
    return out


# ---------------------------------------------------------------- 单位
class TestUnits:
    def test_px_to_emu(self):
        assert abs(PX_TO_EMU - 9525) < E
        assert emu(0) == 0
        assert emu(1280) == 12_192_000
        assert emu(48) == round(48 * 9525)

    def test_pt_conversion(self):
        assert abs(pt(20) - 15) < E  # 20px @96dpi = 15pt

    def test_spc_conversion(self):
        assert spc(2) == 150  # 2px = 1.5pt = 150 (1/100pt)


# ---------------------------------------------------------------- 基础渲染
class TestBasic:
    def test_empty_deck(self):
        prs = render_deck([])
        assert len(prs.slides._sldIdLst) == 0

    def test_minimal_slide_title(self):
        """content 页：标题渲染在左上 A 区。"""
        prs = render_deck([Slide(title="季度汇报")])
        slide = prs.slides[0]
        texts = _find_texts(slide)
        assert any("季度汇报" in t for t in texts)
        title_box = [s for s in slide.shapes if s.has_text_frame and "季度汇报" in s.text_frame.text][0]
        assert title_box.left == emu(48)
        assert title_box.top == emu(44)

    def test_slide_size_16_9(self):
        prs = render_deck([Slide()])
        assert prs.slide_width == 12_192_000
        assert prs.slide_height == 6_858_000

    def test_transparent_box_not_rendered(self):
        """无 background/borderRadius 的 Box 是纯布局容器，不产生 shape。"""
        prs = render_deck([Slide(title="t", children=[Box(style={"width": 200, "height": 100})])])
        slide = prs.slides[0]
        rects = [s for s in slide.shapes if s.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE]
        # 只有 title 文本框，没有矩形
        assert len(rects) == 0

    def test_title_not_duplicated_when_nested_in_box(self):
        """title 出现在嵌套 Box 内的 Text 中时，不重复渲染 master title block。"""
        slide = Slide(
            page_type="cover",
            title="2025全球AI产业格局洞察",
            children=[
                Box(
                    style={"flexDirection": "column", "alignItems": "center", "width": "100%"},
                    children=[
                        Text("2025全球AI产业格局洞察", style={"fontSize": 64}),
                        Text("副标题", style={"fontSize": 24}),
                    ],
                ),
            ],
        )
        prs = render_deck([slide])
        pptx_slide = prs.slides[0]
        texts = _find_texts(pptx_slide)
        # title 文本只出现一次
        assert texts.count("2025全球AI产业格局洞察") == 1
        # 副标题仍被渲染
        assert any("副标题" in t for t in texts)

    def test_title_not_duplicated_with_newline_in_text(self):
        """Text 内容含换行符时，归一化后与 title 匹配则不重复渲染。"""
        slide = Slide(
            page_type="cover",
            title="人工智能在医疗领域的应用与展望",
            children=[
                Box(
                    style={"flexDirection": "column", "alignItems": "flex-start", "width": "100%"},
                    children=[
                        Text("人工智能在医疗领域\n的应用与展望", style={"fontSize": 64}),
                        Text("AI IN HEALTHCARE", style={"fontSize": 18}),
                    ],
                ),
            ],
        )
        prs = render_deck([slide])
        texts = _find_texts(prs.slides[0])
        # 归一化后 title 只出现一次（master title block 不渲染）
        count = sum(1 for t in texts if "人工智能在医疗领域" in t and "应用与展望" in t)
        assert count == 1

    def test_title_not_duplicated_direct_child(self):
        """title 作为直接 child 出现时，不重复渲染 master title block。"""
        slide = Slide(
            title="标题A",
            children=[Text("标题A", style={"fontSize": 32})],
        )
        prs = render_deck([slide])
        texts = _find_texts(prs.slides[0])
        assert texts.count("标题A") == 1

    def test_title_rendered_when_not_in_children(self):
        """title 不在 children 中时，master title block 正常渲染。"""
        slide = Slide(
            title="独立标题",
            children=[Text("其他内容", style={"fontSize": 20})],
        )
        prs = render_deck([slide])
        texts = _find_texts(prs.slides[0])
        assert "独立标题" in texts
        assert "其他内容" in texts


# ---------------------------------------------------------------- 几何一致性
class TestGeometry:
    def test_roundtrip_geometry(self):
        """布局结果坐标 → pptx shape 坐标（EMU 精确一致）。"""
        slide = Slide(
            title="几何",
            children=[
                Box(style={"background": "#0EA5E9", "width": 400, "height": 200, "padding": 24}),
                Box(style={"background": "#F59E0B", "width": 300, "height": 100, "marginTop": 20}),
            ],
        )
        result = layout_slide(slide)
        boxes = [n for n in result.nodes if n.kind == "box"]
        boxes.sort(key=lambda n: n.rect.x + n.rect.y)  # type: ignore[union-attr]

        prs = render_deck([slide])
        pptx_slide = prs.slides[0]
        rects = [s for s in pptx_slide.shapes if s.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE]
        assert len(rects) == 2

        for box, shape in zip(boxes, rects):
            assert shape.left == emu(box.rect.x)  # type: ignore[union-attr]
            assert shape.top == emu(box.rect.y)  # type: ignore[union-attr]
            assert shape.width == emu(box.rect.width)  # type: ignore[union-attr]
            assert shape.height == emu(box.rect.height)  # type: ignore[union-attr]

    def test_roundtrip_text_position(self):
        """文本框坐标与布局一致。"""
        slide = Slide(children=[Text("hello", style={"fontSize": 20})])
        result = layout_slide(slide)
        text_node = next(n for n in result.nodes if n.kind == "text")

        prs = render_deck([slide])
        pptx_slide = prs.slides[0]
        boxes = [s for s in pptx_slide.shapes if s.shape_type == MSO_SHAPE_TYPE.TEXT_BOX]
        assert boxes
        tb = boxes[0]
        assert tb.top == emu(text_node.rect.y)
        assert tb.height == emu(text_node.rect.height)
        # 文本框宽度含防换行缓冲（5%），左对齐时 left 不变
        _buf = max(text_node.rect.width * 0.05, 4.0)
        assert tb.left == emu(text_node.rect.x)
        assert tb.width == emu(text_node.rect.width + _buf)
        assert tb.text_frame.text == "hello"


# ---------------------------------------------------------------- 文本样式
class TestTextStyle:
    def test_font_size_bold_color_align(self):
        slide = Slide(
            children=[
                Text(
                    "重点",
                    style={"fontSize": 28, "fontWeight": "bold", "color": "#E5484D", "textAlign": "center"},
                )
            ]
        )
        prs = render_deck([slide])
        tb = [s for s in prs.slides[0].shapes if s.shape_type == MSO_SHAPE_TYPE.TEXT_BOX][0]
        p = tb.text_frame.paragraphs[0]
        run = p.runs[0]
        assert abs(run.font.size.pt - pt(28)) < E
        assert run.font.bold is True
        assert str(run.font.color.rgb) == "E5484D"
        assert p.alignment is not None and p.alignment == 2  # CENTER

    def test_line_height(self):
        slide = Slide(children=[Text("两行文本", style={"fontSize": 20, "lineHeight": 1.8})])
        prs = render_deck([slide])
        tb = [s for s in prs.slides[0].shapes if s.shape_type == MSO_SHAPE_TYPE.TEXT_BOX][0]
        assert abs(tb.text_frame.paragraphs[0].line_spacing - 1.8) < E

    def test_letter_spacing_patched(self):
        slide = Slide(children=[Text("AB", style={"fontSize": 20, "letterSpacing": 2})])
        prs = render_deck([slide])
        tb = [s for s in prs.slides[0].shapes if s.shape_type == MSO_SHAPE_TYPE.TEXT_BOX][0]
        r_pr = tb.text_frame.paragraphs[0].runs[0]._r.get_or_add_rPr()
        assert r_pr.get("spc") == str(spc(2))

    def test_rich_text_span_and_br(self):
        """富文本：span 内联颜色 + <br /> 分段。"""
        slide = Slide(
            children=[
                Text(
                    '营收 <span style={{color:"#E5484D"}}>120亿</span><br />同比增长 34%',
                    style={"fontSize": 20},
                )
            ]
        )
        prs = render_deck([slide])
        tb = [s for s in prs.slides[0].shapes if s.shape_type == MSO_SHAPE_TYPE.TEXT_BOX][0]
        tf = tb.text_frame
        assert len(tf.paragraphs) == 2
        runs = tf.paragraphs[0].runs
        assert len(runs) == 2
        assert runs[0].text == "营收 "
        assert runs[1].text == "120亿"
        assert str(runs[1].font.color.rgb) == "E5484D"
        assert tf.paragraphs[1].text == "同比增长 34%"

    def test_rich_text_span_quoted_keys(self):
        """span 键带引号（CSS 风格）时 color/fontWeight/fontSize 全部生效。"""
        slide = Slide(
            children=[
                Text(
                    '活跃 <span style={{"color": "#2563EB", "fontWeight": "bold", "fontSize": 28}}>8000万</span>',
                    style={"fontSize": 20},
                )
            ]
        )
        prs = render_deck([slide])
        tb = [s for s in prs.slides[0].shapes if s.shape_type == MSO_SHAPE_TYPE.TEXT_BOX][0]
        runs = tb.text_frame.paragraphs[0].runs
        assert len(runs) == 2
        span_run = runs[1]
        assert span_run.text == "8000万"
        assert str(span_run.font.color.rgb) == "2563EB"
        assert span_run.font.bold is True
        assert abs(span_run.font.size.pt - pt(28)) < E
        # 外层 run 不受影响
        assert runs[0].font.bold is not True
        assert abs(runs[0].font.size.pt - pt(20)) < E


# ---------------------------------------------------------------- 背景与高级样式
class TestBackground:
    def test_solid_background(self):
        slide = Slide(title="x", background="#0F172A", children=[])
        prs = render_deck([slide])
        shapes = list(prs.slides[0].shapes)
        bg = shapes[0]
        assert bg.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE
        assert _shape_rect(bg) == (0, 0, 12_192_000, 6_858_000)
        assert str(bg.fill.fore_color.rgb) == "0F172A"

    def test_gradient_background(self):
        slide = Slide(background="linear-gradient(180deg, #0F172A, #1E3A8A)", children=[])
        prs = render_deck([slide])
        bg = list(prs.slides[0].shapes)[0]
        grad = bg.fill._xPr.find(qn("a:gradFill"))
        assert grad is not None
        gs_lst = grad.find(qn("a:gsLst"))
        assert gs_lst is not None
        stops = gs_lst.findall(qn("a:gs"))
        assert len(stops) == 2
        colors = [s.find(qn("a:srgbClr")).get("val") for s in stops]
        assert "0F172A" in colors and "1E3A8A" in colors
        lin = grad.find(qn("a:lin"))
        # CSS 180deg(top→bottom) → OOXML 270° = 270*60000
        assert lin.get("ang") == str((90 - 180) % 360 * 60000)

    def test_alpha_background(self):
        """RGBA 背景 → srgbClr 含 a:alpha。"""
        slide = Slide(background="#0F172A80", children=[])
        prs = render_deck([slide])
        bg = list(prs.slides[0].shapes)[0]
        srgb = bg.fill.fore_color._xFill.find(qn("a:srgbClr"))
        alpha = srgb.find(qn("a:alpha"))
        assert alpha is not None
        assert int(alpha.get("val")) == pytest.approx(round(0x80 / 255 * 100000))

    def test_border_radius(self):
        slide = Slide(children=[Box(style={"background": "#0EA5E9", "width": 200, "height": 100, "borderRadius": 16})])
        prs = render_deck([slide])
        shape = [s for s in prs.slides[0].shapes if s.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE][0]
        # ROUNDED_RECTANGLE 的 adjustments 有值
        assert shape.adjustments[0] is not None
        assert 0 < shape.adjustments[0] <= 0.5

    def test_shadow_xml(self):
        """apply_shadow → spPr 含 outerShdw。"""
        from pptx.util import Emu

        prs = render_deck([Slide(title="x")])
        pptx_slide = prs.slides[0]
        shape = pptx_slide.shapes.add_shape(1, Emu(0), Emu(0), Emu(100), Emu(100))
        apply_shadow(shape)
        sp_pr = shape._element.spPr
        effect = sp_pr.find(qn("a:effectLst"))
        assert effect is not None
        shdw = effect.find(qn("a:outerShdw"))
        assert shdw is not None
        assert shdw.get("blurRad") is not None


# ---------------------------------------------------------------- 增强渲染（border/boxShadow/opacity/zIndex）
class TestEnhancedRendering:
    def test_border_rendered(self):
        """border → shape.line 颜色与宽度。"""
        from pptx.util import Pt

        slide = Slide(
            children=[
                Box(style={"background": "#111111", "border": "2px solid #3B82F6", "width": 200, "height": 100})
            ]
        )
        prs = render_deck([slide])
        shape = [s for s in prs.slides[0].shapes if s.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE][0]
        assert str(shape.line.color.rgb) == "3B82F6"
        assert shape.line.width == Pt(2 * 0.75)  # 2px → 1.5pt

    def test_no_border_keeps_lineless(self):
        """无 border 的 Box 边框仍为无边框。"""
        from pptx.enum.dml import MSO_FILL_TYPE

        slide = Slide(children=[Box(style={"background": "#111111", "width": 100, "height": 50})])
        prs = render_deck([slide])
        shape = [s for s in prs.slides[0].shapes if s.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE][0]
        assert shape.line.fill.type == MSO_FILL_TYPE.BACKGROUND

    def test_box_shadow_rendered(self):
        """boxShadow → spPr 含 outerShdw。"""
        slide = Slide(
            children=[
                Box(style={"background": "#0F172A", "boxShadow": "0 8px 16px 76", "width": 200, "height": 100})
            ]
        )
        prs = render_deck([slide])
        shape = [s for s in prs.slides[0].shapes if s.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE][0]
        sp_pr = shape._element.spPr
        effect = sp_pr.find(qn("a:effectLst"))
        assert effect is not None
        shdw = effect.find(qn("a:outerShdw"))
        assert shdw is not None

    def test_opacity_scales_solid_alpha(self):
        """opacity 0.5 × 不透明背景 → alpha 50%。"""
        slide = Slide(
            children=[Box(style={"background": "#0F172A", "opacity": 0.5, "width": 100, "height": 50})]
        )
        prs = render_deck([slide])
        shape = [s for s in prs.slides[0].shapes if s.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE][0]
        srgb = shape.fill.fore_color._xFill.find(qn("a:srgbClr"))
        alpha = srgb.find(qn("a:alpha"))
        assert alpha is not None
        assert int(alpha.get("val")) == pytest.approx(round(128 / 255 * 100000))  # round(255*0.5)=128

    def test_opacity_scales_gradient_stops(self):
        """opacity 作用于渐变两端 stop。"""
        slide = Slide(
            children=[
                Box(
                    style={
                        "background": "linear-gradient(180deg, #0F172A, #1E3A8A)",
                        "opacity": 0.5,
                        "width": 100,
                        "height": 50,
                    }
                )
            ]
        )
        prs = render_deck([slide])
        shape = [s for s in prs.slides[0].shapes if s.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE][0]
        grad = shape.fill._xPr.find(qn("a:gradFill"))
        gs_lst = grad.find(qn("a:gsLst"))
        for stop in gs_lst.findall(qn("a:gs")):
            srgb = stop.find(qn("a:srgbClr"))
            alpha = srgb.find(qn("a:alpha"))
            assert alpha is not None
            assert int(alpha.get("val")) == pytest.approx(round(128 / 255 * 100000))  # round(255*0.5)=128

    def test_zindex_order(self):
        """zIndex 大的后渲染（shape 顺序靠后，位于上层）。"""
        slide = Slide(
            children=[
                Box(style={"background": "#111111", "width": 100, "height": 50, "zIndex": 1}),
                Box(style={"background": "#222222", "width": 100, "height": 50, "zIndex": 0}),
            ]
        )
        prs = render_deck([slide])
        shapes = [s for s in prs.slides[0].shapes if s.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE]
        assert str(shapes[-1].fill.fore_color.rgb) == "111111"


# ---------------------------------------------------------------- 页脚与页类型
class TestMaster:
    def test_footer_page_numbers(self):
        slides = [Slide(title="一"), Slide(title="二")]
        prs = render_deck(slides, options=RenderOptions(project_name="季度汇报"))
        for idx, pptx_slide in enumerate(prs.slides):
            texts = _find_texts(pptx_slide)
            assert any(t.strip() == f"{idx + 1}/2" for t in texts)
            assert any("季度汇报" in t for t in texts)

    def test_footer_hidden_on_cover_and_ending(self):
        slides = [Slide(page_type="cover", title="封面"), Slide(title="内容"), Slide(page_type="ending", title="谢谢")]
        prs = render_deck(slides)
        assert not any("1/3" in t for t in _find_texts(prs.slides[0]))
        assert any("2/3" in t for t in _find_texts(prs.slides[1]))
        assert not any("3/3" in t for t in _find_texts(prs.slides[2]))

    def test_cover_title_centered(self):
        slide = Slide(page_type="cover", title="2026 年度报告", children=[])
        prs = render_deck([slide])
        tb = [s for s in prs.slides[0].shapes if s.has_text_frame and "2026" in s.text_frame.text][0]
        assert tb.text_frame.paragraphs[0].alignment == 2  # CENTER

    def test_ending_title_centered(self):
        """ending 页：hero-center 居中标题。"""
        slide = Slide(page_type="ending", title="谢谢观看", children=[])
        prs = render_deck([slide])
        tb = [s for s in prs.slides[0].shapes if s.has_text_frame and "谢谢" in s.text_frame.text][0]
        assert tb.text_frame.paragraphs[0].alignment == 2  # CENTER

    def test_section_full_band(self):
        slide = Slide(page_type="section", title="第二部分", children=[])
        prs = render_deck([slide], options=RenderOptions(section_accent="0F172A"))
        pptx_slide = prs.slides[0]
        band = [s for s in pptx_slide.shapes if s.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE][0]
        assert _shape_rect(band) == (0, 0, 12_192_000, 6_858_000)
        assert str(band.fill.fore_color.rgb) == "0F172A"

    def test_notes(self):
        slides = [Slide(title="a"), Slide(title="b")]
        prs = render_deck(slides, options=RenderOptions(notes={0: "开场白", 1: "总结"}))
        assert prs.slides[0].notes_slide.notes_text_frame.text == "开场白"
        assert prs.slides[1].notes_slide.notes_text_frame.text == "总结"


# ---------------------------------------------------------------- 遍历与保存
class TestIntegrity:
    def test_traverse_all_shapes(self):
        """复杂页：全部 shape 遍历无异常。"""
        slide = Slide(
            title="复杂页",
            background="linear-gradient(135deg, #0F172A, #334155)",
            children=[
                Box(
                    style={"flexDirection": "row", "gap": 20, "padding": 24, "background": "#FFFFFF"},
                    children=[
                        Box(style={"flex": 1, "height": 200, "background": "#0EA5E9", "borderRadius": 12}),
                        Box(
                            style={"flex": 1, "height": 200, "background": "#F59E0B"},
                            children=[Text("卡片内容", style={"fontSize": 24, "color": "#FFFFFF"})],
                        ),
                    ],
                ),
                Text('关键 <span style={{color:"#E5484D"}}>数据</span>', style={"fontSize": 20, "marginTop": 24}),
            ],
        )
        prs = render_deck([slide])
        count = 0
        for pptx_slide in prs.slides:
            for shape in pptx_slide.shapes:
                count += 1
                assert shape.left >= 0 and shape.top >= 0
                assert shape.width > 0 and shape.height > 0
        assert count >= 5  # 背景 + 2 卡片 + 内容文本 + 标题 + 页脚

    def test_save_and_reopen(self, tmp_path):
        """保存 → 重新打开 → 断言文本与坐标仍在。"""
        out = tmp_path / "deck.pptx"
        slide = Slide(title="保存测试", children=[Text("正文内容", style={"fontSize": 20})])
        prs = render_deck([slide], str(out))
        assert out.exists()

        reopened = Presentation(str(out))
        assert len(reopened.slides) == 1
        texts = _find_texts(reopened.slides[0])
        assert any("保存测试" in t for t in texts)
        assert any("正文内容" in t for t in texts)
        assert reopened.slide_width == 12_192_000

    def test_render_error_bad_path(self, tmp_path):
        out = tmp_path / "no_such_dir" / "x.pptx"
        with pytest.raises(SlidepUserError) as ei:
            render_deck([Slide(title="x")], str(out))
        assert ei.value.code is ErrorCode.RENDER_OOXML_FAILED
