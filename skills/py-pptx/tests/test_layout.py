"""Flexbox 布局引擎核验测试（T1.2）。

核验目标（对齐任务分解文档）：
1. golden 测试：手算坐标的用例集合（10+ 布局组合）断言输出一致
2. 溢出/负尺寸/空容器断言报错（LAYOUT_OVERFLOW 等）
3. 模糊测试：随机生成属性组合跑 1000 次无崩溃、无死循环
4. 文本测量：单行/换行/长词截断/空串/letterSpacing
5. flex / justify / align / 百分比 / absolute / padding / margin 语义
"""

import random

import pytest

from slidep import ErrorCode, SlidepUserError
from slidep.dsl import Box, Slide, Text
from slidep.layout import (
    CANVAS_WIDTH,
    Rect,
    build_tree,
    flatten,
    layout_node,
    layout_slide,
    measure_text,
    text_width,
)
from slidep.layout.engine import SLIDE_CONTENT_RECT

E = 1e-6


# ---------------------------------------------------------------- 文本测量
class TestTextMeasure:
    def test_single_line_width(self):
        # "ABC"：0.55*3 = 1.65 倍字号
        w = text_width("ABC", 20)
        assert abs(w - 20 * 0.55 * 3) < E

    def test_cjk_width(self):
        # 中文 2 字 = 2 倍字号
        w = text_width("中文", 20)
        assert abs(w - 40) < E

    def test_space_narrower(self):
        w = text_width("A B", 20)
        assert abs(w - 20 * (0.55 + 0.3 + 0.55)) < E

    def test_empty_text(self):
        assert text_width("", 20) == 0.0
        m = measure_text("", 100, 20)
        assert m.lines == 1 and m.height == 20 * 1.3

    def test_no_limit_single_line(self):
        m = measure_text("超长文本不换行", 0, 20)
        assert m.lines == 1

    def test_wrap_by_width(self):
        # 4 个汉字 = 80px，限宽 60 → 2 行
        m = measure_text("一二三四", 60, 20)
        assert m.lines == 2
        assert abs(m.height - 20 * 1.3 * 2) < E

    def test_wrap_at_word_break(self):
        # "AA BB CC" 限宽 60：0.55*20=11/字，"AA BB"= 11*2+6+11*2=50 ≤60，"AA BB CC"=50+6+22=78>60
        m = measure_text("AA BB CC", 60, 20)
        assert m.lines == 2

    def test_long_word_forced_break(self):
        # 无断点超长串：限宽 30（0.55*20=11/字）→ 每行 2 字
        m = measure_text("AAAAAAAAAA", 30, 20)
        assert m.lines >= 4

    def test_letter_spacing_adds_width(self):
        w = text_width("AB", 20, letter_spacing=2)
        assert abs(w - 20 * 0.55 * 2 - 2) < E  # 2 字符 1 个间距

    def test_wrap_with_spacing(self):
        m = measure_text("AB", 50, 20, letter_spacing=30)
        assert m.lines == 2  # 22+30=52>50


