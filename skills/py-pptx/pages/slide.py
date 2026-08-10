from slidep.dsl import Slide, Box, Text

slide = Slide(
    page_type="cover",
    role="hero",
    rhythm="peak",
    title="人工智能在医疗领域的应用与展望",
    background="#061F32",
    children=[
        Box(
            style={
                "flexDirection": "column",
                "justifyContent": "center",
                "alignItems": "flex-start",
                "padding": 80,
                "width": "100%",
                "height": "100%",
            },
            children=[
                Text(
                    "人工智能在医疗领域\n的应用与展望",
                    style={"fontSize": 64, "color": "#FFFFFF", "fontWeight": "bold", "marginBottom": 20},
                ),
                Text(
                    "AI IN HEALTHCARE: APPLICATIONS AND OUTLOOK",
                    style={"fontSize": 18, "color": "#08A6F6", "fontWeight": "bold", "marginBottom": 40},
                ),
                Text(
                    "行业深度分析报告 · 2025",
                    style={"fontSize": 18, "color": "#FFFFFF", "fontWeight": "normal"},
                ),
            ],
        ),
    ],
)
