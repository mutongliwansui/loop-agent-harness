# -*- coding: utf-8 -*-
"""P7 工具矩阵 · supporting/valley — Table + 锚点"""
from slidep.dsl import Slide, Box, Text, Table

slide = Slide(
    page_type="content",
    role="supporting",
    rhythm="valley",
    title="AI 工具矩阵：按需选型",
    background="#0F172A",
    children=[
        # 左：工具矩阵表格
        Box(
            style={"position": "absolute", "left": 48, "top": 120, "width": 680, "height": 540},
            children=[
                Table(
                    data=[
                        ["类别", "代表工具", "典型任务", "提效幅度"],
                        ["文本生成", "ChatGPT / Claude", "报告、邮件、文案", "60%"],
                        ["数据分析", "Copilot / NotebookLM", "报表、洞察、可视化", "50%"],
                        ["设计创意", "Midjourney / Canva", "配图、海报、排版", "70%"],
                        ["开发助手", "Cursor / Copilot", "编码、测试、评审", "55%"],
                        ["办公协同", "飞书智能伙伴 / Teams", "纪要、日程、搜索", "45%"],
                    ],
                    style={"width": "100%", "height": "100%"},
                ),
            ],
        ),
        # 右：锚点 + 选型建议（纯 column）
        Box(
            style={"position": "absolute", "left": 760, "top": 120, "width": 472, "height": 540, "flexDirection": "column", "gap": 18},
            children=[
                Text("45–70%", style={"fontSize": 56, "fontWeight": "bold", "color": "#F59E0B"}),
                Text("单任务提效幅度", style={"fontSize": 20, "color": "#FFFFFF"}),
                Text(
                    "不同任务的提效空间差异很大：规则明确、批量化的任务（文本、设计）提升最明显，"
                    "而需要强领域判断的任务（协同、决策）提升相对温和。选型的三个原则："
                    "第一，从提效幅度最高且使用频率最高的任务切入；第二，优先选择已集成在现有办公链路的工具，"
                    "降低切换成本；第三，为团队建立统一的使用规范与提示词模板，避免各自摸索。"
                    "注意评估数据安全条款，涉及敏感信息的场景需选择本地化或私有化部署方案。",
                    style={"fontSize": 18, "color": "#FFFFFF", "lineHeight": 1.7},
                ),
            ],
        ),
    ],
)
