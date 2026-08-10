"""结构化日志：JSON 行输出，便于机器解析与预览服务消费。

字段约定：ts / level / logger / msg / code / page / file / lineno / extra
级别：DEBUG < INFO < WARN < ERROR。
环境变量 SLIDEP_LOG_LEVEL 可覆盖默认级别（默认 INFO）。
环境变量 SLIDEP_LOG_JSON=0 可切换回纯文本格式（调试用）。
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from typing import Any, Optional

_RESERVED = {"ts", "level", "logger", "msg", "code", "page", "file", "lineno", "extra"}


class JsonFormatter(logging.Formatter):
    """输出单行 JSON 的日志格式化器。"""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": round(record.created, 3),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        # 从 record 携带的 slidep 上下文提取
        ctx = getattr(record, "slidep_ctx", None)
        if isinstance(ctx, dict):
            for key in ("code", "page", "file", "lineno"):
                if key in ctx:
                    payload[key] = ctx[key]
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


class SlidepLogger(logging.Logger):
    """带 slidep 上下文的 Logger：自动附加 code/page/file/lineno。"""

    def _log_with_ctx(
        self,
        level: int,
        msg: str,
        *,
        code: Optional[str] = None,
        page: Optional[str] = None,
        file: Optional[str] = None,
        lineno: Optional[int] = None,
        **kwargs,
    ) -> None:
        ctx = {}
        if code:
            ctx["code"] = code
        if page:
            ctx["page"] = page
        if file:
            ctx["file"] = file
        if lineno is not None:
            ctx["lineno"] = lineno
        kwargs.setdefault("extra", {})["slidep_ctx"] = ctx
        self.log(level, msg, **kwargs)

    def info_ctx(self, msg: str, **ctx) -> None:
        self._log_with_ctx(logging.INFO, msg, **ctx)

    def warn_ctx(self, msg: str, **ctx) -> None:
        self._log_with_ctx(logging.WARNING, msg, **ctx)

    def error_ctx(self, msg: str, **ctx) -> None:
        self._log_with_ctx(logging.ERROR, msg, **ctx)


def setup_logging(name: str = "slidep") -> SlidepLogger:
    """初始化根日志配置，返回命名 Logger。幂等：重复调用只返回 logger。"""
    logging.setLoggerClass(SlidepLogger)
    root = logging.getLogger(name)
    if root.handlers:
        return root  # type: ignore[return-value]

    level = os.environ.get("SLIDEP_LOG_LEVEL", "INFO").upper()
    root.setLevel(level)

    handler = logging.StreamHandler(sys.stderr)
    if os.environ.get("SLIDEP_LOG_JSON", "1") == "1":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
    root.addHandler(handler)
    root.propagate = False
    return root  # type: ignore[return-value]


def get_logger(name: str = "slidep") -> SlidepLogger:
    """获取带上下文能力的 logger。"""
    return setup_logging().getChild(name)  # type: ignore[return-value]
