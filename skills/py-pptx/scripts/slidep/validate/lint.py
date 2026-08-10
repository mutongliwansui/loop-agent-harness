"""设计规范 Lint 门禁（T3.1）：把 T0.2 方法论变成自动执行的硬门禁。

两类检查：
- **静态检查**（AST 级）：直接读组件属性（字体家族/字号/颜色数量/TOC 条目数）
- **动态检查**（布局级）：消费 T1.2 布局结果（面积/密度/留白/锚点/版式多样性）

规则定义全部读 ``rules.json``（单一数据源），lint 函数与 rules.json 中 ``lint`` 标识一一对应。

公共 API：
- ``validate_deck(slides) -> LintReport``：全量校验
- ``validate_slide(slide, page_index) -> list[LintIssue]``：单页校验
- ``LintReport`` / ``LintIssue``：结果数据结构
"""

from __future__ import annotations

import json
import os
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Optional

from slidep.dsl import Box, Chart, CodeBlock, FAIcon, Image, Math, QRCode, SVG, Slide, Table, Text
from slidep.dsl.styles import Color, Gradient, parse_background, parse_color
from slidep.layout import LayoutNode, LayoutResult, Rect, layout_slide, SLIDE_CONTENT_RECT

#: rules.json 路径
_RULES_PATH = os.path.join(os.path.dirname(__file__), "rules.json")

#: B 区面积（内容区）
_B_AREA = SLIDE_CONTENT_RECT.width * SLIDE_CONTENT_RECT.height

#: 叶子组件类型集合
_LEAF_TYPES = {"Text", "Chart", "Image", "Table", "FAIcon", "SVG", "QRCode", "CodeBlock", "Math"}


# ================================================================ 数据结构

@dataclass
class LintIssue:
    """单条 lint 告警。

    Attributes:
        page: 页码（0-based），``-1`` 表示 deck 级别。
        rule_id: 规则 id（如 ``typography.max_font_families``）。
        rule_name: 规则中文名。
        level: ``"error"`` 或 ``"warning"``。
        actual: 实测值。
        limit: 阈值。
        message: 面向用户的描述。
    """

    page: int
    rule_id: str
    rule_name: str
    level: str  # "error" | "warning"
    actual: Any
    limit: Any
    message: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "page": self.page,
            "rule_id": self.rule_id,
            "rule_name": self.rule_name,
            "level": self.level,
            "actual": self.actual,
            "limit": self.limit,
            "message": self.message,
        }


@dataclass
class LintReport:
    """全量校验报告。"""

    issues: list[LintIssue] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        """无 error 级别告警即通过。"""
        return not any(i.level == "error" for i in self.issues)

    @property
    def error_count(self) -> int:
        return sum(1 for i in self.issues if i.level == "error")

    @property
    def warning_count(self) -> int:
        return sum(1 for i in self.issues if i.level == "warning")

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "error_count": self.error_count,
            "warning_count": self.warning_count,
            "issues": [i.to_dict() for i in self.issues],
        }


# ================================================================ 规则加载

def _load_rules() -> dict:
    """加载 rules.json。"""
    with open(_RULES_PATH, encoding="utf-8") as f:
        return json.load(f)


def _find_rule(rules: dict, rule_id: str) -> dict:
    """按 id 查找规则定义。"""
    for r in rules["rules"]:
        if r["id"] == rule_id:
            return r
    raise KeyError(f"规则 {rule_id} 不在 rules.json 中")


# ================================================================ 辅助：遍历组件树

def _walk_components(slide: Slide):
    """深度优先遍历 slide 的所有组件（含 slide 自身）。"""
    yield slide
    for child in getattr(slide, "children", []):
        yield from _walk_components(child)


def _walk_texts(slide: Slide):
    """遍历 slide 中所有 Text 组件。"""
    for comp in _walk_components(slide):
        if isinstance(comp, Text):
            yield comp


