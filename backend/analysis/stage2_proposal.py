"""Pure orchestration helpers for the Stage 2 co-firing proposal.

This module deliberately has no store, terminal, clock, or configuration-file
I/O.  The CLI supplies frozen bars, symbol metadata, strategies and the already
validated production configuration.  The output is proposal evidence only.
"""

from __future__ import annotations

import hashlib
import json
import math
from bisect import bisect_right
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import datetime
from itertools import combinations
from typing import Any

from ..contracts import Candle, Direction, Regime, StrategyResult, SymbolSpec, Timeframe
from ..core.config import Config
from ..core.timeutil import ensure_utc, timeframe_delta
from ..regime.classifier import RegimeVerdict, apply_hysteresis, classify_raw
from ..regime.features import (
    NewsBlackoutFlags,
    RegimeFeatureConfig,
    compute_regime_inputs,
)
from ..scoring.configuration import Stage1ScoringModel
from ..scoring.gate import is_displayed
from ..scoring.score import (
    compute_breadth_quality_score,
    enabled_in,
    resolve_cluster,
    resolve_clusters,
    tally,
)
from ..scoring.types import ClusterDef, ClusterRegistry, ClusterState
from ..strategies.base import Strategy
from .stage2_cofire import (
    MODULE_IDS,
    ClusterProposal,
    CofireAnalysis,
    CofireObservation,
    PairRegimeMetrics,
    equal_cluster_weights,
)


CALIBRATION_QUALITIES = (80, 85, 90, 93, 95, 100)
TREND_DIRECTION = {
    Regime.TRENDING_BULLISH: Direction.BUY,
    Regime.TRENDING_BEARISH: Direction.SELL,
}


@dataclass(frozen=True)
class EffectiveRegime:
    """One H1 verdict at the instant its source candle became closed."""

    close_time: datetime
    regime: Regime

    def __post_init__(self) -> None:
        object.__setattr__(self, "close_time", ensure_utc(self.close_time))


@dataclass(frozen=True)
class EvaluatedObservation:
    """Compact one-symbol M15 close result used by proposal calculations."""

    symbol: str
    bar_time: datetime
    close_time: datetime
    cofire: CofireObservation

    def __post_init__(self) -> None:
        if not self.symbol:
            raise ValueError("symbol must be non-empty")
        object.__setattr__(self, "bar_time", ensure_utc(self.bar_time))
        object.__setattr__(self, "close_time", ensure_utc(self.close_time))
        if self.close_time <= self.bar_time:
            raise ValueError("close_time must be after bar_time")


@dataclass(frozen=True)
class NeutralClusterProposal:
    """Measured membership before any regime-ID mapping is authorized."""

    proposal_label: str
    modules: tuple[int, ...]
    weight: int
    insufficient_modules: tuple[int, ...]
    provisional: bool


def _regime_feature_config(config: Config) -> RegimeFeatureConfig:
    periods = config.get("regime.inputs.ema_periods")
    if not isinstance(periods, list):
        raise ValueError("regime.inputs.ema_periods must be a list")
    return RegimeFeatureConfig(
        adx_period=int(config.get("regime.inputs.adx_period")),
        ema_periods=tuple(int(value) for value in periods),
        atr_period=int(config.get("regime.inputs.atr_period")),
        atr_percentile_lookback=int(
            config.get("regime.inputs.atr_percentile_lookback")
        ),
        r_squared_bars=int(config.get("regime.inputs.r_squared_bars")),
    )


