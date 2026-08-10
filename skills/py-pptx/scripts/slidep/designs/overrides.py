"""风格包与 lint 联动（T5.1）：不同风格覆盖通用阈值。

设计：
- ``apply_overrides(rules, pack)``：把风格包的 ``lint_overrides`` 合并到 rules.json
- 完全命中（matched）：覆盖 rules.json 中的对应参数
- 软降级（soft_match）：不覆盖（仅结构层生效，常量层保持默认）
- 无命中（no_match）：使用 rules.json 原值

覆盖粒度：参数级（只覆盖 ``lint_overrides`` 中指定的参数，其余保持默认）。
"""

from __future__ import annotations

import copy
from typing import Any

from slidep.designs.models import RoutingResult, StylePack


def apply_overrides(
    rules: dict[str, Any],
    result: RoutingResult,
) -> dict[str, Any]:
    """把风格包的 lint_overrides 合并到 rules.json。

    Args:
        rules: 原始 rules.json dict（不会被修改，返回深拷贝）。
        result: 路由结果。仅 ``matched`` 状态时应用覆盖。

    Returns:
        新的 rules dict（深拷贝 + 覆盖后的版本）。

    覆盖规则：
        - ``matched``：应用 ``lint_overrides``（覆盖对应 rule 的 params）
        - ``soft_match``：不应用（仅结构层生效）
        - ``no_match``：不应用
    """
    merged = copy.deepcopy(rules)

    if not result.is_matched or result.pack is None:
        return merged

    overrides = result.pack.tokens.lint_overrides
    if not overrides:
        return merged

    # 构建 rule_id → rule 的索引
    rule_map: dict[str, dict] = {}
    for rule in merged.get("rules", []):
        rule_map[rule["id"]] = rule

    # 应用覆盖
    for rule_id, param_overrides in overrides.items():
        if rule_id not in rule_map:
            continue
        rule = rule_map[rule_id]
        for param_name, new_value in param_overrides.items():
            rule["params"][param_name] = new_value

    return merged


def get_effective_params(
    rules: dict[str, Any],
    pack: StylePack | None,
    rule_id: str,
) -> dict[str, Any]:
    """获取某条规则的有效参数（合并 lint_overrides 后）。

    Args:
        rules: 原始 rules.json dict。
        pack: 风格包（可为 None，表示使用默认）。
        rule_id: 规则 id。

    Returns:
        该规则的有效参数 dict。
    """
    # 查找原始规则
    original = None
    for rule in rules.get("rules", []):
        if rule["id"] == rule_id:
            original = rule
            break

    if original is None:
        return {}

    params = copy.deepcopy(original.get("params", {}))

    # 应用覆盖
    if pack is not None:
        overrides = pack.tokens.lint_overrides.get(rule_id)
        if overrides:
            params.update(overrides)

    return params


def get_effective_palette(pack: StylePack | None) -> dict[str, str]:
    """获取有效色板（风格包的色板或默认色板）。"""
    if pack is not None:
        p = pack.tokens.palette
        return {
            "primary": p.primary,
            "secondary": p.secondary,
            "accent": p.accent,
            "background": p.background,
            "text": p.text,
            "text_light": p.text_light,
        }
    return {
        "primary": "#1E293B",
        "secondary": "#3B82F6",
        "accent": "#F59E0B",
        "background": "#FFFFFF",
        "text": "#1E293B",
        "text_light": "#64748B",
    }


def get_effective_font_ladder(pack: StylePack | None) -> dict[str, list[int]]:
    """获取有效字号阶梯。"""
    if pack is not None:
        return pack.tokens.font_size_ladder.to_params()
    return {
        "hero_title": [56, 72],
        "title": [32, 40],
        "body": [18, 24],
        "caption": [12, 16],
    }