def _walk_boxes(slide: Slide):
    """遍历 slide 中所有 Box 组件。"""
    for comp in _walk_components(slide):
        if isinstance(comp, Box):
            yield comp


def _walk_images(slide: Slide):
    """遍历 slide 中所有 Image 组件。"""
    for comp in _walk_components(slide):
        if isinstance(comp, Image):
            yield comp


# ================================================================ 辅助：颜色提取

def _extract_colors(slide: Slide) -> set[str]:
    """提取页面中使用的所有 hex 颜色（规范化为 #rrggbb）。"""
    colors: set[str] = set()
    for comp in _walk_components(slide):
        style = comp.style
        # background
        if "background" in style:
            try:
                bg = parse_background(style["background"], "background")
                if isinstance(bg, Color):
                    colors.add(bg.hex6)
                elif isinstance(bg, Gradient):
                    colors.add(bg.start.hex6)
                    colors.add(bg.end.hex6)
            except Exception:
                pass
        # color (Text/FAIcon/Math)
        if "color" in style:
            try:
                c = parse_color(style["color"], "color")
                colors.add(c.hex6)
            except Exception:
                pass
    return colors


def _color_area_map(slide: Slide, layout: Optional[LayoutResult]) -> dict[str, float]:
    """计算每个颜色在 B 区的覆盖面积。

    遍历布局节点，把有 background 的 Box/Slide 和有 color 的 Text 的面积
    归到对应 hex 颜色。
    """
    area_map: dict[str, float] = defaultdict(float)

    if layout is None:
        return dict(area_map)

    for node in layout.nodes:
        comp = node.component
        rect = node.rect
        if rect is None:
            continue
        # 跳过 Slide 根节点（覆盖整画布，不计入 B 区色面积）
        if isinstance(comp, Slide):
            continue
        area = rect.width * rect.height

        style = comp.style
        if "background" in style:
            try:
                bg = parse_background(style["background"], "background")
                if isinstance(bg, Color):
                    area_map[bg.hex6] += area
                elif isinstance(bg, Gradient):
                    area_map[bg.start.hex6] += area * 0.5
                    area_map[bg.end.hex6] += area * 0.5
            except Exception:
                pass
        elif isinstance(comp, Text) and "color" in style:
            try:
                c = parse_color(style["color"], "color")
                area_map[c.hex6] += area
            except Exception:
                pass

    return dict(area_map)


# ================================================================ 辅助：布局分析

def _content_area_used(layout: Optional[LayoutResult]) -> float:
    """B 区内实际被元素覆盖的面积（含重叠，取并集近似为 sum）。"""
    if layout is None:
        return 0.0
    total = 0.0
    for node in layout.nodes:
        if node.rect is None:
            continue
        comp = node.component
        if isinstance(comp, Slide):
            continue
        # 只计算有可见样式的节点（background 或 Text 有内容）
        has_bg = "background" in comp.style
        is_text = isinstance(comp, Text) and comp.text.strip()
        is_media = isinstance(comp, (Image, Chart, Table, QRCode, SVG, CodeBlock, Math, FAIcon))
        if has_bg or is_text or is_media:
            total += node.rect.width * node.rect.height
    return total


def _is_asymmetric(slide: Slide) -> bool:
    """判断页面是否为非对称版式（justifyContent != center 或有 absolute 定位）。"""
    for box in _walk_boxes(slide):
        jc = box.style.get("justifyContent", "")
        if jc == "flex-start" or jc == "flex-end" or jc == "space-between":
            return True
        pos = box.style.get("position", "")
        if pos == "absolute":
            return True
    # Slide 自身的 justifyContent
    jc = slide.style.get("justifyContent", "")
    if jc == "flex-start" or jc == "flex-end" or jc == "space-between":
        return True
    return False


def _is_card_row(slide: Slide) -> bool:
    """判断页面是否为 N 卡片横排版式（row + 多个子元素）。"""
    for box in _walk_boxes(slide):
        if box.style.get("flexDirection") == "row" and len(box.children) >= 2:
            return True
    if slide.style.get("flexDirection") == "row" and len(slide.children) >= 2:
        return True
    return False


