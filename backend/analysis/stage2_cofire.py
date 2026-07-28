"""Pure Stage 2 co-firing metrics and clustering.

The history reader and proposal renderer deliberately live elsewhere. This
module consumes already-aligned observations and performs no I/O.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from itertools import combinations

from ..contracts import Direction, Regime, StrategyResult


MODULE_IDS = tuple(range(1, 29))


@dataclass(frozen=True)
class CofireObservation:
    """One approved observation unit: regime plus all 28 module results."""

    regime: Regime
    results: tuple[StrategyResult, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.regime, Regime):
            raise TypeError("regime must be a Regime")
        ordered = tuple(sorted(self.results, key=lambda result: result.module_id))
        if tuple(result.module_id for result in ordered) != MODULE_IDS:
            raise ValueError("each observation must contain modules 1..28 exactly once")
        for result in ordered:
            if result.fired and result.direction not in (Direction.BUY, Direction.SELL):
                raise ValueError(
                    f"firing module {result.module_id} requires BUY or SELL direction"
                )
            if not result.fired and result.direction is not Direction.NONE:
                raise ValueError(
                    f"non-firing module {result.module_id} requires NONE direction"
                )
        object.__setattr__(self, "results", ordered)


@dataclass(frozen=True)
class PairRegimeMetrics:
    regime: Regime | None
    module_a: int
    module_b: int
    observation_count: int
    fire_count_a: int
    fire_count_b: int
    same_direction_joint_count: int
    same_direction_joint_bar_rate: float
    jaccard: float
    conditional_a_given_b: float
    conditional_b_given_a: float
    phi: float
    degenerate: bool
    opposite_direction_conflict_count: int
    opposite_direction_conflict_rate: float


@dataclass(frozen=True)
class ClusterProposal:
    cluster_id: str
    modules: tuple[int, ...]
    weight: int
    insufficient_modules: tuple[int, ...]
    provisional: bool


@dataclass(frozen=True)
class CofireAnalysis:
    by_regime: tuple[PairRegimeMetrics, ...]
    overall: tuple[PairRegimeMetrics, ...]
    clusters: tuple[ClusterProposal, ...]
    insufficient_modules: tuple[int, ...]


def _safe_ratio(numerator: int | float, denominator: int | float) -> float:
    return 0.0 if denominator == 0 else float(numerator) / float(denominator)


def _phi(
    *,
    observations: int,
    fires_a: int,
    fires_b: int,
    same_direction_joint: int,
) -> tuple[float, bool]:
    """Direction-aware binary phi over ``(bar, BUY|SELL)`` slots.

    Each bar contributes two binary slots. A fired module occupies exactly one
    slot, so opposite-direction simultaneous fires do not become positive
    correlation and the 2x2 table remains valid.
    """

    n11 = same_direction_joint
    n10 = fires_a - n11
    n01 = fires_b - n11
    n00 = 2 * observations - n11 - n10 - n01
    denominator = math.sqrt(
        (n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00)
    )
    if denominator == 0.0:
        return 0.0, True
    return (n11 * n00 - n10 * n01) / denominator, False


def compute_pair_metrics(
    observations: Sequence[CofireObservation],
    regime: Regime | None,
) -> tuple[PairRegimeMetrics, ...]:
    """Compute all 378 pair rows for one regime, or for the whole cohort."""

    if regime is not None and not isinstance(regime, Regime):
        raise TypeError("regime must be a Regime or None")
    selected = [
        observation
        for observation in observations
        if regime is None or observation.regime is regime
    ]
    rows: list[PairRegimeMetrics] = []
    for module_a, module_b in combinations(MODULE_IDS, 2):
        fires_a = 0
        fires_b = 0
        joint = 0
        conflicts = 0
        for observation in selected:
            left = observation.results[module_a - 1]
            right = observation.results[module_b - 1]
            fires_a += int(left.fired)
            fires_b += int(right.fired)
            if left.fired and right.fired:
                if left.direction is right.direction:
                    joint += 1
                else:
                    conflicts += 1
        union = fires_a + fires_b - joint
        count = len(selected)
        phi, degenerate = _phi(
            observations=count,
            fires_a=fires_a,
            fires_b=fires_b,
            same_direction_joint=joint,
        )
        rows.append(
            PairRegimeMetrics(
                regime=regime,
                module_a=module_a,
                module_b=module_b,
                observation_count=count,
                fire_count_a=fires_a,
                fire_count_b=fires_b,
                same_direction_joint_count=joint,
                same_direction_joint_bar_rate=_safe_ratio(joint, count),
                jaccard=_safe_ratio(joint, union),
                conditional_a_given_b=_safe_ratio(joint, fires_b),
                conditional_b_given_a=_safe_ratio(joint, fires_a),
                phi=phi,
                degenerate=degenerate,
                opposite_direction_conflict_count=conflicts,
                opposite_direction_conflict_rate=_safe_ratio(conflicts, count),
            )
        )
    return tuple(rows)


def _validate_membership(
    current_membership: Mapping[str, Sequence[int]],
    target_cluster_count: int,
) -> dict[str, tuple[int, ...]]:
    if isinstance(target_cluster_count, bool) or target_cluster_count < 1:
        raise ValueError("target_cluster_count must be a positive integer")
    if len(current_membership) != target_cluster_count:
        raise ValueError(
            "current membership count must equal target_cluster_count"
        )
    normalized: dict[str, tuple[int, ...]] = {}
    seen: list[int] = []
    for cluster_id, modules in current_membership.items():
        if not isinstance(cluster_id, str) or not cluster_id:
            raise ValueError("cluster ids must be non-empty strings")
        members = tuple(sorted(modules))
        if not members:
            raise ValueError(f"cluster {cluster_id} cannot be empty")
        normalized[cluster_id] = members
        seen.extend(members)
    if tuple(sorted(seen)) != MODULE_IDS:
        raise ValueError("current membership must partition modules 1..28")
    return normalized


def _average_distance(
    left: tuple[int, ...],
    right: tuple[int, ...],
    distances: Mapping[tuple[int, int], float],
) -> float:
    values = [
        distances[(min(module_a, module_b), max(module_a, module_b))]
        for module_a in left
        for module_b in right
    ]
    return sum(values) / len(values)


def cluster_modules(
    overall_metrics: Sequence[PairRegimeMetrics],
    fire_counts: Mapping[int, int],
    current_membership: Mapping[str, Sequence[int]],
    *,
    minimum_module_fires: int,
    target_cluster_count: int,
) -> tuple[tuple[str, tuple[int, ...], tuple[int, ...]], ...]:
    """Constrained deterministic average-linkage clustering.

    Insufficient modules are pre-anchored to their current cluster. Anchors
    carrying different current ids may not merge; sufficient modules may join
    an anchor. This preserves every insufficient module's current membership
    while still retaining exactly the approved number of clusters.
    """

    if isinstance(minimum_module_fires, bool) or minimum_module_fires < 1:
        raise ValueError("minimum_module_fires must be a positive integer")
    membership = _validate_membership(current_membership, target_cluster_count)
    if set(fire_counts) != set(MODULE_IDS):
        raise ValueError("fire_counts must contain modules 1..28")
    if any(
        isinstance(count, bool) or not isinstance(count, int) or count < 0
        for count in fire_counts.values()
    ):
        raise ValueError("fire counts must be non-negative integers")

    phi = {
        (row.module_a, row.module_b): row.phi
        for row in overall_metrics
    }
    expected_pairs = set(combinations(MODULE_IDS, 2))
    if set(phi) != expected_pairs:
        raise ValueError("overall_metrics must contain every module pair exactly once")
    distances = {
        pair: 1.0 - max(value, 0.0)
        for pair, value in phi.items()
    }

    module_cluster = {
        module_id: cluster_id
        for cluster_id, modules in membership.items()
        for module_id in modules
    }
    insufficient = {
        module_id
        for module_id, count in fire_counts.items()
        if count < minimum_module_fires
    }

    clusters: list[tuple[tuple[int, ...], str | None]] = []
    anchored_modules: set[int] = set()
    for cluster_id in sorted(membership):
        members = tuple(
            module_id
            for module_id in membership[cluster_id]
            if module_id in insufficient
        )
        if members:
            clusters.append((members, cluster_id))
            anchored_modules.update(members)
    for module_id in MODULE_IDS:
        if module_id not in anchored_modules:
            clusters.append(((module_id,), None))

    while len(clusters) > target_cluster_count:
        candidates: list[
            tuple[
                float,
                tuple[int, ...],
                tuple[int, ...],
                tuple[int, ...],
                int,
                int,
            ]
        ] = []
        for left_index, right_index in combinations(range(len(clusters)), 2):
            left_members, left_anchor = clusters[left_index]
            right_members, right_anchor = clusters[right_index]
            if (
                left_anchor is not None
                and right_anchor is not None
                and left_anchor != right_anchor
            ):
                continue
            merged = tuple(sorted((*left_members, *right_members)))
            candidates.append(
                (
                    _average_distance(left_members, right_members, distances),
                    merged,
                    left_members,
                    right_members,
                    left_index,
                    right_index,
                )
            )
        if not candidates:
            raise ValueError(
                "insufficient-module anchors prevent reaching target cluster count"
            )
        _, merged, _, _, left_index, right_index = min(candidates)
        left_anchor = clusters[left_index][1]
        right_anchor = clusters[right_index][1]
        anchor = left_anchor if left_anchor is not None else right_anchor
        clusters = [
            cluster
            for index, cluster in enumerate(clusters)
            if index not in (left_index, right_index)
        ]
        clusters.append((merged, anchor))
        clusters.sort(key=lambda item: item[0])

    used_ids = {anchor for _, anchor in clusters if anchor is not None}
    available_ids = [
        cluster_id for cluster_id in sorted(membership) if cluster_id not in used_ids
    ]
    unanchored = sorted(
        (members for members, anchor in clusters if anchor is None)
    )
    labels = {
        members: cluster_id
        for members, cluster_id in zip(unanchored, available_ids, strict=True)
    }
    result = []
    for members, anchor in clusters:
        cluster_id = anchor if anchor is not None else labels[members]
        provisional = tuple(
            module_id for module_id in members if module_id in insufficient
        )
        result.append((cluster_id, members, provisional))
    return tuple(sorted(result, key=lambda item: item[0]))


def equal_cluster_weights(
    cluster_ids: Sequence[str],
    *,
    weight_total: int,
) -> dict[str, int]:
    if isinstance(weight_total, bool) or not isinstance(weight_total, int):
        raise ValueError("weight_total must be an integer")
    ids = tuple(sorted(cluster_ids))
    if not ids or len(set(ids)) != len(ids):
        raise ValueError("cluster_ids must be unique and non-empty")
    if weight_total < len(ids):
        raise ValueError("weight_total must be at least the cluster count")
    base, remainder = divmod(weight_total, len(ids))
    return {
        cluster_id: base + int(index < remainder)
        for index, cluster_id in enumerate(ids)
    }


def analyse_cofiring(
    observations: Sequence[CofireObservation],
    current_membership: Mapping[str, Sequence[int]],
    *,
    minimum_module_fires: int,
    target_cluster_count: int,
    weight_total: int,
) -> CofireAnalysis:
    """Run metrics, membership proposal and outcome-uninformed equal weights."""

    by_regime = tuple(
        row
        for regime in Regime
        for row in compute_pair_metrics(observations, regime)
    )
    overall = compute_pair_metrics(observations, None)
    fire_counts = {
        module_id: sum(
            int(observation.results[module_id - 1].fired)
            for observation in observations
        )
        for module_id in MODULE_IDS
    }
    insufficient = tuple(
        module_id
        for module_id in MODULE_IDS
        if fire_counts[module_id] < minimum_module_fires
    )
    clustered = cluster_modules(
        overall,
        fire_counts,
        current_membership,
        minimum_module_fires=minimum_module_fires,
        target_cluster_count=target_cluster_count,
    )
    weights = equal_cluster_weights(
        [cluster_id for cluster_id, _, _ in clustered],
        weight_total=weight_total,
    )
    proposals = tuple(
        ClusterProposal(
            cluster_id=cluster_id,
            modules=modules,
            weight=weights[cluster_id],
            insufficient_modules=provisional,
            provisional=bool(provisional),
        )
        for cluster_id, modules, provisional in clustered
    )
    return CofireAnalysis(
        by_regime=by_regime,
        overall=overall,
        clusters=proposals,
        insufficient_modules=insufficient,
    )


__all__ = [
    "ClusterProposal",
    "CofireAnalysis",
    "CofireObservation",
    "MODULE_IDS",
    "PairRegimeMetrics",
    "analyse_cofiring",
    "cluster_modules",
    "compute_pair_metrics",
    "equal_cluster_weights",
]
