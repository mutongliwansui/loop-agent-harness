# -*- coding: utf-8 -*-
"""P1 封面 · hero/peak — AI 赋能高效工作"""
from slidep.dsl import Slide, Box, Text, Image

slide = Slide(
    page_type="cover",
    role="hero",
    rhythm="peak",
    title="AI 赋能高效工作",
    background="#0F172A",
    children=[
        # 全屏背景网络图（弱化）
        Box(
            style={"position": "absolute", "top": 0, "left": 0, "width": "100%", "height": "100%", "opacity": 0.30},
            children=[
                Image(
                    src="resources/images/ai_network.png",
                    object_fit="cover",
                    style={"width": "100%", "height": "100%"},
                ),
            ],
        ),
        # 底部主视觉信息（纯 column，避免 row 容器）
        Box(
            style={"position": "absolute", "bottom": 120, "left": 80, "width": 1100, "flexDirection": "column", "gap": 16, "alignItems": "flex-start"},
            children=[
                Text("AI-EMPOWERED WORKFLOW", style={"fontSize": 18, "fontWeight": "bold", "color": "#F59E0B", "letterSpacing": 3}),
                Text("从重复劳动到创造性工作，AI 正在重塑每一天的效率", style={"fontSize": 24, "color": "#FFFFFF", "lineHeight": 1.5}),
                Text("汇报人：效率研究小组  |  2026 年 8 月", style={"fontSize": 16, "color": "#FFFFFF"}),
            ],
        ),
    ],
)