def _max_font_size_on_page(slide: Slide) -> float:
    """页面最大字号。"""
    sizes = [t.style.get("fontSize", 18) for t in _walk_texts(slide) if "fontSize" in t.style]
    return max(sizes) if sizes else 0.0


def _text_char_count(slide: Slide) -> int:
    """页面文本字符总数（不含空白）。"""
    return sum(len(t.text.replace(" ", "").replace("\n", "")) for t in _walk_texts(slide))


# ================================================================ 检查函数

# ---- typography.max_font_families ----
def validate_font_families(slides: list[Slide], rules: dict) -> list[LintIssue]:
    """字体家族上限：全篇 ≤ 2 个字体家族。"""
    rule = _find_rule(rules, "typography.max_font_families")
    max_families = rule["params"]["max"]

    families: set[str] = set()
    for slide in slides:
        for text in _walk_texts(slide):
            ff = text.style.get("fontFamily")
            if ff:
                families.add(ff)

    issues: list[LintIssue] = []
    if len(families) > max_families:
        issues.append(LintIssue(
            page=-1,
            rule_id=rule["id"],
            rule_name=rule["name"],
            level=rule["level"],
            actual=len(families),
            limit=max_families,
            message=f"全篇使用 {len(families)} 个字体家族 {sorted(families)}，超过上限 {max_families}",
        ))
    return issues


# ---- typography.size_ladder ----
def validate_font_sizes(slides: list[Slide], rules: dict) -> list[LintIssue]:
    """字号阶梯合法：每个字号必须落在某一级阶梯区间内。"""
    rule = _find_rule(rules, "typography.size_ladder")
    ladder = rule["params"]

    issues: list[LintIssue] = []
    for page_idx, slide in enumerate(slides):
        for text in _walk_texts(slide):
            size = text.style.get("fontSize")
            if size is None:
                continue
            size = float(size)
            # 检查是否落在任一阶梯
            in_range = False
            for level_name, (lo, hi) in ladder.items():
                if lo <= size <= hi:
                    in_range = True
                    break
            if not in_range:
                issues.append(LintIssue(
                    page=page_idx,
                    rule_id=rule["id"],
                    rule_name=rule["name"],
                    level=rule["level"],
                    actual=size,
                    limit=str(ladder),
                    message=f"字号 {size}px 不在任一阶梯区间内（title/hero_title/body/caption）",
                ))
    return issues


