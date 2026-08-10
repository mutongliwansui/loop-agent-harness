"""预览 HTTP 服务（T4.2）：FastAPI + SSE 实时推送。

端点：
- ``GET /``                 → 画廊 HTML 页面（内嵌 JS 订阅 SSE 自动刷新）
- ``GET /api/slides``       → JSON: 幻灯片列表 + SVG 预览
- ``GET /api/slides/{idx}`` → JSON: 单页 SVG
- ``GET /api/status``       → JSON: daemon 状态 + 编译计数
- ``GET /api/events``       → SSE: 编译完成事件流（自动刷新通知）
- ``GET /preview/{idx}``    → 单页 SVG（image/svg+xml，可独立访问）

设计：
- 服务在 daemon 子进程内运行（``PreviewServer.run()`` 阻塞）
- 页面加载从 ``pages/`` 目录即时渲染 SVG（不依赖 .pptx 文件）
- 编译事件通过 SSE 推送到浏览器，前端收到后重新拉取 SVG
- 无 LibreOffice 依赖（纯 SVG 矢量预览，速度更快）
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path
from typing import Any, Optional

from slidep.cli.loader import load_pages
from slidep.logging_setup import get_logger

log = get_logger("preview.server")


class PreviewServer:
    """预览 HTTP 服务。

    用法：
        server = PreviewServer(project_dir, port=8000)
        server.run()  # 阻塞运行
    """

    def __init__(
        self,
        project_dir: str | Path,
        port: int = 8000,
        *,
        skip_lint: bool = True,
        project_name: str = "",
    ) -> None:
        self._project = Path(project_dir).resolve()
        self._port = port
        self._skip_lint = skip_lint
        self._project_name = project_name or self._project.name

        # 编译事件通知（供 SSE）
        self._event_subscribers: list[asyncio.Queue] = []
        self._event_lock = threading.Lock()
        self._last_compile_time: float = 0.0
        self._compile_count: int = 0

        # FastAPI app（延迟创建）
        self._app = None
        self._server = None

    @property
    def port(self) -> int:
        return self._port

    @property
    def project_dir(self) -> Path:
        return self._project

    def create_app(self):
        """创建 FastAPI 应用（延迟导入，避免未安装 fastapi 时模块加载失败）。"""
        if self._app is not None:
            return self._app

        from fastapi import FastAPI, Response
        from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse

        app = FastAPI(title="SlideP Preview", docs_url="/api/docs")

        # ---- 画廊 HTML ----
        @app.get("/", response_class=HTMLResponse)
        async def gallery():
            return _gallery_html(self._port)

        # ---- 幻灯片列表 ----
        @app.get("/api/slides")
        async def api_slides():
            slides_data = self._render_slides()
            return JSONResponse({
                "total": len(slides_data),
                "project": self._project_name,
                "slides": slides_data,
                "compile_count": self._compile_count,
                "last_compile": self._last_compile_time,
            })

        # ---- 单页 SVG ----
        @app.get("/api/slides/{idx}")
        async def api_slide(idx: int):
            slides_data = self._render_slides()
            if idx < 0 or idx >= len(slides_data):
                return JSONResponse({"error": f"页码超出范围: {idx}"}, status_code=404)
            return JSONResponse(slides_data[idx])

        # ---- 单页 SVG 原始内容 ----
        @app.get("/preview/{idx}")
        async def preview_svg(idx: int):
            slides_data = self._render_slides()
            if idx < 0 or idx >= len(slides_data):
                return Response("Not Found", status_code=404, media_type="text/plain")
            svg = slides_data[idx]["svg"]
            return Response(svg, media_type="image/svg+xml")

        # ---- 状态 ----
        @app.get("/api/status")
        async def api_status():
            return JSONResponse({
                "running": True,
                "project": str(self._project),
                "port": self._port,
                "compile_count": self._compile_count,
                "last_compile": self._last_compile_time,
            })

        # ---- SSE 事件流 ----
        @app.get("/api/events")
        async def api_events():
            queue: asyncio.Queue = asyncio.Queue()

            # 注册订阅者
            with self._event_lock:
                self._event_subscribers.append(queue)

            async def event_stream():
                try:
                    # 初始连接发送 hello
                    yield f"data: {json.dumps({'type': 'connected', 'compile_count': self._compile_count})}\n\n"

                    while True:
                        try:
                            msg = await asyncio.wait_for(queue.get(), timeout=15.0)
                            yield f"data: {json.dumps(msg)}\n\n"
                        except asyncio.TimeoutError:
                            # 心跳
                            yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"
                finally:
                    with self._event_lock:
                        if queue in self._event_subscribers:
                            self._event_subscribers.remove(queue)

            return StreamingResponse(
                event_stream(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                },
            )

        self._app = app
        return app

    def notify_compile(self, success: bool, error: Optional[str] = None) -> None:
        """通知所有 SSE 订阅者编译完成（daemon 编译后调用）。"""
        self._compile_count += 1
        self._last_compile_time = time.time()
        msg = {
            "type": "compiled",
            "success": success,
            "error": error,
            "compile_count": self._compile_count,
            "timestamp": self._last_compile_time,
        }
        with self._event_lock:
            for queue in self._event_subscribers:
                try:
                    queue.put_nowait(msg)
                except asyncio.QueueFull:
                    pass

    def _render_slides(self) -> list[dict[str, Any]]:
        """加载页面 → 渲染 SVG 列表。"""
        from slidep.preview.svg_renderer import render_slides_svg

        try:
            slides = load_pages(self._project)
            svgs = render_slides_svg(slides, project_name=self._project_name)
            return [
                {
                    "index": i,
                    "page_type": slide.page_type,
                    "title": slide.title or "",
                    "svg": svg,
                }
                for i, (slide, svg) in enumerate(zip(slides, svgs))
            ]
        except Exception as e:  # noqa: BLE001
            log.error_ctx(f"预览渲染失败: {e}")
            return [
                {
                    "index": 0,
                    "page_type": "error",
                    "title": "渲染错误",
                    "svg": _error_svg(str(e)),
                }
            ]

    def run(self) -> None:
        """阻塞运行 uvicorn 服务。"""
        import uvicorn

        app = self.create_app()
        config = uvicorn.Config(
            app,
            host="0.0.0.0",
            port=self._port,
            log_level="warning",
            access_log=False,
        )
        self._server = uvicorn.Server(config)
        log.info_ctx(f"预览服务启动: http://localhost:{self._port}")
        self._server.run()

    def stop(self) -> None:
        """停止服务。"""
        if self._server is not None:
            self._server.should_exit = True
            self._server = None
            log.info_ctx("预览服务已停止")


# ================================================================ 画廊 HTML

def _gallery_html(port: int) -> str:
    """画廊 HTML 页面（内嵌 CSS + JS）。"""
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SlideP Preview</title>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0F172A; color: #E2E8F0; }}
  .header {{ position: fixed; top: 0; left: 0; right: 0; height: 56px; background: #1E293B; display: flex; align-items: center; padding: 0 24px; z-index: 100; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }}
  .header h1 {{ font-size: 18px; font-weight: 600; }}
  .header .status {{ margin-left: auto; font-size: 13px; color: #94A3B8; display: flex; align-items: center; gap: 8px; }}
  .header .dot {{ width: 8px; height: 8px; border-radius: 50%; background: #10B981; }}
  .header .dot.compiling {{ background: #F59E0B; animation: pulse 1s infinite; }}
  .header .dot.error {{ background: #EF4444; }}
  @keyframes pulse {{ 0%,100% {{ opacity: 1; }} 50% {{ opacity: 0.4; }} }}
  .gallery {{ padding: 80px 24px 24px; display: flex; flex-direction: column; gap: 24px; max-width: 1400px; margin: 0 auto; }}
  .slide-card {{ background: #1E293B; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.2); }}
  .slide-card .meta {{ padding: 12px 16px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #334155; }}
  .slide-card .meta .idx {{ font-size: 14px; font-weight: 600; color: #60A5FA; min-width: 32px; }}
  .slide-card .meta .type {{ font-size: 11px; padding: 2px 8px; border-radius: 4px; background: #334155; color: #94A3B8; }}
  .slide-card .meta .title {{ font-size: 14px; color: #CBD5E1; flex: 1; }}
  .slide-card .meta .fullscreen {{ cursor: pointer; font-size: 13px; color: #60A5FA; padding: 4px 8px; border-radius: 4px; }}
  .slide-card .meta .fullscreen:hover {{ background: #334155; }}
  .slide-card svg {{ width: 100%; height: auto; display: block; background: white; }}
  .empty {{ text-align: center; padding: 80px; color: #64748B; }}
  .refreshing {{ opacity: 0.6; transition: opacity 0.3s; }}
</style>
</head>
<body>
<div class="header">
  <h1>SlideP Preview</h1>
  <div class="status">
    <span class="dot" id="statusDot"></span>
    <span id="statusText">就绪</span>
  </div>
</div>
<div class="gallery" id="gallery">
  <div class="empty">加载中...</div>
</div>
<script>
let slidesData = [];
let eventSource = null;

// ---- 加载幻灯片 ----
async function loadSlides() {{
  try {{
    const resp = await fetch('/api/slides');
    const data = await resp.json();
    slidesData = data.slides || [];
    renderGallery();
    updateStatus('就绪', 'ok');
  }} catch (e) {{
    updateStatus('加载失败', 'error');
    document.getElementById('gallery').innerHTML = '<div class="empty">加载失败: ' + e.message + '</div>';
  }}
}}

// ---- 渲染画廊 ----
function renderGallery() {{
  const gallery = document.getElementById('gallery');
  if (slidesData.length === 0) {{
    gallery.innerHTML = '<div class="empty">暂无幻灯片，请检查 pages/ 目录</div>';
    return;
  }}
  gallery.innerHTML = slidesData.map((s, i) => `
    <div class="slide-card" id="slide-${{i}}">
      <div class="meta">
        <span class="idx">${{i + 1}}</span>
        <span class="type">${{s.page_type || 'unknown'}}</span>
        <span class="title">${{s.title || ''}}</span>
        <span class="fullscreen" onclick="fullscreen(${{i}})">全屏</span>
      </div>
      ${{s.svg || ''}}
    </div>
  `).join('');
}}

// ---- 全屏 ----
function fullscreen(idx) {{
  const slide = slidesData[idx];
  if (!slide) return;
  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html><head><title>Slide ${{idx + 1}}</title><style>body{{margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh;}}svg{{max-width:100vw;max-height:100vh;}}</style></head><body>${{slide.svg}}</body></html>`);
  w.document.close();
}}

// ---- 状态指示 ----
function updateStatus(text, state) {{
  const dot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  dot.className = 'dot' + (state === 'compiling' ? ' compiling' : state === 'error' ? ' error' : '');
  statusText.textContent = text;
}}

// ---- SSE 订阅 ----
function connectSSE() {{
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events');
  eventSource.onmessage = async (e) => {{
    const msg = JSON.parse(e.data);
    if (msg.type === 'compiled') {{
      if (msg.success) {{
        updateStatus('编译成功，刷新中...', 'compiling');
        // 重新加载幻灯片
        await loadSlides();
        updateStatus('就绪 (编译 #' + msg.compile_count + ')', 'ok');
      }} else {{
        updateStatus('编译失败: ' + (msg.error || ''), 'error');
      }}
    }}
  }};
  eventSource.onerror = () => {{
    updateStatus('连接断开，重连中...', 'error');
    setTimeout(connectSSE, 3000);
  }};
}}

// ---- 初始化 ----
(async () => {{
  await loadSlides();
  connectSSE();
}})();
</script>
</body>
</html>"""


def _error_svg(msg: str) -> str:
    """错误占位 SVG。"""
    from xml.sax.saxutils import escape

    escaped = escape(msg[:200])
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">'
        f'<rect width="1280" height="720" fill="#FEF2F2"/>'
        f'<text x="640" y="360" font-size="24" font-family="sans-serif" '
        f'text-anchor="middle" dominant-baseline="central" fill="#DC2626">'
        f'渲染错误: {escaped}</text></svg>'
    )
