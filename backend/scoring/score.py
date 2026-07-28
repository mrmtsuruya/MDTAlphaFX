"""§5.1 cluster collapse and §5.2 score computation."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from math import isfinite

from ..contracts import Direction, Regime, StrategyResult, VoteTally
from .types import ClusterDef, ClusterRegistry, ClusterState, FiringCluster, ScoreBreakdown


_TRENDING_REGIMES = frozenset(
    {Regime.TRENDING_BULLISH, Regime.TRENDING_BEARISH}
)
_VOTE_POINTS_DIVISOR = 10.0
_APPROVED_STAGE1_ALPHA = 0.5


def _validate_direction(direction: Direction, *, name: str) -> None:
    if direction not in (Direction.BUY, Direction.SELL):
        raise ValueError(f"{name} must be BUY or SELL")


def _validate_score(value: float, *, name: str) -> float:
    numeric = float(value)
    if not isfinite(numeric) or not 0.0 <= numeric <= 100.0:
        raise ValueError(f"{name} must be finite and within 0..100")
    return numeric


def _resolved_by_id(
    clusters: Sequence[FiringCluster],
    registry: ClusterRegistry,
) -> dict[str, FiringCluster]:
    known = {cluster.cluster_id for cluster in registry.clusters}
    resolved: dict[str, FiringCluster] = {}
    for cluster in clusters:
        if cluster.cluster_id not in known:
            raise ValueError(f"unknown cluster id {cluster.cluster_id!r}")
        if cluster.cluster_id in resolved:
            raise ValueError(f"duplicate resolved cluster {cluster.cluster_id!r}")
        _validate_score(cluster.score, name=f"cluster {cluster.cluster_id} score")
        resolved[cluster.cluster_id] = cluster
    return resolved


def resolve_cluster(
    definition: ClusterDef,
    module_results: Sequence[StrategyResult],
) -> FiringCluster:
    """Collapse one §5.1 cluster using ANY / majority / MAX semantics."""

    members = set(definition.modules)
    seen: set[int] = set()
    firing: list[StrategyResult] = []
    for result in module_results:
        if result.module_id not in members:
            raise ValueError(
                f"module {result.module_id} does not belong to cluster "
                f"{definition.cluster_id}"
            )
        if result.module_id in seen:
            raise ValueError(f"duplicate module result {result.module_id}")
        seen.add(result.module_id)
        _validate_score(result.score, name=f"module {result.module_id} score")
        if result.fired and result.direction in (Direction.BUY, Direction.SELL):
            firing.append(result)

    buys = [result for result in firing if result.direction is Direction.BUY]
    sells = [result for result in firing if result.direction is Direction.SELL]
    if len(buys) == len(sells):
        return FiringCluster(
            cluster_id=definition.cluster_id,
            fired=False,
            direction=Direction.NONE,
            score=0.0,
            contributing_modules=tuple(result.module_id for result in firing),
            top_module="",
        )

    direction = Direction.BUY if len(buys) > len(sells) else Direction.SELL
    agreeing = buys if direction is Direction.BUY else sells
    strongest = max(agreeing, key=lambda result: result.score)
    return FiringCluster(
        cluster_id=definition.cluster_id,
        fired=True,
        direction=direction,
        score=float(strongest.score),
        contributing_modules=tuple(result.module_id for result in agreeing),
        top_module=strongest.module_name,
    )


def resolve_clusters(
    module_results: Sequence[StrategyResult],
    registry: ClusterRegistry,
) -> tuple[FiringCluster, ...]:
    """Resolve the complete registry while preserving registry order."""

    registry.assert_invariants()
    by_module: dict[int, StrategyResult] = {}
    for result in module_results:
        if result.module_id in by_module:
            raise ValueError(f"duplicate module result {result.module_id}")
        by_module[result.module_id] = result
    unknown = set(by_module) - set(range(1, 29))
    if unknown:
        raise ValueError(f"module ids outside 1–28: {sorted(unknown)}")

    return tuple(
        resolve_cluster(
            definition,
            [
                by_module[module_id]
                for module_id in definition.modules
                if module_id in by_module
            ],
        )
        for definition in registry.clusters
    )


def enabled_in(
    regime: Regime,
    cluster_id: str,
    direction: Direction,
    trend_direction: Direction,
    cluster_map: Mapping[Regime, Mapping[str, ClusterState]],
) -> bool:
    """Return whether a cluster belongs to this candidate's denominator.

    The approved Stage 1 reading makes a trending counter-trend candidate's
    complete available set the ``COUNTER_ONLY`` D2/F pair. Its denominator is
    therefore 22, not the 90 produced by the superseded pseudocode.
    """

    try:
        state = cluster_map[regime][cluster_id]
    except KeyError as exc:
        raise ValueError(
            f"cluster map has no state for {regime.value}/{cluster_id}"
        ) from exc

    if state is ClusterState.SUPPRESSED:
        return False

    if regime in _TRENDING_REGIMES:
        _validate_direction(direction, name="direction")
        _validate_direction(trend_direction, name="trend_direction")
        counter_trend = direction is not trend_direction
        return (
            state is ClusterState.COUNTER_ONLY
            if counter_trend
            else state is ClusterState.ENABLED
        )

    return state is ClusterState.ENABLED


def compute_breadth_quality_score(
    clusters: Sequence[FiringCluster],
    registry: ClusterRegistry,
    regime: Regime,
    direction: Direction,
    trend_direction: Direction,
    cluster_map: Mapping[Regime, Mapping[str, ClusterState]],
    alpha: float,
    htf_penalty: float,
) -> ScoreBreakdown:
    """Compute §5.2 breadth, quality and full-precision composite together."""

    registry.assert_invariants()
    _validate_direction(direction, name="direction")
    if not isfinite(float(alpha)) or float(alpha) <= 0.0:
        raise ValueError("alpha must be finite and greater than zero")
    if not isfinite(float(htf_penalty)) or not 0.0 <= float(htf_penalty) <= 1.0:
        raise ValueError("htf_penalty must be finite and within 0..1")

    resolved = _resolved_by_id(clusters, registry)
    available_defs = [
        definition
        for definition in registry.clusters
        if enabled_in(
            regime,
            definition.cluster_id,
            direction,
            trend_direction,
            cluster_map,
        )
    ]
    denominator = sum(definition.weight for definition in available_defs)

    agreeing: list[tuple[FiringCluster, int]] = []
    for definition in available_defs:
        cluster = resolved.get(definition.cluster_id)
        if (
            cluster is not None
            and cluster.fired
            and cluster.direction is direction
        ):
            agreeing.append((cluster, definition.weight))

    numerator = sum(weight for _, weight in agreeing)
    breadth = numerator / denominator if denominator else 0.0
    quality = (
        sum(cluster.score * weight for cluster, weight in agreeing) / numerator
        if numerator
        else 0.0
    )
    score = quality * (breadth ** float(alpha)) * float(htf_penalty)
    return ScoreBreakdown(
        breadth=breadth,
        quality=quality,
        score=score,
        denominator=denominator,
        numerator=numerator,
        htf_penalty_applied=float(htf_penalty),
    )


def tally(
    clusters: Sequence[FiringCluster],
    registry: ClusterRegistry,
    regime: Regime,
    trend_direction: Direction,
    cluster_map: Mapping[Regime, Mapping[str, ClusterState]],
) -> VoteTally:
    """Compute the displayed, non-scoring §5.2.1 two-sided tally."""

    registry.assert_invariants()
    resolved = _resolved_by_id(clusters, registry)

    def side(candidate_direction: Direction) -> list[tuple[FiringCluster, int]]:
        result: list[tuple[FiringCluster, int]] = []
        for definition in registry.clusters:
            cluster = resolved.get(definition.cluster_id)
            if (
                cluster is not None
                and cluster.fired
                and cluster.direction is candidate_direction
                and enabled_in(
                    regime,
                    definition.cluster_id,
                    candidate_direction,
                    trend_direction,
                    cluster_map,
                )
            ):
                result.append((cluster, definition.weight))
        return result

    buy = side(Direction.BUY)
    sell = side(Direction.SELL)

    def points(side_clusters: Sequence[tuple[FiringCluster, int]]) -> float:
        return (
            sum(cluster.score * weight for cluster, weight in side_clusters)
            / _VOTE_POINTS_DIVISOR
        )

    all_firing = [cluster for cluster, _ in (*buy, *sell)]
    leading = (
        max(all_firing, key=lambda cluster: cluster.score).top_module
        if all_firing
        else "NONE"
    )
    return VoteTally(
        buy_votes=len(buy),
        buy_points=points(buy),
        sell_votes=len(sell),
        sell_points=points(sell),
        contested=bool(buy) and bool(sell),
        leading_contributor=leading,
    )


def flat_score(
    module_results: Sequence[object],
    direction: Direction,
    *,
    alpha: float = _APPROVED_STAGE1_ALPHA,
) -> float:
    """Apply §5.2's normal formula at module level.

    The supplied module sequence is already the regime-available denominator.
    Agreeing firing modules determine breadth, their arithmetic mean confidence
    determines quality, and the approved Stage 1 alpha is used unless a caller
    explicitly supplies the versioned configuration value.
    """

    _validate_direction(direction, name="direction")
    if not isfinite(float(alpha)) or float(alpha) <= 0.0:
        raise ValueError("alpha must be finite and greater than zero")
    if not module_results:
        return 0.0

    agreeing: list[float] = []
    for result in module_results:
        try:
            fired = bool(result.fired)
            result_direction = result.direction
            result_score = _validate_score(result.score, name="module score")
        except AttributeError as exc:
            raise TypeError(
                "flat_score requires StrategyResult-like module objects"
            ) from exc
        if fired and result_direction is direction:
            agreeing.append(result_score)

    breadth = len(agreeing) / len(module_results)
    quality = sum(agreeing) / len(agreeing) if agreeing else 0.0
    return quality * (breadth ** float(alpha))


__all__ = [
    "enabled_in",
    "resolve_cluster",
    "resolve_clusters",
    "compute_breadth_quality_score",
    "tally",
    "flat_score",
]
