"""关键词路由（T5.1）：用户 query → 风格包匹配。

三态路由：
- ``matched``：query 命中某风格包的 keywords → 完全命中，结构层+常量层生效
- ``soft_match``：query 命中某风格包的 soft_keywords → 软降级，仅结构层生效
- ``no_match``：无命中 → 使用通用风格

匹配算法：
- 中文分词简化为关键词子串匹配（不依赖 jieba，直接 ``in`` 检测）
- 多风格包同时命中时取 score 最高的
- score = matched_keyword_count / max(len(query_keywords), 1)
"""

from __future__ import annotations

import re
from typing import Optional

from slidep.designs.builtin import BUILTIN_PACKS, get_builtin_pack
from slidep.designs.models import RoutingResult, StylePack

#: 通用风格包 id（无命中时 fallback）
DEFAULT_PACK_ID = "general"

#: 中英文分词正则（中文按字，英文按单词）
_TOKEN_RE = re.compile(r"[\u4e00-\u9fff]|[a-zA-Z]+")


def _tokenize(query: str) -> list[str]:
    """简单分词：中文按单字，英文按单词。

    用于扩展匹配（query 的每个 token 检查是否在 keywords 中）。
    """
    return _TOKEN_RE.findall(query.lower())


def _count_matches(query_lower: str, keywords: list[str]) -> list[str]:
    """统计 query 命中了哪些关键词。"""
    matched = []
    for kw in keywords:
        if kw.lower() in query_lower:
            matched.append(kw)
    return matched


def route_query(query: str, packs: Optional[list[StylePack]] = None) -> RoutingResult:
    """关键词路由：query → 风格包匹配。

    Args:
        query: 用户输入的主题/需求描述（如「季度业务汇报」）。
        packs: 候选风格包列表，默认使用全部内置风格包。

    Returns:
        RoutingResult：三态结果（matched / soft_match / no_match）。

    路由规则：
        1. 遍历所有风格包的 ``keywords``，命中数最多的为 ``matched``
        2. 若无 keyword 命中，检查 ``soft_keywords``，命中则为 ``soft_match``
        3. 都无命中 → ``no_match``，返回通用风格包
        4. 多个风格包 keyword 命中数相同时，取 score 更高的
    """
    if packs is None:
        packs = BUILTIN_PACKS

    query_lower = query.lower()

    # ---- 第一轮：硬关键词匹配 ----
    best_pack: Optional[StylePack] = None
    best_keywords: list[str] = []
    best_score = 0.0

    for pack in packs:
        matched = _count_matches(query_lower, pack.keywords)
        if matched:
            score = len(matched) / max(len(pack.keywords), 1)
            if score > best_score or (score == best_score and len(matched) > len(best_keywords)):
                best_pack = pack
                best_keywords = matched
                best_score = score

    if best_pack is not None:
        return RoutingResult(
            status="matched",
            pack=best_pack,
            matched_keywords=best_keywords,
            score=round(best_score, 4),
        )

    # ---- 第二轮：软关键词匹配 ----
    best_pack = None
    best_keywords = []
    best_score = 0.0

    for pack in packs:
        if pack.id == DEFAULT_PACK_ID:
            continue  # 通用风格不参与软匹配
        matched = _count_matches(query_lower, pack.soft_keywords)
        if matched:
            score = len(matched) / max(len(pack.soft_keywords), 1)
            if score > best_score or (score == best_score and len(matched) > len(best_keywords)):
                best_pack = pack
                best_keywords = matched
                best_score = score

    if best_pack is not None:
        return RoutingResult(
            status="soft_match",
            pack=best_pack,
            matched_keywords=best_keywords,
            score=round(best_score, 4),
        )

    # ---- 无命中：返回通用风格 ----
    general = get_builtin_pack(DEFAULT_PACK_ID)
    return RoutingResult(
        status="no_match",
        pack=general,
        matched_keywords=[],
        score=0.0,
    )


def get_pack(pack_id: str) -> Optional[StylePack]:
    """按 id 获取风格包。"""
    return get_builtin_pack(pack_id)


def list_packs() -> list[StylePack]:
    """列出全部风格包。"""
    return list(BUILTIN_PACKS)
