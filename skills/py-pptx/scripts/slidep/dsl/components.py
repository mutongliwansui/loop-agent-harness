"""DSL 组件模型（T1.1）：Slide / Box / Text 组件树。

- 声明式构造：``Slide(...)`` / ``Box(...)`` / ``Text("内容", style=...)``
- pydantic v2 模型，构造时自动执行 style 白名单校验（见 styles.validate_style）
- 序列化：``to_dict()`` / ``from_dict()`` 支持 round-trip
- 遍历：``walk()`` 带深度；``components()`` 按类型过滤

约束（对齐 references/component-*.md）：
- Slide 是唯一根节点，不允许出现在 children 中
- Text 无 children；Box/Slide 的 children 仅允许 Box/Text
"""

from __future__ import annotations

from typing import Annotated, Any, Iterator, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

from slidep import ErrorCode, dsl_error
from slidep.dsl.styles import validate_style

MAX_DEPTH_WARNING = 5  #: 容器嵌套深度超过此值给出警告（references/component-box.md）


class ComponentBase(BaseModel):
    """所有组件基类：type + style。"""

    model_config = ConfigDict(extra="forbid")

    type: str
    style: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _check_style(self) -> "ComponentBase":
        validate_style(self.type, self.style)
        return self


class Box(ComponentBase):
    """Flexbox 容器：排列子组件。"""

    type: Literal["Box"] = "Box"
    children: list["Node"] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_children(self) -> "Box":
        for child in self.children:
            if isinstance(child, Slide):
                raise dsl_error(ErrorCode.DSL_INVALID_CHILDREN, component="Box", reason="Box 不能包含 Slide")
        return self


class Text(ComponentBase):
    """富文本：内容字符串 + 文本样式。支持 ``Text("内容", style=...)`` 位置写法。"""

    type: Literal["Text"] = "Text"
    text: str = ""

    def __init__(self, text: str = "", **kwargs: Any) -> None:
        super().__init__(text=text, **kwargs)


class Slide(ComponentBase):
    """页面根组件：唯一允许出现在文件顶层的组件。"""

    type: Literal["Slide"] = "Slide"
    page_type: Literal["cover", "toc", "content", "section", "ending"] = "content"
    role: Literal["hero", "supporting", "transition"] = "supporting"
    rhythm: Literal["peak", "valley", "transition"] = "valley"
    title: Optional[str] = None
    background: Optional[str] = None
    children: list["Node"] = Field(default_factory=list)

    @model_validator(mode="after")
    def _finalize(self) -> "Slide":
        for child in self.children:
            if isinstance(child, Slide):
                raise dsl_error(ErrorCode.DSL_INVALID_CHILDREN, component="Slide", reason="Slide 不能嵌套 Slide")
        # background 顶层字段并入 style（render 层统一从 style 读）
        if self.background is not None and "background" not in self.style:
            self.style = {**self.style, "background": self.background}
        return self


class Chart(ComponentBase):
    """数据可视化组件：柱/折/饼/面积/散点图（对应 T2.1）。

    data 为二维数组，首行表头，首列分类轴。数值列必须为 number。
    饼图仅支持单系列。
    """

    type: Literal["Chart"] = "Chart"
    chart_type: Literal["barChart", "lineChart", "pieChart", "areaChart", "scatterChart"]
    data: list[list] = Field(default_factory=list)
    title: Optional[str] = None

    @model_validator(mode="after")
    def _validate_chart_data(self) -> "Chart":
        if len(self.data) < 2:
            raise dsl_error(
                ErrorCode.DSL_MISSING_REQUIRED_PROP,
                component="Chart", prop="data",
                hint="图表数据至少需要 2 行（表头 + 1 数据行）",
            )
        ncols = len(self.data[0])
        if ncols < 2:
            raise dsl_error(
                ErrorCode.DSL_INVALID_STYLE_VALUE,
                prop="data", value=repr(self.data),
                reason="每行至少 2 列（分类 + 1 系列）",
            )
        if self.chart_type == "pieChart" and ncols > 2:
            raise dsl_error(
                ErrorCode.DSL_INVALID_STYLE_VALUE,
                prop="chart_type", value="pieChart",
                reason="饼图仅支持单系列（2 列）",
            )
        for row_idx, row in enumerate(self.data[1:], start=1):
            if len(row) != ncols:
                raise dsl_error(
                    ErrorCode.DSL_INVALID_STYLE_VALUE,
                    prop="data", value=repr(row),
                    reason=f"第 {row_idx} 行列数与表头不一致",
                )
            for col_idx, cell in enumerate(row[1:], start=1):
                if not isinstance(cell, (int, float)) or isinstance(cell, bool):
                    raise dsl_error(
                        ErrorCode.DSL_INVALID_STYLE_VALUE,
                        prop="data", value=repr(cell),
                        reason=f"第 {row_idx} 行第 {col_idx + 1} 列非数值类型",
                    )
        return self


