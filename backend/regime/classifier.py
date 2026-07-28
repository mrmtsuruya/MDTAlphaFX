"""§3 Tier 1 — Market Regime Classifier.

Runs before strategy evaluation. Determines context and gates which clusters may
contribute. **No strategy module ever calls into this** (rule 2) — Tier 1 gates
modules externally.

All functions in this module are pure. Inputs and configuration are supplied by
the caller; the classifier performs no I/O and reads no clock or global state.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from ..contracts import Direction, Regime
from ..scoring.types import ClusterState


@dataclass(frozen=True)
class RegimeInputs:
    """§3.1 classification inputs, pre-computed. Real, so tests can construct
    the exact edge cases §3.2 and §3.3 describe."""

    adx: float
    ema_stack_aligned: bool
    ema_stack_bullish: bool
    atr_percentile: float
    r_squared: float
    within_news_blackout: bool


@dataclass(frozen=True)
class RegimeVerdict:
    """What the classifier returns for one timeframe, one bar."""

    regime: Regime
    regime_confidence: float  # 0..1
    bars_in_regime: int
    pending: Regime | None  # classification awaiting confirmation, if any
    pending_bars: int


def _config_value(config: Mapping[str, Any], section: str, key: str) -> Any:
    """Read the production nested schema while accepting flat injected config.

    Stage 1 tests deliberately inject leaf-only dictionaries, whereas the
    production YAML groups values by section. Nested values are authoritative
    when both forms are present.
    """

    section_values = config.get(section)
    if isinstance(section_values, Mapping) and key in section_values:
        return section_values[key]
    if key in config:
        return config[key]
    raise KeyError(f"missing regime config value: {section}.{key}")


def _finite_number(config: Mapping[str, Any], section: str, key: str) -> float:
    value = _config_value(config, section, key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{section}.{key} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{section}.{key} must be finite")
    return number


def _validated_inputs(inputs: RegimeInputs) -> None:
    for field_name in ("adx", "atr_percentile", "r_squared"):
        value = getattr(inputs, field_name)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TypeError(f"RegimeInputs.{field_name} must be a finite number")
        if not math.isfinite(float(value)):
            raise ValueError(f"RegimeInputs.{field_name} must be finite")


def _is_trending(regime: Regime) -> bool:
    return regime in (Regime.TRENDING_BULLISH, Regime.TRENDING_BEARISH)


def _adx_dead_band_holds(
    previous_regime: Regime,
    raw: Regime,
    inputs: RegimeInputs,
    config: Mapping[str, Any],
) -> bool:
    """Apply the approved ordering for ADX-driven TRANSITIONAL results.

    The dead band applies only when ADX is the condition that made the otherwise
    qualifying current-regime branch fall through to TRANSITIONAL. A broken EMA
    stack, insufficient R², or another non-ADX reason is genuine uncertainty
    and therefore takes effect immediately.
    """

    if raw is not Regime.TRANSITIONAL:
        return False

    volatile_above = _finite_number(
        config, "classification", "atr_percentile_volatile_above"
    )
    if inputs.within_news_blackout or inputs.atr_percentile > volatile_above:
        return False

    if _is_trending(previous_regime):
        trend_enter = _finite_number(config, "hysteresis", "adx_trend_enter")
        trend_exit = _finite_number(config, "hysteresis", "adx_trend_exit")
        r_squared_above = _finite_number(
            config, "classification", "r_squared_trend_above"
        )
        adx_is_only_failed_condition = (
            inputs.adx <= trend_enter
            and inputs.ema_stack_aligned
            and inputs.r_squared > r_squared_above
        )
        return adx_is_only_failed_condition and inputs.adx >= trend_exit

    if previous_regime is Regime.RANGING:
        range_enter = _finite_number(config, "hysteresis", "adx_range_enter")
        range_exit = _finite_number(config, "hysteresis", "adx_range_exit")
        atr_range_below = _finite_number(
            config, "classification", "atr_percentile_range_below"
        )
        adx_is_only_failed_condition = (
            inputs.adx >= range_enter
            and inputs.atr_percentile < atr_range_below
        )
        return adx_is_only_failed_condition and inputs.adx <= range_exit

    return False


def classify_raw(inputs: RegimeInputs, config: dict) -> Regime:
    """§3.2 — the ordered rules, before hysteresis.

    Evaluated IN ORDER, first match wins:

        IF within news_blackout_window   -> VOLATILE_NEWS
        ELIF atr_percentile > 90         -> VOLATILE_NEWS
        ELIF adx > adx_trend_enter
             AND ema_stack_aligned
             AND r_squared > 0.60        -> TRENDING_BULLISH | TRENDING_BEARISH
        ELIF adx < adx_range_enter
             AND atr_percentile < 60     -> RANGING
        ELSE                             -> TRANSITIONAL

    Order is load-bearing: a news blackout outranks a textbook trend.
    """
    _validated_inputs(inputs)
    volatile_above = _finite_number(
        config, "classification", "atr_percentile_volatile_above"
    )
    trend_enter = _finite_number(config, "hysteresis", "adx_trend_enter")
    r_squared_above = _finite_number(
        config, "classification", "r_squared_trend_above"
    )
    range_enter = _finite_number(config, "hysteresis", "adx_range_enter")
    atr_range_below = _finite_number(
        config, "classification", "atr_percentile_range_below"
    )

    if inputs.within_news_blackout:
        return Regime.VOLATILE_NEWS
    if inputs.atr_percentile > volatile_above:
        return Regime.VOLATILE_NEWS
    if (
        inputs.adx > trend_enter
        and inputs.ema_stack_aligned
        and inputs.r_squared > r_squared_above
    ):
        return (
            Regime.TRENDING_BULLISH
            if inputs.ema_stack_bullish
            else Regime.TRENDING_BEARISH
        )
    if inputs.adx < range_enter and inputs.atr_percentile < atr_range_below:
        return Regime.RANGING
    return Regime.TRANSITIONAL


def apply_hysteresis(
    previous: RegimeVerdict,
    raw: Regime,
    inputs: RegimeInputs,
    config: dict,
) -> RegimeVerdict:
    """§3.3 — both mechanisms, both mandatory.

    **Asymmetric thresholds.** Enter TRENDING above `adx_trend_enter`, exit only
    below `adx_trend_exit`. Enter RANGING below `adx_range_enter`, exit above
    `adx_range_exit`. The dead band between prevents oscillation — an ADX
    wandering across a single threshold must not flip the regime.

    **Confirmation bars.** A new classification must hold `regime_confirm_bars`
    consecutive CLOSED bars before it takes effect. Until confirmed the previous
    regime remains active and `regime_confidence` decays toward 0.

    **TRANSITIONAL is exempt from confirmation** — degrading to uncertain should
    be immediate.
    """
    _validated_inputs(inputs)
    if not isinstance(previous, RegimeVerdict):
        raise TypeError("previous must be a RegimeVerdict")
    if not isinstance(previous.regime, Regime):
        raise TypeError("previous.regime must be a Regime")
    if not isinstance(raw, Regime):
        raise TypeError("raw must be a Regime")

    confirmation_value = _config_value(
        config, "hysteresis", "regime_confirm_bars"
    )
    if isinstance(confirmation_value, bool) or not isinstance(
        confirmation_value, int
    ):
        raise TypeError("hysteresis.regime_confirm_bars must be a positive integer")
    if confirmation_value < 1:
        raise ValueError("hysteresis.regime_confirm_bars must be a positive integer")
    confirm_bars = confirmation_value

    transitional_exempt = _config_value(
        config, "hysteresis", "transitional_exempt_from_confirmation"
    )
    if transitional_exempt is not True:
        raise ValueError(
            "hysteresis.transitional_exempt_from_confirmation must be true"
        )

    effective_raw = (
        previous.regime
        if _adx_dead_band_holds(previous.regime, raw, inputs, config)
        else raw
    )

    if effective_raw is previous.regime:
        return RegimeVerdict(
            regime=previous.regime,
            regime_confidence=1.0,
            bars_in_regime=previous.bars_in_regime + 1,
            pending=None,
            pending_bars=0,
        )

    if effective_raw is Regime.TRANSITIONAL:
        return RegimeVerdict(
            regime=Regime.TRANSITIONAL,
            regime_confidence=1.0,
            bars_in_regime=1,
            pending=None,
            pending_bars=0,
        )

    pending_bars = (
        previous.pending_bars + 1 if previous.pending is effective_raw else 1
    )
    if pending_bars >= confirm_bars:
        return RegimeVerdict(
            regime=effective_raw,
            regime_confidence=1.0,
            bars_in_regime=1,
            pending=None,
            pending_bars=0,
        )

    remaining_confirmations = confirm_bars - pending_bars
    return RegimeVerdict(
        regime=previous.regime,
        regime_confidence=remaining_confirmations / confirm_bars,
        bars_in_regime=previous.bars_in_regime + 1,
        pending=effective_raw,
        pending_bars=pending_bars,
    )


def cluster_state(
    regime: Regime,
    cluster_id: str,
    cluster_map: dict[Regime, dict[str, ClusterState]],
) -> ClusterState:
    """§3.4 — the three-state regime→cluster map.

    SUPPRESSED means members return `fired=False` regardless of pattern.
    COUNTER_ONLY (§3.4 note 1) means the cluster may contribute only AGAINST the
    trend direction, as an early-reversal warning; it cannot add conviction to a
    with-trend signal and is excluded from that signal's scoring denominator.
    """
    if not isinstance(regime, Regime):
        raise TypeError("regime must be a Regime")
    if not isinstance(cluster_id, str) or not cluster_id:
        raise TypeError("cluster_id must be a non-empty string")

    row: Mapping[str, Any] | None = None
    candidate_keys: tuple[Any, ...]
    if _is_trending(regime):
        candidate_keys = (regime, regime.value, "TRENDING")
    else:
        candidate_keys = (regime, regime.value)

    for key in candidate_keys:
        candidate = cluster_map.get(key)
        if candidate is not None:
            if not isinstance(candidate, Mapping):
                raise TypeError(f"cluster map row {key!r} must be a mapping")
            row = candidate
            break

    if row is None:
        raise KeyError(f"cluster map has no row for regime {regime.value}")
    if cluster_id not in row:
        raise KeyError(
            f"cluster map row {regime.value} has no cluster {cluster_id!r}"
        )

    value = row[cluster_id]
    if isinstance(value, ClusterState):
        return value
    try:
        return ClusterState(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"invalid cluster state for {regime.value}.{cluster_id}: {value!r}"
        ) from exc


def htf_alignment_penalty(
    signal_direction: Direction, bias_regime: Regime, config: dict
) -> float:
    """§3.5 — the bias timeframe does NOT veto, it penalises.

    "This keeps counter-trend setups available at reduced conviction rather than
    banning them — which matters because cluster F is the most orthogonal signal
    in the library and is inherently counter-trend."
    """
    if not isinstance(signal_direction, Direction):
        raise TypeError("signal_direction must be a Direction")
    if not isinstance(bias_regime, Regime):
        raise TypeError("bias_regime must be a Regime")

    aligned = _finite_number(config, "per_timeframe", "aligned_multiplier")
    counter_bias = _finite_number(
        config, "per_timeframe", "counter_bias_penalty"
    )
    if counter_bias <= 0.0 or counter_bias > aligned:
        raise ValueError(
            "per_timeframe.counter_bias_penalty must be positive and no greater "
            "than aligned_multiplier"
        )

    if (
        bias_regime is Regime.TRENDING_BULLISH
        and signal_direction is Direction.SELL
    ) or (
        bias_regime is Regime.TRENDING_BEARISH
        and signal_direction is Direction.BUY
    ):
        return counter_bias
    return aligned


__all__ = [
    "RegimeInputs",
    "RegimeVerdict",
    "classify_raw",
    "apply_hysteresis",
    "cluster_state",
    "htf_alignment_penalty",
]
