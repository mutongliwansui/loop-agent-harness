"""统一错误码体系。

分层约定（前缀 SLIDEP_ + 四位编号，首数字标识所属子系统）：

| 编号段 | 子系统   | 示例                                     |
| ------ | -------- | ---------------------------------------- |
| 1xxx   | DSL      | 非法属性、非法样式值、组件树结构错误     |
| 2xxx   | 布局     | 溢出、负尺寸、空容器、布局无法计算       |
| 3xxx   | 渲染     | OOXML 写入失败、资源缺失、字体缺失       |
| 4xxx   | 素材/IO  | 文件不存在、格式不支持、提取失败         |
| 5xxx   | 校验     | 密度/色彩/版式/锚点门禁未通过            |
| 6xxx   | CLI/运行时 | 参数错误、daemon 状态错误、命令执行失败  |

错误分两类：
- ``SlidepError`` 及子类 ``SlidepUserError``：用户可修复的错误，必须携带定位信息（文件/页/行）与修复提示。
- ``SlidepSystemError``：系统级故障（依赖缺失、崩溃），保留完整堆栈。
"""

from __future__ import annotations

from enum import Enum
from typing import Optional


class ErrorCode(str, Enum):
    """全量错误码枚举。code 与 message 模板一一对应，禁止散落硬编码。"""

    # ---- 1xxx DSL ----
    DSL_UNKNOWN_PROPERTY = "SLIDEP_1001"
    DSL_INVALID_STYLE_VALUE = "SLIDEP_1002"
    DSL_UNKNOWN_COMPONENT = "SLIDEP_1003"
    DSL_INVALID_CHILDREN = "SLIDEP_1004"
    DSL_MISSING_REQUIRED_PROP = "SLIDEP_1005"

    # ---- 2xxx 布局 ----
    LAYOUT_OVERFLOW = "SLIDEP_2001"
    LAYOUT_NEGATIVE_SIZE = "SLIDEP_2002"
    LAYOUT_EMPTY_CONTAINER = "SLIDEP_2003"
    LAYOUT_UNRESOLVABLE = "SLIDEP_2004"

    # ---- 3xxx 渲染 ----
    RENDER_OOXML_FAILED = "SLIDEP_3001"
    RENDER_IMAGE_MISSING = "SLIDEP_3002"
    RENDER_FONT_MISSING = "SLIDEP_3003"

    # ---- 4xxx 素材/IO ----
    IO_FILE_NOT_FOUND = "SLIDEP_4001"
    IO_FORMAT_UNSUPPORTED = "SLIDEP_4002"
    IO_EXTRACTION_FAILED = "SLIDEP_4003"

    # ---- 5xxx 校验 ----
    VALIDATE_DENSITY = "SLIDEP_5001"
    VALIDATE_COLOR_RATIO = "SLIDEP_5002"
    VALIDATE_LAYOUT_REPEAT = "SLIDEP_5003"
    VALIDATE_ANCHOR_MISSING = "SLIDEP_5004"
    VALIDATE_FONT_RULE = "SLIDEP_5005"

    # ---- 6xxx CLI/运行时 ----
    CLI_INVALID_ARGS = "SLIDEP_6001"
    CLI_DAEMON_STATE = "SLIDEP_6002"
    CLI_EXEC_FAILED = "SLIDEP_6003"


