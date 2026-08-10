"""slidep 引擎包入口：版本号与对外导出。"""

from .errors import (
    ErrorCode,
    SlidepError,
    SlidepSystemError,
    SlidepUserError,
    cli_error,
    dsl_error,
    io_error,
    layout_error,
    render_error,
    validate_error,
)

__version__ = "0.1.0"

__all__ = [
    "ErrorCode",
    "SlidepError",
    "SlidepUserError",
    "SlidepSystemError",
    "dsl_error",
    "layout_error",
    "render_error",
    "io_error",
    "validate_error",
    "cli_error",
    "__version__",
]
