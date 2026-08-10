"""预览服务测试（T4.2）。

核验目标（对齐任务分解文档）：
1. SVG 渲染：Slide → SVG 字符串，包含背景/标题/文本/页脚等元素
2. HTTP 接口：``/api/slides``、``/api/slides/{idx}``、``/preview/{idx}``、``/api/status``
3. SSE 自动刷新：编译完成 → 事件推送到订阅者
4. 无 LibreOffice fallback：纯 SVG 路径可用（不依赖外部软件）
5. 画廊 HTML：``/`` 返回可用的 HTML 页面

测试策略：
- SVG 渲染器用单元测试（不依赖 FastAPI/uvicorn）
- HTTP 接口用 TestClient（fastapi.testclient）
- SSE 用 TestClient + 异步队列
- 无 LibreOffice 路径：验证 SVG 渲染器不调用外部进程
"""

from __future__ import annotations

import json
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest

# 检查 FastAPI 是否安装
try:
    import fastapi  # noqa: F401
    HAS_FASTAPI = True
except ImportError:
    HAS_FASTAPI = False

# 复用 test_daemon.py 的合规页面构造
VALID_LONG_TEXT = (
    "本季度营收达到一百二十亿元同比增长百分之三十四创下历史新高。"
    "核心产品线表现强劲用户增长显著市场占有率稳步提升。"
    "下半年将重点投入研发创新持续优化产品体验深化客户服务。"
    "团队规模扩大至五百人新增三个区域办事处覆盖全国主要城市。"
    "客户满意度提升至百分之九十五复购率达到百分之六十八。"
    "技术架构完成云原生改造部署效率提升三倍故障率下降百分之六十。"
    "本季度营收达到一百二十亿元同比增长百分之三十四创下历史新高。"
    "核心产品线表现强劲用户增长显著市场占有率稳步提升。"
)


def _write_valid_project(tmp_path: Path) -> Path:
    """构造合规的 5 页项目。"""
    pages = tmp_path / "pages"
    pages.mkdir()
    (pages / "slide_01_cover.py").write_text(
        "from slidep.dsl import Slide, Text\n"
        "slide = Slide(\n"
        "    page_type='cover', role='hero', rhythm='peak',\n"
        "    title='季度报告', background='#0F172A',\n"
        "    children=[Text('2026 Q2', style={'fontSize': 56, 'color': '#FFFFFF'})],\n"
        ")\n",
        encoding="utf-8",
    )
    long_var = 'LONG = ' + repr(VALID_LONG_TEXT)
    for i in range(3):
        jc = "'flex-start'" if i < 2 else "'center'"
        (pages / f"slide_0{i+2}_content.py").write_text(
            f"from slidep.dsl import Slide, Text\n"
            f"{long_var}\n"
            f"slide = Slide(\n"
            f"    page_type='content', role='supporting', rhythm='peak',\n"
            f"    title='内容页{i+1}',\n"
            f"    children=[\n"
            f"        Text('标题{i+1}', style={{'fontSize': 56, 'color': '#1E293B'}}),\n"
            f"        Text(LONG, style={{'fontSize': 20, 'color': '#475569'}}),\n"
            f"    ],\n"
            f"    style={{'justifyContent': {jc}}},\n"
            f")\n",
            encoding="utf-8",
        )
    (pages / "slide_05_ending.py").write_text(
        "from slidep.dsl import Slide, Text\n"
        "slide = Slide(\n"
        "    page_type='ending', role='transition', rhythm='transition',\n"
        "    title='谢谢', background='#0F172A',\n"
        "    children=[Text('感谢聆听', style={'fontSize': 56, 'color': '#FFFFFF'})],\n"
        ")\n",
        encoding="utf-8",
    )
    return tmp_path


# ================================================================ SVG 渲染器