# ---------------------------------------------------------------- T2.2 媒体与富文本组件


class Image(ComponentBase):
    """图片组件：本地相对路径嵌入，支持 objectFit 裁剪/适配。

    src 为 resources/images/ 下的相对路径（或绝对路径）。
    objectFit: cover → 裁剪填充；contain → 等比缩放留白。
    """

    type: Literal["Image"] = "Image"
    src: str
    object_fit: Literal["cover", "contain"] = "cover"

    @model_validator(mode="after")
    def _validate_image(self) -> "Image":
        if not self.src or not self.src.strip():
            raise dsl_error(
                ErrorCode.DSL_MISSING_REQUIRED_PROP,
                component="Image", prop="src",
                hint="图片路径不能为空",
            )
        return self


class Table(ComponentBase):
    """表格组件：二维 cells + 斑马纹 + 表头样式。

    data 为二维字符串数组。header=True 时首行加粗高亮。
    zebra=True 时奇数行交替底色。
    """

    type: Literal["Table"] = "Table"
    data: list[list[str]] = Field(default_factory=list)
    header: bool = True
    zebra: bool = True

    @model_validator(mode="after")
    def _validate_table(self) -> "Table":
        if not self.data or len(self.data) < 1:
            raise dsl_error(
                ErrorCode.DSL_MISSING_REQUIRED_PROP,
                component="Table", prop="data",
                hint="表格数据至少需要 1 行",
            )
        ncols = len(self.data[0])
        if ncols < 1:
            raise dsl_error(
                ErrorCode.DSL_INVALID_STYLE_VALUE,
                prop="data", value=repr(self.data),
                reason="表格至少需要 1 列",
            )
        for row_idx, row in enumerate(self.data):
            if len(row) != ncols:
                raise dsl_error(
                    ErrorCode.DSL_INVALID_STYLE_VALUE,
                    prop="data", value=repr(row),
                    reason=f"第 {row_idx} 行列数({len(row)})与表头({ncols})不一致",
                )
        return self


class FAIcon(ComponentBase):
    """FontAwesome 图标组件：内置常用图标子集，SVG 路径渲染。

    name 为内置图标名（如 'check', 'star', 'home'）。
    color 控制图标填充色。
    """

    type: Literal["FAIcon"] = "FAIcon"
    name: str

    @model_validator(mode="after")
    def _validate_icon(self) -> "FAIcon":
        if not self.name or not self.name.strip():
            raise dsl_error(
                ErrorCode.DSL_MISSING_REQUIRED_PROP,
                component="FAIcon", prop="name",
                hint="图标名称不能为空",
            )
        return self


class SVG(ComponentBase):
    """SVG 图形组件：结构化图形（流程图/时间轴/架构图）。

    markup 为合法 SVG 字符串。轻量解析器支持 rect/circle/ellipse/line/
    polyline/polygon/path/text/g 元素。
    """

    type: Literal["SVG"] = "SVG"
    markup: str

    @model_validator(mode="after")
    def _validate_svg(self) -> "SVG":
        if not self.markup or not self.markup.strip():
            raise dsl_error(
                ErrorCode.DSL_MISSING_REQUIRED_PROP,
                component="SVG", prop="markup",
                hint="SVG 标记不能为空",
            )
        return self