#: 错误码 -> 默认消息模板（{placeholders} 由错误实例填充）
CODE_TEMPLATES: dict[ErrorCode, str] = {
    ErrorCode.DSL_UNKNOWN_PROPERTY: "未知样式属性 '{prop}'，组件 '{component}' 不支持",
    ErrorCode.DSL_INVALID_STYLE_VALUE: "样式属性 '{prop}' 的值 '{value}' 非法：{reason}",
    ErrorCode.DSL_UNKNOWN_COMPONENT: "未知组件 '{component}'，请检查组件名称",
    ErrorCode.DSL_INVALID_CHILDREN: "组件 '{component}' 的子组件类型非法：{reason}",
    ErrorCode.DSL_MISSING_REQUIRED_PROP: "组件 '{component}' 缺少必填属性 '{prop}'",
    ErrorCode.LAYOUT_OVERFLOW: "布局溢出：'{node}' 底部超出画布 {exceed}px（画布 {canvas}px）",
    ErrorCode.LAYOUT_NEGATIVE_SIZE: "布局尺寸非法：'{node}' 计算尺寸为负（{size}）",
    ErrorCode.LAYOUT_EMPTY_CONTAINER: "容器 '{node}' 为空或子项均不可见",
    ErrorCode.LAYOUT_UNRESOLVABLE: "布局无法收敛：'{node}' {reason}",
    ErrorCode.RENDER_OOXML_FAILED: "OOXML 写入失败：{reason}",
    ErrorCode.RENDER_IMAGE_MISSING: "图片资源缺失：{path}（请确认文件存在于 resources/images/）",
    ErrorCode.RENDER_FONT_MISSING: "字体缺失：{font}（请确认系统已安装该字体）",
    ErrorCode.IO_FILE_NOT_FOUND: "文件不存在：{path}",
    ErrorCode.IO_FORMAT_UNSUPPORTED: "不支持的格式：{path}（仅支持 {supported}）",
    ErrorCode.IO_EXTRACTION_FAILED: "素材提取失败：{path} {reason}",
    ErrorCode.VALIDATE_DENSITY: "密度门禁未通过：{detail}（实测 {actual}，阈值 {limit}）",
    ErrorCode.VALIDATE_COLOR_RATIO: "色彩面积门禁未通过：{detail}（实测 {actual}%，阈值 {limit}%）",
    ErrorCode.VALIDATE_LAYOUT_REPEAT: "版式门禁未通过：{detail}",
    ErrorCode.VALIDATE_ANCHOR_MISSING: "视觉锚点缺失：{page} 页无 ≥44px 元素且无 ≥40% 面积主视觉",
    ErrorCode.VALIDATE_FONT_RULE: "字体门禁未通过：{detail}",
    ErrorCode.CLI_INVALID_ARGS: "参数错误：{detail}",
    ErrorCode.CLI_DAEMON_STATE: "Daemon 状态错误：{detail}",
    ErrorCode.CLI_EXEC_FAILED: "命令执行失败：{detail}",
}


class SlidepError(Exception):
    """全部 slidep 错误的基类。"""

    code: ErrorCode
    #: 定位信息（用户错误必须有）
    page: Optional[str] = None
    file: Optional[str] = None
    lineno: Optional[int] = None
    #: 修复提示（面向用户，可打印到 CLI 输出）
    hint: Optional[str] = None

    def __init__(
        self,
        code: ErrorCode,
        *,
        page: Optional[str] = None,
        file: Optional[str] = None,
        lineno: Optional[int] = None,
        hint: Optional[str] = None,
        **fields,
    ) -> None:
        self.code = code
        self.page = page
        self.file = file
        self.lineno = lineno
        self.hint = hint
        self.fields = fields
        try:
            message = CODE_TEMPLATES[code].format(**fields)
        except (KeyError, IndexError):
            message = f"{code.value}: {fields}"
        super().__init__(message)

    @property
    def location(self) -> str:
        parts = []
        if self.file:
            parts.append(self.file)
        if self.page:
            parts.append(f"page={self.page}")
        if self.lineno is not None:
            parts.append(f"line={self.lineno}")
        return " ".join(parts) if parts else "-"

    def to_dict(self) -> dict:
        return {
            "code": self.code.value,
            "message": str(self),
            "location": self.location,
            "hint": self.hint,
            "fields": self.fields,
        }

    def __str__(self) -> str:
        return f"[{self.code.value}] {super().__str__()}"


class SlidepUserError(SlidepError):
    """用户可修复错误：定位 + 提示。CLI 遇到此类错误退出码 1，不打印堆栈。"""


class SlidepSystemError(SlidepError):
    """系统级故障：依赖缺失/内部崩溃。CLI 遇到此类错误退出码 2，打印堆栈。"""


# 便捷构造函数（按分层命名，供各子系统调用）
def dsl_error(code: ErrorCode, **kw) -> SlidepUserError:
    return SlidepUserError(code, **kw)


def layout_error(code: ErrorCode, **kw) -> SlidepUserError:
    return SlidepUserError(code, **kw)


def render_error(code: ErrorCode, **kw) -> SlidepUserError:
    return SlidepUserError(code, **kw)


def io_error(code: ErrorCode, **kw) -> SlidepUserError:
    return SlidepUserError(code, **kw)


def validate_error(code: ErrorCode, **kw) -> SlidepUserError:
    return SlidepUserError(code, **kw)


def cli_error(code: ErrorCode, **kw) -> SlidepUserError:
    return SlidepUserError(code, **kw)