# ---------------------------------------------------------------- golden 手算
class TestGolden:
    """手算坐标的用例集合。所有坐标基于 B 区容器（x=48,y=120,w=1184,h=540）。"""

    def test_empty_slide(self):
        result = layout_slide(Slide())
        assert result.root.rect == Rect(0, 0, 1280, 720)

    def test_column_stack_texts(self):
        """两个 Text 垂直堆叠：第一个高 20*1.3=26，第二个 marginTop 10。"""
        slide = Slide(children=[Text("A", style={"fontSize": 20}), Text("B", style={"fontSize": 20, "marginTop": 10})])
        r = layout_slide(slide)
        nodes = {n.id: n for n in r.nodes}
        texts = [n for n in r.nodes if n.kind == "text"]
        texts.sort(key=lambda n: n.rect.y)  # type: ignore[union-attr]
        t1, t2 = texts
        assert abs(t1.rect.x - 48) < E  # type: ignore[union-attr]
        assert abs(t1.rect.y - 120) < E  # type: ignore[union-attr]
        assert abs(t1.rect.height - 26) < E  # type: ignore[union-attr]
        assert abs(t2.rect.y - (120 + 26 + 10)) < E  # type: ignore[union-attr]

    def test_row_with_gap(self):
        """row 布局：两个 100px 宽的 Box，gap 20。"""
        slide = Slide(children=[Box(style={"width": 100, "height": 50}), Box(style={"width": 100, "height": 50, "gap": 0})])
        # gap 在父容器
        slide = Slide(
            style={"flexDirection": "row", "gap": 20},
            children=[Box(style={"width": 100, "height": 50}), Box(style={"width": 100, "height": 50})],
        )
        r = layout_slide(slide)
        boxes = [n for n in r.nodes if n.kind == "box"]
        boxes.sort(key=lambda n: n.rect.x)  # type: ignore[union-attr]
        b1, b2 = boxes
        assert abs(b1.rect.x - 48) < E  # type: ignore[union-attr]
        assert abs(b2.rect.x - (48 + 100 + 20)) < E  # type: ignore[union-attr]

    def test_justify_center(self):
        """row + justifyContent center：两个 100 宽子项居中。"""
        slide = Slide(
            style={"flexDirection": "row", "justifyContent": "center"},
            children=[Box(style={"width": 100, "height": 50}), Box(style={"width": 100, "height": 50})],
        )
        r = layout_slide(slide)
        boxes = [n for n in r.nodes if n.kind == "box"]
        boxes.sort(key=lambda n: n.rect.x)  # type: ignore[union-attr]
        first = boxes[0]
        expected = 48 + (1184 - 200) / 2
        assert abs(first.rect.x - expected) < E  # type: ignore[union-attr]

    def test_justify_space_between(self):
        slide = Slide(
            style={"flexDirection": "row", "justifyContent": "space-between"},
            children=[Box(style={"width": 100, "height": 50}), Box(style={"width": 100, "height": 50})],
        )
        r = layout_slide(slide)
        boxes = [n for n in r.nodes if n.kind == "box"]
        boxes.sort(key=lambda n: n.rect.x)  # type: ignore[union-attr]
        b1, b2 = boxes
        assert abs(b1.rect.x - 48) < E  # type: ignore[union-attr]
        assert abs(b2.rect.right - (48 + 1184)) < E  # type: ignore[union-attr]

    def test_align_center(self):
        """row + alignItems center：交叉轴（y）居中。子项高 50，容器高 540。"""
        slide = Slide(
            style={"flexDirection": "row", "alignItems": "center"},
            children=[Box(style={"width": 100, "height": 50})],
        )
        r = layout_slide(slide)
        box = next(n for n in r.nodes if n.kind == "box")
        expected_y = 120 + (540 - 50) / 2
        assert abs(box.rect.y - expected_y) < E  # type: ignore[union-attr]

    def test_stretch_default(self):
        """默认 alignItems=stretch：无高度子项在交叉轴拉伸满。"""
        slide = Slide(style={"flexDirection": "row"}, children=[Box(style={"width": 100})])
        r = layout_slide(slide)
        box = next(n for n in r.nodes if n.kind == "box")
        assert abs(box.rect.height - 540) < E  # type: ignore[union-attr]

    def test_flex_grow(self):
        """flex:1 分配剩余空间。两个子项，一个 flex:1 一个 flex:2。"""
        slide = Slide(
            style={"flexDirection": "row"},
            children=[Box(style={"flex": 1, "height": 50}), Box(style={"flex": 2, "height": 50})],
        )
        r = layout_slide(slide)
        boxes = [n for n in r.nodes if n.kind == "box"]
        boxes.sort(key=lambda n: n.rect.x)  # type: ignore[union-attr]
        b1, b2 = boxes
        assert abs(b1.rect.width - 1184 / 3) < E  # type: ignore[union-attr]
        assert abs(b2.rect.width - 1184 * 2 / 3) < E  # type: ignore[union-attr]

    def test_percent_width(self):
        """子项 width 50% → 592px。"""
        slide = Slide(
            style={"flexDirection": "row"},
            children=[Box(style={"width": "50%", "height": 50})],
        )
        r = layout_slide(slide)
        box = next(n for n in r.nodes if n.kind == "box")
        assert abs(box.rect.width - 1184 * 0.5) < E  # type: ignore[union-attr]

    def test_padding_inset(self):
        """容器 padding 24：子项左上偏移。"""
        slide = Slide(
            children=[
                Box(style={"padding": 24, "background": "#111111"}, children=[Text("X", style={"fontSize": 20})]),
            ]
        )
        r = layout_slide(slide)
        text = next(n for n in r.nodes if n.kind == "text")
        assert abs(text.rect.x - (48 + 24)) < E  # type: ignore[union-attr]
        assert abs(text.rect.y - (120 + 24)) < E  # type: ignore[union-attr]

    def test_absolute_position(self):
        """absolute + top/right 相对画布定位。"""
        slide = Slide(children=[Box(style={"position": "absolute", "top": 20, "right": 30, "width": 100, "height": 50})])
        r = layout_slide(slide)
        box = next(n for n in r.nodes if n.kind == "box")
        assert abs(box.rect.x - (1280 - 100 - 30)) < E  # type: ignore[union-attr]
        assert abs(box.rect.y - 20) < E  # type: ignore[union-attr]

    def test_nested_flex(self):
        """嵌套：外层 column，内层 row。"""
        slide = Slide(
            children=[
                Box(
                    style={"flexDirection": "row", "gap": 16},
                    children=[Box(style={"flex": 1, "height": 100}), Box(style={"flex": 1, "height": 100})],
                )
            ]
        )
        r = layout_slide(slide)
        inner = [n for n in r.nodes if n.kind == "box" and n.rect.width == (1184 - 16) / 2]  # type: ignore[operator]
        assert len(inner) == 2

    def test_text_wrap_in_constrained_box(self):
        """文本在受限宽度内自动换行：宽度 = 显式宽度，高度 = 行数×行高。"""
        slide = Slide(
            children=[Box(style={"width": 100}, children=[Text("一二三四五六七八", style={"fontSize": 20})])]
        )
        r = layout_slide(slide)
        text = next(n for n in r.nodes if n.kind == "text")
        # 每行最多 5 字（20*5=100），8 字 → 2 行
        assert abs(text.rect.height - 20 * 1.3 * 2) < E  # type: ignore[union-attr]

    def test_container_sizes_to_content(self):
        """alignItems=flex-start 下：无显式尺寸的容器由内容撑开 + padding。"""
        slide = Slide(
            style={"alignItems": "flex-start"},
            children=[
                Box(style={"padding": 10}, children=[Text("A", style={"fontSize": 20})]),
            ],
        )
        r = layout_slide(slide)
        box = next(n for n in r.nodes if n.kind == "box")
        # 内容宽 11px（A=0.55*20）+ padding 20 → 31；高 26+20 → 46
        assert abs(box.rect.width - (20 * 0.55 + 20)) < E  # type: ignore[union-attr]
        assert abs(box.rect.height - (26 + 20)) < E  # type: ignore[union-attr]

    def test_default_stretch_fills_cross_axis(self):
        """默认 alignItems=stretch：无宽度的 column 子项被拉满容器宽度（flexbox 标准行为）。"""
        slide = Slide(children=[Box(style={"height": 50})])
        r = layout_slide(slide)
        box = next(n for n in r.nodes if n.kind == "box")
        assert abs(box.rect.width - 1184) < E  # type: ignore[union-attr]


