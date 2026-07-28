"""§5.3 signal gate and candidate-centric §5.4 timeframe combination."""

from __future__ import annotations

from collections.abc import Sequence
from math import isfinite
from typing import Any, Mapping

from ..contracts import (
    Direction,
    GateOutcome,
    Regime,
    Timeframe,
    TimeframeState,
    VoteTally,
)
from ..core.errors import ConfigError
from .types import (
    ClusterRegistry,
    FiringCluster,
    MultiTimeframeDecision,
    MultiTimeframeInput,
    MultiTimeframePolicy,
    MultiTimeframeRoute,
    ScoreBreakdown,
)


VALIDITY_CONDITIONS = (
    "MIN_CLUSTERS",
    "MIN_PILLARS",
    "REGIME_NOT_VOLATILE_NEWS",
    "MAX_SPREAD",
    "NO_CONFLICTING_POSITION",
    "BIAS_TIMEFRAMES_NOT_CONFLICTED",
    "POOR_RR",
)

_NO_SCORE_PENALTY = 1.0
_BIAS_CONFLICT_REASON = "BIAS_TIMEFRAMES_NOT_CONFLICTED"
_DIRECTIONAL_REGIMES = {
    Regime.TRENDING_BULLISH: Direction.BUY,
    Regime.TRENDING_BEARISH: Direction.SELL,
}
_TIMEFRAME_RANK = {
    Timeframe.H4: 0,
    Timeframe.H1: 1,
    Timeframe.M15: 2,
    Timeframe.M5: 3,
    Timeframe.M1: 4,
}


def _value(
    config: Mapping[str, Any],
    key: str,
    *sections: str,
) -> Any:
    if key in config:
        return config[key]
    for section in sections:
        nested = config.get(section)
        if isinstance(nested, Mapping) and key in nested:
            return nested[key]
    raise ConfigError(f"missing scoring config key {key!r}")


def _optional_value(
    config: Mapping[str, Any],
    key: str,
    *sections: str,
) -> Any | None:
    try:
        return _value(config, key, *sections)
    except ConfigError:
        return None


def _number(value: Any, *, name: str) -> float:
    if isinstance(value, bool):
        raise ConfigError(f"{name} must be numeric")
    try:
        numeric = float(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"{name} must be numeric") from exc
    if not isfinite(numeric):
        raise ConfigError(f"{name} must be finite")
    return numeric


def _integer(value: Any, *, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f"{name} must be an integer")
    return value


def _timeframe(value: Any, *, name: str) -> Timeframe:
    if isinstance(value, Timeframe):
        return value
    try:
        return Timeframe(str(value))
    except ValueError as exc:
        raise ConfigError(f"{name} is not a supported timeframe: {value!r}") from exc


def _direction(value: Any, *, name: str) -> Direction:
    if isinstance(value, Direction):
        return value
    try:
        return Direction(str(value))
    except ValueError as exc:
        raise ConfigError(f"{name} is not a supported direction: {value!r}") from exc


def count_pillars(
    firing: Sequence[FiringCluster], registry: ClusterRegistry
) -> int:
    """Count pillars among firing modules, not among cluster definitions."""

    pillars: set[int] = set()
    for cluster in firing:
        if not cluster.fired or cluster.direction is Direction.NONE:
            continue
        for module_id in cluster.contributing_modules:
            try:
                pillars.add(registry.pillar_of_module[module_id])
            except KeyError as exc:
                raise ValueError(
                    f"no pillar registered for firing module {module_id}"
                ) from exc
    return len(pillars)