def classify_closed_h1(
    candles: Sequence[Candle],
    config: Config,
    *,
    news_blackouts: NewsBlackoutFlags | None = None,
) -> tuple[EffectiveRegime, ...]:
    """Classify H1 candles and timestamp verdicts at candle close.

    When no calendar is supplied, the caller gets the same explicit
    ATR-only/no-blackout boundary used by the Stage 1 replay.  The CLI records
    that limitation in provenance.
    """

    flags = (
        NewsBlackoutFlags.no_blackouts(len(candles))
        if news_blackouts is None
        else news_blackouts
    )
    inputs = compute_regime_inputs(candles, flags, _regime_feature_config(config))
    regime_config = config.section("regime")
    previous: RegimeVerdict | None = None
    result: list[EffectiveRegime] = []
    for candle, values in zip(candles, inputs):
        if values is None:
            continue
        raw = classify_raw(values, regime_config)
        if previous is None:
            verdict = RegimeVerdict(
                regime=raw,
                regime_confidence=1.0,
                bars_in_regime=1,
                pending=None,
                pending_bars=0,
            )
        else:
            verdict = apply_hysteresis(previous, raw, values, regime_config)
        previous = verdict
        result.append(
            EffectiveRegime(
                close_time=candle.time + timeframe_delta(Timeframe.H1),
                regime=verdict.regime,
            )
        )
    return tuple(result)


def attach_latest_closed_regimes(
    m15_bars: Sequence[Candle],
    h1_regimes: Sequence[EffectiveRegime],
) -> tuple[Regime | None, ...]:
    """Attach the latest effective H1 verdict without lookahead."""

    ordered = tuple(h1_regimes)
    close_times = tuple(point.close_time for point in ordered)
    if close_times != tuple(sorted(close_times)) or len(set(close_times)) != len(
        close_times
    ):
        raise ValueError("H1 regimes must have unique increasing close times")
    result: list[Regime | None] = []
    m15_delta = timeframe_delta(Timeframe.M15)
    for bar in m15_bars:
        close_time = ensure_utc(bar.time) + m15_delta
        index = bisect_right(close_times, close_time) - 1
        result.append(None if index < 0 else ordered[index].regime)
    return tuple(result)


def _compact_result(result: StrategyResult) -> StrategyResult:
    """Retain only fields used by co-fire and Stage 1 score calculations."""

    return StrategyResult(
        module_id=result.module_id,
        module_name=result.module_name,
        fired=result.fired,
        direction=result.direction,
        score=result.score,
        evidence={},
    )


def evaluate_full_prefix_population(
    *,
    symbol: str,
    bars: Sequence[Candle],
    spec: SymbolSpec,
    strategies: Sequence[Strategy],
    regimes: Sequence[Regime | None],
) -> tuple[EvaluatedObservation, ...]:
    """Evaluate the common eligible population with exact full-prefix semantics.

    Recorded Stage 2 goldens call each detector with the complete prefix.  This
    routine intentionally preserves that meaning.  It is quadratic in cohort
    length for detectors that rescan their input; callers must not relabel it a
    performant rolling-window batch implementation.
    """

    if len(bars) != len(regimes):
        raise ValueError("bars and regimes must have equal length")
    ordered = tuple(sorted(strategies, key=lambda strategy: strategy.module_id))
    if tuple(strategy.module_id for strategy in ordered) != MODULE_IDS:
        raise ValueError("strategies must contain modules 1..28 exactly once")
    start_index = max(strategy.min_bars for strategy in ordered) - 1
    m15_delta = timeframe_delta(Timeframe.M15)
    result: list[EvaluatedObservation] = []
    for index in range(start_index, len(bars)):
        regime = regimes[index]
        if regime is None:
            continue
        prefix = list(bars[: index + 1])
        module_results = tuple(
            _compact_result(strategy.evaluate(prefix, spec))
            for strategy in ordered
        )
        result.append(
            EvaluatedObservation(
                symbol=symbol,
                bar_time=bars[index].time,
                close_time=bars[index].time + m15_delta,
                cofire=CofireObservation(regime=regime, results=module_results),
            )
        )
    return tuple(result)


def proposal_registry(
    current: Stage1ScoringModel,
    clusters: Sequence[ClusterProposal],
    *,
    mapping_authorized: bool = False,
) -> ClusterRegistry:
    """Build a mapped registry only after its A–H mapping is authorized."""

    if not mapping_authorized:
        raise ValueError(
            "mapping measured clusters to A/B/C/D1/D2/E/F/G/H is not "
            "authorized; use neutral_cluster_proposals"
        )

    by_id = {cluster.cluster_id: cluster for cluster in clusters}
    current_ids = tuple(definition.cluster_id for definition in current.registry.clusters)
    if set(by_id) != set(current_ids):
        raise ValueError("proposal cluster ids must match the Stage 1 registry")
    registry = ClusterRegistry(
        clusters=tuple(
            ClusterDef(
                cluster_id=definition.cluster_id,
                name=definition.name,
                weight=by_id[definition.cluster_id].weight,
                modules=by_id[definition.cluster_id].modules,
            )
            for definition in current.registry.clusters
        ),
        pillar_of_module=current.registry.pillar_of_module,
    )
    registry.assert_invariants()
    return registry


