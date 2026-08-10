"""媒体与富文本组件核验测试（T2.2）。

核验目标（对齐任务分解文档）：
1. 每个新组件模型校验（必填属性 / 样式白名单 / 序列化 round-trip）
2. 布局集成：每个组件作为叶子节点 measure/arrange
3. 每个渲染器生成合法 PNG（或原生表格）
4. 端到端：组件在 Slide 中渲染为 pptx，元素类型与位置正确
5. 边界：缺失资源 / 未知图标 / 非法 SVG / 空数据不崩溃
"""

import io

import pytest
from PIL import Image as PILImage

from slidep import ErrorCode, SlidepUserError
from slidep.dsl import (
    Box,
    CodeBlock,
    FAIcon,
    Image,
    Math,
    QRCode,
    SVG,
    Slide,
    Table,
    Text,
    from_dict,
    to_dict,
)
from slidep.layout import layout_slide
from slidep.render import (
    render_codeblock_png,
    render_deck,
    render_icon_png,
    render_image_png,
    render_math_png,
    render_qrcode_png,
    render_svg_png,
)

E = 1e-6


def _is_png(data: bytes) -> bool:
    """检查是否为合法 PNG。"""
    return data[:8] == b"\x89PNG\r\n\x1a\n"


def _png_size(data: bytes) -> tuple[int, int]:
    """从 PNG bytes 读取宽高。"""
    img = PILImage.open(io.BytesIO(data))
    return img.size


# ================================================================ 组件模型
class TestMediaModels:
    # ---- Image ----
    def test_image_valid(self):
        img = Image(src="logo.png")
        assert img.src == "logo.png"
        assert img.object_fit == "cover"

    def test_image_empty_src(self):
        with pytest.raises(SlidepUserError) as ei:
            Image(src="")
        assert ei.value.code is ErrorCode.DSL_MISSING_REQUIRED_PROP

    def test_image_contain_fit(self):
        img = Image(src="x.png", object_fit="contain")
        assert img.object_fit == "contain"

    def test_image_style_whitelist(self):
        with pytest.raises(SlidepUserError) as ei:
            Image(src="x.png", style={"color": "#FF0000"})
        assert ei.value.code is ErrorCode.DSL_UNKNOWN_PROPERTY

    # ---- Table ----
    def test_table_valid(self):
        t = Table(data=[["A", "B"], ["1", "2"]])
        assert len(t.data) == 2
        assert t.header is True
        assert t.zebra is True

    def test_table_empty_data(self):
        with pytest.raises(SlidepUserError) as ei:
            Table(data=[])
        assert ei.value.code is ErrorCode.DSL_MISSING_REQUIRED_PROP

    def test_table_ragged_rows(self):
        with pytest.raises(SlidepUserError) as ei:
            Table(data=[["A", "B"], ["1"]])
        assert ei.value.code is ErrorCode.DSL_INVALID_STYLE_VALUE

    def test_table_header_off(self):
        t = Table(data=[["A"]], header=False, zebra=False)
        assert t.header is False
        assert t.zebra is False

    # ---- FAIcon ----
    def test_icon_valid(self):
        ic = FAIcon(name="check")
        assert ic.name == "check"

    def test_icon_empty_name(self):
        with pytest.raises(SlidepUserError) as ei:
            FAIcon(name="")
        assert ei.value.code is ErrorCode.DSL_MISSING_REQUIRED_PROP

    def test_icon_style_whitelist(self):
        """FAIcon 允许 color 但不允许 fontSize。"""
        ic = FAIcon(name="star", style={"color": "#FF0000"})
        assert ic.style["color"] == "#FF0000"
        with pytest.raises(SlidepUserError) as ei:
            FAIcon(name="star", style={"fontSize": 20})
        assert ei.value.code is ErrorCode.DSL_UNKNOWN_PROPERTY

    # ---- SVG ----
    def test_svg_valid(self):
        sv = SVG(markup='<svg><rect width="10" height="10"/></svg>')
        assert "<rect" in sv.markup

    def test_svg_empty_markup(self):
        with pytest.raises(SlidepUserError) as ei:
            SVG(markup="")
        assert ei.value.code is ErrorCode.DSL_MISSING_REQUIRED_PROP

    # ---- QRCode ----
    def test_qrcode_valid(self):
        qr = QRCode(value="https://example.com")
        assert qr.value == "https://example.com"

    def test_qrcode_empty_value(self):
        with pytest.raises(SlidepUserError) as ei:
            QRCode(value="")
        assert ei.value.code is ErrorCode.DSL_MISSING_REQUIRED_PROP

    # ---- CodeBlock ----
    def test_codeblock_valid(self):
        cb = CodeBlock(code="print('hello')")
        assert cb.code == "print('hello')"
        assert cb.language == "text"

    def test_codeblock_empty_code(self):
        with pytest.raises(SlidepUserError) as ei:
            CodeBlock(code="")
        assert ei.value.code is ErrorCode.DSL_MISSING_REQUIRED_PROP

    def test_codeblock_python(self):
        cb = CodeBlock(code="x = 1", language="python")
        assert cb.language == "python"

    # ---- Math ----
    def test_math_valid(self):
        m = Math(latex="E=mc^2")
        assert m.latex == "E=mc^2"

    def test_math_empty_latex(self):
        with pytest.raises(SlidepUserError) as ei:
            Math(latex="")
        assert ei.value.code is ErrorCode.DSL_MISSING_REQUIRED_PROP

    def test_math_style_color(self):
        m = Math(latex="x^2", style={"color": "#0000FF"})
        assert m.style["color"] == "#0000FF"

    # ---- 序列化 round-trip ----
    @pytest.mark.parametrize("comp,cls", [
        (Image(src="a.png"), Image),
        (Table(data=[["X"]]), Table),
        (FAIcon(name="check"), FAIcon),
        (SVG(markup="<svg/>"), SVG),
        (QRCode(value="abc"), QRCode),
        (CodeBlock(code="x=1", language="python"), CodeBlock),
        (Math(latex="x^2"), Math),
    ])
    def test_roundtrip(self, comp, cls):
        d = to_dict(comp)
        c2 = from_dict(d)
        assert isinstance(c2, cls)
        assert c2.type == comp.type


