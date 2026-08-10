"""代码块渲染器（T2.2）：语法高亮 + 等宽字体 → PNG bytes。

使用 Pillow ImageDraw 渲染多色代码，支持基础语法高亮：
- 关键字（语言特定）
- 字符串（单/双引号）
- 注释（# 或 //）
- 数字
- 函数名

支持语言：python / javascript / java / go / sql / json / yaml / bash / text
"""

from __future__ import annotations

import io
import re
from typing import Optional

from PIL import Image, ImageDraw, ImageFont

from slidep import ErrorCode, render_error

#: 暗色主题配色
_THEME = {
    "bg": (30, 30, 38),       # #1E1E26
    "fg": (213, 213, 213),     # #D5D5D5
    "keyword": (86, 156, 214),  # #569CD6 蓝
    "string": (206, 145, 120),  # #CE9178 橙
    "comment": (106, 153, 85),  # #6A9955 绿
    "number": (181, 206, 168),  # #B5CEA8 浅绿
    "func": (220, 220, 170),    # #DCDCAA 黄
    "lineno": (133, 133, 133),  # #858585 灰
}

#: 各语言关键字集
_KEYWORDS: dict[str, set[str]] = {
    "python": {"def", "class", "if", "else", "elif", "for", "while", "return", "import",
               "from", "as", "try", "except", "finally", "with", "lambda", "yield",
               "global", "nonlocal", "pass", "break", "continue", "True", "False",
               "None", "and", "or", "not", "in", "is", "raise", "assert", "del"},
    "javascript": {"var", "let", "const", "function", "if", "else", "for", "while",
                   "return", "class", "extends", "super", "this", "new", "try", "catch",
                   "finally", "throw", "typeof", "instanceof", "in", "of", "delete",
                   "void", "do", "switch", "case", "break", "continue", "default",
                   "true", "false", "null", "undefined", "async", "await", "yield",
                   "import", "from", "export", "as"},
    "java": {"public", "private", "protected", "class", "interface", "extends", "implements",
             "static", "final", "void", "int", "long", "double", "float", "boolean", "char",
             "String", "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
             "return", "new", "this", "super", "try", "catch", "finally", "throw", "throws",
             "import", "package", "null", "true", "false", "instanceof", "synchronized",
             "abstract", "enum", "var"},
    "go": {"func", "var", "const", "type", "struct", "interface", "package", "import",
           "if", "else", "for", "range", "switch", "case", "default", "break", "continue",
           "return", "go", "defer", "select", "chan", "map", "nil", "true", "false",
           "make", "new", "len", "cap", "append", "copy"},
    "sql": {"SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE",
            "CREATE", "TABLE", "ALTER", "DROP", "INDEX", "VIEW", "JOIN", "LEFT", "RIGHT",
            "INNER", "OUTER", "ON", "AS", "ORDER", "BY", "GROUP", "HAVING", "LIMIT", "OFFSET",
            "AND", "OR", "NOT", "IN", "EXISTS", "BETWEEN", "LIKE", "IS", "NULL", "DISTINCT",
            "UNION", "ALL", "CASE", "WHEN", "THEN", "ELSE", "END", "COUNT", "SUM", "AVG",
            "MIN", "MAX"},
    "json": {"true", "false", "null"},
    "yaml": {"true", "false", "null", "yes", "no"},
    "bash": {"if", "then", "else", "elif", "fi", "for", "do", "done", "while", "case",
             "esac", "function", "return", "local", "export", "echo", "printf", "read",
             "source", "exit", "cd", "pwd", "ls", "cp", "mv", "rm", "mkdir", "chmod"},
}

#: 注释前缀（按语言）
_COMMENT_PREFIX: dict[str, str] = {
    "python": "#", "yaml": "#", "bash": "#",
    "javascript": "//", "java": "//", "go": "//",
    "sql": "--",
    "json": "",  # JSON 无注释
    "text": "",
}

#: 字体缓存
_font_cache: dict[int, ImageFont.FreeTypeFont] = {}
_mono_font_path: Optional[str] = None


def _get_mono_font_path() -> Optional[str]:
    """查找系统等宽字体路径。"""
    global _mono_font_path
    if _mono_font_path is not None:
        return _mono_font_path
    # 优先用 matplotlib 自带 DejaVu Sans Mono
    try:
        import matplotlib.font_manager as fm
        for f in fm.fontManager.ttflist:
            if f.name == "DejaVu Sans Mono":
                _mono_font_path = f.fname
                return _mono_font_path
    except ImportError:
        pass
    # Windows 退化
    import os
    for p in ["C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/cour.ttf"]:
        if os.path.isfile(p):
            _mono_font_path = p
            return _mono_font_path
    return None


