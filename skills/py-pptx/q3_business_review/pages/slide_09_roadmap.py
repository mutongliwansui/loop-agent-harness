# -*- coding: utf-8 -*-
"""P9 落地路线 · supporting/valley — 三阶段路线图 + 锚点 + 正文"""
from slidep.dsl import Slide, Box, Text, SVG

ROADMAP_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1184 300">
  <text x="40" y="30" font-size="20" fill="#061F32" font-weight="bold">Phase 1 · Oct</text>
  <text x="420" y="30" font-size="20" fill="#061F32" font-weight="bold">Phase 2 · Nov</text>
  <text x="800" y="30" font-size="20" fill="#061F32" font-weight="bold">Phase 3 · Dec</text>
  <rect x="40" y="60" width="360" height="160" rx="8" fill="#E8F3FC" stroke="#061F32" stroke-width="1.5"/>
  <rect x="420" y="60" width="360" height="160" rx="8" fill="#E8F3FC" stroke="#061F32" stroke-width="1.5"/>
  <rect x="800" y="60" width="360" height="160" rx="8" fill="#E8F3FC" stroke="#061F32" stroke-width="1.5"/>
  <line x1="404" y1="140" x2="414" y2="140" stroke="#08A6F6" stroke-width="3"/>
  <polygon points="418,140 408,134 408,146" fill="#08A6F6"/>
  <line x1="784" y1="140" x2="794" y2="140" stroke="#08A6F6" stroke-width="3"/>
  <polygon points="798,140 788,134 788,146" fill="#08A6F6"/>
</svg>"""

slide = Slide(
    page_type="content",
    role="supporting",
    rhythm="valley",
    title="60 天跑通、90 天放量、季度末复盘，节奏可控",
    background="#FFFFFF",
    children=[
        # 顶部：三阶段路线图（视觉主体）
        Box(
            style={"position": "absolute", "left": 48, "top": 120, "width": 1184, "height": 250},
            children=[
                SVG(markup=ROADMAP_SVG, style={"width": "100%", "height": "100%"}),
            ],
        ),
        # 阶段一：起步验证
        Box(
            style={"position": "absolute", "left": 64, "top": 225, "width": 320, "flexDirection": "column", "gap": 8},
            children=[
                Text("起步验证", style={"fontSize": 22, "fontWeight": "bold", "color": "#061F32"}),
                Text("产品标准化、渠道签约 30 家、50 家种子客户交付", style={"fontSize": 15, "color": "#44546A", "lineHeight": 1.5}),
            ],
        ),
        # 阶段二：规模放量
        Box(
            style={"position": "absolute", "left": 444, "top": 225, "width": 320, "flexDirection": "column", "gap": 8},
            children=[
                Text("规模放量", style={"fontSize": 22, "fontWeight": "bold", "color": "#061F32"}),
                Text("渠道全面铺开，月新签 60 家以上，出海两城试点", style={"fontSize": 15, "color": "#44546A", "lineHeight": 1.5}),
            ],
        ),
        # 阶段三：复盘迭代
        Box(
            style={"position": "absolute", "left": 824, "top": 225, "width": 320, "flexDirection": "column", "gap": 8},
            children=[
                Text("复盘迭代", style={"fontSize": 22, "fontWeight": "bold", "color": "#061F32"}),
                Text("季度末复盘三引擎贡献，确定 Q1 预算与节奏", style={"fontSize": 15, "color": "#44546A", "lineHeight": 1.5}),
            ],
        ),
        # 锚点：90 天闭环（≥44px 文字锚点）
        Box(
            style={"position": "absolute", "left": 48, "top": 390, "width": 1184, "height": 95, "flexDirection": "column", "gap": 6},
            children=[
                Text("90天", style={"fontSize": 64, "fontWeight": "bold", "color": "#061F32"}),
                Text("三阶段闭环，每 30 天一个里程碑可监控", style={"fontSize": 22, "color": "#44546A"}),
            ],
        ),
        # 底部正文（≥180 字）
        Box(
            style={"position": "absolute", "left": 48, "top": 500, "width": 1184, "height": 140},
            children=[
                Text(
                    "落地节奏按验证、放量、复盘三段推进：10 月完成产品标准化与渠道准备，"
                    "以 50 家种子客户跑通交付模型，验证中腰部客单价与续约假设；"
                    "11 月渠道全面铺开，目标月新签 60 家以上，同时启动出海两城试点；"
                    "12 月进入复盘窗口，以月度经营会盯住签约、交付、留存三项指标，"
                    "对未达里程碑的引擎启动退出或资源再分配。预算投放与里程碑强绑定："
                    "前 30 天仅释放 40% 预算，跑通后再释放剩余 60%，把风险控制在可承受范围，"
                    "确保 Q4 增长不仅是冲刺，更是可持续、可复制、可复盘的增长。",
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