def neutral_cluster_proposals(
    analysis: CofireAnalysis,
    *,
    weight_total: int,
) -> tuple[NeutralClusterProposal, ...]:
    """Relabel measured member tuples P01..P09 without implying regime meaning."""

    ordered = tuple(sorted(analysis.clusters, key=lambda cluster: cluster.modules))
    labels = tuple(f"P{index:02d}" for index in range(1, len(ordered) + 1))
    weights = equal_cluster_weights(labels, weight_total=weight_total)
    return tuple(
        NeutralClusterProposal(
            proposal_label=label,
            modules=cluster.modules,
            weight=weights[label],
            insufficient_modules=cluster.insufficient_modules,
            provisional=cluster.provisional,
        )
        for label, cluster in zip(labels, ordered, strict=True)
    )


def _pair_matrices(
    rows: Sequence[PairRegimeMetrics],
) -> dict[str, Any]:
    by_pair = {(row.module_a, row.module_b): row for row in rows}
    expected = set(combinations(MODULE_IDS, 2))
    if set(by_pair) != expected:
        raise ValueError("pair rows must contain all 378 module pairs")

    metric_names = (
        "phi",
        "jaccard",
        "same_direction_joint_bar_rate",
        "opposite_direction_conflict_rate",
    )
    matrices: dict[str, list[list[float | bool | None]]] = {}
    for metric in metric_names:
        matrix: list[list[float | bool | None]] = []
        for module_a in MODULE_IDS:
            line: list[float | bool | None] = []
            for module_b in MODULE_IDS:
                if module_a == module_b:
                    line.append(None)
                    continue
                row = by_pair[(min(module_a, module_b), max(module_a, module_b))]
                line.append(getattr(row, metric))
            matrix.append(line)
        matrices[metric] = matrix

    conditional: list[list[float | None]] = []
    for module_a in MODULE_IDS:
        line = []
        for module_b in MODULE_IDS:
            if module_a == module_b:
                line.append(None)
                continue
            row = by_pair[(min(module_a, module_b), max(module_a, module_b))]
            line.append(
                row.conditional_a_given_b
                if module_a < module_b
                else row.conditional_b_given_a
            )
        conditional.append(line)
    matrices["conditional_row_given_column"] = conditional

    degenerate: list[list[bool | None]] = []
    for module_a in MODULE_IDS:
        line = []
        for module_b in MODULE_IDS:
            if module_a == module_b:
                line.append(None)
            else:
                line.append(
                    by_pair[(min(module_a, module_b), max(module_a, module_b))].degenerate
                )
        degenerate.append(line)
    matrices["degenerate"] = degenerate
    return {"module_ids": list(MODULE_IDS), "diagonal": None, "matrices": matrices}