# ---- typography.min_body_chars + layout.max_whitespace_ratio + layout.card_fill_min_ratio ----
def validate_density(
    slides: list[Slide],
    rules: dict,
    layouts: Optional[list[LayoutResult]] = None,
) -> list[LintIssue]:
    """密度检查：正文字数下限 / 留白上限 / 卡片填充率下限。"""
    char_rule = _find_rule(rules, "typography.min_body_chars")
    min_chars = char_rule["params"]["min"]
    ws_rule = _find_rule(rules, "layout.max_whitespace_ratio")
    max_ws = ws_rule["params"]["max"]
    fill_rule = _find_rule(rules, "layout.card_fill_min_ratio")
    min_fill = fill_rule["params"]["min"]

    issues: list[LintIssue] = []

    for page_idx, slide in enumerate(slides):
        # 只检查 content 页
        if slide.page_type != "content":
            continue

        # ---- 正文字数 ----
        char_count = _text_char_count(slide)
        if char_count < min_chars:
            issues.append(LintIssue(
                page=page_idx,
                rule_id=char_rule["id"],
                rule_name=char_rule["name"],
                level=char_rule["level"],
                actual=char_count,
                limit=min_chars,
                message=f"正文字数 {char_count} 字，少于下限 {min_chars} 字",
            ))

        # ---- 留白率 / 卡片填充率（需要布局结果）----
        if layouts and page_idx < len(layouts):
            layout = layouts[page_idx]
            if layout is None:
                continue
            used = _content_area_used(layout)
            ws_ratio = 1.0 - (used / _B_AREA) if _B_AREA > 0 else 0.0
            if ws_ratio > max_ws:
                issues.append(LintIssue(
                    page=page_idx,
                    rule_id=ws_rule["id"],
                    rule_name=ws_rule["name"],
                    level=ws_rule["level"],
                    actual=round(ws_ratio, 3),
                    limit=max_ws,
                    message=f"留白率 {ws_ratio:.1%}，超过上限 {max_ws:.0%}",
                ))

            # ---- 卡片填充率 ----
            for node in layout.nodes:
                comp = node.component
                if not isinstance(comp, Box):
                    continue
                if "background" not in comp.style:
                    continue  # 不是卡片
                if node.rect is None:
                    continue
                card_area = node.rect.width * node.rect.height
                if card_area <= 0:
                    continue
                # 计算子元素覆盖面积
                child_area = 0.0
                for child in node.children:
                    if child.rect is None:
                        continue
                    child_area += child.rect.width * child.rect.height
                fill_ratio = min(child_area / card_area, 1.0) if card_area > 0 else 0.0
                if fill_ratio < min_fill:
                    issues.append(LintIssue(
                        page=page_idx,
                        rule_id=fill_rule["id"],
                        rule_name=fill_rule["name"],
                        level=fill_rule["level"],
                        actual=round(fill_ratio, 3),
                        limit=min_fill,
                        message=f"卡片填充率 {fill_ratio:.0%}，低于下限 {min_fill:.0%}",
                    ))

    return issues


# ---- typography.anchor_min_size + anchor.per_page_required + anchor.min_image_area_ratio ----
def validate_anchor(
    slides: list[Slide],
    rules: dict,
    layouts: Optional[list[LayoutResult]] = None,
) -> list[LintIssue]:
    """锚点检查：每页 ≥1 视觉锚点（≥44px 文字或 ≥40% 面积图）。"""
    required_rule = _find_rule(rules, "anchor.per_page_required")
    min_size_rule = _find_rule(rules, "typography.anchor_min_size")
    min_anchor_size = min_size_rule["params"]["min"]
    img_rule = _find_rule(rules, "anchor.min_image_area_ratio")
    min_img_ratio = img_rule["params"]["min"]

    issues: list[LintIssue] = []

    for page_idx, slide in enumerate(slides):
        if slide.page_type != "content":
            continue

        has_anchor = False

        # ---- 文字锚点：≥44px ----
        for text in _walk_texts(slide):
            size = text.style.get("fontSize", 0)
            if size and float(size) >= min_anchor_size:
                has_anchor = True
                break

        # ---- 图片锚点：面积 ≥ 40% B 区 ----
        if not has_anchor and layouts and page_idx < len(layouts):
            layout = layouts[page_idx]
            if layout is None:
                continue
            for node in layout.nodes:
                comp = node.component
                if not isinstance(comp, (Image, Chart)):
                    continue
                if node.rect is None:
                    continue
                img_area = node.rect.width * node.rect.height
                ratio = img_area / _B_AREA if _B_AREA > 0 else 0.0
                if ratio >= min_img_ratio:
                    has_anchor = True
                    break
                # 图片面积不足但仍有图：记录告警
                elif isinstance(comp, Image):
                    issues.append(LintIssue(
                        page=page_idx,
                        rule_id=img_rule["id"],
                        rule_name=img_rule["name"],
                        level=img_rule["level"],
                        actual=round(ratio, 3),
                        limit=min_img_ratio,
                        message=f"图片锚点面积占比 {ratio:.0%}，低于下限 {min_img_ratio:.0%}",
                    ))

        if not has_anchor:
            issues.append(LintIssue(
                page=page_idx,
                rule_id=required_rule["id"],
                rule_name=required_rule["name"],
                level=required_rule["level"],
                actual=0,
                limit=1,
                message=f"页面无视觉锚点（需 ≥{min_anchor_size}px 文字或 ≥{min_img_ratio:.0%} B 区面积图片）",
            ))

    return issues