# ================================================================ 布局集成
class TestMediaLayout:
    @pytest.mark.parametrize("comp,kind,default_w,default_h", [
        (Image(src="x.png"), "image", 400.0, 300.0),
        (Table(data=[["A", "B"]]), "table", 600.0, 300.0),
        (FAIcon(name="check"), "icon", 48.0, 48.0),
        (SVG(markup="<svg/>"), "svg", 400.0, 300.0),
        (QRCode(value="abc"), "qrcode", 200.0, 200.0),
        (CodeBlock(code="x=1"), "codeblock", 600.0, 400.0),
        (Math(latex="x^2"), "math", 400.0, 100.0),
    ])
    def test_default_sizes(self, comp, kind, default_w, default_h):
        """无显式尺寸时，各组件取默认值。"""
        slide = Slide(
            style={"alignItems": "flex-start"},
            children=[comp],
        )
        result = layout_slide(slide)
        node = next(n for n in result.nodes if n.kind == kind)
        assert abs(node.measured_w - default_w) < E
        assert abs(node.measured_h - default_h) < E

    def test_explicit_sizes(self):
        """显式 width/height 生效。"""
        slide = Slide(children=[
            QRCode(value="x", style={"width": 150, "height": 150}),
        ])
        result = layout_slide(slide)
        qr_node = next(n for n in result.nodes if n.kind == "qrcode")
        assert abs(qr_node.measured_w - 150) < E
        assert abs(qr_node.measured_h - 150) < E

    def test_media_in_flex_row(self):
        """多个媒体组件在 row 布局中并排。"""
        slide = Slide(
            style={"flexDirection": "row", "gap": 20, "alignItems": "flex-start"},
            children=[
                FAIcon(name="check", style={"width": 64, "height": 64}),
                Math(latex="E=mc^2", style={"width": 200, "height": 80}),
                QRCode(value="abc", style={"width": 120, "height": 120}),
            ],
        )
        result = layout_slide(slide)
        kinds = [n.kind for n in result.nodes if n.kind in ("icon", "math", "qrcode")]
        assert kinds == ["icon", "math", "qrcode"]

    def test_media_overflow_detected(self):
        """CodeBlock 高度超出 B 区 → 布局溢出。"""
        slide = Slide(children=[
            CodeBlock(code="x" * 100, style={"height": 700}),
        ])
        with pytest.raises(SlidepUserError) as ei:
            layout_slide(slide)
        assert ei.value.code is ErrorCode.LAYOUT_OVERFLOW


