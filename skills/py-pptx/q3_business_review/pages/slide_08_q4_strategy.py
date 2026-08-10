# -*- coding: utf-8 -*-
"""P8 Q4 增长策略 · supporting/valley — 三支柱战略结构图 + 锚点 + 正文"""
from slidep.dsl import Slide, Box, Text, SVG

STRATEGY_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1184 300">
  <rect x="40" y="0" width="1104" height="64" rx="8" fill="#061F32"/>
  <line x1="240" y1="64" x2="240" y2="104" stroke="#08A6F6" stroke-width="3"/>
  <line x1="600" y1="64" x2="600" y2="104" stroke="#08A6F6" stroke-width="3"/>
  <line x1="960" y1="64" x2="960" y2="104" stroke="#08A6F6" stroke-width="3"/>
  <circle cx="240" cy="108" r="5" fill="#08A6F6"/>
  <circle cx="600" cy="108" r="5" fill="#08A6F6"/>
  <circle cx="960" cy="108" r="5" fill="#08A6F6"/>
  <rect x="60" y="120" width="360" height="160" rx="8" fill="#E8F3FC" stroke="#061F32" stroke-width="1.5"/>
  <rect x="420" y="120" width="360" height="160" rx="8" fill="#E8F3FC" stroke="#061F32" stroke-width="1.5"/>
  <rect x="780" y="120" width="360" height="160" rx="8" fill="#E8F3FC" stroke="#061F32" stroke-width="1.5"/>
</svg>"""

slide = Slide(
    page_type="content",
    role="supporting",
    rhythm="valley",
    title="Q4 三引擎并进：存量深耕、中腰部突破、出海试点",
    background="#FFFFFF",
    children=[
        # 顶部：战略结构图（视觉主体）
        Box(
            style={"position": "absolute", "left": 48, "top": 120, "width": 1184, "height": 250},
            children=[
                SVG(markup=STRATEGY_SVG, style={"width": "100%", "height": "100%"}),
            ],
        ),
        # 目标条文字
        Box(
            style={"position": "absolute", "left": 342, "top": 132, "width": 500, "height": 40, "justifyContent": "center"},
            children=[
                Text("Q4 目标：营收 +25%、新客贡献提升至 35%", style={"fontSize": 22, "fontWeight": "bold", "color": "#FFFFFF", "textAlign": "center"}),
            ],
        ),
        # 引擎一：存量深耕
        Box(
            style={"position": "absolute", "left": 76, "top": 230, "width": 328, "flexDirection": "column", "gap": 10},
            children=[
                Text("引擎一 · 存量深耕", style={"fontSize": 24, "fontWeight": "bold", "color": "#061F32"}),
                Text("交叉销售 + 增购升级，客单提升 30%", style={"fontSize": 16, "color": "#44546A", "lineHeight": 1.5}),
                Text("预计贡献 55% 增量", style={"fontSize": 16, "fontWeight": "bold", "color": "#08A6F6"}),
            ],
        ),
        # 引擎二：中腰部突破
        Box(
            style={"position": "absolute", "left": 436, "top": 230, "width": 328, "flexDirection": "column", "gap": 10},
            children=[
                Text("引擎二 · 中腰部突破", style={"fontSize": 24, "fontWeight": "bold", "color": "#061F32"}),
                Text("标准化产品 + 渠道下沉，覆盖 200 家新客", style={"fontSize": 16, "color": "#44546A", "lineHeight": 1.5}),
                Text("预计贡献 35% 增量", style={"fontSize": 16, "fontWeight": "bold", "color": "#08A6F6"}),
            ],
        ),
        # 引擎三：出海试点
        Box(
            style={"position": "absolute", "left": 796, "top": 230, "width": 328, "flexDirection": "column", "gap": 10},
            children=[
                Text("引擎三 · 出海试点", style={"fontSize": 24, "fontWeight": "bold", "color": "#061F32"}),
                Text("东南亚两城试点，验证国际化路径", style={"fontSize": 16, "color": "#44546A", "lineHeight": 1.5}),
                Text("预计贡献 10% 增量", style={"fontSize": 16, "fontWeight": "bold", "color": "#08A6F6"}),
            ],
        ),
        # 锚点：增量营收数字（≥44px 文字锚点）
        Box(
            style={"position": "absolute", "left": 48, "top": 390, "width": 1184, "height": 95, "flexDirection": "column", "gap": 6},
            children=[
                Text("880万", style={"fontSize": 64, "fontWeight": "bold", "color": "#061F32"}),
                Text("预计 Q4 增量营收，三引擎按 5:4:1 贡献", style={"fontSize": 22, "color": "#44546A"}),
            ],
        ),
        # 底部正文（≥180 字）
        Box(
            style={"position": "absolute", "left": 48, "top": 500, "width": 1184, "height": 140},
            children=[
                Text(
                    "三引擎按贡献与风险分层配置：存量深耕是基本盘，基于 92% 留存率的客户基础，"
                    "通过交叉销售数据智能模块与增购高级席位，预计贡献约 55% 的增量营收，风险最低；"
                    "中腰部突破是主攻方向，以标准化产品压缩交付周期、以区域渠道扩大触达面，"
                    "目标新增 200 家订阅客户，预计贡献 35% 增量；出海试点是卡位动作，"
                    "以两座东南亚城市为样板验证产品本地化路径，投入有限但战略意义明确。"
                    "三引擎共用产研底座，预算按 5:4:1 配置，并设置月度里程碑与退出开关，"
                    "确保每笔投入都有明确责任人与止损线。",
                    style={"fontSize": 18, "color": "#061F32", "lineHeight": 1.7},
                ),
            ],
        ),
        # Source
        Box(
            style={"position": "absolute", "left": 48, "top": 648, "width": 1184, "height": 12},
            children=[
                Text("Source：战略部 · Q4 经营计划（模拟数据）", style={"fontSize": 14, "color": "#44546A"}),
            ],
        ),
    ],
)
