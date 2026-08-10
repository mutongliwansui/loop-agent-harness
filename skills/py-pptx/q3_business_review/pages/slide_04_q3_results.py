# -*- coding: utf-8 -*-
"""P4 Q3 业绩 · supporting/valley — 营收柱状 + 增速折线（左图右文）"""
from slidep.dsl import Slide, Box, Text, Chart

slide = Slide(
    page_type="content",
    role="supporting",
    rhythm="valley",
    title="Q3 营收 2.4 亿、同比 +38%，订阅收入占比升至 61%",
    background="#FFFFFF",
    children=[
        # 左：图表区（B 区约 56% 宽，视觉锚点）
        Box(
            style={"position": "absolute", "left": 48, "top": 120, "width": 660, "height": 540, "flexDirection": "column", "gap": 16},
            children=[
                # 营收柱状图
                Box(style={"width": "100%", "height": 300},
                    children=[
                        Chart(
                            chart_type="barChart",
                            title="季度营收（亿元）",
                            data=[
                                ["季度", "营收"],
                                ["Q1", 1.5],
                                ["Q2", 1.9],
                                ["Q3", 2.4],
                                ["Q4E", 3.0],
                            ],
                            style={"width": "100%", "height": "100%"},
                        ),
                    ]),
                # 同比增速折线图
                Box(style={"width": "100%", "height": 210},
                    children=[
                        Chart(
                            chart_type="lineChart",
                            title="同比增速（%）",
                            data=[
                                ["季度", "增速"],
                                ["Q1", 25],
                                ["Q2", 30],
                                ["Q3", 38],
                                ["Q4E", 45],
                            ],
                            style={"width": "100%", "height": "100%"},
                        ),
                    ]),
            ],
        ),
        # 右：洞察正文（≥180 字）+ Source
        Box(
            style={"position": "absolute", "left": 748, "top": 120, "width": 484, "height": 540, "flexDirection": "column", "gap": 16},
            children=[
                Text("2.4亿", style={"fontSize": 64, "fontWeight": "bold", "color": "#061F32"}),
                Text("Q3 单季营收，连续三季环比正增长", style={"fontSize": 22, "color": "#44546A"}),
                Text(
                    "Q3 营收 2.4 亿元、同比增长 38%，在行业平均增速 20% 的背景下表现亮眼。"
                    "结构上，订阅制收入占比升至 61%，ARR 口径下复购率 92%，说明产品黏性扎实；"
                    "但一次性项目类收入占比仍有近四成，其毛利低于订阅业务约 12 个百分点，"
                    "拉低了整体毛利率的改善速度。分产品线看，数据智能平台贡献了主要增量，"
                    "而传统报表工具增长趋缓。管理层需要认识到：短期的规模增长已到位，"
                    "下一步的关键是把收入结构向高毛利、可预测的订阅模式持续迁移，"
                    "同时为 Q4 的新客获取建立独立的增长引擎。",
                    style={"fontSize": 18, "color": "#061F32", "lineHeight": 1.7},
                ),
                Text("Source：经营分析部 · Q3 财务报表（模拟数据，交付前可替换）", style={"fontSize": 14, "color": "#44546A"}),
            ],
        ),
    ],
)
