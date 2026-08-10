# -*- coding: utf-8 -*-
"""P5 效率实证 · hero/peak — 数据锚点 + 双图"""
from slidep.dsl import Slide, Box, Text, Chart

slide = Slide(
    page_type="content",
    role="hero",
    rhythm="peak",
    title="效率实证：数据说话",
    background="#0F172A",
    children=[
        # 顶部：巨型数据锚点（纯 column）
        Box(
            style={"position": "absolute", "left": 48, "top": 120, "width": 1184, "height": 140, "flexDirection": "column", "gap": 4},
            children=[
                Text("40%+", style={"fontSize": 72, "fontWeight": "bold", "color": "#F59E0B"}),
                Text("事务性耗时下降 · 试点团队 12 周追踪数据", style={"fontSize": 24, "color": "#FFFFFF"}),
            ],
        ),
        # 中部：双图并排（各自 absolute，无 row 容器）
        Box(
            style={"position": "absolute", "left": 48, "top": 270, "width": 560, "height": 230},
            children=[
                Chart(
                    chart_type="lineChart",
                    title="人均周产出指数（基线 = 100）",
                    data=[
                        ["周", "产出指数"],
                        ["W1", 100],
                        ["W2", 112],
                        ["W3", 121],
                        ["W4", 132],
                        ["W5", 140],
                    ],
                    style={"width": "100%", "height": "100%"},
                ),
            ],
        ),
        Box(
            style={"position": "absolute", "left": 648, "top": 270, "width": 560, "height": 230},
            children=[
                Chart(
                    chart_type="scatterChart",
                    title="AI 渗透率 vs 人均产出",
                    data=[
                        ["渗透率", "人均产出"],
                        [20, 100],
                        [40, 115],
                        [60, 126],
                        [80, 134],
                    ],
                    style={"width": "100%", "height": "100%"},
                ),
            ],
        ),
        # 底部：正文（≥180 字）
        Box(
            style={"position": "absolute", "left": 48, "top": 510, "width": 1184, "height": 150},
            children=[
                Text(
                    "试点团队引入 AI 工具后，人均周产出指数从 100 提升至 140，事务性工作耗时下降超过 40%。"
                    "产出提升并非来自更长的工时，而是来自任务结构的改变：重复录入、格式整理、信息检索被自动化接管，"
                    "员工把时间投向客户沟通与方案决策。数据显示，AI 渗透率达到 60% 后边际收益依然为正，"
                    "说明效率红利来自工作方式的整体重构，而非单一工具替换。对管理者而言，"
                    "关键在于组织学习：先选两三个高频场景跑通流程，再逐步扩大覆盖范围，沉淀可复制的方法论。",
                    style={"fontSize": 18, "color": "#FFFFFF", "lineHeight": 1.7},
                ),
            ],
        ),
    ],
)