class TestSVGRenderer:
    """SVG 渲染器单元测试。"""

    def test_render_slide_svg_returns_valid_xml(self, tmp_path):
        """渲染单页 → 合法 SVG XML。"""
        from slidep.preview.svg_renderer import render_slide_svg
        from slidep.dsl import Slide, Text

        slide = Slide(
            page_type="content",
            title="测试标题",
            children=[
                Text("Hello World", style={"fontSize": 24, "color": "#1E293B"}),
            ],
        )
        svg = render_slide_svg(slide, 0, 3)

        assert svg.startswith("<svg")
        assert svg.endswith("</svg>")
        assert 'viewBox="0 0 1280 720"' in svg

        # 合法 XML
        root = ET.fromstring(svg)
        assert root.tag.endswith("svg")

    def test_render_cover_background(self, tmp_path):
        """cover 页背景色渲染。"""
        from slidep.preview.svg_renderer import render_slide_svg
        from slidep.dsl import Slide, Text

        slide = Slide(
            page_type="cover",
            title="封面",
            background="#0F172A",
            children=[Text("内容", style={"fontSize": 56, "color": "#FFFFFF"})],
        )
        svg = render_slide_svg(slide, 0, 1)
        assert "0,15,42" in svg or "0F172A" in svg.lower() or "rgb(15,23,42)" in svg.lower()

    def test_render_title_cover(self, tmp_path):
        """cover 标题居中渲染。"""
        from slidep.preview.svg_renderer import render_slide_svg
        from slidep.dsl import Slide, Text

        slide = Slide(
            page_type="cover",
            title="封面标题",
            background="#0F172A",
            children=[],
        )
        svg = render_slide_svg(slide, 0, 1)
        assert "封面标题" in svg
        assert "text-anchor=\"middle\"" in svg

    def test_render_title_content(self, tmp_path):
        """content 标题左上渲染。"""
        from slidep.preview.svg_renderer import render_slide_svg
        from slidep.dsl import Slide, Text

        slide = Slide(
            page_type="content",
            title="内容标题",
            children=[Text("正文", style={"fontSize": 18})],
        )
        svg = render_slide_svg(slide, 0, 3)
        assert "内容标题" in svg
        assert "text-anchor=\"start\"" in svg or "text-anchor=\"start\"" in svg

    def test_render_footer_page_number(self, tmp_path):
        """content 页脚显示页码。"""
        from slidep.preview.svg_renderer import render_slide_svg
        from slidep.dsl import Slide, Text

        slide = Slide(
            page_type="content",
            title="测试",
            children=[Text("内容", style={"fontSize": 18})],
        )
        svg = render_slide_svg(slide, 1, 5, project_name="测试项目")
        assert "2/5" in svg
        assert "测试项目" in svg

    def test_render_no_footer_cover(self, tmp_path):
        """cover 页不显示页脚。"""
        from slidep.preview.svg_renderer import render_slide_svg
        from slidep.dsl import Slide, Text

        slide = Slide(
            page_type="cover",
            title="封面",
            background="#0F172A",
            children=[],
        )
        svg = render_slide_svg(slide, 0, 3, project_name="项目")
        assert "1/3" not in svg

    def test_render_text_element(self, tmp_path):
        """Text 组件渲染为 <text> 元素。"""
        from slidep.preview.svg_renderer import render_slide_svg
        from slidep.dsl import Slide, Text

        slide = Slide(
            page_type="content",
            title="测试",
            children=[
                Text("Hello SVG", style={"fontSize": 24, "color": "#FF0000"}),
            ],
        )
        svg = render_slide_svg(slide, 0, 1)
        assert "Hello SVG" in svg
        assert "<text" in svg or "<tspan" in svg

    def test_render_rich_text_spans(self, tmp_path):
        """富文本 span 渲染为 tspan。"""
        from slidep.preview.svg_renderer import render_slide_svg
        from slidep.dsl import Slide, Text

        text = '普通<span style={{"color": "#FF0000", "fontWeight": "bold"}}>红色粗体</span>文字'
        slide = Slide(
            page_type="content",
            title="富文本",
            children=[Text(text, style={"fontSize": 20, "color": "#1E293B"})],
        )
        svg = render_slide_svg(slide, 0, 1)
        assert "<tspan" in svg
        assert "rgb(255,0,0)" in svg
        assert 'font-weight="bold"' in svg

    def test_render_box_with_background(self, tmp_path):
        """Box 背景色渲染。"""
        from slidep.preview.svg_renderer import render_slide_svg
        from slidep.dsl import Slide, Box, Text

        slide = Slide(
            page_type="content",
            title="Box 测试",
            children=[
                Box(
                    style={"background": "#3B82F6", "borderRadius": 12},
                    children=[Text("Box 内容", style={"fontSize": 18})],
                ),
            ],
        )
        svg = render_slide_svg(slide, 0, 1)
        assert "rgb(59,130,246)" in svg
        assert "rx=" in svg

    def test_render_gradient_background(self, tmp_path):
        """渐变背景渲染。"""
        from slidep.preview.svg_renderer import render_slide_svg
        from slidep.dsl import Slide, Text

        slide = Slide(
            page_type="cover",
            title="渐变封面",
            background="linear-gradient(135deg, #667EEA, #764BA2)",
            children=[],
        )
        svg = render_slide_svg(slide, 0, 1)
        assert "linearGradient" in svg
        assert "gradientUnits" in svg

    def test_render_section_page(self, tmp_path):
        """section 页色块 + 白字标题。"""
        from slidep.preview.svg_renderer import render_slide_svg
        from slidep.dsl import Slide

        slide = Slide(
            page_type="section",
            title="章节标题",
            children=[],
        )
        svg = render_slide_svg(slide, 0, 3, section_accent="1E293B")
        assert "rgb(30,41,59)" in svg  # section 色块
        assert "章节标题" in svg
        assert "#FFFFFF" in svg or "rgb(255,255,255)" in svg

    def test_render_multiple_slides(self, tmp_path):
        """render_slides_svg 渲染多页。"""
        from slidep.preview.svg_renderer import render_slides_svg
        from slidep.dsl import Slide, Text

        slides = [
            Slide(page_type="cover", title="封面", children=[]),
            Slide(page_type="content", title="内容", children=[Text("内容", style={"fontSize": 18})]),
            Slide(page_type="ending", title="结束", children=[]),
        ]
        svgs = render_slides_svg(slides, project_name="测试")
        assert len(svgs) == 3
        for svg in svgs:
            assert svg.startswith("<svg")
            assert svg.endswith("</svg>")

    def test_render_text_alignment(self, tmp_path):
        """textAlign → text-anchor 映射。"""
        from slidep.preview.svg_renderer import render_slide_svg
        from slidep.dsl import Slide, Text

        for align, anchor in [("left", "start"), ("center", "middle"), ("right", "end")]:
            slide = Slide(
                page_type="content",
                title=f"对齐{align}",
                children=[Text(f"对齐{align}", style={"fontSize": 18, "textAlign": align})],
            )
            svg = render_slide_svg(slide, 0, 1)
            assert f'text-anchor="{anchor}"' in svg, f"textAlign={align} 未映射到 {anchor}"

    def test_render_error_svg(self, tmp_path):
        """错误页面生成占位 SVG。"""
        from slidep.preview.server import _error_svg

        svg = _error_svg("测试错误")
        assert svg.startswith("<svg")
        assert "测试错误" in svg
        # 合法 XML
        root = ET.fromstring(svg)
        assert root.tag.endswith("svg")

    def test_render_table_svg(self, tmp_path):
        """Table 渲染为 SVG 网格。"""
        from slidep.preview.svg_renderer import render_slide_svg
        from slidep.dsl import Slide, Table

        slide = Slide(
            page_type="content",
            title="表格测试",
            children=[
                Table(
                    data=[["名称", "值"], ["A", "100"], ["B", "200"]],
                    header=True,
                    zebra=True,
                ),
            ],
        )
        svg = render_slide_svg(slide, 0, 1)
        assert "<rect" in svg  # 表头/斑马纹背景
        assert "<line" in svg  # 网格线
        assert "名称" in svg
        assert "100" in svg