def _get_font(size: int) -> ImageFont.FreeTypeFont:
    """获取等宽字体（带缓存）。"""
    if size not in _font_cache:
        path = _get_mono_font_path()
        if path:
            _font_cache[size] = ImageFont.truetype(path, size)
        else:
            _font_cache[size] = ImageFont.load_default()
    return _font_cache[size]


def _tokenize_line(line: str, language: str) -> list[tuple[str, str]]:
    """将一行代码分词为 (text, token_type) 序列。

    token_type: 'keyword' | 'string' | 'comment' | 'number' | 'func' | 'fg'
    """
    if not line:
        return [("", "fg")]

    comment_prefix = _COMMENT_PREFIX.get(language, "")
    kw_set = _KEYWORDS.get(language, set())

    # 先提取注释（行内注释）
    comment_text = ""
    code_part = line
    if comment_prefix:
        idx = line.find(comment_prefix)
        if idx >= 0:
            # 确保不是字符串内的
            before = line[:idx]
            quote_count = before.count('"') + before.count("'")
            if quote_count % 2 == 0:
                code_part = line[:idx]
                comment_text = line[idx:]

    tokens: list[tuple[str, str]] = []
    # 正则：字符串、数字、标识符、其他
    pattern = re.compile(
        r'(?P<string>"[^"]*"|\'[^\']*\')'
        r'|(?P<number>\b\d+\.?\d*\b)'
        r'|(?P<ident>[a-zA-Z_]\w*)'
        r'|(?P<other>\s+|[^\s\w])'
    )

    pos = 0
    for m in pattern.finditer(code_part):
        if m.start() > pos:
            tokens.append((code_part[pos:m.start()], "fg"))
        if m.group("string"):
            tokens.append((m.group("string"), "string"))
        elif m.group("number"):
            tokens.append((m.group("number"), "number"))
        elif m.group("ident"):
            word = m.group("ident")
            if word in kw_set:
                tokens.append((word, "keyword"))
            else:
                # 检查是否是函数调用（后面跟 '('）
                rest = code_part[m.end():]
                if rest and rest[0] == "(":
                    tokens.append((word, "func"))
                else:
                    tokens.append((word, "fg"))
        elif m.group("other"):
            tokens.append((m.group("other"), "fg"))
        pos = m.end()

    if pos < len(code_part):
        tokens.append((code_part[pos:], "fg"))

    if comment_text:
        tokens.append((comment_text, "comment"))

    return tokens


def render_codeblock_png(
    code: str,
    language: str,
    width_px: float,
    height_px: float,
) -> bytes:
    """渲染代码块为 PNG bytes。

    Args:
        code: 代码文本
        language: 语法高亮语言
        width_px: 目标宽度
        height_px: 目标高度

    Returns:
        PNG 图片字节流（暗色主题）
    """
    lines = code.split("\n")
    n_lines = len(lines)

    # 字号根据行数和高度自适应
    font_size = min(16, max(10, int(height_px / (n_lines * 1.6))))
    font = _get_font(font_size)
    line_h = int(font_size * 1.5)
    lineno_w = len(str(n_lines)) * font_size + font_size * 2  # 行号区域宽度

    # 计算实际画布尺寸
    canvas_w = max(int(width_px), lineno_w + 100)
    canvas_h = max(int(height_px), n_lines * line_h + 20)

    img = Image.new("RGBA", (canvas_w, canvas_h), _THEME["bg"])
    draw = ImageDraw.Draw(img)

    y = 10
    for i, line in enumerate(lines, 1):
        # 行号
        lineno_str = f"{i:>{len(str(n_lines))}} "
        draw.text((8, y), lineno_str, fill=_THEME["lineno"], font=font)

        # 代码内容
        x = lineno_w
        tokens = _tokenize_line(line, language)
        for text, token_type in tokens:
            color = _THEME.get(token_type, _THEME["fg"])
            draw.text((x, y), text, fill=color, font=font)
            # 估算文本宽度（等宽字体）
            x += len(text) * font_size * 0.6

        y += line_h

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf.getvalue()
