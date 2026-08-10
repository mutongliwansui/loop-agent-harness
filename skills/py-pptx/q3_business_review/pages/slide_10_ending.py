# -*- coding: utf-8 -*-
"""P10 结束页 · hero/peak — 行动号召 + 决策点（column 列表）"""
from slidep.dsl import Slide, Box, Text

DECISIONS = [
    ("D1", "批准 Q4 三引擎增长策略与 180 万预算"),
    ("D2", "授予渠道与区域团队中腰部市场签约权限"),
    ("D3", "月度经营会绑定里程碑，季度末出具复盘报告"),
]

slide = Slide(
    page_type="ending",
    role="hero",
    rhythm="peak",
    title="批准 Q4 增长预算，锁定全年目标",
    background="#061F32",
    children=[
        # 左：三个决策点（column 列表，无 row 容器）
        Box(
            style={"position": "absolute", "left": 96, "top": 200, "width": 760, "flexDirection": "column", "gap": 30},
            children=[
                Box(style={"flexDirection": "column", "gap": 6},
                    children=[
                        Text(DECISIONS[0][0], style={"fontSize": 32, "fontWeight": "bold", "color": "#08A6F6"}),
                        Text(DECISIONS[0][1], style={"fontSize": 22, "color": "#FFFFFF", "lineHeight": 1.5}),
                    ]),
                Box(style={"flexDirection": "column", "gap": 6},
                    children=[
                        Text(DECISIONS[1][0], style={"fontSize": 32, "fontWeight": "bold", "color": "#08A6F6"}),
                        Text(DECISIONS[1][1], style={"fontSize": 22, "color": "#FFFFFF", "lineHeight": 1.5}),
                    ]),
                Box(style={"flexDirection": "column", "gap": 6},
                    children=[
                        Text(DECISIONS[2][0], style={"fontSize": 32, "fontWeight": "bold", "color": "#08A6F6"}),
                        Text(DECISIONS[2][1], style={"fontSize": 22, "color": "#FFFFFF", "lineHeight": 1.5}),
                    ]),
            ],
        ),
        # 右：核心指标回顾 + 联系方式
        Box(
            style={"position": "absolute", "right": 96, "top": 210, "width": 340, "flexDirection": "column", "gap": 18},
            children=[
                Box(style={"width": 64, "height": 4, "background": "#08A6F6"}),
                Text("本季度三个数字", style={"fontSize": 20, "fontWeight": "bold", "color": "#FFFFFF"}),
                Text("+38% 营收增速 · 92% 留存率 · 3 大引擎", style={"fontSize": 18, "color": "#FFFFFF", "lineHeight": 1.6}),
                Text("云启科技 · 运营管理部 · 2026.10", style={"fontSize": 16, "color": "#FFFFFF"}),
            ],
        ),
    ],
)