# ---------------------------------------------------------------- 错误分支
class TestErrors:
    def test_overflow_height(self):
        """内容超出画布 → LAYOUT_OVERFLOW。"""
        slide = Slide(children=[Box(style={"height": 1000})])
        with pytest.raises(SlidepUserError) as ei:
            layout_slide(slide)
        assert ei.value.code is ErrorCode.LAYOUT_OVERFLOW

    def test_overflow_bottom(self):
        slide = Slide(children=[Box(style={"marginTop": 700, "height": 100})])
        with pytest.raises(SlidepUserError) as ei:
            layout_slide(slide)
        assert ei.value.code is ErrorCode.LAYOUT_OVERFLOW
        assert "Slide" in str(ei.value) or "Box" in str(ei.value)

    def test_overflow_negative_position(self):
        """absolute 定位超出画布（top 700 + 高 100 → 底 800）→ LAYOUT_OVERFLOW。"""
        slide = Slide(children=[Box(style={"position": "absolute", "top": 700, "height": 100, "width": 100})])
        with pytest.raises(SlidepUserError) as ei:
            layout_slide(slide)
        assert ei.value.code is ErrorCode.LAYOUT_OVERFLOW

    def test_no_overflow_normal(self):
        slide = Slide(children=[Text("ok", style={"fontSize": 18})])
        result = layout_slide(slide)
        assert result.root.rect == Rect(0, 0, 1280, 720)


