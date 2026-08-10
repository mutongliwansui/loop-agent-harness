"""表格渲染器（T2.2）：python-pptx 原生表格 + 斑马纹 + 表头样式。

直接在 pptx slide 上添加表格（不经过 PNG），保留可编辑性。
- header=True: 首行加粗 + 深色背景 + 白字
- zebra=True: 奇数数据行浅灰底色
- 列宽均分（按列数等分总宽）
"""

from __future__ import annotations

from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Pt

from slidep import ErrorCode, render_error
from slidep.render.units import emu

#: 表头样式
_HEADER_BG = "1E293B"  # 深蓝灰
_HEADER_FG = (255, 255, 255)

#: 斑马纹颜色
_ZEBRA_BG = "F1F5F9"  # 浅灰
_NORMAL_BG = "FFFFFF"  # 白

#: 文字样式
_BODY_FG = (30, 41, 59)  # #1E293B
_FONT_SIZE = 14  # pt
_HEADER_SIZE = 14  # pt


def render_table(
    pptx_slide,
    data: list[list[str]],
    header: bool,
    zebra: bool,
    rect,
) -> None:
    """在 slide 上添加表格。

    Args:
        pptx_slide: python-pptx Slide 对象
        data: 二维字符串数组
        header: 首行是否为表头
        zebra: 是否启用斑马纹
        rect: 布局 Rect (x, y, width, height)
    """
    n_rows = len(data)
    n_cols = len(data[0]) if data else 0
    if n_rows == 0 or n_cols == 0:
        return

    try:
        graphic_frame = pptx_slide.shapes.add_table(
            n_rows, n_cols,
            emu(rect.x), emu(rect.y), emu(rect.width), emu(rect.height),
        )
        table = graphic_frame.table

        # 关闭默认表格样式带状（自行控制）
        _disable_default_banding(table)

        # 列宽均分
        col_w = int(rect.width / n_cols)
        for col_idx in range(n_cols):
            table.columns[col_idx].width = Emu(col_w)

        # 行高均分
        row_h = int(rect.height / n_rows)
        for row_idx in range(n_rows):
            table.rows[row_idx].height = Emu(row_h)

        # 填充单元格
        for row_idx in range(n_rows):
            is_header = header and row_idx == 0
            is_zebra = zebra and not is_header and (row_idx % 2 == 0)
            for col_idx in range(n_cols):
                cell = table.cell(row_idx, col_idx)
                cell.text = str(data[row_idx][col_idx])
                _style_cell(cell, is_header, is_zebra)

    except Exception as exc:  # noqa: BLE001
        raise render_error(
            ErrorCode.RENDER_OOXML_FAILED,
            reason=f"表格渲染失败: {exc}",
        ) from exc


def _disable_default_banding(table) -> None:
    """关闭默认表格带状样式（避免与自定义斑马纹冲突）。"""
    from pptx.oxml.ns import qn

    tbl = table._tbl
    tbl_pr = tbl.find(qn("a:tblPr"))
    if tbl_pr is not None:
        tbl_pr.set("firstRow", "0")
        tbl_pr.set("bandRow", "0")


def _style_cell(cell, is_header: bool, is_zebra: bool) -> None:
    """设置单元格样式（背景色、字体、对齐）。"""
    # 背景
    cell.fill.solid()
    if is_header:
        cell.fill.fore_color.rgb = RGBColor.from_string(_HEADER_BG)
    elif is_zebra:
        cell.fill.fore_color.rgb = RGBColor.from_string(_ZEBRA_BG)
    else:
        cell.fill.fore_color.rgb = RGBColor.from_string(_NORMAL_BG)

    # 文字
    tf = cell.text_frame
    tf.margin_left = Emu(40000)
    tf.margin_right = Emu(40000)
    tf.margin_top = Emu(20000)
    tf.margin_bottom = Emu(20000)
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf.word_wrap = True

    for para in tf.paragraphs:
        para.alignment = PP_ALIGN.LEFT
        for run in para.runs:
            run.font.size = Pt(_HEADER_SIZE if is_header else _FONT_SIZE)
            run.font.bold = is_header
            fg = _HEADER_FG if is_header else _BODY_FG
            run.font.color.rgb = RGBColor(*fg)
            run.font.name = "Calibri"