# ================================================================ PNG 渲染
class TestMediaRendering:
    def test_qrcode_produces_png(self):
        png = render_qrcode_png("https://example.com", 200, 200)
        assert _is_png(png)
        w, h = _png_size(png)
        assert w > 50 and h > 50

    def test_qrcode_custom_colors(self):
        png = render_qrcode_png("test", 200, 200, fg_color="#0000FF", bg_color="#FFFF00")
        assert _is_png(png)

    def test_icon_produces_png(self):
        png = render_icon_png("check", 64, 64)
        assert _is_png(png)
        w, h = _png_size(png)
        assert w > 10 and h > 10

    def test_icon_custom_color(self):
        png = render_icon_png("star", 48, 48, color="#FF0000")
        assert _is_png(png)

    @pytest.mark.parametrize("icon_name", ["check", "star", "home", "user", "heart", "cog"])
    def test_multiple_icons(self, icon_name):
        png = render_icon_png(icon_name, 48, 48)
        assert _is_png(png)

    def test_svg_produces_png(self):
        markup = '<svg viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="#4F46E5"/></svg>'
        png = render_svg_png(markup, 200, 200)
        assert _is_png(png)

    def test_svg_multiple_elements(self):
        markup = '''<svg viewBox="0 0 200 100">
            <circle cx="50" cy="50" r="30" fill="red"/>
            <rect x="100" y="20" width="60" height="60" fill="blue"/>
            <line x1="10" y1="90" x2="190" y2="10" stroke="green" stroke-width="2"/>
        </svg>'''
        png = render_svg_png(markup, 400, 200)
        assert _is_png(png)

    def test_math_produces_png(self):
        png = render_math_png("E=mc^2", 300, 80)
        assert _is_png(png)

    def test_math_fraction(self):
        png = render_math_png(r"\frac{a}{b}", 200, 80)
        assert _is_png(png)

    def test_math_custom_color(self):
        png = render_math_png("x^2 + y^2", 200, 60, color="#FF0000")
        assert _is_png(png)

    def test_codeblock_produces_png(self):
        png = render_codeblock_png("print('hello')", "python", 400, 200)
        assert _is_png(png)
        w, h = _png_size(png)
        assert w > 50 and h > 50

    @pytest.mark.parametrize("lang", ["python", "javascript", "java", "go", "sql", "json", "yaml", "bash", "text"])
    def test_codeblock_all_languages(self, lang):
        png = render_codeblock_png(f"# {lang} code\nx = 1", lang, 400, 200)
        assert _is_png(png)

    def test_codeblock_multiline(self):
        code = "def hello():\n    print('world')\n    return True"
        png = render_codeblock_png(code, "python", 500, 300)
        assert _is_png(png)

    def test_image_produces_png(self, tmp_path):
        """Image 渲染需要真实图片文件。"""
        img_path = tmp_path / "test.png"
        img = PILImage.new("RGBA", (200, 150), (255, 100, 50, 255))
        img.save(str(img_path))

        png = render_image_png(str(img_path), "cover", 400, 300)
        assert _is_png(png)
        w, h = _png_size(png)
        assert w > 50 and h > 50

    def test_image_cover_fit(self, tmp_path):
        """objectFit=cover 裁剪填充。"""
        img_path = tmp_path / "wide.png"
        img = PILImage.new("RGBA", (400, 100), (0, 255, 0, 255))
        img.save(str(img_path))

        png = render_image_png(str(img_path), "cover", 200, 200)
        assert _is_png(png)
        w, h = _png_size(png)
        # cover 应该填充到目标尺寸
        assert w >= 200 or h >= 200

    def test_image_contain_fit(self, tmp_path):
        """objectFit=contain 等比缩放留白。"""
        img_path = tmp_path / "tall.png"
        img = PILImage.new("RGBA", (100, 400), (0, 0, 255, 255))
        img.save(str(img_path))

        png = render_image_png(str(img_path), "contain", 200, 200)
        assert _is_png(png)

    def test_image_rounded_corners(self, tmp_path):
        """圆角处理。"""
        img_path = tmp_path / "round.png"
        img = PILImage.new("RGBA", (200, 200), (255, 0, 0, 255))
        img.save(str(img_path))

        png = render_image_png(str(img_path), "cover", 200, 200, border_radius=20)
        assert _is_png(png)


