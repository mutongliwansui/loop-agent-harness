# -*- coding: utf-8 -*-
"""P3 执行摘要 · supporting/valley — Context / Complication / Resolution 三栏（absolute 分栏）"""
from slidep.dsl import Slide, Box, Text

slide = Slide(
    page_type="content",
    role="supporting",
    rhythm="valley",
    title="Q3 超额达成 1.18 倍，Q4 需以拉新接棒增长",
    background="#FFFFFF",
    children=[
        # 顶部：视觉锚点（Navy 色块 + 白色巨数）
        Box(
            style={"position": "absolute", "left": 48, "top": 120, "width": 320, "height": 130, "background": "#061F32", "borderRadius": 8, "flexDirection": "column", "justifyContent": "center", "padding": 20},
            children=[
                Text("+38%", style={"fontSize": 72, "fontWeight": "bold", "color": "#FFFFFF"}),
            ],
        ),
        # 锚点说明（灰色，置于色块右侧）
        Box(
            style={"position": "absolute", "left": 400, "top": 152, "width": 832, "height": 60, "flexDirection": "column", "justifyContent": "center"},
            children=[
                Text("Q3 营收同比增速，目标达成率 118%，创近六季度新高", style={"fontSize": 22, "color": "#44546A"}),
            ],
        ),
        # 栏一：背景 Context
        Box(
            style={"position": "absolute", "left": 48, "top": 286, "width": 368, "height": 340, "flexDirection": "column", "gap": 12},
            children=[
                Text("背景 Context", style={"fontSize": 24, "fontWeight": "bold", "color": "#08A6F6"}),
                Text(
                    "上半年完成组织与产品架构调整后，订阅制收入连续三个季度环比正增长，"
                    "Q3 新签与续约双增，营收、毛利、人效等核心指标全面向好，"
                    "经营基本面扎实，为下一阶段增长提供了可依赖的底座；"
                    "同时销售体系标准化程度提升，交付周期环比缩短 18%，客户成功团队扩编到位。",
                    style={"fontSize": 22, "color": "#061F32", "lineHeight": 1.6},
                ),
            ],
        ),
        # 栏二：挑战 Complication
        Box(
            style={"position": "absolute", "left": 440, "top": 286, "width": 368, "height": 340, "flexDirection": "column", "gap": 12},
            children=[
                Text("挑战 Complication", style={"fontSize": 24, "fontWeight": "bold", "color": "#08A6F6"}),
                Text(
                    "增长结构仍偏存量：老客复购贡献了七成增量，新客获取增速落后大盘约 12 个百分点；"
                    "若没有新引擎接棒，按当前动能测算，下季度增速将回落至 20% 以下，"
                    "全年目标承压，必须在存量之外为新客拉新建立独立引擎，"
                    "才能维持增长曲线不减速。",
                    style={"fontSize": 22, "color": "#061F32", "lineHeight": 1.6},
                ),
            ],
        ),
        # 栏三：结论 Resolution
        Box(
            style={"position": "absolute", "left": 832, "top": 286, "width": 368, "height": 340, "flexDirection": "column", "gap": 12},
            children=[
                Text("结论 Resolution", style={"fontSize": 24, "fontWeight": "bold", "color": "#08A6F6"}),
                Text(
                    "Q4 聚焦三大增长引擎：存量深耕提客单、中腰部拉新放量、出海试点卡位；"
                    "以 180 万预算撬动约 880 万增量营收，整体增速目标 +25%，"
                    "并配套月度里程碑与风险预案，确保策略可落地、可监控、可复盘。",
                    style={"fontSize": 22, "color": "#061F32", "lineHeight": 1.6},
                ),
            ],
        ),
        # 底部 Source
        Box(
            style={"position": "absolute", "left": 48, "top": 650, "width": 1184, "height": 20},
            children=[
                Text("Source：经营分析部 · Q3 财务报表与 CRM 口径；数据为演示用模拟值", style={"fontSize": 14, "color": "#44546A"}),
            ],
        ),
    ],
)
