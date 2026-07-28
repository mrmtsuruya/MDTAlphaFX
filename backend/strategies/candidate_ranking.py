"""Approved deterministic candidate ranking for Stage 2 modules 1–10."""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Sequence
from datetime import datetime, timedelta
from typing import TypeVar

from ..contracts import Direction


Candidate = TypeVar("Candidate")
CandidateKey = tuple[
    int,
    float,
    tuple[tuple[str, str, float], ...],
    tuple[int, ...],
]


def candidate_sort_key(
    *,
    formation_index: int,
    raw_zone_min: float,
    raw_zone_max: float,
    geometry_coordinates: Iterable[tuple[str, str, float]],
    source_indices: Iterable[int],
) -> CandidateKey:
    """Build the exact ascending key approved by the recovery addendum."""

    if (
        isinstance(formation_index, bool)
        or not isinstance(formation_index, int)
        or formation_index < 0
    ):
        raise ValueError("formation_index must be a non-negative integer")
    low = float(raw_zone_min)
    high = float(raw_zone_max)
    if not math.isfinite(low) or not math.isfinite(high) or high < low:
        raise ValueError("raw candidate zone must be finite and ordered")

    canonical: list[tuple[str, str, float]] = []
    for role, utc_time_iso, raw_price in geometry_coordinates:
        if not isinstance(role, str) or not role:
            raise ValueError("candidate coordinate role must be non-empty")
        if not isinstance(utc_time_iso, str) or not utc_time_iso:
            raise ValueError("candidate coordinate time must be non-empty")
        try:
            moment = datetime.fromisoformat(utc_time_iso)
        except ValueError as exc:
            raise ValueError("candidate coordinate time must be ISO-8601") from exc
        if moment.tzinfo is None or moment.utcoffset() != timedelta(0):
            raise ValueError("candidate coordinate time must be timezone-aware UTC")
        value = float(raw_price)
        if not math.isfinite(value):
            raise ValueError("candidate coordinate price must be finite")
        canonical.append((role, utc_time_iso, value))

    indices: set[int] = set()
    for index in source_indices:
        if isinstance(index, bool) or not isinstance(index, int) or index < 0:
            raise ValueError("candidate source indices must be non-negative integers")
        indices.add(index)
    if not indices:
        raise ValueError("candidate ranking requires at least one source index")

    return (
        -formation_index,
        high - low,
        tuple(sorted(canonical)),
        tuple(sorted(indices)),
    )


def select_candidate(
    candidates: Sequence[Candidate],
    *,
    direction_of: Callable[[Candidate], Direction],
    key_of: Callable[[Candidate], CandidateKey],
) -> Candidate | None:
    """Select one same-direction candidate; preserve opposite-direction flat."""

    if not candidates:
        return None
    directions = {direction_of(candidate) for candidate in candidates}
    if not directions <= {Direction.BUY, Direction.SELL}:
        raise ValueError("ranked candidates require BUY or SELL directions")
    if len(directions) != 1:
        return None
    return min(candidates, key=key_of)


__all__ = ["CandidateKey", "candidate_sort_key", "select_candidate"]
