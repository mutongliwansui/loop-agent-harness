# -*- coding: utf-8 -*-
"""P6 章节过渡 · transition — 02 市场洞察（满 Navy 底 + 编号）"""
from slidep.dsl import Slide, Box, Text

slide = Slide(
    page_type="section",
    role="transition",
    rhythm="transition",
    title="市场洞察",
    background="#061F32",
    children=[
        # 左侧编号
        Box(
            style={"position": "absolute", "left": 96, "top": 220, "width": 320, "height": 120},
            children=[
                Text("02", style={"fontSize": 72, "fontWeight": "bold", "color": "#08A6F6"}),
            ],
        ),
        # 右侧章节说明
        Box(
            style={"position": "absolute", "left": 480, "top": 240, "width": 700, "flexDirection": "column", "gap": 16},
            children=[
                Box(style={"width": 64, "height": 4, "background": "#08A6F6"}),
                Text("客户结构正在迁移：中腰部市场对 AI 能力的需求集中释放", style={"fontSize": 24, "color": "#FFFFFF", "lineHeight": 1.6}),
                Text("本章回答：增长窗口在哪？我们如何卡位？", style={"fontSize": 18, "color": "#FFFFFF"}),
            ],
        ),
    ],
)