def pairwise_artifacts(analysis: CofireAnalysis) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return overall and per-regime pair rows plus square matrices."""

    overall = {
        "rows": [_metric_dict(row) for row in analysis.overall],
        **_pair_matrices(analysis.overall),
    }
    by_regime: dict[str, Any] = {}
    for regime in Regime:
        rows = tuple(row for row in analysis.by_regime if row.regime is regime)
        by_regime[regime.value] = {
            "rows": [_metric_dict(row) for row in rows],
            **_pair_matrices(rows),
        }
    return overall, {"regimes": by_regime}


def _metric_dict(row: PairRegimeMetrics) -> dict[str, Any]:
    value = asdict(row)
    value["regime"] = None if row.regime is None else row.regime.value
    return value


def fire_count_artifact(
    observations: Sequence[EvaluatedObservation],
) -> dict[str, Any]:
    """Ordinary bar fire counts overall and per effective H1 regime."""

    overall = {
        module_id: sum(
            int(row.cofire.results[module_id - 1].fired) for row in observations
        )
        for module_id in MODULE_IDS
    }
    by_regime = {
        regime.value: {
            module_id: sum(
                int(row.cofire.results[module_id - 1].fired)
                for row in observations
                if row.cofire.regime is regime
            )
            for module_id in MODULE_IDS
        }
        for regime in Regime
    }
    return {
        "observation_count": len(observations),
        "overall": {str(key): value for key, value in overall.items()},
        "by_regime": {
            regime: {str(key): value for key, value in counts.items()}
            for regime, counts in by_regime.items()
        },
    }


def _case_rows(
    *,
    registry: ClusterRegistry,
    cluster_map: Mapping[Regime, Mapping[str, ClusterState]],
    regime: Regime,
    direction: Direction,
    trend_direction: Direction,
    alpha: float,
    penalty: float,
    display_threshold: float,
    auto_threshold: float,
) -> dict[str, Any]:
    available = tuple(
        definition
        for definition in registry.clusters
        if enabled_in(
            regime,
            definition.cluster_id,
            direction,
            trend_direction,
            cluster_map,
        )
    )
    denominator = sum(definition.weight for definition in available)
    rows: list[dict[str, Any]] = []
    for cluster_count in range(1, len(available) + 1):
        for subset in combinations(available, cluster_count):
            numerator = sum(definition.weight for definition in subset)
            breadth = numerator / denominator if denominator else 0.0
            quality_rows = {
                str(quality): quality * (breadth**alpha) * penalty
                for quality in CALIBRATION_QUALITIES
            }
            reach_factor = (breadth**alpha) * penalty
            rows.append(
                {
                    "clusters": [definition.cluster_id for definition in subset],
                    "cluster_count": cluster_count,
                    "numerator": numerator,
                    "denominator": denominator,
                    "breadth": breadth,
                    "scores_by_quality": quality_rows,
                    "quality_required_for_display": (
                        display_threshold / reach_factor
                        if reach_factor
                        else None
                    ),
                    "quality_required_for_auto": (
                        auto_threshold / reach_factor if reach_factor else None
                    ),
                }
            )
    summaries: list[dict[str, Any]] = []
    for cluster_count in range(1, len(available) + 1):
        selected = [row for row in rows if row["cluster_count"] == cluster_count]
        summaries.append(
            {
                "cluster_count": cluster_count,
                "subset_count": len(selected),
                "breadth_min": min(row["breadth"] for row in selected),
                "breadth_max": max(row["breadth"] for row in selected),
                "score_ranges_by_quality": {
                    str(quality): {
                        "min": min(
                            row["scores_by_quality"][str(quality)]
                            for row in selected
                        ),
                        "max": max(
                            row["scores_by_quality"][str(quality)]
                            for row in selected
                        ),
                    }
                    for quality in CALIBRATION_QUALITIES
                },
            }
        )
    return {
        "regime": regime.value,
        "direction": direction.value,
        "trend_direction": trend_direction.value,
        "penalty": penalty,
        "available_clusters": [
            {
                "cluster_id": definition.cluster_id,
                "weight": definition.weight,
            }
            for definition in available
        ],
        "denominator": denominator,
        "subset_rows": rows,
        "by_cluster_count": summaries,
    }


def reachability_artifact(
    *,
    config: Config,
    current: Stage1ScoringModel,
    registry: ClusterRegistry,
    mapping_authorized: bool = False,
) -> dict[str, Any]:
    """Regenerate exact §5.3.1/§5.3.2 reachability under proposal weights."""

    if not mapping_authorized:
        raise ValueError(
            "Stage 1 reachability requires an authorized A–H cluster mapping"
        )

    alpha = float(config.get("scoring.alpha"))
    display = float(config.get("scoring.thresholds.display_threshold"))
    auto = float(config.get("scoring.thresholds.auto_execute_threshold"))
    uplift = float(config.get("regime.regime_policy.transitional_threshold_uplift"))
    counter_penalty = float(
        config.get("regime.per_timeframe.counter_bias_penalty")
    )
    cases = (
        (
            "TRENDING_WITH_TREND",
            Regime.TRENDING_BULLISH,
            Direction.BUY,
            Direction.BUY,
            1.0,
            display,
        ),
        (
            "TRENDING_COUNTER_TREND",
            Regime.TRENDING_BULLISH,
            Direction.SELL,
            Direction.BUY,
            counter_penalty,
            display,
        ),
        (
            "RANGING",
            Regime.RANGING,
            Direction.BUY,
            Direction.NONE,
            1.0,
            display,
        ),
        (
            "TRANSITIONAL",
            Regime.TRANSITIONAL,
            Direction.BUY,
            Direction.NONE,
            1.0,
            display + uplift,
        ),
    )
    return {
        "formula": "quality * breadth**alpha * penalty",
        "alpha": alpha,
        "quality_grid": list(CALIBRATION_QUALITIES),
        "display_threshold": display,
        "auto_execute_threshold": auto,
        "transitional_display_uplift": uplift,
        "cases": {
            label: _case_rows(
                registry=registry,
                cluster_map=current.cluster_map,
                regime=regime,
                direction=direction,
                trend_direction=trend_direction,
                alpha=alpha,
                penalty=penalty,
                display_threshold=case_display,
                auto_threshold=auto,
            )
            for (
                label,
                regime,
                direction,
                trend_direction,
                penalty,
                case_display,
            ) in cases
        },
    }


def neutral_reachability_artifact(
    *,
    config: Config,
    clusters: Sequence[NeutralClusterProposal],
) -> dict[str, Any]:
    """Return unrestricted pre-gating reachability without assigning A–H IDs.

    This is not a regenerated §5.3.1/§5.3.2 table.  Those tables depend on the
    A–H regime map and remain blocked until measured clusters are mapped.
    """

    alpha = float(config.get("scoring.alpha"))
    display = float(config.get("scoring.thresholds.display_threshold"))
    auto = float(config.get("scoring.thresholds.auto_execute_threshold"))
    denominator = sum(cluster.weight for cluster in clusters)
    rows: list[dict[str, Any]] = []
    for count in range(1, len(clusters) + 1):
        for subset in combinations(clusters, count):
            numerator = sum(cluster.weight for cluster in subset)
            breadth = numerator / denominator if denominator else 0.0
            factor = breadth**alpha
            rows.append(
                {
                    "clusters": [cluster.proposal_label for cluster in subset],
                    "cluster_count": count,
                    "numerator": numerator,
                    "denominator": denominator,
                    "breadth": breadth,
                    "scores_by_quality": {
                        str(quality): quality * factor
                        for quality in CALIBRATION_QUALITIES
                    },
                    "quality_required_for_base_display": display / factor,
                    "quality_required_for_base_auto": auto / factor,
                }
            )
    return {
        "status": "PRE_HTF_UNRESTRICTED_REFERENCE_NOT_STAGE1_REACHABILITY",
        "blocked_reason": (
            "Measured member tuples have no authorized mapping to the "
            "A/B/C/D1/D2/E/F/G/H regime-gating IDs."
        ),
        "formula": "quality * breadth**alpha",
        "alpha": alpha,
        "quality_grid": list(CALIBRATION_QUALITIES),
        "base_display_threshold": display,
        "base_auto_execute_threshold": auto,
        "denominator": denominator,
        "subset_rows": rows,
    }


def pre_htf_score_ingredients(
    *,
    observations: Sequence[EvaluatedObservation],
    config: Config,
    clusters: Sequence[NeutralClusterProposal],
) -> tuple[dict[str, Any], ...]:
    """Collapse neutral clusters and emit unrestricted pre-HTF ingredients.

    Regime gating and HTF penalties are deliberately not applied.  The rows
    preserve enough information to regenerate the true Stage 1 distribution
    after those policies are authorized.
    """

    alpha = float(config.get("scoring.alpha"))
    denominator = sum(cluster.weight for cluster in clusters)
    definitions = tuple(
        ClusterDef(
            cluster_id=cluster.proposal_label,
            name=cluster.proposal_label,
            weight=cluster.weight,
            modules=cluster.modules,
        )
        for cluster in clusters
    )
    result: list[dict[str, Any]] = []
    for observation in observations:
        resolved = tuple(
            resolve_cluster(
                definition,
                [
                    observation.cofire.results[module_id - 1]
                    for module_id in definition.modules
                ],
            )
            for definition in definitions
        )
        for direction in (Direction.BUY, Direction.SELL):
            agreeing = tuple(
                (definition, cluster)
                for definition, cluster in zip(definitions, resolved, strict=True)
                if cluster.fired and cluster.direction is direction
            )
            numerator = sum(definition.weight for definition, _ in agreeing)
            if numerator == 0:
                continue
            quality = (
                sum(cluster.score * definition.weight for definition, cluster in agreeing)
                / numerator
            )
            breadth = numerator / denominator if denominator else 0.0
            result.append(
                {
                    "symbol": observation.symbol,
                    "bar_time": observation.bar_time.isoformat(),
                    "close_time": observation.close_time.isoformat(),
                    "effective_h1_regime": observation.cofire.regime.value,
                    "direction": direction.value,
                    "agreeing_neutral_clusters": [
                        definition.cluster_id for definition, _ in agreeing
                    ],
                    "cluster_count": len(agreeing),
                    "unrestricted_denominator": denominator,
                    "numerator": numerator,
                    "breadth": breadth,
                    "quality": quality,
                    "pre_htf_unrestricted_score": quality * (breadth**alpha),
                    "regime_gating_applied": False,
                    "htf_penalty_applied": None,
                }
            )
    return tuple(result)


def score_ingredient_summary(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Summarise neutral pre-HTF rows without relabelling them realised scores."""

    values = [float(row["pre_htf_unrestricted_score"]) for row in rows]
    probabilities = (0.0, 0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99, 1.0)
    frequency = Counter(round(value, 6) for value in values)
    return {
        "status": "PRE_HTF_UNRESTRICTED_INGREDIENTS_NOT_REALISED_STAGE1",
        "candidate_rows": len(rows),
        "regime_gating_applied": False,
        "htf_penalty_applied": False,
        "quantile_method": "linear interpolation at p*(n-1)",
        "quantiles": {
            str(probability): _quantile(values, probability)
            for probability in probabilities
        },
        "score_frequency_rounded_6dp": [
            {"score": score, "count": count}
            for score, count in sorted(frequency.items())
        ],
    }