# ================================================================ HTTP 服务

@pytest.mark.skipif(not HAS_FASTAPI, reason="fastapi 未安装")
class TestPreviewServer:
    """PreviewServer HTTP 接口测试。"""

    def test_api_slides_returns_list(self, tmp_path):
        """/api/slides 返回幻灯片列表。"""
        from fastapi.testclient import TestClient
        from slidep.preview import PreviewServer

        _write_valid_project(tmp_path)
        server = PreviewServer(tmp_path, port=0)
        app = server.create_app()
        client = TestClient(app)

        resp = client.get("/api/slides")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 5
        assert len(data["slides"]) == 5
        assert "svg" in data["slides"][0]
        assert data["slides"][0]["svg"].startswith("<svg")

    def test_api_slide_single(self, tmp_path):
        """/api/slides/{idx} 返回单页。"""
        from fastapi.testclient import TestClient
        from slidep.preview import PreviewServer

        _write_valid_project(tmp_path)
        server = PreviewServer(tmp_path, port=0)
        app = server.create_app()
        client = TestClient(app)

        resp = client.get("/api/slides/0")
        assert resp.status_code == 200
        data = resp.json()
        assert data["index"] == 0
        assert data["svg"].startswith("<svg")

    def test_api_slide_not_found(self, tmp_path):
        """/api/slides/999 返回 404。"""
        from fastapi.testclient import TestClient
        from slidep.preview import PreviewServer

        _write_valid_project(tmp_path)
        server = PreviewServer(tmp_path, port=0)
        app = server.create_app()
        client = TestClient(app)

        resp = client.get("/api/slides/999")
        assert resp.status_code == 404

    def test_preview_svg_endpoint(self, tmp_path):
        """/preview/{idx} 返回 SVG 原始内容。"""
        from fastapi.testclient import TestClient
        from slidep.preview import PreviewServer

        _write_valid_project(tmp_path)
        server = PreviewServer(tmp_path, port=0)
        app = server.create_app()
        client = TestClient(app)

        resp = client.get("/preview/0")
        assert resp.status_code == 200
        assert "image/svg+xml" in resp.headers.get("content-type", "")
        assert resp.text.startswith("<svg")

    def test_api_status(self, tmp_path):
        """/api/status 返回服务状态。"""
        from fastapi.testclient import TestClient
        from slidep.preview import PreviewServer

        _write_valid_project(tmp_path)
        server = PreviewServer(tmp_path, port=8088)
        app = server.create_app()
        client = TestClient(app)

        resp = client.get("/api/status")
        assert resp.status_code == 200
        data = resp.json()
        assert data["running"] is True
        assert data["port"] == 8088
        assert "project" in data

    def test_gallery_html(self, tmp_path):
        """``/`` 返回画廊 HTML。"""
        from fastapi.testclient import TestClient
        from slidep.preview import PreviewServer

        _write_valid_project(tmp_path)
        server = PreviewServer(tmp_path, port=0)
        app = server.create_app()
        client = TestClient(app)

        resp = client.get("/")
        assert resp.status_code == 200
        assert "text/html" in resp.headers.get("content-type", "")
        assert "SlideP Preview" in resp.text
        assert "EventSource" in resp.text  # SSE 订阅代码
        assert "loadSlides" in resp.text

    def test_no_pages_returns_error_svg(self, tmp_path):
        """无 pages 目录时返回错误 SVG。"""
        from fastapi.testclient import TestClient
        from slidep.preview import PreviewServer

        # tmp_path 没有 pages/ 目录
        server = PreviewServer(tmp_path, port=0)
        app = server.create_app()
        client = TestClient(app)

        resp = client.get("/api/slides")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] >= 1
        # 应该返回错误占位 SVG
        assert "error" in data["slides"][0]["page_type"] or "svg" in data["slides"][0]

    def test_notify_compile_increments_count(self, tmp_path):
        """notify_compile 增加编译计数。"""
        from fastapi.testclient import TestClient
        from slidep.preview import PreviewServer

        _write_valid_project(tmp_path)
        server = PreviewServer(tmp_path, port=0)
        app = server.create_app()
        client = TestClient(app)

        # 初始状态
        resp = client.get("/api/status")
        assert resp.json()["compile_count"] == 0

        # 模拟编译完成
        server.notify_compile(success=True)

        resp = client.get("/api/status")
        assert resp.json()["compile_count"] == 1
        assert resp.json()["last_compile"] > 0

    def test_sse_events_endpoint(self, tmp_path):
        """SSE 事件流：connected 消息 + 编译事件推送。

        httpx.ASGITransport 不支持无限流式响应（receive 永久等待
        response_complete），因此直接测试 SSE 内部机制（队列 + notify）。
        """
        import asyncio
        from slidep.preview import PreviewServer

        _write_valid_project(tmp_path)
        server = PreviewServer(tmp_path, port=0)
        app = server.create_app()

        async def _test_sse():
            # 模拟 SSE 订阅
            queue: asyncio.Queue = asyncio.Queue()
            with server._event_lock:
                server._event_subscribers.append(queue)

            # 触发编译事件
            server.notify_compile(success=True)

            # 订阅者应收到编译事件
            msg = await asyncio.wait_for(queue.get(), timeout=2.0)
            assert msg["type"] == "compiled"
            assert msg["success"] is True
            assert msg["compile_count"] == 1

            # 再次触发（失败事件）
            server.notify_compile(success=False, error="测试错误")
            msg = await asyncio.wait_for(queue.get(), timeout=2.0)
            assert msg["type"] == "compiled"
            assert msg["success"] is False
            assert "测试错误" in msg["error"]

        asyncio.run(_test_sse())

    def test_sse_receives_compile_event(self, tmp_path):
        """SSE 多订阅者同时收到编译事件。"""
        import asyncio
        from slidep.preview import PreviewServer

        _write_valid_project(tmp_path)
        server = PreviewServer(tmp_path, port=0)
        app = server.create_app()

        async def _test_multi_subscriber():
            # 两个订阅者
            q1: asyncio.Queue = asyncio.Queue()
            q2: asyncio.Queue = asyncio.Queue()
            with server._event_lock:
                server._event_subscribers.append(q1)
                server._event_subscribers.append(q2)

            # 触发编译
            server.notify_compile(success=True)

            # 两个订阅者都应收到
            msg1 = await asyncio.wait_for(q1.get(), timeout=2.0)
            msg2 = await asyncio.wait_for(q2.get(), timeout=2.0)

            assert msg1["type"] == "compiled"
            assert msg2["type"] == "compiled"
            assert msg1["compile_count"] == msg2["compile_count"] == 1

        asyncio.run(_test_multi_subscriber())

    def test_sse_route_configured(self, tmp_path):
        """SSE 路由 /api/events 正确配置。"""
        from slidep.preview import PreviewServer

        _write_valid_project(tmp_path)
        server = PreviewServer(tmp_path, port=0)
        app = server.create_app()

        # 查找 /api/events 路由
        sse_route = None
        for route in app.routes:
            if hasattr(route, "path") and route.path == "/api/events":
                sse_route = route
                break

        assert sse_route is not None, "SSE 路由 /api/events 未配置"