# ---- color.max_theme_colors ----
def validate_color_palette(slides: list[Slide], rules: dict) -> list[LintIssue]:
    """主题色数量上限：全篇 ≤ 4 个 hex。"""
    rule = _find_rule(rules, "color.max_theme_colors")
    max_colors = rule["params"]["max"]

    all_colors: set[str] = set()
    for slide in slides:
        all_colors |= _extract_colors(slide)

    issues: list[LintIssue] = []
    if len(all_colors) > max_colors:
        issues.append(LintIssue(
            page=-1,
            rule_id=rule["id"],
            rule_name=rule["name"],
            level=rule["level"],
            actual=len(all_colors),
            limit=max_colors,
            message=f"全篇使用 {len(all_colors)} 个主题色 {sorted(all_colors)}，超过上限 {max_colors}",
        ))
    return issues


# ---- color.primary_ratio + color.secondary_ratio + color.accent_ratio + color.accent_ratio_hero ----
def validate_color_ratio(
    slides: list[Slide],
    rules: dict,
    layouts: Optional[list[LayoutResult]] = None,
) -> list[LintIssue]:
    """色彩面积占比检查：主/辅/强调色面积不超过阈值。"""
    primary_rule = _find_rule(rules, "color.primary_ratio")
    secondary_rule = _find_rule(rules, "color.secondary_ratio")
    accent_rule = _find_rule(rules, "color.accent_ratio")
    accent_hero_rule = _find_rule(rules, "color.accent_ratio_hero")

    issues: list[LintIssue] = []

    if not layouts:
        return issues

    for page_idx, slide in enumerate(slides):
        if page_idx >= len(layouts):
            continue
        layout = layouts[page_idx]
        if layout is None:
            continue
        area_map = _color_area_map(slide, layout)

        if not area_map:
            continue

        # 按面积降序排列
        sorted_colors = sorted(area_map.items(), key=lambda x: -x[1])
        total_area = sum(area_map.values())
        if total_area <= 0:
            continue

        is_hero = slide.role == "hero"

        for rank, (color_hex, area) in enumerate(sorted_colors):
            ratio = area / _B_AREA if _B_AREA > 0 else 0.0
            if rank == 0:
                # 主色
                if ratio > primary_rule["params"]["max"]:
                    issues.append(LintIssue(
                        page=page_idx,
                        rule_id=primary_rule["id"],
                        rule_name=primary_rule["name"],
                        level=primary_rule["level"],
                        actual=round(ratio, 3),
                        limit=primary_rule["params"]["max"],
                        message=f"主色 {color_hex} 面积占比 {ratio:.0%}，超过上限 {primary_rule['params']['max']:.0%}",
                    ))
            elif rank == 1:
                # 辅色
                if ratio > secondary_rule["params"]["max"]:
                    issues.append(LintIssue(
                        page=page_idx,
                        rule_id=secondary_rule["id"],
                        rule_name=secondary_rule["name"],
                        level=secondary_rule["level"],
                        actual=round(ratio, 3),
                        limit=secondary_rule["params"]["max"],
                        message=f"辅色 {color_hex} 面积占比 {ratio:.0%}，超过上限 {secondary_rule['params']['max']:.0%}",
                    ))
            else:
                # 强调色
                limit = accent_hero_rule["params"]["max"] if is_hero else accent_rule["params"]["max"]
                rule_ref = accent_hero_rule if is_hero else accent_rule
                if ratio > limit:
                    issues.append(LintIssue(
                        page=page_idx,
                        rule_id=rule_ref["id"],
                        rule_name=rule_ref["name"],
                        level=rule_ref["level"],
                        actual=round(ratio, 3),
                        limit=limit,
                        message=f"强调色 {color_hex} 面积占比 {ratio:.0%}，超过上限 {limit:.0%}",
                    ))

    return issues