# ================================================================ 边界情况
class TestMediaEdgeCases:
    def test_image_missing_file(self):
        with pytest.raises(SlidepUserError) as ei:
            render_image_png("nonexistent_file.png", "cover", 200, 200)
        assert ei.value.code is ErrorCode.RENDER_IMAGE_MISSING

    def test_unknown_icon_raises(self):
        with pytest.raises(SlidepUserError) as ei:
            render_icon_png("nonexistent-icon", 48, 48)
        assert ei.value.code is ErrorCode.RENDER_OOXML_FAILED
        assert "未知图标" in str(ei.value)

    def test_invalid_svg_raises(self):
        with pytest.raises(SlidepUserError) as ei:
            render_svg_png("<not valid xml><>", 200, 200)
        assert ei.value.code is ErrorCode.RENDER_OOXML_FAILED

    def test_math_invalid_latex_raises(self):
        """无效 LaTeX 公式应报错（mathtext 语法错误）。"""
        with pytest.raises(SlidepUserError) as ei:
            render_math_png(r"\unknowncommand{xyz}", 200, 80)
        assert ei.value.code is ErrorCode.RENDER_OOXML_FAILED

    def test_codeblock_empty_lines(self):
        """空行代码不崩溃。"""
        png = render_codeblock_png("", "text", 200, 100)
        assert _is_png(png)

    def test_codeblock_very_long_line(self):
        """超长行不崩溃。"""
        png = render_codeblock_png("x = " + "1" * 200, "python", 600, 200)
        assert _is_png(png)

    def test_qrcode_long_value(self):
        """长 URL 不崩溃。"""
        png = render_qrcode_png("https://example.com/" + "a" * 100, 200, 200)
        assert _is_png(png)

    def test_svg_with_text_element(self):
        """SVG 含 text 元素。"""
        markup = '<svg viewBox="0 0 200 50"><text x="10" y="30" font-size="14" fill="black">Hello SVG</text></svg>'
        png = render_svg_png(markup, 200, 50)
        assert _is_png(png)

    def test_svg_with_path_element(self):
        """SVG 含 path 元素。"""
        markup = '<svg viewBox="0 0 100 100"><path d="M10 10 L90 10 L50 90 Z" fill="#3B82F6"/></svg>'
        png = render_svg_png(markup, 200, 200)
        assert _is_png(png)

    def test_svg_with_g_transform(self):
        """SVG 含 g translate 变换。"""
        markup = '<svg viewBox="0 0 200 200"><g transform="translate(50, 50)"><rect width="50" height="50" fill="red"/></g></svg>'
        png = render_svg_png(markup, 200, 200)
        assert _is_png(png)