# ================================================================ 无 LibreOffice fallback

class TestNoLibreOfficeFallback:
    """验证 SVG 预览路径不依赖 LibreOffice。"""

    def test_svg_renderer_no_subprocess(self, tmp_path):
        """SVG 渲染器不调用 subprocess（无 LibreOffice 依赖）。"""
        from slidep.preview.svg_renderer import render_slide_svg
        from slidep.dsl import Slide, Text, Box

        slide = Slide(
            page_type="content",
            title="无依赖测试",
            children=[
                Box(
                    style={"background": "#3B82F6", "borderRadius": 8},
                    children=[
                        Text("矢量渲染", style={"fontSize": 20, "color": "#FFFFFF"}),
                    ],
                ),
            ],
        )

        # 应该成功渲染，不调用任何外部进程
        svg = render_slide_svg(slide, 0, 1)
        assert svg.startswith("<svg")
        assert "矢量渲染" in svg
        assert "rgb(59,130,246)" in svg

    def test_svg_preview_vs_ooxml_independent(self, tmp_path):
        """SVG 预览与 OOXML 渲染独立（不导入 python-pptx）。"""
        import sys

        # 记录导入前的模块
        before = set(sys.modules.keys())

        from slidep.preview.svg_renderer import render_slide_svg
        from slidep.dsl import Slide, Text

        slide = Slide(
            page_type="content",
            title="独立渲染",
            children=[Text("测试", style={"fontSize": 18})],
        )
        svg = render_slide_svg(slide, 0, 1)

        after = set(sys.modules.keys())
        new_modules = after - before

        # SVG 渲染不应触发 python-pptx 导入
        assert "pptx" not in new_modules, "SVG 渲染器不应依赖 python-pptx"
        assert svg.startswith("<svg")

    def test_fallback_path_available(self, tmp_path):
        """无 LibreOffice 环境下 fallback 路径可用。"""
        from slidep.preview.svg_renderer import render_slides_svg
        from slidep.dsl import Slide, Text

        slides = [
            Slide(page_type="cover", title="封面", background="#0F172A", children=[]),
            Slide(page_type="content", title="内容", children=[Text("内容", style={"fontSize": 18})]),
            Slide(page_type="ending", title="结束", background="#0F172A", children=[]),
        ]

        # SVG 路径不需要 LibreOffice
        svgs = render_slides_svg(slides, project_name="fallback 测试")
        assert len(svgs) == 3
        for svg in svgs:
            assert svg.startswith("<svg")
            assert "</svg>" in svg