def evaluate_validity(
    breakdown: ScoreBreakdown,
    firing: Sequence[FiringCluster],
    registry: ClusterRegistry,
    regime: Regime,
    spread_points: int,
    max_spread_points: int,
    has_conflicting_position: bool,
    bias_timeframes_conflicted: bool,
    poor_rr: bool,
    config: dict,
) -> GateOutcome:
    """Evaluate all structural facts and record every failure."""

    min_clusters = _integer(
        _value(config, "min_clusters", "validity"), name="min_clusters"
    )
    min_pillars = _integer(
        _value(config, "min_pillars", "validity"), name="min_pillars"
    )
    if min_clusters < 0 or min_pillars < 0:
        raise ConfigError("min_clusters and min_pillars must be non-negative")

    agreeing = [
        cluster
        for cluster in firing
        if cluster.fired and cluster.direction is not Direction.NONE
    ]
    distinct_clusters = len({cluster.cluster_id for cluster in agreeing})
    failures: list[str] = []
    if distinct_clusters < min_clusters:
        failures.append("MIN_CLUSTERS")
    if count_pillars(agreeing, registry) < min_pillars:
        failures.append("MIN_PILLARS")
    if regime is Regime.VOLATILE_NEWS:
        failures.append("REGIME_NOT_VOLATILE_NEWS")
    if spread_points > max_spread_points:
        failures.append("MAX_SPREAD")
    if has_conflicting_position:
        failures.append("NO_CONFLICTING_POSITION")
    if bias_timeframes_conflicted:
        failures.append(_BIAS_CONFLICT_REASON)
    if poor_rr:
        failures.append("POOR_RR")

    display_threshold = _number(
        _value(config, "display_threshold", "thresholds"),
        name="display_threshold",
    )
    auto_threshold = _number(
        _value(config, "auto_execute_threshold", "thresholds"),
        name="auto_execute_threshold",
    )
    return GateOutcome(
        passed=not failures,
        failed_conditions=failures,
        score=breakdown.score,
        breadth=breakdown.breadth,
        quality=breakdown.quality,
        display_threshold=display_threshold,
        auto_execute_threshold=auto_threshold,
    )


def is_displayed(score: float, regime: Regime, config: dict) -> bool:
    """Apply the inclusive view filter and TRANSITIONAL's display-only uplift."""

    threshold = _number(
        _value(config, "display_threshold", "thresholds"),
        name="display_threshold",
    )
    if regime is Regime.TRANSITIONAL:
        threshold += _number(
            _value(
                config,
                "transitional_threshold_uplift",
                "regime_policy",
            ),
            name="transitional_threshold_uplift",
        )
    return float(score) >= threshold


def is_auto_eligible(
    score: float,
    votes: VoteTally,
    regime: Regime,
    symbol_enabled: bool,
    config: dict,
) -> bool:
    """Apply the inclusive AUTO threshold, dissent block and symbol toggle."""

    del regime  # The +5 TRANSITIONAL uplift applies to display only.
    threshold = _number(
        _value(config, "auto_execute_threshold", "thresholds"),
        name="auto_execute_threshold",
    )
    contested_blocks = _optional_value(
        config, "contested_blocks_auto", "tally"
    )
    if contested_blocks is None:
        contested_blocks = True
    if not isinstance(contested_blocks, bool):
        raise ConfigError("contested_blocks_auto must be boolean")
    return (
        bool(symbol_enabled)
        and not (contested_blocks and votes.contested)
        and float(score) >= threshold
    )


def assert_thresholds_ordered(config: dict) -> None:
    """Reject an AUTO threshold below the display threshold at startup."""

    display = _number(
        _value(config, "display_threshold", "thresholds"),
        name="display_threshold",
    )
    auto = _number(
        _value(config, "auto_execute_threshold", "thresholds"),
        name="auto_execute_threshold",
    )
    if auto < display:
        raise ConfigError(
            "auto_execute_threshold must be greater than or equal to "
            "display_threshold"
        )


