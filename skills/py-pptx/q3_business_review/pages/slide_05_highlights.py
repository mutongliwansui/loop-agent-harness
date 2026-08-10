# -*- coding: utf-8 -*-
"""P5 Q3 亮点 · hero/peak — 三大 KPI 深色卡片锚点（absolute 分卡）+ 底部正文"""
from slidep.dsl import Slide, Box, Text

slide = Slide(
    page_type="content",
    role="hero",
    rhythm="peak",
    title="增长、留存、人效三线齐升，基本面全面向好",
    background="#FFFFFF",
    children=[
        # KPI 卡一（absolute 定位，避免 row 布局）
        Box(
            style={"position": "absolute", "left": 48, "top": 120, "width": 373, "height": 250, "background": "#061F32", "borderRadius": 8, "padding": 24, "flexDirection": "column", "gap": 12, "justifyContent": "center"},
            children=[
                Text("+38%", style={"fontSize": 72, "fontWeight": "bold", "color": "#FFFFFF"}),
                Text("营收同比增速", style={"fontSize": 24, "fontWeight": "bold", "color": "#08A6F6"}),
                Text("近六季度最高，目标达成 118%", style={"fontSize": 16, "color": "#FFFFFF", "lineHeight": 1.5}),
            ],
        ),
        # KPI 卡二
        Box(
            style={"position": "absolute", "left": 453, "top": 120, "width": 373, "height": 250, "background": "#061F32", "borderRadius": 8, "padding": 24, "flexDirection": "column", "gap": 12, "justifyContent": "center"},
            children=[
                Text("92%", style={"fontSize": 72, "fontWeight": "bold", "color": "#FFFFFF"}),
                Text("客户留存率", style={"fontSize": 24, "fontWeight": "bold", "color": "#08A6F6"}),
                Text("订阅客户净金额留存率创纪录", style={"fontSize": 16, "color": "#FFFFFF", "lineHeight": 1.5}),
            ],
        ),
        # KPI 卡三
        Box(
            style={"position": "absolute", "left": 858, "top": 120, "width": 373, "height": 250, "background": "#061F32", "borderRadius": 8, "padding": 24, "flexDirection": "column", "gap": 12, "justifyContent": "center"},
            children=[
                Text("+24%", style={"fontSize": 72, "fontWeight": "bold", "color": "#FFFFFF"}),
                Text("人均产出提升", style={"fontSize": 24, "fontWeight": "bold", "color": "#08A6F6"}),
                Text("流程自动化后销售人效持续爬坡", style={"fontSize": 16, "color": "#FFFFFF", "lineHeight": 1.5}),
            ],
        ),
        # 底部正文（≥180 字，含指标印证说明）
        Box(
            style={"position": "absolute", "left": 48, "top": 410, "width": 900, "height": 220},
            children=[
                Text(
                    "三项指标相互印证，说明 Q3 的增长并非单一偶发因素推动：留存率 92% 的高位稳定，"
                    "来源于上半年交付质量与客户成功体系的整体升级；营收增速 38% 的抬升，"
                    "得益于数据智能产品线在既有客户群中的交叉销售；人效提升 24%，"
                    "则来自合同、报价、回访等高频环节的自动化覆盖。管理层的关注点应从结果验证转向机制固化："
                    "把这三条改善路径沉淀为可复制的运营方法，确保 Q4 在扩大新客规模的同时，"
                    "不稀释存量客户的留存质量与人效水平。",
                    style={"fontSize": 18, "color": "#44546A", "lineHeight": 1.7},
                ),
            ],
        ),
        # Source
        Box(
            style={"position": "absolute", "left": 48, "top": 664, "width": 1184, "height": 20},
            children=[
                Text("Source：经营分析部 · Q3 经营周报（模拟数据）", style={"fontSize": 14, "color": "#44546A"}),
            ],
        ),
    ],
)