# ---- layout.asymmetric_min_ratio + layout.card_row_max_pages ----
def validate_layout_diversity(
    slides: list[Slide],
    rules: dict,
    layouts: Optional[list[LayoutResult]] = None,
) -> list[LintIssue]:
    """版式多样性：非对称版式占比 ≥ 40%，N 卡片横排页数 ≤ 2。"""
    asym_rule = _find_rule(rules, "layout.asymmetric_min_ratio")
    card_rule = _find_rule(rules, "layout.card_row_max_pages")

    issues: list[LintIssue] = []

    # ---- 非对称版式占比 ----
    content_pages = [s for s in slides if s.page_type == "content"]
    if content_pages:
        asym_count = sum(1 for s in content_pages if _is_asymmetric(s))
        asym_ratio = asym_count / len(content_pages)
        if asym_ratio < asym_rule["params"]["min"]:
            issues.append(LintIssue(
                page=-1,
                rule_id=asym_rule["id"],
                rule_name=asym_rule["name"],
                level=asym_rule["level"],
                actual=round(asym_ratio, 3),
                limit=asym_rule["params"]["min"],
                message=f"非对称版式占比 {asym_ratio:.0%}，低于下限 {asym_rule['params']['min']:.0%}",
            ))

    # ---- N 卡片横排页数 ----
    card_row_pages = sum(1 for s in slides if _is_card_row(s))
    if card_row_pages > card_rule["params"]["max"]:
        issues.append(LintIssue(
            page=-1,
            rule_id=card_rule["id"],
            rule_name=card_rule["name"],
            level=card_rule["level"],
            actual=card_row_pages,
            limit=card_rule["params"]["max"],
            message=f"N 卡片横排版式 {card_row_pages} 页，超过上限 {card_rule['params']['max']} 页",
        ))

    return issues


# ---- layout.hero_page_ratio ----
def validate_hero_quota(slides: list[Slide], rules: dict) -> list[LintIssue]:
    """Hero 页配额：占全篇 20%-30%。"""
    rule = _find_rule(rules, "layout.hero_page_ratio")
    min_ratio = rule["params"]["min"]
    max_ratio = rule["params"]["max"]

    if not slides:
        return []

    hero_count = sum(1 for s in slides if s.role == "hero")
    ratio = hero_count / len(slides)

    issues: list[LintIssue] = []
    if ratio < min_ratio:
        issues.append(LintIssue(
            page=-1,
            rule_id=rule["id"],
            rule_name=rule["name"],
            level=rule["level"],
            actual=round(ratio, 3),
            limit=f"[{min_ratio}, {max_ratio}]",
            message=f"Hero 页占比 {ratio:.0%}（{hero_count}/{len(slides)}），低于下限 {min_ratio:.0%}",
        ))
    elif ratio > max_ratio:
        issues.append(LintIssue(
            page=-1,
            rule_id=rule["id"],
            rule_name=rule["name"],
            level=rule["level"],
            actual=round(ratio, 3),
            limit=f"[{min_ratio}, {max_ratio}]",
            message=f"Hero 页占比 {ratio:.0%}（{hero_count}/{len(slides)}），超过上限 {max_ratio:.0%}",
        ))
    return issues


