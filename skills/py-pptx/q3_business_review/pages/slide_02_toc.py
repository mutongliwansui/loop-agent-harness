# -*- coding: utf-8 -*-
"""P2 目录 · transition — 四段式结构（业绩 → 洞察 → 策略 → 行动）"""
from slidep.dsl import Slide, Box, Text

TOC_ITEMS = [
    ("01", "业绩回顾", "Q3 营收、毛利与三大经营信号"),
    ("02", "市场洞察", "中腰部客户迁移加速，窗口打开"),
    ("03", "增长策略", "三引擎：存量深耕、中腰部、出海"),
    ("04", "落地行动", "预算配置、路线图与风险预案"),
]

slide = Slide(
    page_type="toc",
    role="transition",
    rhythm="transition",
    title="目录 CONTENTS",
    background="#FFFFFF",
    children=[
        # 左侧垂直装饰线
        Box(style={"position": "absolute", "left": 48, "top": 130, "width": 4, "height": 440, "background": "#061F32"}),
        # 右侧四段式竖排列表（每段为 column，避免卡片横排）
        Box(
            style={"position": "absolute", "left": 96, "top": 132, "width": 1000, "height": 440, "flexDirection": "column", "gap": 28},
            children=[
                Box(style={"flex": 1, "flexDirection": "column", "gap": 8, "justifyContent": "center"},
                    children=[
                        Text(TOC_ITEMS[0][0], style={"fontSize": 40, "fontWeight": "bold", "color": "#08A6F6"}),
                        Text(TOC_ITEMS[0][1], style={"fontSize": 24, "fontWeight": "bold", "color": "#061F32"}),
                        Text(TOC_ITEMS[0][2], style={"fontSize": 16, "color": "#44546A", "width": 520, "lineHeight": 1.5}),
                    ]),
                Box(style={"flex": 1, "flexDirection": "column", "gap": 8, "justifyContent": "center"},
                    children=[
                        Text(TOC_ITEMS[1][0], style={"fontSize": 40, "fontWeight": "bold", "color": "#08A6F6"}),
                        Text(TOC_ITEMS[1][1], style={"fontSize": 24, "fontWeight": "bold", "color": "#061F32"}),
                        Text(TOC_ITEMS[1][2], style={"fontSize": 16, "color": "#44546A", "width": 520, "lineHeight": 1.5}),
                    ]),
                Box(style={"flex": 1, "flexDirection": "column", "gap": 8, "justifyContent": "center"},
                    children=[
                        Text(TOC_ITEMS[2][0], style={"fontSize": 40, "fontWeight": "bold", "color": "#08A6F6"}),
                        Text(TOC_ITEMS[2][1], style={"fontSize": 24, "fontWeight": "bold", "color": "#061F32"}),
                        Text(TOC_ITEMS[2][2], style={"fontSize": 16, "color": "#44546A", "width": 520, "lineHeight": 1.5}),
                    ]),
                Box(style={"flex": 1, "flexDirection": "column", "gap": 8, "justifyContent": "center"},
                    children=[
                        Text(TOC_ITEMS[3][0], style={"fontSize": 40, "fontWeight": "bold", "color": "#08A6F6"}),
                        Text(TOC_ITEMS[3][1], style={"fontSize": 24, "fontWeight": "bold", "color": "#061F32"}),
                        Text(TOC_ITEMS[3][2], style={"fontSize": 16, "color": "#44546A", "width": 520, "lineHeight": 1.5}),
                    ]),
            ],
        ),
    ],
)
