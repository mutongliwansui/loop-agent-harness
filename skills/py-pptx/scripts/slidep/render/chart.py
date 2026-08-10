"""图表渲染器：python-pptx 原生图表 API + matplotlib PNG 预览。

PPTX 输出使用 python-pptx 原生图表 API（``add_native_chart``），生成可在 PowerPoint 中编辑的图表。
SVG 预览保留 matplotlib 渲染（``render_chart_png``），因为预览不需要可编辑性。
matplotlib 为可选依赖：未安装时 add_native_chart 正常工作，render_chart_png 报错。

支持 5 种图表类型：barChart / lineChart / pieChart / areaChart / scatterChart
"""

from __future__ import annotations

from typing import Optional

from pptx.chart.data import CategoryChartData, XyChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION, XL_LABEL_POSITION
from pptx.util import Pt

from slidep import ErrorCode, SlidepUserError, render_error

#: 默认主题色板（对标 design-principle.md 辅色 + 强调色）
DEFAULT_PALETTE = ["#0EA5E9", "#F59E0B", "#10B981", "#8B5CF6", "#EF4444", "#6366F1"]

#: DSL chart_type → python-pptx XL_CHART_TYPE 映射
_CHART_TYPE_MAP: dict[str, XL_CHART_TYPE] = {
    "barChart": XL_CHART_TYPE.COLUMN_CLUSTERED,
    "lineChart": XL_CHART_TYPE.LINE_MARKERS,
    "pieChart": XL_CHART_TYPE.PIE,
    "areaChart": XL_CHART_TYPE.AREA,
    "scatterChart": XL_CHART_TYPE.XY_SCATTER,
}


