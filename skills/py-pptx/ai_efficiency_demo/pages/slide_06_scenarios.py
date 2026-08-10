# -*- coding: utf-8 -*-
"""P6 高频场景 · supporting/valley — FAIcon 卡片 + Image 配图"""
from slidep.dsl import Slide, Box, Text, FAIcon, Image

SCENARIOS = [
    ("file", "文档处理", "纪要、合同审阅、周报自动生成"),
    ("chart-bar", "数据分析", "报表解读、异常预警、口径问答"),
    ("envelope", "客户沟通", "邮件起草、客服话术、多语言翻译"),
    ("code", "代码开发", "代码补全、单元测试、代码评审"),
    ("database", "知识管理", "资料归档、知识问答、文档检索"),
    ("calendar", "日程协同", "会议安排、待办排序、跨时区协调"),
]

_CARD = {
    "flex": 1,
    "flexDirection": "column",
    "gap": 12,
    "padding": 24,
    "borderRadius": 14,
    "border": "1px solid #3B82F6",
}

slide = Slide(
    page_type="content",
    role="supporting",
    rhythm="valley",
    title="六大高频场景：AI 已能接手",
    background="#0F172A",
    children=[
        # 顶部：锚点 + 副标题
        Box(style={"flexDirection": "row", "gap": 18, "alignItems": "center", "width": "100%"},
            children=[
                Text("6", style={"fontSize": 56, "fontWeight": "bold", "color": "#F59E0B"}),
                Box(style={"flexDirection": "column", "gap": 2},
                    children=[
                        Text("类高频场景，AI 已能接手", style={"fontSize": 24, "fontWeight": "bold", "color": "#FFFFFF"}),
                        Text("占日常工作量的 60% 以上，均有成熟工具支撑", style={"fontSize": 14, "color": "#FFFFFF"}),
                    ]),
            ]),
        # 中：2×3 卡片网格（border 勾边，无 background，避免白色面积超标）
        Box(style={"flexDirection": "row", "gap": 14, "width": "100%"},
            children=[
                Box(style=dict(_CARD),
                    children=[
                        FAIcon(name=icon, style={"width": 28, "height": 28, "color": "#3B82F6"}),
                        Text(name, style={"fontSize": 20, "fontWeight": "bold", "color": "#FFFFFF", "width": "100%"}),
                        Text(desc, style={"fontSize": 15, "color": "#FFFFFF", "lineHeight": 1.6, "width": "100%"}),
                    ])
                for icon, name, desc in SCENARIOS[:3]
            ]),
        Box(style={"flexDirection": "row", "gap": 14, "width": "100%"},
            children=[
                Box(style=dict(_CARD),
                    children=[
                        FAIcon(name=icon, style={"width": 28, "height": 28, "color": "#3B82F6"}),
                        Text(name, style={"fontSize": 20, "fontWeight": "bold", "color": "#FFFFFF", "width": "100%"}),
                        Text(desc, style={"fontSize": 15, "color": "#FFFFFF", "lineHeight": 1.6, "width": "100%"}),
                    ])
                for icon, name, desc in SCENARIOS[3:]
            ]),
        # 底：配图 + 选型建议
        Box(style={"flexDirection": "row", "gap": 24, "alignItems": "center", "width": "100%"},
            children=[
                Image(
                    src="resources/images/ai_workspace.png",
                    object_fit="cover",
                    style={"width": 360, "height": 180, "borderRadius": 12},
                ),
                Box(style={"flexDirection": "column", "gap": 8, "flex": 1},
                    children=[
                        Text(
                            "建议按『高频 × 低风险』原则优先启动：先选文档处理与知识管理，"
                            "因为它们最容易度量节省的时间，也最容易在两周内跑通第一个闭环，"
                            "为后续场景的推广积累经验与信心。选定后为每个场景设定明确的提效指标，"
                            "例如每周节省工时、初稿合格率，让推广有据可依，逐步扩展到其余四类。",
                            style={"fontSize": 15, "color": "#FFFFFF", "lineHeight": 1.7, "width": "100%"},
                        ),
                    ]),
            ]),
    ],
)