def realised_score_rows(
    *,
    observations: Sequence[EvaluatedObservation],
    config: Config,
    current: Stage1ScoringModel,
    registry: ClusterRegistry,
    mapping_authorized: bool = False,
    htf_policy_authorized: bool = False,
) -> tuple[dict[str, Any], ...]:
    """Compute every non-empty BUY/SELL candidate score under the proposal."""

    if not mapping_authorized:
        raise ValueError(
            "realised Stage 1 scores require an authorized A–H cluster mapping"
        )
    if not htf_policy_authorized:
        raise ValueError(
            "realised Stage 1 scores require an authorized HTF penalty policy"
        )

    alpha = float(config.get("scoring.alpha"))
    counter_penalty = float(
        config.get("regime.per_timeframe.counter_bias_penalty")
    )
    result: list[dict[str, Any]] = []
    for observation in observations:
        regime = observation.cofire.regime
        trend_direction = TREND_DIRECTION.get(regime, Direction.NONE)
        resolved = resolve_clusters(observation.cofire.results, registry)
        votes = tally(
            resolved,
            registry,
            regime,
            trend_direction,
            current.cluster_map,
        )
        for direction in (Direction.BUY, Direction.SELL):
            penalty = (
                counter_penalty
                if trend_direction is not Direction.NONE
                and direction is not trend_direction
                else 1.0
            )
            breakdown = compute_breadth_quality_score(
                resolved,
                registry,
                regime,
                direction,
                trend_direction,
                current.cluster_map,
                alpha,
                penalty,
            )
            if breakdown.numerator == 0:
                continue
            agreeing = tuple(
                cluster.cluster_id
                for cluster in resolved
                if cluster.fired
                and cluster.direction is direction
                and enabled_in(
                    regime,
                    cluster.cluster_id,
                    direction,
                    trend_direction,
                    current.cluster_map,
                )
            )
            result.append(
                {
                    "symbol": observation.symbol,
                    "bar_time": observation.bar_time.isoformat(),
                    "close_time": observation.close_time.isoformat(),
                    "regime": regime.value,
                    "direction": direction.value,
                    "agreeing_clusters": list(agreeing),
                    "cluster_count": len(agreeing),
                    "breadth": breakdown.breadth,
                    "quality": breakdown.quality,
                    "score": breakdown.score,
                    "denominator": breakdown.denominator,
                    "numerator": breakdown.numerator,
                    "htf_penalty_applied": breakdown.htf_penalty_applied,
                    "displayed": is_displayed(
                        breakdown.score,
                        regime,
                        dict(current.runtime_config),
                    ),
                    "auto_score_reached": breakdown.score
                    >= float(config.get("scoring.thresholds.auto_execute_threshold")),
                    "contested": votes.contested,
                    "buy_votes": votes.buy_votes,
                    "buy_points": votes.buy_points,
                    "sell_votes": votes.sell_votes,
                    "sell_points": votes.sell_points,
                }
            )
    return tuple(result)


