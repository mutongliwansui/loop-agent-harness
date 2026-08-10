# -*- coding: utf-8 -*-
"""P1 封面 · hero/peak — 2026 年第三季度业务汇报"""
from slidep.dsl import Slide, Box, Text

slide = Slide(
    page_type="cover",
    role="hero",
    rhythm="peak",
    title="2026 年第三季度业务汇报",
    background="#061F32",
    children=[
        # 左上：公司标识
        Box(
            style={"position": "absolute", "top": 48, "left": 80, "flexDirection": "column", "gap": 6},
            children=[
                Text("云启科技 · YUNQI TECH", style={"fontSize": 18, "fontWeight": "bold", "color": "#08A6F6", "letterSpacing": 2}),
                Text("B2B SaaS 智能业务平台", style={"fontSize": 14, "color": "#FFFFFF", "letterSpacing": 1}),
            ],
        ),
        # 右侧装饰线
        Box(style={"position": "absolute", "top": 150, "right": 120, "width": 6, "height": 120, "background": "#08A6F6"}),
        # 底部：副标题与场合信息
        Box(
            style={"position": "absolute", "bottom": 100, "left": 80, "width": 1100, "flexDirection": "column", "gap": 16},
            children=[
                Box(style={"width": 64, "height": 4, "background": "#08A6F6"}),
                Text("季度经营会 · 管理层汇报", style={"fontSize": 22, "color": "#FFFFFF"}),
                Text("回顾 Q3 经营结果，对齐 Q4 增长策略与资源投入", style={"fontSize": 18, "color": "#FFFFFF", "lineHeight": 1.6}),
                Text("汇报人：运营管理部   |   2026 年 10 月", style={"fontSize": 16, "color": "#FFFFFF"}),
            ],
        ),
    ],
)
