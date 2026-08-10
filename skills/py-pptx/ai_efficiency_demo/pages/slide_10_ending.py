# -*- coding: utf-8 -*-
"""P10 结束页 · hero/peak — 行动号召 + QRCode"""
from slidep.dsl import Slide, Box, Text, QRCode

slide = Slide(
    page_type="ending",
    role="hero",
    rhythm="peak",
    title="从一个小任务开始",
    background="#0F172A",
    children=[
        # 左：行动号召（纯 column，无 row 容器）
        Box(
            style={"position": "absolute", "left": 48, "top": 140, "width": 760, "height": 460, "flexDirection": "column", "gap": 20, "alignItems": "flex-start"},
            children=[
                Text(
                    "效率提升不是一次性工程，而是持续累积的复利。"
                    "今天迈出的第一步，会在三个月后变成团队共同的效率资产。",
                    style={"fontSize": 20, "color": "#FFFFFF", "lineHeight": 1.7},
                ),
                Text("→ 选定一个高频任务，本周开始试用", style={"fontSize": 18, "color": "#FFFFFF"}),
                Text("→ 建立团队共享的提示词与模板库", style={"fontSize": 18, "color": "#FFFFFF"}),
                Text("→ 三个月后复盘 ROI，再决定扩展范围", style={"fontSize": 18, "color": "#FFFFFF"}),
                Text("谢谢聆听，欢迎交流", style={"fontSize": 24, "fontWeight": "bold", "color": "#F59E0B"}),
            ],
        ),
        # 右：二维码
        Box(
            style={"position": "absolute", "left": 880, "top": 170, "width": 352, "height": 380, "flexDirection": "column", "gap": 12, "alignItems": "center"},
            children=[
                QRCode(
                    value="https://copilot.microsoft.com",
                    style={"width": 220, "height": 220},
                ),
                Text("扫码体验 AI 工作助手", style={"fontSize": 16, "color": "#FFFFFF"}),
            ],
        ),
    ],
)