# ---- image.l1_area + image.l2_min_size + image.l3_max_size ----
def validate_image_tiers(
    slides: list[Slide],
    rules: dict,
    layouts: Optional[list[LayoutResult]] = None,
) -> list[LintIssue]:
    """图片分级检查：L1 面积 / L2 尺寸 / L3 角标。"""
    l1_rule = _find_rule(rules, "image.l1_area")
    l2_rule = _find_rule(rules, "image.l2_min_size")
    l3_rule = _find_rule(rules, "image.l3_max_size")

    l1_min = l1_rule["params"]["min"]
    l2_min_w = l2_rule["params"]["min"]["width"]
    l2_min_h = l2_rule["params"]["min"]["height"]
    l3_max = l3_rule["params"]["max"]

    issues: list[LintIssue] = []

    if not layouts:
        return issues

    for page_idx, slide in enumerate(slides):
        if slide.page_type != "content":
            continue
        if page_idx >= len(layouts):
            continue

        layout = layouts[page_idx]
        if layout is None:
            continue
        # 收集页面所有图片的尺寸
        img_sizes: list[tuple[float, float]] = []
        for node in layout.nodes:
            comp = node.component
            if not isinstance(comp, Image):
                continue
            if node.rect is None:
                continue
            w, h = node.rect.width, node.rect.height
            img_sizes.append((w, h))

        if not img_sizes:
            continue

        # 按面积降序排序
        img_sizes.sort(key=lambda wh: -(wh[0] * wh[1]))

        # L1: 最大图片面积 ≥ 40% B 区
        l1_w, l1_h = img_sizes[0]
        l1_area = l1_w * l1_h
        l1_ratio = l1_area / _B_AREA if _B_AREA > 0 else 0.0
        if l1_ratio < l1_min:
            issues.append(LintIssue(
                page=page_idx,
                rule_id=l1_rule["id"],
                rule_name=l1_rule["name"],
                level=l1_rule["level"],
                actual=round(l1_ratio, 3),
                limit=l1_min,
                message=f"L1 主视觉面积占比 {l1_ratio:.0%}，低于下限 {l1_min:.0%}",
            ))

        # L2: 中等图片尺寸 ≥ 280×180
        for w, h in img_sizes[1:]:
            if w < l3_max and h < l3_max:
                continue  # L3 跳过
            if w < l2_min_w or h < l2_min_h:
                issues.append(LintIssue(
                    page=page_idx,
                    rule_id=l2_rule["id"],
                    rule_name=l2_rule["name"],
                    level=l2_rule["level"],
                    actual=f"{w:.0f}x{h:.0f}",
                    limit=f"{l2_min_w}x{l2_min_h}",
                    message=f"L2 支撑图尺寸 {w:.0f}x{h:.0f}，小于下限 {l2_min_w}x{l2_min_h}",
                ))

        # L3: 角标 ≤ 64x64
        for w, h in img_sizes:
            if w <= l3_max and h <= l3_max:
                continue  # 合规 L3
            # 非角标但很小的图片不触发 L3 检查

    return issues


# ---- toc.max_entries ----
def validate_toc(slides: list[Slide], rules: dict) -> list[LintIssue]:
    """目录条目上限：≤ 8 条。"""
    rule = _find_rule(rules, "toc.max_entries")
    max_entries = rule["params"]["max"]

    issues: list[LintIssue] = []
    for page_idx, slide in enumerate(slides):
        if slide.page_type != "toc":
            continue
        # TOC 条目 = children 数量（每个 child 代表一条目录）
        entries = len(slide.children)
        if entries > max_entries:
            issues.append(LintIssue(
                page=page_idx,
                rule_id=rule["id"],
                rule_name=rule["name"],
                level=rule["level"],
                actual=entries,
                limit=max_entries,
                message=f"目录条目 {entries} 条，超过上限 {max_entries} 条",
            ))
    return issues


# ---- structure.max_nesting_depth ----
def _max_depth(comp, level: int = 1) -> int:
    """组件树最大嵌套深度（Slide 根节点为第 1 层）。"""
    children = getattr(comp, "children", [])
    if not children:
        return level
    return max(_max_depth(c, level + 1) for c in children)


