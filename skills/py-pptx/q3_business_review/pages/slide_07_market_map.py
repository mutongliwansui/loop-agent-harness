# -*- coding: utf-8 -*-
"""P7 竞争格局 · supporting/valley — 2×2 矩阵（SVG 骨架 + Text 叠层）+ 洞察"""
from slidep.dsl import Slide, Box, Text, SVG

MATRIX_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 440">
  <rect x="0" y="0" width="620" height="440" rx="8" fill="#FFFFFF" stroke="#061F32" stroke-width="2"/>
  <rect x="2" y="2" width="306" height="216" fill="#E8F3FC"/>
  <rect x="312" y="2" width="306" height="216" fill="#F1F5F9"/>
  <rect x="2" y="222" width="306" height="216" fill="#F1F5F9"/>
  <rect x="312" y="222" width="306" height="216" fill="#E8F3FC"/>
  <line x1="310" y1="2" x2="310" y2="438" stroke="#061F32" stroke-width="2"/>
  <line x1="2" y1="220" x2="618" y2="220" stroke="#061F32" stroke-width="2"/>
</svg>"""

slide = Slide(
    page_type="content",
    role="supporting",
    rhythm="valley",
    title="中腰部客户迁移加速，AI 能力成为选型分水岭",
    background="#FFFFFF",
    children=[
        # 左：2×2 矩阵（视觉锚点，≥50% B 区）
        Box(
            style={"position": "absolute", "left": 48, "top": 120, "width": 620, "height": 440},
            children=[
                SVG(markup=MATRIX_SVG, style={"width": "100%", "height": "100%"}),
            ],
        ),
        # 左上象限：蓝海区（小客户 × 高采纳）
        Box(
            style={"position": "absolute", "left": 60, "top": 64, "width": 240, "flexDirection": "column", "gap": 6},
            children=[
                Text("蓝海区", style={"fontSize": 24, "fontWeight": "bold", "color": "#061F32"}),
                Text("中腰部新客迁移加速，AI 需求集中释放", style={"fontSize": 16, "color": "#44546A", "lineHeight": 1.5}),
            ],
        ),
        # 右上象限：红海区（大客户 × 高采纳）
        Box(
            style={"position": "absolute", "left": 360, "top": 64, "width": 240, "flexDirection": "column", "gap": 6},
            children=[
                Text("红海区", style={"fontSize": 24, "fontWeight": "bold", "color": "#061F32"}),
                Text("头部竞品聚焦存量，价格战趋缓", style={"fontSize": 16, "color": "#44546A", "lineHeight": 1.5}),
            ],
        ),
        # 左下象限：长尾区（小客户 × 低采纳）
        Box(
            style={"position": "absolute", "left": 60, "top": 290, "width": 240, "flexDirection": "column", "gap": 6},
            children=[
                Text("长尾区", style={"fontSize": 24, "fontWeight": "bold", "color": "#061F32"}),
                Text("预算与需求不足，暂不投入", style={"fontSize": 16, "color": "#44546A", "lineHeight": 1.5}),
            ],
        ),
        # 右下象限：存量区（大客户 × 低采纳）
        Box(
            style={"position": "absolute", "left": 360, "top": 290, "width": 240, "flexDirection": "column", "gap": 6},
            children=[
                Text("存量区", style={"fontSize": 24, "fontWeight": "bold", "color": "#061F32"}),
                Text("深耕增购是现金牛，毛利最高", style={"fontSize": 16, "color": "#44546A", "lineHeight": 1.5}),
            ],
        ),
        # 矩阵下方：坐标轴说明
        Box(
            style={"position": "absolute", "left": 48, "top": 572, "width": 620, "height": 24},
            children=[
                Text("横轴：客户规模（小 → 大）   纵轴：AI 采纳度（低 → 高）", style={"fontSize": 14, "color": "#44546A"}),
            ],
        ),
        # 右：洞察正文（≥180 字）+ Source
        Box(
            style={"position": "absolute", "left": 712, "top": 120, "width": 520, "height": 500, "flexDirection": "column", "gap": 16},
            children=[
                Text("蓝海窗口", style={"fontSize": 64, "fontWeight": "bold", "color": "#061F32"}),
                Text("Q4 主攻方向：中腰部新客", style={"fontSize": 22, "color": "#44546A"}),
                Text(
                    "市场竞争格局正在发生结构性变化：头部客户市场的渗透率已超过 65%，"
                    "头部竞品把资源压在存量维护上，新增投入放缓；而中腰部客户（年预算 50-200 万）"
                    "对 AI 能力的需求在 Q3 集中释放，询单量环比增长 52%，但头部厂商尚未建立差异化方案，"
                    "供给出现窗口。我们判断：未来两个季度是切入中腰部市场的最佳时机。"
                    "策略上，用标准化产品 + 场景化模板降低交付成本，以订阅制快速覆盖；"
                    "同时守住存量区的高毛利基本盘，用增购收入支撑出海试点的前期投入。",
                    style={"fontSize": 18, "color": "#061F32", "lineHeight": 1.7},
                ),
                Text("Source：市场研究部 · Q3 竞争情报与询单漏斗（模拟数据）", style={"fontSize": 14, "color": "#44546A"}),
            ],
        ),
    ],
)