# ---------------------------------------------------------------- 工具函数
class TestHelpers:
    def test_build_tree_ids_sorted(self):
        slide = Slide(children=[Box(children=[Text("a")]), Text("b")])
        root = build_tree(slide)
        nodes = flatten(root)
        ids = [n.id for n in nodes]
        assert ids == sorted(ids)
        assert len(nodes) == 4

    def test_rect_helpers(self):
        rect = Rect(10, 20, 100, 50)
        assert rect.right == 110
        assert rect.bottom == 70

    def test_layout_node_generic(self):
        box = Box(style={"flexDirection": "row"}, children=[Box(style={"width": 50, "height": 30})])
        r = layout_node(box, Rect(0, 0, 200, 100))
        child = next(n for n in r.nodes if n.kind == "box" and n.parent is not None)
        assert abs(child.rect.width - 50) < E  # type: ignore[union-attr]
        assert abs(child.rect.height - 30) < E  # type: ignore[union-attr]


# ---------------------------------------------------------------- 增强能力（border/margin/min-max/relative/zIndex）
class TestEnhancedLayout:
    def test_margin_left_right_row(self):
        """row 布局：marginLeft/marginRight 占主轴空间。"""
        slide = Slide(
            style={"flexDirection": "row"},
            children=[
                Box(style={"width": 100, "height": 50, "marginLeft": 10, "marginRight": 20}),
                Box(style={"width": 100, "height": 50}),
            ],
        )
        r = layout_slide(slide)
        boxes = [n for n in r.nodes if n.kind == "box"]
        boxes.sort(key=lambda n: n.rect.x)  # type: ignore[union-attr]
        b1, b2 = boxes
        assert abs(b1.rect.x - (48 + 10)) < E  # type: ignore[union-attr]
        assert abs(b2.rect.x - (48 + 10 + 100 + 20)) < E  # type: ignore[union-attr]

    def test_margin_shorthand_cross_axis(self):
        """column 容器：margin 简写影响主轴间距与交叉轴起点。"""
        slide = Slide(
            children=[
                Box(children=[Text("A", style={"fontSize": 20})]),
                Box(style={"margin": "10px 20px"}, children=[Text("B", style={"fontSize": 20})]),
            ]
        )
        r = layout_slide(slide)
        texts = [n for n in r.nodes if n.kind == "text"]
        texts.sort(key=lambda n: n.rect.y)  # type: ignore[union-attr]
        t1, t2 = texts
        # B 的 Box 在 y=120+26+10（margin-top）；文本再内缩 0（无 padding/border）
        assert abs(t2.rect.y - (120 + 26 + 10)) < E  # type: ignore[union-attr]  # margin-top 10
        # margin-left 20 → Box 交叉轴起点偏移，文本随 Box x
        assert abs(t2.rect.x - (48 + 20)) < E  # type: ignore[union-attr]

    def test_min_width_floor(self):
        """minWidth 保底：auto 尺寸小于 min 时提升。"""
        slide = Slide(
            style={"alignItems": "flex-start"},
            children=[Box(style={"minWidth": 300, "height": 50})],
        )
        r = layout_slide(slide)
        box = next(n for n in r.nodes if n.kind == "box")
        assert abs(box.rect.width - 300) < E  # type: ignore[union-attr]

    def test_max_width_cap(self):
        """maxWidth 封顶：显式尺寸超限时压缩。"""
        slide = Slide(
            style={"flexDirection": "row"},
            children=[Box(style={"width": 500, "height": 50, "maxWidth": 300})],
        )
        r = layout_slide(slide)
        box = next(n for n in r.nodes if n.kind == "box")
        assert abs(box.rect.width - 300) < E  # type: ignore[union-attr]

    def test_relative_offset(self):
        """relative：top/left 相对原位偏移，不影响兄弟节点。"""
        slide = Slide(
            style={"flexDirection": "row"},
            children=[
                Box(style={"width": 100, "height": 50}),
                Box(style={"width": 100, "height": 50, "position": "relative", "left": 20, "top": 10}),
            ],
        )
        r = layout_slide(slide)
        boxes = [n for n in r.nodes if n.kind == "box"]
        boxes.sort(key=lambda n: n.rect.x)  # type: ignore[union-attr]
        b1, b2 = boxes
        assert abs(b1.rect.x - 48) < E  # type: ignore[union-attr]
        assert abs(b2.rect.x - (48 + 100 + 20)) < E  # type: ignore[union-attr]  # 原位 148 + 20
        assert abs(b2.rect.y - (120 + 10)) < E  # type: ignore[union-attr]

    def test_border_insets_content(self):
        """border-box：border 计入容器尺寸并内缩内容。"""
        slide = Slide(
            children=[
                Box(
                    style={"border": "2px solid #3B82F6", "padding": 10, "background": "#111111"},
                    children=[Text("X", style={"fontSize": 20})],
                ),
            ]
        )
        r = layout_slide(slide)
        text = next(n for n in r.nodes if n.kind == "text")
        assert abs(text.rect.x - (48 + 10 + 2)) < E  # type: ignore[union-attr]  # padding + border
        assert abs(text.rect.y - (120 + 10 + 2)) < E  # type: ignore[union-attr]

    def test_absolute_relative_to_padding_box(self):
        """absolute 子项相对父 padding box（border 从内侧起算）。"""
        slide = Slide(
            children=[
                Box(
                    style={"border": "4px solid #000000", "width": 400, "height": 200},
                    children=[Box(style={"position": "absolute", "top": 10, "left": 10, "width": 50, "height": 30})],
                ),
            ]
        )
        r = layout_slide(slide)
        abs_box = next(n for n in r.nodes if n.kind == "box" and n.style.position == "absolute")
        assert abs(abs_box.rect.x - (48 + 4 + 10)) < E  # type: ignore[union-attr]
        assert abs(abs_box.rect.y - (120 + 4 + 10)) < E  # type: ignore[union-attr]

    def test_zindex_resolved(self):
        """zIndex 解析进 ResolvedStyle。"""
        slide = Slide(children=[Box(style={"zIndex": 5})])
        r = layout_slide(slide)
        box = next(n for n in r.nodes if n.kind == "box")
        assert box.style.z_index == 5  # type: ignore[union-attr]