# ================================================================ 端到端
class TestMediaE2E:
    def test_qrcode_in_slide(self, tmp_path):
        """QRCode 在 Slide 中渲染为 pptx 图片。"""
        slide = Slide(
            title="扫码访问",
            children=[
                QRCode(value="https://example.com", style={"width": 200, "height": 200}),
            ],
        )
        out = tmp_path / "qr_deck.pptx"
        render_deck([slide], str(out))
        assert out.exists()

        from pptx import Presentation
        from pptx.enum.shapes import MSO_SHAPE_TYPE

        reopened = Presentation(str(out))
        pics = [s for s in reopened.slides[0].shapes if s.shape_type == MSO_SHAPE_TYPE.PICTURE]
        assert len(pics) == 1

    def test_icon_in_slide(self, tmp_path):
        """FAIcon 在 Slide 中渲染为 pptx 图片。"""
        slide = Slide(
            title="图标演示",
            children=[
                FAIcon(name="check", style={"width": 64, "height": 64, "color": "#22C55E"}),
            ],
        )
        out = tmp_path / "icon_deck.pptx"
        render_deck([slide], str(out))
        assert out.exists()

        from pptx import Presentation
        from pptx.enum.shapes import MSO_SHAPE_TYPE

        reopened = Presentation(str(out))
        pics = [s for s in reopened.slides[0].shapes if s.shape_type == MSO_SHAPE_TYPE.PICTURE]
        assert len(pics) == 1

    def test_math_in_slide(self, tmp_path):
        """Math 在 Slide 中渲染为 pptx 图片。"""
        slide = Slide(
            title="质能方程",
            children=[
                Math(latex=r"E=mc^2", style={"width": 300, "height": 80, "color": "#1E293B"}),
            ],
        )
        out = tmp_path / "math_deck.pptx"
        render_deck([slide], str(out))
        assert out.exists()

    def test_codeblock_in_slide(self, tmp_path):
        """CodeBlock 在 Slide 中渲染为 pptx 图片。"""
        slide = Slide(
            title="代码示例",
            children=[
                CodeBlock(
                    code="def greet(name):\n    return f'Hello, {name}!'",
                    language="python",
                    style={"width": 600, "height": 200},
                ),
            ],
        )
        out = tmp_path / "code_deck.pptx"
        render_deck([slide], str(out))
        assert out.exists()

    def test_svg_in_slide(self, tmp_path):
        """SVG 在 Slide 中渲染为 pptx 图片。"""
        markup = '<svg viewBox="0 0 300 200"><rect x="10" y="10" width="280" height="180" rx="10" fill="#4F46E5"/><circle cx="150" cy="100" r="60" fill="#FFFFFF"/></svg>'
        slide = Slide(
            title="SVG 图形",
            children=[
                SVG(markup=markup, style={"width": 400, "height": 300}),
            ],
        )
        out = tmp_path / "svg_deck.pptx"
        render_deck([slide], str(out))
        assert out.exists()

    def test_table_in_slide(self, tmp_path):
        """Table 在 Slide 中渲染为原生可编辑表格。"""
        slide = Slide(
            title="数据表格",
            children=[
                Table(
                    data=[
                        ["指标", "Q1", "Q2"],
                        ["营收", "12.4", "15.2"],
                        ["利润", "3.1", "4.0"],
                    ],
                    style={"width": 600, "height": 200},
                ),
            ],
        )
        out = tmp_path / "table_deck.pptx"
        render_deck([slide], str(out))
        assert out.exists()

        from pptx import Presentation

        reopened = Presentation(str(out))
        # 表格保留可编辑性：通过 has_table 检测
        table_shapes = [s for s in reopened.slides[0].shapes if s.has_table]
        assert len(table_shapes) == 1
        tbl = table_shapes[0].table
        assert len(tbl.rows) == 3
        assert len(tbl.columns) == 3
        assert tbl.cell(0, 0).text == "指标"

    def test_image_in_slide(self, tmp_path):
        """Image 在 Slide 中渲染为 pptx 图片。"""
        # 创建测试图片
        img_path = tmp_path / "logo.png"
        img = PILImage.new("RGBA", (300, 200), (99, 102, 241, 255))
        img.save(str(img_path))

        slide = Slide(
            title="图片展示",
            children=[
                Image(src=str(img_path), object_fit="cover", style={"width": 400, "height": 300, "borderRadius": 12}),
            ],
        )
        out = tmp_path / "image_deck.pptx"
        render_deck([slide], str(out))
        assert out.exists()

        from pptx import Presentation
        from pptx.enum.shapes import MSO_SHAPE_TYPE

        reopened = Presentation(str(out))
        pics = [s for s in reopened.slides[0].shapes if s.shape_type == MSO_SHAPE_TYPE.PICTURE]
        assert len(pics) == 1

    def test_multiple_media_on_slide(self, tmp_path):
        """多种媒体组件同页渲染。"""
        slide = Slide(
            title="综合演示",
            children=[
                Box(
                    style={"flexDirection": "row", "gap": 24, "alignItems": "flex-start"},
                    children=[
                        FAIcon(name="rocket", style={"width": 48, "height": 48, "color": "#6366F1"}),
                        Math(latex=r"\sum_{i=1}^{n} i = \frac{n(n+1)}{2}", style={"width": 300, "height": 80}),
                        QRCode(value="https://slidep.dev", style={"width": 100, "height": 100}),
                    ],
                ),
            ],
        )
        out = tmp_path / "multi_media.pptx"
        render_deck([slide], str(out))
        assert out.exists()

        from pptx import Presentation
        from pptx.enum.shapes import MSO_SHAPE_TYPE

        reopened = Presentation(str(out))
        pics = [s for s in reopened.slides[0].shapes if s.shape_type == MSO_SHAPE_TYPE.PICTURE]
        # icon + math + qrcode = 3 张图片
        assert len(pics) == 3

    def test_text_and_table_combined(self, tmp_path):
        """文字说明 + 表格同页。"""
        slide = Slide(
            title="季度报告",
            children=[
                Text("以下是 2026 年各季度的业绩数据：", style={"fontSize": 18, "width": 600}),
                Table(
                    data=[
                        ["季度", "营收(亿)", "利润(亿)", "增长率"],
                        ["Q1", "12.4", "3.1", "15%"],
                        ["Q2", "15.2", "4.0", "22%"],
                        ["Q3", "18.9", "5.2", "24%"],
                    ],
                    style={"width": 800, "height": 200, "marginTop": 20},
                ),
            ],
        )
        out = tmp_path / "text_table.pptx"
        render_deck([slide], str(out))
        assert out.exists()
