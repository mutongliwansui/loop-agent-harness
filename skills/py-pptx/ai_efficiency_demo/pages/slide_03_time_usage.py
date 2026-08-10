# -*- coding: utf-8 -*-
"""P3 现状痛点 · supporting/valley — 时间都去哪了（barChart 锚点）"""
from slidep.dsl import Slide, Box, Text, Chart

slide = Slide(
    page_type="content",
    role="supporting",
    rhythm="valley",
    title="时间都去哪了：低效工作的真实成本",
    background="#0F172A",
    children=[
        # 左：双系列柱状图（B 区 57% 宽度，视觉锚点）
        Box(
            style={"position": "absolute", "left": 48, "top": 120, "width": 680, "height": 540},
            children=[
                Chart(
                    chart_type="barChart",
                    title="每日事务性工作耗时（小时）对比",
                    data=[
                        ["任务", "当前", "AI 辅助后"],
                        ["邮件处理", 1.4, 0.4],
                        ["会议纪要", 1.6, 0.5],
                        ["重复录入", 1.9, 0.6],
                        ["资料查找", 1.3, 0.3],
                        ["数据整理", 1.5, 0.5],
                    ],
                    style={"width": "100%", "height": "100%"},
                ),
            ],
        ),
        # 右：锚点 + 洞察正文（纯 column）
        Box(
            style={"position": "absolute", "left": 760, "top": 120, "width": 472, "height": 540, "flexDirection": "column", "gap": 18},
            children=[
                Text("6.5h", style={"fontSize": 64, "fontWeight": "bold", "color": "#F59E0B"}),
                Text("日均浪费在事务性工作", style={"fontSize": 20, "color": "#FFFFFF"}),
                Text(
                    "知识工作者每天平均有 6.5 小时花在事务性工作上：整理邮件、誊写会议纪要、重复录入数据、来回查找资料。"
                    "这些任务规则明确、产出标准固定，恰恰是 AI 最擅长处理的类型。"
                    "研究显示，引入生成式 AI 后，事务性工作耗时平均下降 60% 以上，且质量波动远小于人工。"
                    "真正的杠杆在于：把省下来的时间投入判断、沟通与创造，让每个人专注于只有人能完成的事，"
                    "这正是组织提效的起点，值得从今天开始行动。",
                    style={"fontSize": 18, "color": "#FFFFFF", "lineHeight": 1.7},
                ),
            ],
        ),
    ],
)
