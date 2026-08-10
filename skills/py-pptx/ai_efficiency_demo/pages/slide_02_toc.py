# -*- coding: utf-8 -*-
"""P2 目录 · transition — 四段式结构"""
from slidep.dsl import Slide, Box, Text, FAIcon

TOC_ITEMS = [
    ("现状与痛点", "看清时间浪费在哪里，AI 的杠杆才有支点"),
    ("AI 工作流", "输入、理解、生成、校验、交付，五步闭环"),
    ("效率实证", "40% 的耗时下降，来自真实团队数据"),
    ("高频场景", "文档、数据、沟通、开发，六类任务先行"),
    ("工具矩阵", "按任务类型选型，找到你的第一台引擎"),
    ("落地回报", "投入产出可量化，三个月看到变化"),
]

slide = Slide(
    page_type="toc",
    role="transition",
    rhythm="transition",
    title="目录",
    background="#0F172A",
    children=[
        Box(style={"flexDirection": "column", "gap": 14, "width": "100%"},
            children=[
                Box(style={"flexDirection": "row", "alignItems": "center", "gap": 18},
                    children=[
                        FAIcon(name="chart-line", style={"width": 30, "height": 30, "color": "#3B82F6"}),
                        Text(f"0{idx + 1}", style={"fontSize": 40, "fontWeight": "bold", "color": "#3B82F6", "width": 70}),
                        Box(style={"flexDirection": "column", "gap": 4},
                            children=[
                                Text(title, style={"fontSize": 20, "fontWeight": "bold", "color": "#FFFFFF"}),
                                Text(desc, style={"fontSize": 16, "color": "#FFFFFF", "lineHeight": 1.5}),
                            ]),
                    ])
                for idx, (title, desc) in enumerate(TOC_ITEMS)
            ]),
    ],
)
