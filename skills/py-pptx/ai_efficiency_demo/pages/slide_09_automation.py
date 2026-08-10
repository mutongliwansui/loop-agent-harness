# -*- coding: utf-8 -*-
"""P9 自动化示例 · supporting/valley — CodeBlock"""
from slidep.dsl import Slide, Box, Text, CodeBlock

CODE = """from openai import OpenAI
client = OpenAI()

def summarize(file_text: str) -> str:
    \"\"\"Summarize a long report into key points.\"\"\"
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "user",
             "content": f"Summary: {file_text}"},
        ],
        max_tokens=300,
    )
    return resp.choices[0].message.content"""

slide = Slide(
    page_type="content",
    role="supporting",
    rhythm="valley",
    title="从脚本到智能体：自动化示例",
    background="#0F172A",
    children=[
        # 左：代码块
        Box(
            style={"position": "absolute", "left": 48, "top": 120, "width": 640, "height": 540},
            children=[
                CodeBlock(
                    code=CODE,
                    language="python",
                    style={"width": "100%", "height": "100%"},
                ),
            ],
        ),
        # 右：锚点 + 正文（纯 column）
        Box(
            style={"position": "absolute", "left": 720, "top": 120, "width": 512, "height": 540, "flexDirection": "column", "gap": 18},
            children=[
                Text("分钟级", style={"fontSize": 56, "fontWeight": "bold", "color": "#F59E0B"}),
                Text("报告摘要生成", style={"fontSize": 20, "color": "#FFFFFF"}),
                Text(
                    "十几行代码即可把 AI 能力接入日常工作流：读取文件、生成摘要、写入报告，"
                    "整个过程从小时级压缩到分钟级。进阶路径是三步走：先用脚本完成单个任务，"
                    "再封装为可配置的服务，最后通过定时触发或消息监听形成无人值守的自动化流程。"
                    "团队可以在合规前提下共享提示词与工具函数，沉淀为内部效率资产。"
                    "对于非技术同事，也可以借助低代码平台实现同样的效果，关键是先跑通一个最小闭环，"
                    "让自动化能力从个人技巧变成团队基础设施。",
                    style={"fontSize": 18, "color": "#FFFFFF", "lineHeight": 1.7},
                ),
            ],
        ),
    ],
)