# ---------------------------------------------------------------- 模糊测试
class TestFuzz:
    """随机属性组合 1000 次：不崩溃、不死循环、结果收敛。"""

    def test_fuzz_no_crash(self):
        rng = random.Random(42)
        directions = ["row", "column"]
        justifies = ["flex-start", "center", "flex-end", "space-between", "space-around"]
        aligns = ["flex-start", "center", "flex-end", "stretch"]

        def rand_box(depth: int) -> Box:
            style: dict = {}
            if rng.random() < 0.5:
                style["flexDirection"] = rng.choice(directions)
            if rng.random() < 0.4:
                style["gap"] = rng.randint(0, 60)
            if rng.random() < 0.3:
                style["justifyContent"] = rng.choice(justifies)
            if rng.random() < 0.3:
                style["alignItems"] = rng.choice(aligns)
            if rng.random() < 0.3:
                style["width"] = rng.choice([rng.randint(20, 300), f"{rng.randint(10, 90)}%"])
            if rng.random() < 0.3:
                style["height"] = rng.choice([rng.randint(20, 300), f"{rng.randint(10, 90)}%"])
            if rng.random() < 0.2:
                style["padding"] = rng.randint(0, 40)
            if rng.random() < 0.2:
                style["flex"] = rng.randint(1, 3)
            if rng.random() < 0.1:
                style["position"] = "absolute"
                style["top"] = rng.randint(0, 100)
                style["left"] = rng.randint(0, 100)
                style["width"] = rng.randint(20, 200)
                style["height"] = rng.randint(20, 200)

            children = []
            if depth < 3 and rng.random() < 0.6:
                for _ in range(rng.randint(1, 3)):
                    children.append(rand_box(depth + 1) if rng.random() < 0.6 else rand_text())
            elif rng.random() < 0.3:
                children.append(rand_text())
            return Box(style=style, children=children)

        def rand_text() -> Text:
            chars = "AB中 文-一二三,，。"
            text = "".join(rng.choice(chars) for _ in range(rng.randint(0, 30)))
            return Text(
                text,
                style={
                    "fontSize": rng.choice([12, 14, 16, 18, 20, 24, 32, 40]),
                    **({"color": "#334155"} if rng.random() < 0.5 else {}),
                },
            )

        for _ in range(1000):
            slide = Slide(children=[rand_box(0)])
            try:
                r = layout_slide(slide)
            except SlidepUserError:
                continue  # 溢出属正常拒绝
            # 结果收敛性：所有 rect 有限且非负宽高
            for n in r.nodes:
                assert n.rect is not None
                assert n.rect.width >= -E and n.rect.height >= -E
                assert n.rect.x >= -E - 0.01 and n.rect.y >= -E - 0.01