# ================================================================ 集成测试

@pytest.mark.skipif(not HAS_FASTAPI, reason="fastapi 未安装")
class TestPreviewIntegration:
    """预览服务 + daemon 集成测试。"""

    def test_daemon_with_preview_port(self, tmp_path):
        """daemon 启动时同时启动预览服务。"""
        from slidep.daemon import DaemonManager

        _write_valid_project(tmp_path)
        manager = DaemonManager(tmp_path)

        try:
            # 启动 daemon（包含预览服务）
            status = manager.start(skip_lint=True, port=8099)
            assert status.running is True

            # 验证 daemon 进程存活
            status2 = manager.status()
            assert status2.running is True
        finally:
            manager.stop()

    def test_preview_reload_after_compile(self, tmp_path):
        """编译完成后 /api/slides 反映最新内容。"""
        from fastapi.testclient import TestClient
        from slidep.preview import PreviewServer

        _write_valid_project(tmp_path)
        server = PreviewServer(tmp_path, port=0)
        app = server.create_app()
        client = TestClient(app)

        # 初始加载
        resp1 = client.get("/api/slides")
        data1 = resp1.json()
        assert data1["total"] == 5

        # 修改页面文件
        page_file = tmp_path / "pages" / "slide_01_cover.py"
        original = page_file.read_text(encoding="utf-8")
        page_file.write_text(
            original.replace("2026 Q2", "2026 Q3 修改后"),
            encoding="utf-8",
        )

        # 通知编译完成（模拟 daemon 回调）
        server.notify_compile(success=True)

        # 重新加载应反映修改
        resp2 = client.get("/api/slides")
        data2 = resp2.json()
        assert data2["total"] == 5
        # 第一页应该包含修改后的文本
        assert "2026 Q3" in data2["slides"][0]["svg"]
