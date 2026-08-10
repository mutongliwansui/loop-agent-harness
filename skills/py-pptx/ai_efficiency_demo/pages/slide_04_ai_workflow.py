# -*- coding: utf-8 -*-
"""P4 AI 工作流 · supporting/valley — SVG 流程图"""
from slidep.dsl import Slide, Box, Text, SVG

FLOW_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1160 200">
  <rect x="25" y="55" width="180" height="100" rx="14" fill="#1E293B" stroke="#3B82F6" stroke-width="2"/>
  <text x="115" y="95" text-anchor="middle" font-size="22" font-family="Arial" fill="#FFFFFF" font-weight="bold">Input</text>
  <text x="115" y="122" text-anchor="middle" font-size="14" font-family="Arial" fill="#3B82F6">素材与需求</text>

  <rect x="245" y="55" width="180" height="100" rx="14" fill="#1E293B" stroke="#3B82F6" stroke-width="2"/>
  <text x="335" y="95" text-anchor="middle" font-size="22" font-family="Arial" fill="#FFFFFF" font-weight="bold">Understand</text>
  <text x="335" y="122" text-anchor="middle" font-size="14" font-family="Arial" fill="#3B82F6">理解意图</text>

  <rect x="465" y="55" width="180" height="100" rx="14" fill="#1E293B" stroke="#3B82F6" stroke-width="2"/>
  <text x="555" y="95" text-anchor="middle" font-size="22" font-family="Arial" fill="#FFFFFF" font-weight="bold">Generate</text>
  <text x="555" y="122" text-anchor="middle" font-size="14" font-family="Arial" fill="#3B82F6">内容生成</text>

  <rect x="685" y="55" width="180" height="100" rx="14" fill="#1E293B" stroke="#3B82F6" stroke-width="2"/>
  <text x="775" y="95" text-anchor="middle" font-size="22" font-family="Arial" fill="#FFFFFF" font-weight="bold">Review</text>
  <text x="775" y="122" text-anchor="middle" font-size="14" font-family="Arial" fill="#F59E0B">人工校验</text>

  <rect x="905" y="55" width="180" height="100" rx="14" fill="#3B82F6"/>
  <text x="995" y="95" text-anchor="middle" font-size="22" font-family="Arial" fill="#FFFFFF" font-weight="bold">Deliver</text>
  <text x="995" y="122" text-anchor="middle" font-size="14" font-family="Arial" fill="#FFFFFF">交付沉淀</text>

  <line x1="210" y1="105" x2="240" y2="105" stroke="#3B82F6" stroke-width="3"/>
  <polygon points="242,105 233,99 233,111" fill="#3B82F6"/>
  <line x1="430" y1="105" x2="460" y2="105" stroke="#3B82F6" stroke-width="3"/>
  <polygon points="462,105 453,99 453,111" fill="#3B82F6"/>
  <line x1="650" y1="105" x2="680" y2="105" stroke="#3B82F6" stroke-width="3"/>
  <polygon points="682,105 673,99 673,111" fill="#3B82F6"/>
  <line x1="870" y1="105" x2="900" y2="105" stroke="#3B82F6" stroke-width="3"/>
  <polygon points="902,105 893,99 893,111" fill="#3B82F6"/>
</svg>"""

slide = Slide(
    page_type="content",
    role="supporting",
    rhythm="valley",
    title="AI 工作流：把重复劳动交给机器",
    background="#0F172A",
    children=[
        # 顶部 SVG 流程图（全宽，视觉锚点）
        Box(
            style={"position": "absolute", "left": 48, "top": 120, "width": 1184, "height": 200},
            children=[
                SVG(markup=FLOW_SVG, style={"width": "100%", "height": "100%"}),
            ],
        ),
        # 底部正文（≥180 字）+ 锚点数字
        Box(
            style={"position": "absolute", "left": 48, "top": 360, "width": 1184, "height": 280, "flexDirection": "column", "gap": 12},
            children=[
                Text("5", style={"fontSize": 56, "fontWeight": "bold", "color": "#F59E0B"}),
                Text("步闭环，从输入到交付", style={"fontSize": 20, "color": "#FFFFFF"}),
                Text(
                    "把任务交给 AI，关键是建立可复用的工作流：先喂入素材并说明需求，让模型理解上下文与目标；"
                    "再生成初稿，由人来校验关键事实与立场，最后交付并沉淀为模板。"
                    "闭环的意义在于每次使用都在积累经验，下一次生成质量更高。"
                    "注意：AI 负责速度，人负责方向；校验环节不可省略，尤其是对外输出的内容。"
                    "这样的五步流程适用于周报、纪要、方案初稿等高频重复任务，单次节省 30 分钟以上，"
                    "随着模板库的积累，团队的整体产出会呈现明显的复利效应。",
                    style={"fontSize": 18, "color": "#FFFFFF", "lineHeight": 1.7},
                ),
            ],
        ),
    ],
)