def _hex_to_rgb(hex_str: str) -> RGBColor:
    """hex 字符串 → RGBColor。"""
    h = hex_str.lstrip("#")
    return RGBColor(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


# ================================================================ 原生图表 API

def add_native_chart(
    pptx_slide,
    chart_type: str,
    data: list[list],
    x: int,
    y: int,
    cx: int,
    cy: int,
    palette: Optional[list[str]] = None,
    title: Optional[str] = None,
) -> None:
    """在 pptx_slide 上添加原生可编辑图表。

    Args:
        pptx_slide: python-pptx Slide 对象
        chart_type: 图表类型（barChart/lineChart/pieChart/areaChart/scatterChart）
        data: 二维数组，首行表头，首列分类轴
        x, y: 图表左上角位置（EMU）
        cx, cy: 图表宽高（EMU）
        palette: 自定义色板（hex 列表），缺省用 DEFAULT_PALETTE
        title: 图表标题
    """
    if chart_type not in _CHART_TYPE_MAP:
        raise render_error(
            ErrorCode.RENDER_OOXML_FAILED,
            reason=f"未知图表类型: {chart_type}",
        )

    if not data or len(data) < 2:
        raise render_error(
            ErrorCode.RENDER_OOXML_FAILED,
            reason=f"图表数据不合法：至少需要 2 行，实际 {len(data) if data else 0} 行",
        )

    xl_type = _CHART_TYPE_MAP[chart_type]
    colors = palette or DEFAULT_PALETTE
    headers = data[0]
    categories = [str(r[0]) for r in data[1:]]
    series_names = [str(h) for h in headers[1:]]

    if chart_type == "scatterChart":
        chart_data = _build_xy_data(data, series_names)
    else:
        chart_data = _build_category_data(data, categories, series_names)

    graphic_frame = pptx_slide.shapes.add_chart(
        xl_type, x, y, cx, cy, chart_data
    )
    chart = graphic_frame.chart

    if title:
        chart.has_title = True
        chart.chart_title.text_frame.text = title
    else:
        chart.has_title = False

    if chart_type == "pieChart":
        chart.has_legend = True
        chart.legend.position = XL_LEGEND_POSITION.RIGHT
        chart.legend.include_in_layout = False
    elif len(series_names) > 1:
        chart.has_legend = True
        chart.legend.position = XL_LEGEND_POSITION.BOTTOM
        chart.legend.include_in_layout = False
    else:
        chart.has_legend = False

    _apply_data_labels(chart, chart_type)
    _apply_series_colors(chart, colors, chart_type)
    _style_axes(chart, chart_type)


def _build_category_data(
    data: list[list],
    categories: list[str],
    series_names: list[str],
) -> CategoryChartData:
    """构建 CategoryChartData（柱/折/饼/面积图）。"""
    chart_data = CategoryChartData()
    chart_data.categories = categories
    for i, name in enumerate(series_names):
        values = [float(r[i + 1]) for r in data[1:]]
        chart_data.add_series(name, values)
    return chart_data


def _build_xy_data(
    data: list[list],
    series_names: list[str],
) -> XyChartData:
    """构建 XyChartData（散点图），x 轴为分类索引。"""
    chart_data = XyChartData()
    for i, name in enumerate(series_names):
        series = chart_data.add_series(name)
        for j, row in enumerate(data[1:]):
            series.add_data_point(j, float(row[i + 1]))
    return chart_data


def _apply_data_labels(chart, chart_type: str) -> None:
    """配置数据标签。"""
    if chart_type == "scatterChart":
        return

    plot = chart.plots[0]
    plot.has_data_labels = True
    data_labels = plot.data_labels
    data_labels.number_format = "0.0"
    data_labels.number_format_is_linked = False

    if chart_type == "pieChart":
        data_labels.show_percentage = True
        data_labels.show_value = False
        data_labels.show_category_name = False
    else:
        data_labels.show_value = True
        data_labels.show_percentage = False
        if chart_type == "barChart":
            data_labels.position = XL_LABEL_POSITION.OUTSIDE_END
        elif chart_type == "lineChart":
            data_labels.position = XL_LABEL_POSITION.ABOVE


def _apply_series_colors(chart, colors: list[str], chart_type: str) -> None:
    """设置系列颜色。"""
    if chart_type == "pieChart":
        plot = chart.plots[0]
        series = plot.series[0]
        for i, point in enumerate(series.points):
            color = colors[i % len(colors)]
            point.format.fill.solid()
            point.format.fill.fore_color.rgb = _hex_to_rgb(color)
    else:
        for i, series in enumerate(chart.series):
            color = colors[i % len(colors)]
            series.format.fill.solid()
            series.format.fill.fore_color.rgb = _hex_to_rgb(color)


def _style_axes(chart, chart_type: str) -> None:
    """美化坐标轴样式。"""
    if chart_type == "pieChart":
        return

    gray = RGBColor(0x64, 0x74, 0x8B)

    if chart_type == "scatterChart":
        axes = [chart.category_axis, chart.value_axis]
    else:
        axes = [chart.category_axis, chart.value_axis]

    for axis in axes:
        axis.tick_labels.font.size = Pt(9)
        axis.tick_labels.font.color.rgb = gray

    chart.value_axis.has_major_gridlines = True


# ================================================================ matplotlib PNG 预览

_CJK_FONT_CANDIDATES = {
    "Windows": ["Microsoft YaHei", "SimHei", "SimSun"],
    "Darwin": ["Arial Unicode MS", "PingFang SC", "Heiti SC", "STHeiti"],
    "Linux": ["Noto Sans CJK SC", "WenQuanYi Micro Hei", "WenQuanYi Zen Hei", "Droid Sans Fallback"],
}

_cjk_initialized = False
_cjk_font_name: Optional[str] = None


def _init_cjk_font():
    """注册中文字体，返回可用字体名。仅初始化一次。"""
    global _cjk_initialized, _cjk_font_name
    if _cjk_initialized:
        return _cjk_font_name

    import platform

    import matplotlib.pyplot as plt
    from matplotlib import font_manager as fm

    system = platform.system()
    candidates = _CJK_FONT_CANDIDATES.get(system, _CJK_FONT_CANDIDATES["Linux"])
    available = {f.name for f in fm.fontManager.ttflist}
    for name in candidates:
        if name in available:
            plt.rcParams["font.sans-serif"] = [name] + plt.rcParams.get("font.sans-serif", [])
            plt.rcParams["axes.unicode_minus"] = False
            _cjk_font_name = name
            break
    _cjk_initialized = True
    return _cjk_font_name


def render_chart_png(
    chart_type: str,
    data: list[list],
    width_px: float,
    height_px: float,
    palette: Optional[list[str]] = None,
    title: Optional[str] = None,
) -> bytes:
    """渲染图表为 PNG bytes（仅用于 SVG 预览）。

    Args:
        chart_type: 图表类型（barChart/lineChart/pieChart/areaChart/scatterChart）
        data: 二维数组，首行表头，首列分类轴
        width_px: 目标宽度（px）
        height_px: 目标高度（px）
        palette: 自定义色板（hex 列表），缺省用 DEFAULT_PALETTE
        title: 图表标题

    Returns:
        PNG 图片字节流

    Raises:
        SlidepUserError: matplotlib 未安装时报错
    """
    import io

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import numpy as np
        from matplotlib.colors import to_rgba
    except ImportError:
        raise render_error(
            ErrorCode.RENDER_OOXML_FAILED,
            reason="matplotlib 未安装，图表预览不可用。请安装：pip install matplotlib",
        )

    _init_cjk_font()

    if not data or len(data) < 2:
        raise render_error(
            ErrorCode.RENDER_OOXML_FAILED,
            reason=f"图表数据不合法：至少需要 2 行，实际 {len(data) if data else 0} 行",
        )

    colors = palette or DEFAULT_PALETTE
    headers = data[0]
    rows = data[1:]
    categories = [str(r[0]) for r in rows]
    series_count = len(headers) - 1
    values: list[list[float]] = []
    for c in range(series_count):
        col_vals = [float(r[c + 1]) for r in rows]
        values.append(col_vals)

    dpi = 150
    fig_w = max(width_px / dpi, 2.0)
    fig_h = max(height_px / dpi, 1.5)

    if chart_type == "pieChart":
        side = min(fig_w, fig_h)
        fig, ax = plt.subplots(figsize=(side, side), dpi=dpi)
    else:
        fig, ax = plt.subplots(figsize=(fig_w, fig_h), dpi=dpi)

    fig.patch.set_alpha(0)
    ax.set_facecolor("none")

    try:
        if chart_type == "barChart":
            _render_bar(ax, categories, values, headers, colors)
        elif chart_type == "lineChart":
            _render_line(ax, categories, values, headers, colors)
        elif chart_type == "pieChart":
            _render_pie(ax, categories, values, colors)
        elif chart_type == "areaChart":
            _render_area(ax, categories, values, headers, colors)
        elif chart_type == "scatterChart":
            _render_scatter(ax, categories, values, headers, colors)
        else:
            raise render_error(
                ErrorCode.RENDER_OOXML_FAILED,
                reason=f"未知图表类型: {chart_type}",
            )

        if title:
            ax.set_title(title, fontsize=14, color="#1E293B", pad=12)

        _style_mpl_axes(ax, chart_type)

        buf = io.BytesIO()
        fig.savefig(buf, format="png", transparent=True, bbox_inches="tight", pad_inches=0.08)
        plt.close(fig)
        buf.seek(0)
        return buf.getvalue()
    except SlidepUserError:
        plt.close(fig)
        raise
    except Exception as exc:  # noqa: BLE001
        plt.close(fig)
        raise render_error(
            ErrorCode.RENDER_OOXML_FAILED,
            reason=f"图表渲染失败 ({chart_type}): {exc}",
        ) from exc


def _render_bar(ax, categories, values, headers, colors):
    """柱状图（clustered）。"""
    import numpy as np
    x = np.arange(len(categories))
    n = len(values)
    bar_width = 0.8 / max(n, 1)
    for i, (vals, label) in enumerate(zip(values, headers[1:])):
        offset = (i - n / 2 + 0.5) * bar_width
        color = colors[i % len(colors)]
        bars = ax.bar(x + offset, vals, bar_width, label=label, color=color, edgecolor="white", linewidth=0.5)
        for bar in bars:
            h = bar.get_height()
            if h != 0:
                ax.text(
                    bar.get_x() + bar.get_width() / 2, h,
                    f"{h:g}", ha="center", va="bottom" if h > 0 else "top",
                    fontsize=10, color="#475569",
                )
    ax.set_xticks(x)
    ax.set_xticklabels(categories, fontsize=9)
    if n > 1:
        ax.legend(fontsize=9, framealpha=0.8)


def _render_line(ax, categories, values, headers, colors):
    """折线图。"""
    x = list(range(len(categories)))
    for i, (vals, label) in enumerate(zip(values, headers[1:])):
        color = colors[i % len(colors)]
        ax.plot(x, vals, marker="o", markersize=5, label=label, color=color, linewidth=2)
        for j, v in enumerate(vals):
            ax.text(j, v, f"{v:g}", ha="center", va="bottom", fontsize=10, color="#475569")
    ax.set_xticks(x)
    ax.set_xticklabels(categories, fontsize=9)
    if len(values) > 1:
        ax.legend(fontsize=9, framealpha=0.8)


def _render_pie(ax, categories, values, colors):
    """饼图（单系列，显示百分比）。"""
    vals = values[0]
    pie_colors = [colors[i % len(colors)] for i in range(len(vals))]
    wedges, texts, autotexts = ax.pie(
        vals,
        labels=categories,
        autopct="%1.1f%%",
        colors=pie_colors,
        startangle=90,
        textprops={"fontsize": 9, "color": "#1E293B"},
        pctdistance=0.65,
        wedgeprops={"edgecolor": "white", "linewidth": 1.5},
    )
    for t in autotexts:
        t.set_color("#FFFFFF")
        t.set_fontsize(8)
        t.set_fontweight("bold")
    ax.set_aspect("equal")


def _render_area(ax, categories, values, headers, colors):
    """面积图。"""
    from matplotlib.colors import to_rgba
    x = list(range(len(categories)))
    for i, (vals, label) in enumerate(zip(values, headers[1:])):
        color = colors[i % len(colors)]
        rgba = to_rgba(color, alpha=0.35)
        ax.fill_between(x, vals, color=rgba, label=label)
        ax.plot(x, vals, color=color, linewidth=1.5)
    ax.set_xticks(x)
    ax.set_xticklabels(categories, fontsize=9)
    if len(values) > 1:
        ax.legend(fontsize=9, framealpha=0.8)


def _render_scatter(ax, categories, values, headers, colors):
    """散点图。"""
    x = list(range(len(categories)))
    for i, (vals, label) in enumerate(zip(values, headers[1:])):
        color = colors[i % len(colors)]
        ax.scatter(x, vals, label=label, color=color, s=60, zorder=3, edgecolors="white", linewidth=0.5)
    ax.set_xticks(x)
    ax.set_xticklabels(categories, fontsize=9)
    if len(values) > 1:
        ax.legend(fontsize=9, framealpha=0.8)


def _style_mpl_axes(ax, chart_type: str) -> None:
    """统一美化 matplotlib 坐标轴。"""
    if chart_type == "pieChart":
        ax.axis("off")
        return
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color("#CBD5E1")
    ax.spines["bottom"].set_color("#CBD5E1")
    ax.tick_params(colors="#64748B", labelsize=9)
    ax.yaxis.label.set_color("#475569")
    ax.xaxis.label.set_color("#475569")
    ax.grid(axis="y", color="#E2E8F0", linewidth=0.5, alpha=0.7)
    ax.set_axisbelow(True)