class QRCode(ComponentBase):
    """二维码组件：内联生成，不依赖网络。

    value 为待编码的文本或 URL。
    """

    type: Literal["QRCode"] = "QRCode"
    value: str

    @model_validator(mode="after")
    def _validate_qrcode(self) -> "QRCode":
        if not self.value:
            raise dsl_error(
                ErrorCode.DSL_MISSING_REQUIRED_PROP,
                component="QRCode", prop="value",
                hint="二维码内容不能为空",
            )
        return self


class CodeBlock(ComponentBase):
    """代码块组件：语法高亮 + 等宽字体渲染。

    code 为代码文本。language 控制语法高亮（python/javascript/java/go/sql/json/yaml/bash/text）。
    """

    type: Literal["CodeBlock"] = "CodeBlock"
    code: str
    language: str = "text"

    @model_validator(mode="after")
    def _validate_codeblock(self) -> "CodeBlock":
        if not self.code:
            raise dsl_error(
                ErrorCode.DSL_MISSING_REQUIRED_PROP,
                component="CodeBlock", prop="code",
                hint="代码内容不能为空",
            )
        return self


class Math(ComponentBase):
    """数学公式组件：LaTeX 公式渲染。

    latex 为 matplotlib mathtext 兼容的 LaTeX 公式（如 r'$E=mc^2$'）。
    color 控制公式颜色。
    """

    type: Literal["Math"] = "Math"
    latex: str

    @model_validator(mode="after")
    def _validate_math(self) -> "Math":
        if not self.latex or not self.latex.strip():
            raise dsl_error(
                ErrorCode.DSL_MISSING_REQUIRED_PROP,
                component="Math", prop="latex",
                hint="公式内容不能为空",
            )
        return self


#: 组件树节点类型（type 判别联合）
Node = Annotated[
    Union[Box, Text, Chart, Image, Table, FAIcon, SVG, QRCode, CodeBlock, Math],
    Field(discriminator="type"),
]

Box.model_rebuild()
Slide.model_rebuild()


# ---------------------------------------------------------------- 序列化

def to_dict(node: Node | Slide) -> dict[str, Any]:
    """组件树 → JSON 兼容 dict（round-trip 用）。"""
    return node.model_dump(mode="json", exclude_none=True)


def from_dict(data: dict[str, Any]) -> Node | Slide:
    """JSON 兼容 dict → 组件树。未知 type 抛 DSL_UNKNOWN_COMPONENT。"""
    node_type = data.get("type")
    _registry: dict[str, type] = {
        "Slide": Slide, "Box": Box, "Text": Text, "Chart": Chart,
        "Image": Image, "Table": Table, "FAIcon": FAIcon,
        "SVG": SVG, "QRCode": QRCode, "CodeBlock": CodeBlock, "Math": Math,
    }
    cls = _registry.get(node_type)
    if cls is None:
        raise dsl_error(ErrorCode.DSL_UNKNOWN_COMPONENT, component=repr(node_type))
    return cls.model_validate(data)


# ---------------------------------------------------------------- 遍历

def walk(node: Node | Slide, depth: int = 0) -> Iterator[tuple[Node | Slide, int]]:
    """深度优先遍历，产出 (节点, 深度) 对。根节点深度 0。"""
    yield node, depth
    for child in getattr(node, "children", []):
        yield from walk(child, depth + 1)


def components(node: Node | Slide, cls: Optional[type] = None) -> Iterator[Node | Slide]:
    """按类型过滤遍历（cls=None 时返回全部）。"""
    for item, _ in walk(node):
        if cls is None or isinstance(item, cls):
            yield item


def max_depth(node: Node | Slide) -> int:
    """组件树最大深度（根为 0）。"""
    return max((d for _, d in walk(node)), default=0)


def count_nodes(node: Node | Slide) -> int:
    """组件树节点总数。"""
    return sum(1 for _ in walk(node))
