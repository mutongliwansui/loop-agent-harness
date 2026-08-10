# -*- coding: utf-8 -*-
"""P8 落地回报 · supporting/valley — Math 公式 + pieChart"""
from slidep.dsl import Slide, Box, Text, Math, Chart

slide = Slide(
    page_type="content",
    role="supporting",
    rhythm="valley",
    title="落地回报：投入产出可量化",
    background="#0F172A",
    children=[
        # 左：ROI 公式 + 锚点 + 正文（纯 column）
        Box(
            style={"position": "absolute", "left": 48, "top": 120, "width": 660, "height": 540, "flexDirection": "column", "gap": 16},
            children=[
                Math(
                    latex=r"$ROI = \frac{S \times H - C}{C} \times 100\%$",
                    style={"color": "#3B82F6", "width": 420, "height": 110},
                ),
                Text("3 个月", style={"fontSize": 56, "fontWeight": "bold", "color": "#F59E0B"}),
                Text("回收全部投入", style={"fontSize": 20, "color": "#FFFFFF"}),
                Text(
                    "ROI 公式中，S 为每月节省的小时数，H 为员工时薪，C 为工具与实施成本。"
                    "以 10 人团队为例：人均每月节省 20 小时，时薪 100 元，月节省约 2 万元；"
                    "工具订阅与培训月成本约 6 千元，ROI 超过 230%，三个月即可覆盖全部投入。"
                    "更重要的收益在公式之外：响应速度加快、错误率下降、员工满意度提升，"
                    "这些间接价值往往数倍于直接的工时节省。建议按季度复盘 ROI，动态调整工具组合。",
                    style={"fontSize": 18, "color": "#FFFFFF", "lineHeight": 1.7},
                ),
            ],
        ),
        # 右：投入构成饼图
        Box(
            style={"position": "absolute", "left": 760, "top": 120, "width": 472, "height": 540},
            children=[
                Chart(
                    chart_type="pieChart",
                    title="AI 投入成本构成",
                    data=[
                        ["项目", "占比"],
                        ["工具订阅", 35],
                        ["培训", 25],
                        ["集成开发", 30],
                        ["运维", 10],
                    ],
                    style={"width": "100%", "height": "100%"},
                ),
            ],
        ),
    ],
)