def combine_timeframes(states: dict[Timeframe, object], config: dict) -> dict:
    """Combine states candidate-centrically without averaging them.

    ``candidate_direction`` may be supplied in ``config["mtf"]`` or at the top
    level. If omitted, the entry timeframe's resolved direction is the
    candidate. That preserves the existing API while making the formerly
    indistinguishable Radar and counter-bias rows expressible.
    """

    normalised: dict[Timeframe, TimeframeState] = {}
    for raw_timeframe, state in states.items():
        timeframe = _timeframe(raw_timeframe, name="timeframe state key")
        if not isinstance(state, TimeframeState):
            raise TypeError(
                "combine_timeframes requires frozen TimeframeState values"
            )
        if state.timeframe is not timeframe:
            raise ValueError(
                f"timeframe key {timeframe.value} does not match state "
                f"{state.timeframe.value}"
            )
        normalised[timeframe] = state
    if not normalised:
        raise ValueError("combine_timeframes requires at least one state")

    raw_bias = _optional_value(config, "bias_timeframe", "per_timeframe")
    if raw_bias is None:
        bias_timeframe = (
            Timeframe.H4
            if Timeframe.H4 in normalised
            else min(normalised, key=lambda item: _TIMEFRAME_RANK[item])
        )
    else:
        bias_timeframe = _timeframe(raw_bias, name="bias_timeframe")
    if bias_timeframe not in normalised:
        raise ValueError(
            f"bias timeframe {bias_timeframe.value} has no TimeframeState"
        )

    raw_entry = _optional_value(config, "entry_timeframe", "per_timeframe")
    if raw_entry is None:
        # §5.4 specifies M15 as the default. Selecting the lowest available
        # non-bias timeframe silently turned the configured M5 analysis stream
        # into the default entry stream whenever both were present.
        entry_timeframe = Timeframe.M15
    else:
        entry_timeframe = _timeframe(raw_entry, name="entry_timeframe")
    if entry_timeframe not in normalised:
        raise ValueError(
            f"entry timeframe {entry_timeframe.value} has no TimeframeState"
        )

    secondary_bias = (
        Timeframe.H1
        if Timeframe.H1 in normalised and Timeframe.H1 is not bias_timeframe
        else None
    )
    raw_counter_penalty = _optional_value(
        config, "counter_bias_penalty", "per_timeframe"
    )
    counter_penalty = (
        None
        if raw_counter_penalty is None
        else _number(raw_counter_penalty, name="counter_bias_penalty")
    )
    raw_aligned = _optional_value(config, "aligned_multiplier", "per_timeframe")
    aligned_multiplier = (
        _NO_SCORE_PENALTY
        if raw_aligned is None
        else _number(raw_aligned, name="aligned_multiplier")
    )
    if not 0.0 <= aligned_multiplier <= 1.0:
        raise ConfigError("aligned_multiplier must be within 0..1")

    raw_candidate = _optional_value(config, "candidate_direction", "mtf")
    candidate_direction = (
        normalised[entry_timeframe].direction
        if raw_candidate is None
        else _direction(raw_candidate, name="candidate_direction")
    )
    if candidate_direction is Direction.NONE:
        raise ValueError("candidate_direction must resolve to BUY or SELL")

    policy = MultiTimeframePolicy(
        bias_timeframe=bias_timeframe,
        secondary_bias_timeframe=secondary_bias,
        entry_timeframe=entry_timeframe,
        counter_bias_penalty=counter_penalty,
        aligned_multiplier=aligned_multiplier,
    )
    inputs = MultiTimeframeInput(
        states=normalised,
        candidate_direction=candidate_direction,
        policy=policy,
    )

    def effective_direction(state: TimeframeState) -> Direction:
        if state.direction is not Direction.NONE:
            return state.direction
        return _DIRECTIONAL_REGIMES.get(state.regime, Direction.NONE)

    bias_direction = effective_direction(inputs.states[bias_timeframe])
    secondary_direction = (
        effective_direction(inputs.states[secondary_bias])
        if secondary_bias is not None
        else Direction.NONE
    )
    bias_conflict = (
        bias_direction is not Direction.NONE
        and secondary_direction is not Direction.NONE
        and bias_direction is not secondary_direction
    )
    entry_direction = effective_direction(inputs.states[entry_timeframe])

    route = MultiTimeframeRoute.STANDARD
    score_penalty = aligned_multiplier
    counter_bias = False
    failures: tuple[str, ...] = ()

    if bias_conflict:
        route = MultiTimeframeRoute.SUPPRESSED
        failures = (_BIAS_CONFLICT_REASON,)
    elif (
        bias_direction is candidate_direction
        and entry_direction not in (Direction.NONE, candidate_direction)
    ):
        route = MultiTimeframeRoute.RADAR
    elif (
        entry_direction is candidate_direction
        and bias_direction not in (Direction.NONE, candidate_direction)
    ):
        if counter_penalty is None:
            raise ConfigError(
                "counter_bias_penalty is required for a counter-bias candidate"
            )
        if not 0.0 <= counter_penalty <= 1.0:
            raise ConfigError("counter_bias_penalty must be within 0..1")
        score_penalty = counter_penalty
        counter_bias = True
    elif entry_direction is Direction.NONE:
        route = MultiTimeframeRoute.RADAR

    aligned_count = sum(
        effective_direction(state) is candidate_direction
        for state in inputs.states.values()
    )
    return MultiTimeframeDecision(
        states=inputs.states,
        candidate_direction=candidate_direction,
        route=route,
        score_penalty=score_penalty,
        counter_bias=counter_bias,
        bias_timeframes_conflicted=bias_conflict,
        failed_conditions=failures,
        aligned_count=aligned_count,
        timeframe_count=len(inputs.states),
    ).as_dict()


__all__ = [
    "VALIDITY_CONDITIONS",
    "count_pillars",
    "evaluate_validity",
    "is_displayed",
    "is_auto_eligible",
    "assert_thresholds_ordered",
    "combine_timeframes",
]