def validate_nesting_depth(slides: list[Slide], rules: dict) -> list[LintIssue]:
    """容器嵌套深度上限：不超过 5 层（Box 过多嵌套难维护）。"""
    rule = _find_rule(rules, "structure.max_nesting_depth")
    max_depth = rule["params"]["max"]

    issues: list[LintIssue] = []
    for page_idx, slide in enumerate(slides):
        depth = _max_depth(slide)
        if depth > max_depth:
            issues.append(LintIssue(
                page=page_idx,
                rule_id=rule["id"],
                rule_name=rule["name"],
                level=rule["level"],
                actual=depth,
                limit=max_depth,
                message=f"组件嵌套深度 {depth} 层，超过上限 {max_depth} 层；优先用 flex 分配而非层层嵌套",
            ))
    return issues


# ================================================================ 公共 API

#: lint 函数注册表（与 rules.json lint 标识一一对应）
_LINT_REGISTRY = {
    "validate_font_families": validate_font_families,
    "validate_font_sizes": validate_font_sizes,
    "validate_density": validate_density,
    "validate_anchor": validate_anchor,
    "validate_color_palette": validate_color_palette,
    "validate_color_ratio": validate_color_ratio,
    "validate_layout_diversity": validate_layout_diversity,
    "validate_hero_quota": validate_hero_quota,
    "validate_image_tiers": validate_image_tiers,
    "validate_toc": validate_toc,
    "validate_nesting_depth": validate_nesting_depth,
}


def validate_deck(
    slides: list[Slide],
    run_layout: bool = True,
) -> LintReport:
    """全量校验 deck。

    Args:
        slides: 全部页面列表。
        run_layout: 是否执行布局计算（动态检查需要）。``False`` 时仅做静态检查。

    Returns:
        LintReport，含全部告警。
    """
    rules = _load_rules()
    issues: list[LintIssue] = []

    # 布局计算（动态检查需要）
    layouts: Optional[list[LayoutResult]] = None
    if run_layout:
        layouts = []
        for slide in slides:
            try:
                layouts.append(layout_slide(slide))
            except Exception:
                # 布局失败（如溢出）不影响 lint 执行
                layouts.append(None)

    # 静态检查（不需要布局结果）
    issues.extend(validate_font_families(slides, rules))
    issues.extend(validate_font_sizes(slides, rules))
    issues.extend(validate_color_palette(slides, rules))
    issues.extend(validate_hero_quota(slides, rules))
    issues.extend(validate_toc(slides, rules))
    issues.extend(validate_nesting_depth(slides, rules))

    # 动态检查（需要布局结果）
    issues.extend(validate_density(slides, rules, layouts))
    issues.extend(validate_anchor(slides, rules, layouts))
    issues.extend(validate_color_ratio(slides, rules, layouts))
    issues.extend(validate_layout_diversity(slides, rules, layouts))
    issues.extend(validate_image_tiers(slides, rules, layouts))

    return LintReport(issues=issues)


def validate_slide(slide: Slide, page_index: int = 0) -> list[LintIssue]:
    """单页校验（不含 deck 级别规则）。

    Args:
        slide: 单个页面。
        page_index: 页码（0-based），用于告警定位。

    Returns:
        告警列表（不含 hero_quota / layout_diversity 等 deck 级规则）。
    """
    rules = _load_rules()

    layout: Optional[LayoutResult] = None
    try:
        layout = layout_slide(slide)
    except Exception:
        layout = None

    layouts = [layout]

    issues: list[LintIssue] = []
    # 单页校验时，page_index 用于覆盖默认的 0
    # 静态检查
    issues.extend(validate_font_families([slide], rules))
    issues.extend(validate_font_sizes([slide], rules))
    issues.extend(validate_color_palette([slide], rules))
    issues.extend(validate_toc([slide], rules))
    issues.extend(validate_nesting_depth([slide], rules))

    # 动态检查
    issues.extend(validate_density([slide], rules, layouts))
    issues.extend(validate_anchor([slide], rules, layouts))
    issues.extend(validate_color_ratio([slide], rules, layouts))
    issues.extend(validate_image_tiers([slide], rules, layouts))

    # 覆盖 page 索引
    for issue in issues:
        if issue.page == 0:
            issue.page = page_index

    return issues