def _quantile(values: Sequence[float], probability: float) -> float | None:
    if not values:
        return None
    ordered = sorted(float(value) for value in values)
    position = probability * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def score_distribution_artifact(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Summarise score rows while leaving every raw row available separately."""

    probabilities = (0.0, 0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99, 1.0)

    def summary(selected: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        scores = [float(row["score"]) for row in selected]
        frequency = Counter(round(score, 6) for score in scores)
        return {
            "candidate_rows": len(selected),
            "quantile_method": "linear interpolation at p*(n-1)",
            "quantiles": {
                str(probability): _quantile(scores, probability)
                for probability in probabilities
            },
            "displayed_rows": sum(bool(row["displayed"]) for row in selected),
            "auto_score_reached_rows": sum(
                bool(row["auto_score_reached"]) for row in selected
            ),
            "contested_rows": sum(bool(row["contested"]) for row in selected),
            "score_frequency_rounded_6dp": [
                {"score": score, "count": count}
                for score, count in sorted(frequency.items())
            ],
        }

    groups: dict[str, dict[str, Any]] = {}
    for regime in Regime:
        for direction in (Direction.BUY, Direction.SELL):
            key = f"{regime.value}/{direction.value}"
            selected = [
                row
                for row in rows
                if row["regime"] == regime.value
                and row["direction"] == direction.value
            ]
            groups[key] = summary(selected)
    return {
        "scope": (
            "Non-empty BUY and SELL candidate sides after proposed cluster "
            "collapse; no outcomes, costs, fills, M1 replay, or execution."
        ),
        "overall": summary(rows),
        "by_regime_direction": groups,
    }


def canonical_json_bytes(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


def sha256_value(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def observation_digest(
    observations: Sequence[EvaluatedObservation],
) -> str:
    """Hash the exact compact detector population consumed by the proposal."""

    rows = [
        {
            "symbol": row.symbol,
            "bar_time": row.bar_time.isoformat(),
            "close_time": row.close_time.isoformat(),
            "regime": row.cofire.regime.value,
            "results": [
                {
                    "module_id": result.module_id,
                    "fired": result.fired,
                    "direction": result.direction.value,
                    "score": result.score,
                }
                for result in row.cofire.results
            ],
        }
        for row in observations
    ]
    return sha256_value(rows)


__all__ = [
    "CALIBRATION_QUALITIES",
    "EffectiveRegime",
    "EvaluatedObservation",
    "NeutralClusterProposal",
    "attach_latest_closed_regimes",
    "canonical_json_bytes",
    "classify_closed_h1",
    "evaluate_full_prefix_population",
    "fire_count_artifact",
    "observation_digest",
    "pairwise_artifacts",
    "neutral_cluster_proposals",
    "neutral_reachability_artifact",
    "pre_htf_score_ingredients",
    "proposal_registry",
    "reachability_artifact",
    "realised_score_rows",
    "score_distribution_artifact",
    "score_ingredient_summary",
    "sha256_value",
]
