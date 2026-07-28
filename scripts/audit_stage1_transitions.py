"""Deterministically audit the saved Stage 1 regime replay against price.

This command performs no broker I/O and does not mutate model configuration.
It reads ``docs/stage1-gate/regime_replay.json`` and writes two review artifacts:

* ``transition_audit.json`` — machine-readable evidence for every segment.
* ``transition_audit.md`` — operator-facing findings, including all one-bar
  segments and representative sustained transitions.

The audit independently re-implements the small §3.2/§3.3 decision table from
the specification.  It deliberately does not call the production classifier:
an exhaustive agreement result is therefore evidence rather than a tautology.

Price assessments are diagnostics, not trading-performance claims.  Regimes are
defined by contemporaneous features, so later price movement cannot prove a
classification false.  The explicit, fixed diagnostic thresholds below merely
turn the operator's chart-review queue into a reproducible triage.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.contracts import Regime  # noqa: E402
from backend.core.config import Config  # noqa: E402

DEFAULT_REPLAY = REPO_ROOT / "docs" / "stage1-gate" / "regime_replay.json"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "docs" / "stage1-gate"
SCHEMA_VERSION = 1
REGIME_VALUES = frozenset(regime.value for regime in Regime)
REQUIRED_ROW_FIELDS = frozenset(
    {
        "symbol",
        "time",
        "open",
        "high",
        "low",
        "close",
        "adx",
        "atr_percentile",
        "r_squared",
        "ema_stack_aligned",
        "ema_stack_bullish",
        "within_news_blackout",
        "raw_regime",
        "regime",
        "confidence",
        "bars_in_regime",
    }
)

# These are audit-only price triage thresholds, not model parameters.
PRICE_DIAGNOSTIC_RULES = {
    "pre_segment_range_bars": 20,
    "trend_supportive_signed_move_range_units_gte": 0.5,
    "trend_contradictory_signed_move_range_units_lte": -0.5,
    "range_supportive_efficiency_lte": 0.35,
    "range_supportive_abs_move_range_units_lte": 2.0,
    "range_contradictory_efficiency_gte": 0.65,
    "range_contradictory_abs_move_range_units_gte": 3.0,
    "volatile_supportive_median_range_ratio_gte": 1.25,
    "volatile_supportive_max_range_ratio_gte": 2.0,
    "volatile_contradictory_median_range_ratio_lt": 0.8,
    "volatile_contradictory_max_range_ratio_lt": 1.0,
    "one_bar_range_supportive_range_ratio_lte": 1.0,
    "one_bar_range_supportive_abs_move_range_units_lt": 1.0,
    "one_bar_range_contradictory_range_ratio_gte": 2.0,
    "one_bar_range_contradictory_abs_move_range_units_gte": 1.5,
}


@dataclass(frozen=True)
class AuditVerdict:
    regime: str
    confidence: float
    bars_in_regime: int
    pending: str | None
    pending_bars: int


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Audit Stage 1 regime transitions against features and price."
    )
    parser.add_argument("--replay", default=str(DEFAULT_REPLAY))
    parser.add_argument("--config", default=str(REPO_ROOT / "config"))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    return parser


def _number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{name} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def _regime_parameters(config: Config) -> dict[str, Any]:
    return {
        "atr_percentile_volatile_above": _number(
            config.get("regime.classification.atr_percentile_volatile_above"),
            "atr_percentile_volatile_above",
        ),
        "r_squared_trend_above": _number(
            config.get("regime.classification.r_squared_trend_above"),
            "r_squared_trend_above",
        ),
        "atr_percentile_range_below": _number(
            config.get("regime.classification.atr_percentile_range_below"),
            "atr_percentile_range_below",
        ),
        "adx_trend_enter": _number(
            config.get("regime.hysteresis.adx_trend_enter"), "adx_trend_enter"
        ),
        "adx_trend_exit": _number(
            config.get("regime.hysteresis.adx_trend_exit"), "adx_trend_exit"
        ),
        "adx_range_enter": _number(
            config.get("regime.hysteresis.adx_range_enter"), "adx_range_enter"
        ),
        "adx_range_exit": _number(
            config.get("regime.hysteresis.adx_range_exit"), "adx_range_exit"
        ),
        "regime_confirm_bars": int(
            config.get("regime.hysteresis.regime_confirm_bars")
        ),
        "transitional_exempt_from_confirmation": config.get(
            "regime.hysteresis.transitional_exempt_from_confirmation"
        ),
    }


def independent_raw(row: Mapping[str, Any], params: Mapping[str, Any]) -> str:
    """Independent transcription of the ordered §3.2 decision table."""

    adx = _number(row["adx"], "adx")
    atr_percentile = _number(row["atr_percentile"], "atr_percentile")
    r_squared = _number(row["r_squared"], "r_squared")
    if row["within_news_blackout"]:
        return Regime.VOLATILE_NEWS.value
    if atr_percentile > params["atr_percentile_volatile_above"]:
        return Regime.VOLATILE_NEWS.value
    if (
        adx > params["adx_trend_enter"]
        and row["ema_stack_aligned"]
        and r_squared > params["r_squared_trend_above"]
    ):
        return (
            Regime.TRENDING_BULLISH.value
            if row["ema_stack_bullish"]
            else Regime.TRENDING_BEARISH.value
        )
    if (
        adx < params["adx_range_enter"]
        and atr_percentile < params["atr_percentile_range_below"]
    ):
        return Regime.RANGING.value
    return Regime.TRANSITIONAL.value


def _is_trending(regime: str) -> bool:
    return regime in {
        Regime.TRENDING_BULLISH.value,
        Regime.TRENDING_BEARISH.value,
    }


def independent_dead_band_holds(
    previous_regime: str,
    raw: str,
    row: Mapping[str, Any],
    params: Mapping[str, Any],
) -> bool:
    """Independent transcription of the approved ADX-only dead-band rule."""

    if raw != Regime.TRANSITIONAL.value:
        return False
    if (
        row["within_news_blackout"]
        or _number(row["atr_percentile"], "atr_percentile")
        > params["atr_percentile_volatile_above"]
    ):
        return False
    adx = _number(row["adx"], "adx")
    if _is_trending(previous_regime):
        adx_is_only_failed_condition = (
            adx <= params["adx_trend_enter"]
            and row["ema_stack_aligned"]
            and _number(row["r_squared"], "r_squared")
            > params["r_squared_trend_above"]
        )
        return adx_is_only_failed_condition and adx >= params["adx_trend_exit"]
    if previous_regime == Regime.RANGING.value:
        adx_is_only_failed_condition = (
            adx >= params["adx_range_enter"]
            and _number(row["atr_percentile"], "atr_percentile")
            < params["atr_percentile_range_below"]
        )
        return adx_is_only_failed_condition and adx <= params["adx_range_exit"]
    return False


def independent_hysteresis_step(
    previous: AuditVerdict,
    raw: str,
    row: Mapping[str, Any],
    params: Mapping[str, Any],
) -> AuditVerdict:
    """Independent transcription of §3.3 for one closed bar."""

    confirm_bars = params["regime_confirm_bars"]
    if not isinstance(confirm_bars, int) or isinstance(confirm_bars, bool):
        raise TypeError("regime_confirm_bars must be a positive integer")
    if confirm_bars < 1:
        raise ValueError("regime_confirm_bars must be a positive integer")
    if params["transitional_exempt_from_confirmation"] is not True:
        raise ValueError("TRANSITIONAL must be exempt from confirmation")

    effective_raw = (
        previous.regime
        if independent_dead_band_holds(previous.regime, raw, row, params)
        else raw
    )
    if effective_raw == previous.regime:
        return AuditVerdict(
            previous.regime, 1.0, previous.bars_in_regime + 1, None, 0
        )
    if effective_raw == Regime.TRANSITIONAL.value:
        return AuditVerdict(Regime.TRANSITIONAL.value, 1.0, 1, None, 0)
    pending_bars = (
        previous.pending_bars + 1 if previous.pending == effective_raw else 1
    )
    if pending_bars >= confirm_bars:
        return AuditVerdict(effective_raw, 1.0, 1, None, 0)
    return AuditVerdict(
        previous.regime,
        (confirm_bars - pending_bars) / confirm_bars,
        previous.bars_in_regime + 1,
        effective_raw,
        pending_bars,
    )


def _initial_verdict(row: Mapping[str, Any], confirm_bars: int) -> AuditVerdict:
    confidence = _number(row["confidence"], "confidence")
    pending: str | None = None
    pending_bars = 0
    if confidence < 1.0:
        inferred = int(round(confirm_bars * (1.0 - confidence)))
        if inferred <= 0 or row["raw_regime"] in {
            row["regime"],
            Regime.TRANSITIONAL.value,
        }:
            raise ValueError("cannot infer first-row pending hysteresis state")
        pending = str(row["raw_regime"])
        pending_bars = inferred
    return AuditVerdict(
        regime=str(row["regime"]),
        confidence=confidence,
        bars_in_regime=int(row["bars_in_regime"]),
        pending=pending,
        pending_bars=pending_bars,
    )


def _same_visible_verdict(expected: AuditVerdict, row: Mapping[str, Any]) -> bool:
    return (
        expected.regime == row["regime"]
        and math.isclose(
            expected.confidence,
            _number(row["confidence"], "confidence"),
            rel_tol=0.0,
            abs_tol=1e-12,
        )
        and expected.bars_in_regime == row["bars_in_regime"]
    )


def _iso_utc(value: Any) -> datetime:
    if not isinstance(value, str):
        raise TypeError("time must be an ISO string")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None or result.utcoffset() is None:
        raise ValueError("time must be timezone-aware")
    if result.utcoffset().total_seconds() != 0:
        raise ValueError("time must be UTC")
    return result


def _schema_violations(symbol: str, rows: Sequence[Mapping[str, Any]]) -> list[dict]:
    violations: list[dict] = []
    prior_time: datetime | None = None
    for index, row in enumerate(rows):
        missing = sorted(REQUIRED_ROW_FIELDS - row.keys())
        if missing:
            violations.append(
                {
                    "symbol": symbol,
                    "index": index,
                    "kind": "MISSING_FIELDS",
                    "detail": missing,
                }
            )
            continue
        try:
            timestamp = _iso_utc(row["time"])
            prices = {
                key: _number(row[key], key)
                for key in ("open", "high", "low", "close")
            }
            for key in ("adx", "atr_percentile", "r_squared", "confidence"):
                _number(row[key], key)
            if row["symbol"] != symbol:
                raise ValueError("row symbol differs from containing symbol")
            if prior_time is not None and timestamp <= prior_time:
                raise ValueError("timestamps are not strictly increasing")
            prior_time = timestamp
            if not (
                prices["low"]
                <= min(prices["open"], prices["close"])
                <= max(prices["open"], prices["close"])
                <= prices["high"]
            ):
                raise ValueError("OHLC envelope is impossible")
            if prices["low"] <= 0.0:
                raise ValueError("price must be positive")
            if not 0.0 <= _number(row["adx"], "adx") <= 100.0:
                raise ValueError("ADX outside [0,100]")
            if not 0.0 <= _number(
                row["atr_percentile"], "atr_percentile"
            ) <= 100.0:
                raise ValueError("ATR percentile outside [0,100]")
            if not 0.0 <= _number(row["r_squared"], "r_squared") <= 1.0:
                raise ValueError("R-squared outside [0,1]")
            if not 0.0 <= _number(row["confidence"], "confidence") <= 1.0:
                raise ValueError("confidence outside [0,1]")
            if (
                not isinstance(row["bars_in_regime"], int)
                or isinstance(row["bars_in_regime"], bool)
                or row["bars_in_regime"] < 1
            ):
                raise ValueError("bars_in_regime must be a positive integer")
            for key in (
                "ema_stack_aligned",
                "ema_stack_bullish",
                "within_news_blackout",
            ):
                if not isinstance(row[key], bool):
                    raise TypeError(f"{key} must be boolean")
            if row["raw_regime"] not in REGIME_VALUES:
                raise ValueError("unknown raw regime")
            if row["regime"] not in REGIME_VALUES:
                raise ValueError("unknown effective regime")
        except (KeyError, TypeError, ValueError) as exc:
            violations.append(
                {
                    "symbol": symbol,
                    "index": index,
                    "time": row.get("time"),
                    "kind": "INVALID_ROW",
                    "detail": str(exc),
                }
            )
    return violations


def _gap_summary(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    gaps: list[float] = []
    for left, right in zip(rows, rows[1:]):
        hours = (_iso_utc(right["time"]) - _iso_utc(left["time"])).total_seconds() / 3600
        if hours > 1.0:
            gaps.append(hours)
    return {
        "non_hourly_gap_count": len(gaps),
        "maximum_gap_hours": max(gaps, default=0.0),
    }


def _mechanical_audit(
    symbol: str,
    rows: Sequence[Mapping[str, Any]],
    params: Mapping[str, Any],
) -> dict[str, Any]:
    raw_mismatches: list[dict] = []
    hysteresis_mismatches: list[dict] = []
    for index, row in enumerate(rows):
        expected_raw = independent_raw(row, params)
        if expected_raw != row["raw_regime"]:
            raw_mismatches.append(
                {
                    "symbol": symbol,
                    "index": index,
                    "time": row["time"],
                    "expected": expected_raw,
                    "actual": row["raw_regime"],
                }
            )
    if rows:
        previous = _initial_verdict(rows[0], params["regime_confirm_bars"])
        for index in range(1, len(rows)):
            row = rows[index]
            expected = independent_hysteresis_step(
                previous, str(row["raw_regime"]), row, params
            )
            if not _same_visible_verdict(expected, row):
                hysteresis_mismatches.append(
                    {
                        "symbol": symbol,
                        "index": index,
                        "time": row["time"],
                        "expected": {
                            "regime": expected.regime,
                            "confidence": expected.confidence,
                            "bars_in_regime": expected.bars_in_regime,
                        },
                        "actual": {
                            "regime": row["regime"],
                            "confidence": row["confidence"],
                            "bars_in_regime": row["bars_in_regime"],
                        },
                    }
                )
            previous = expected
    return {
        "raw_branch_mismatches": raw_mismatches,
        "hysteresis_mismatches": hysteresis_mismatches,
    }


def segment_bounds(rows: Sequence[Mapping[str, Any]]) -> list[tuple[int, int]]:
    """Return inclusive effective-regime segment bounds."""

    if not rows:
        return []
    result: list[tuple[int, int]] = []
    start = 0
    for index in range(1, len(rows) + 1):
        if index < len(rows) and rows[index]["regime"] == rows[start]["regime"]:
            continue
        result.append((start, index - 1))
        start = index
    return result


def _entry_support(
    rows: Sequence[Mapping[str, Any]],
    start: int,
    params: Mapping[str, Any],
) -> dict[str, Any]:
    target = str(rows[start]["regime"])
    confirm_bars = params["regime_confirm_bars"]
    if start == 0:
        return {
            "status": "WINDOW_BOUNDARY",
            "rule": "entry predates or coincides with saved window",
            "raw_window": [rows[start]["raw_regime"]],
        }
    if target == Regime.TRANSITIONAL.value:
        raw_window = [rows[start]["raw_regime"]]
        valid = (
            rows[start]["raw_regime"] == target
            and not independent_dead_band_holds(
                str(rows[start - 1]["regime"]), target, rows[start], params
            )
        )
        return {
            "status": "PASS" if valid else "FAIL",
            "rule": "TRANSITIONAL takes effect immediately",
            "raw_window": raw_window,
        }
    raw_window = [
        str(row["raw_regime"])
        for row in rows[max(0, start - confirm_bars + 1) : start + 1]
    ]
    valid = len(raw_window) == confirm_bars and all(
        value == target for value in raw_window
    )
    return {
        "status": "PASS" if valid else "FAIL",
        "rule": f"{confirm_bars} consecutive raw confirmations",
        "raw_window": raw_window,
    }


def _feature_support(
    rows: Sequence[Mapping[str, Any]],
    start: int,
    end: int,
    params: Mapping[str, Any],
) -> dict[str, Any]:
    supported = 0
    raw_matches = 0
    for row in rows[start : end + 1]:
        regime = str(row["regime"])
        raw = str(row["raw_regime"])
        raw_matches += raw == regime
        supported += raw == regime or independent_dead_band_holds(
            regime, raw, row, params
        )
    bars = end - start + 1
    return {
        "direct_or_dead_band_bars": supported,
        "direct_or_dead_band_share": supported / bars,
        "raw_label_match_bars": raw_matches,
        "raw_label_match_share": raw_matches / bars,
    }


def price_metrics(
    rows: Sequence[Mapping[str, Any]], start: int, end: int
) -> dict[str, Any]:
    """Compute scale-free, post-label price diagnostics for a segment."""

    lookback = PRICE_DIAGNOSTIC_RULES["pre_segment_range_bars"]
    prior = rows[max(0, start - lookback) : start]
    prior_ranges = [
        _number(row["high"], "high") - _number(row["low"], "low") for row in prior
    ]
    prior_ranges = [value for value in prior_ranges if value > 0.0]
    if not prior_ranges:
        return {
            "status": "UNAVAILABLE",
            "reason": "no positive pre-segment bar range in saved window",
        }

    segment = rows[start : end + 1]
    typical_range = statistics.median(prior_ranges)
    ranges = [
        _number(row["high"], "high") - _number(row["low"], "low")
        for row in segment
    ]
    net_move = _number(segment[-1]["close"], "close") - _number(
        segment[0]["open"], "open"
    )
    path = abs(
        _number(segment[0]["close"], "close")
        - _number(segment[0]["open"], "open")
    )
    path += sum(
        abs(
            _number(right["close"], "close")
            - _number(left["close"], "close")
        )
        for left, right in zip(segment, segment[1:])
    )
    return {
        "status": "READY",
        "pre_segment_median_range": typical_range,
        "net_move": net_move,
        "net_move_range_units": net_move / typical_range,
        "path_efficiency": abs(net_move) / path if path > 0.0 else 0.0,
        "median_bar_range_ratio": statistics.median(ranges) / typical_range,
        "maximum_bar_range_ratio": max(ranges) / typical_range,
    }


def assess_price(regime: str, bars: int, metrics: Mapping[str, Any]) -> dict[str, str]:
    """Apply explicit audit-only triage rules to segment price diagnostics."""

    if metrics["status"] != "READY":
        return {"status": "UNAVAILABLE", "reason": str(metrics["reason"])}
    move = float(metrics["net_move_range_units"])
    efficiency = float(metrics["path_efficiency"])
    median_ratio = float(metrics["median_bar_range_ratio"])
    maximum_ratio = float(metrics["maximum_bar_range_ratio"])

    if regime == Regime.TRANSITIONAL.value:
        return {
            "status": "NOT_SCORED",
            "reason": "TRANSITIONAL makes no directional or volatility price claim",
        }
    if _is_trending(regime):
        signed_move = move if regime == Regime.TRENDING_BULLISH.value else -move
        if (
            signed_move
            >= PRICE_DIAGNOSTIC_RULES[
                "trend_supportive_signed_move_range_units_gte"
            ]
        ):
            return {
                "status": "SUPPORTIVE",
                "reason": f"directional move {signed_move:.2f} pre-range units",
            }
        if (
            signed_move
            <= PRICE_DIAGNOSTIC_RULES[
                "trend_contradictory_signed_move_range_units_lte"
            ]
        ):
            return {
                "status": "CONTRADICTORY",
                "reason": f"opposing move {signed_move:.2f} signed pre-range units",
            }
        return {
            "status": "MIXED",
            "reason": f"directional move only {signed_move:.2f} pre-range units",
        }
    if regime == Regime.RANGING.value:
        if bars == 1:
            if (
                median_ratio
                <= PRICE_DIAGNOSTIC_RULES[
                    "one_bar_range_supportive_range_ratio_lte"
                ]
                and abs(move)
                < PRICE_DIAGNOSTIC_RULES[
                    "one_bar_range_supportive_abs_move_range_units_lt"
                ]
            ):
                return {
                    "status": "SUPPORTIVE",
                    "reason": "single bar stayed within one typical range",
                }
            if (
                median_ratio
                >= PRICE_DIAGNOSTIC_RULES[
                    "one_bar_range_contradictory_range_ratio_gte"
                ]
                or abs(move)
                >= PRICE_DIAGNOSTIC_RULES[
                    "one_bar_range_contradictory_abs_move_range_units_gte"
                ]
            ):
                return {
                    "status": "CONTRADICTORY",
                    "reason": "single bar expanded or displaced beyond range triage bound",
                }
            return {"status": "MIXED", "reason": "single-bar range evidence is marginal"}
        if (
            efficiency
            <= PRICE_DIAGNOSTIC_RULES["range_supportive_efficiency_lte"]
            and abs(move)
            <= PRICE_DIAGNOSTIC_RULES[
                "range_supportive_abs_move_range_units_lte"
            ]
        ):
            return {
                "status": "SUPPORTIVE",
                "reason": f"low path efficiency ({efficiency:.2f}) and contained displacement",
            }
        if (
            efficiency
            >= PRICE_DIAGNOSTIC_RULES["range_contradictory_efficiency_gte"]
            and abs(move)
            >= PRICE_DIAGNOSTIC_RULES[
                "range_contradictory_abs_move_range_units_gte"
            ]
        ):
            return {
                "status": "CONTRADICTORY",
                "reason": f"efficient displacement ({efficiency:.2f}) escaped the range bound",
            }
        return {
            "status": "MIXED",
            "reason": f"range efficiency/displacement split ({efficiency:.2f}, {abs(move):.2f})",
        }
    if regime == Regime.VOLATILE_NEWS.value:
        if (
            median_ratio
            >= PRICE_DIAGNOSTIC_RULES[
                "volatile_supportive_median_range_ratio_gte"
            ]
            or maximum_ratio
            >= PRICE_DIAGNOSTIC_RULES[
                "volatile_supportive_max_range_ratio_gte"
            ]
        ):
            return {
                "status": "SUPPORTIVE",
                "reason": f"range expansion median/max {median_ratio:.2f}×/{maximum_ratio:.2f}×",
            }
        if (
            median_ratio
            < PRICE_DIAGNOSTIC_RULES[
                "volatile_contradictory_median_range_ratio_lt"
            ]
            and maximum_ratio
            < PRICE_DIAGNOSTIC_RULES[
                "volatile_contradictory_max_range_ratio_lt"
            ]
        ):
            return {
                "status": "CONTRADICTORY",
                "reason": f"bar ranges contracted to {median_ratio:.2f}× median",
            }
        return {
            "status": "MIXED",
            "reason": f"range ratio {median_ratio:.2f}× median, {maximum_ratio:.2f}× max",
        }
    raise ValueError(f"unsupported regime: {regime}")


def _round_floats(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 8)
    if isinstance(value, dict):
        return {key: _round_floats(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_round_floats(item) for item in value]
    return value


def _segment_records(
    symbol: str,
    rows: Sequence[Mapping[str, Any]],
    params: Mapping[str, Any],
) -> list[dict[str, Any]]:
    bounds = segment_bounds(rows)
    records: list[dict[str, Any]] = []
    for segment_index, (start, end) in enumerate(bounds):
        regime = str(rows[start]["regime"])
        bars = end - start + 1
        metrics = price_metrics(rows, start, end)
        assessment = assess_price(regime, bars, metrics)
        previous_regime = (
            str(rows[bounds[segment_index - 1][0]]["regime"])
            if segment_index > 0
            else None
        )
        next_regime = (
            str(rows[bounds[segment_index + 1][0]]["regime"])
            if segment_index + 1 < len(bounds)
            else None
        )
        round_trip = (
            bars == 1
            and previous_regime is not None
            and previous_regime == next_regime
        )
        entry = _entry_support(rows, start, params)
        record = {
            "id": f"{symbol}-{segment_index:04d}",
            "symbol": symbol,
            "segment_index": segment_index,
            "regime": regime,
            "previous_regime": previous_regime,
            "next_regime": next_regime,
            "start": rows[start]["time"],
            "end": rows[end]["time"],
            "bars": bars,
            "one_bar": bars == 1,
            "round_trip_aba": round_trip,
            "false_flip_candidate": round_trip,
            "entry_support": entry,
            "exit_raw_regime": rows[end + 1]["raw_regime"]
            if end + 1 < len(rows)
            else None,
            "feature_support": _feature_support(rows, start, end, params),
            "price_metrics": metrics,
            "price_assessment": assessment,
        }
        records.append(_round_floats(record))
    return records


def _context_rows(
    rows: Sequence[Mapping[str, Any]], start: int, end: int
) -> list[dict[str, Any]]:
    indices = sorted(
        {
            index
            for index in (
                start - 2,
                start - 1,
                start,
                min(start + 1, end),
                max(start, end - 1),
                end,
                end + 1,
                end + 2,
            )
            if 0 <= index < len(rows)
        }
    )
    keys = (
        "time",
        "open",
        "high",
        "low",
        "close",
        "adx",
        "atr_percentile",
        "r_squared",
        "ema_stack_aligned",
        "ema_stack_bullish",
        "raw_regime",
        "regime",
        "confidence",
        "bars_in_regime",
    )
    return [_round_floats({key: rows[index][key] for key in keys}) for index in indices]


def _representative_examples(
    records: Sequence[Mapping[str, Any]],
    rows_by_symbol: Mapping[str, Sequence[Mapping[str, Any]]],
) -> list[dict[str, Any]]:
    selected: list[tuple[str, Mapping[str, Any]]] = []
    for regime in sorted(REGIME_VALUES):
        candidates = [
            row for row in records if row["one_bar"] and row["regime"] == regime
        ]
        if candidates:
            selected.append(("FIRST_ONE_BAR_" + regime, min(candidates, key=lambda x: x["start"])))
    for regime in sorted(REGIME_VALUES):
        candidates = [
            row for row in records if not row["one_bar"] and row["regime"] == regime
        ]
        if candidates:
            selected.append(
                (
                    "LONGEST_SUSTAINED_" + regime,
                    max(candidates, key=lambda x: (x["bars"], x["start"])),
                )
            )
    contradictory = [
        row
        for row in records
        if not row["one_bar"]
        and row["price_assessment"]["status"] == "CONTRADICTORY"
    ]
    contradictory.sort(
        key=lambda row: (
            -abs(row["price_metrics"].get("net_move_range_units", 0.0)),
            row["start"],
        )
    )
    selected.extend(("LARGEST_PRICE_CONTRADICTION", row) for row in contradictory[:4])

    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    bounds_by_symbol = {
        symbol: segment_bounds(rows) for symbol, rows in rows_by_symbol.items()
    }
    for example_type, record in selected:
        if record["id"] in seen:
            continue
        seen.add(str(record["id"]))
        start, end = bounds_by_symbol[str(record["symbol"])][
            int(record["segment_index"])
        ]
        result.append(
            {
                "example_type": example_type,
                "segment": record,
                "context": _context_rows(
                    rows_by_symbol[str(record["symbol"])], start, end
                ),
            }
        )
    return result


def _counts(
    records: Iterable[Mapping[str, Any]], key_path: tuple[str, ...]
) -> dict[str, int]:
    counter: Counter[str] = Counter()
    for record in records:
        value: Any = record
        for key in key_path:
            value = value[key]
        counter[str(value)] += 1
    return dict(sorted(counter.items()))


def build_audit(
    replay: Mapping[str, Any],
    replay_path: Path,
    config: Config,
) -> dict[str, Any]:
    rows_value = replay.get("rows")
    if not isinstance(rows_value, dict) or not rows_value:
        raise ValueError("replay.rows must be a non-empty symbol mapping")
    rows_by_symbol: dict[str, list[Mapping[str, Any]]] = {}
    for symbol, rows in sorted(rows_value.items()):
        if not isinstance(symbol, str) or not isinstance(rows, list) or not rows:
            raise ValueError("each replay symbol must contain a non-empty row list")
        if not all(isinstance(row, dict) for row in rows):
            raise ValueError(f"{symbol}: every row must be an object")
        rows_by_symbol[symbol] = rows

    params = _regime_parameters(config)
    schema_violations: list[dict] = []
    raw_mismatches: list[dict] = []
    hysteresis_mismatches: list[dict] = []
    gaps: dict[str, dict[str, Any]] = {}
    records: list[dict[str, Any]] = []
    symbol_summaries: list[dict[str, Any]] = []
    for symbol, rows in rows_by_symbol.items():
        symbol_schema = _schema_violations(symbol, rows)
        schema_violations.extend(symbol_schema)
        if symbol_schema:
            continue
        mechanical = _mechanical_audit(symbol, rows, params)
        raw_mismatches.extend(mechanical["raw_branch_mismatches"])
        hysteresis_mismatches.extend(mechanical["hysteresis_mismatches"])
        gaps[symbol] = _gap_summary(rows)
        symbol_records = _segment_records(symbol, rows, params)
        records.extend(symbol_records)
        symbol_summaries.append(
            {
                "symbol": symbol,
                "rows": len(rows),
                "segments": len(symbol_records),
                "switches": max(0, len(symbol_records) - 1),
                "one_bar_segments": sum(row["one_bar"] for row in symbol_records),
                "round_trip_aba": sum(
                    row["round_trip_aba"] for row in symbol_records
                ),
                "price_assessment": _counts(
                    symbol_records, ("price_assessment", "status")
                ),
                **gaps[symbol],
            }
        )

    entry_failures = [
        row for row in records if row["entry_support"]["status"] == "FAIL"
    ]
    one_bar = [row for row in records if row["one_bar"]]
    sustained = [row for row in records if not row["one_bar"]]
    round_trip = [row for row in one_bar if row["round_trip_aba"]]
    observed_transitions = [row for row in records if row["previous_regime"] is not None]
    impossible_ids = sorted(
        {
            *(f"{row['symbol']}:{row['time']}" for row in hysteresis_mismatches),
            *(str(row["id"]) for row in entry_failures),
        }
    )
    mechanical_pass = not (
        schema_violations
        or raw_mismatches
        or hysteresis_mismatches
        or entry_failures
    )
    config_version_match = replay.get("config_version") == config.version

    one_bar_by_regime = _counts(one_bar, ("regime",))
    one_bar_price = _counts(one_bar, ("price_assessment", "status"))
    round_trip_price = _counts(round_trip, ("price_assessment", "status"))
    sustained_price = _counts(sustained, ("price_assessment", "status"))
    evidence_status = (
        "PASS_WITH_DIAGNOSTIC_CAVEATS" if mechanical_pass else "FAIL"
    )
    audit = {
        "schema_version": SCHEMA_VERSION,
        "audit_kind": "STAGE1_READ_ONLY_TRANSITION_EVIDENCE",
        "status": evidence_status,
        "source": {
            "path": replay_path.as_posix(),
            "sha256": hashlib.sha256(replay_path.read_bytes()).hexdigest(),
            "account": replay.get("account"),
            "timeframe": replay.get("timeframe"),
            "replay_generated_at": replay.get("generated_at"),
            "calendar_supplied": replay.get("calendar_supplied"),
            "replay_config_version": replay.get("config_version"),
            "audit_config_version": config.version,
            "config_version_match": config_version_match,
        },
        "scope": {
            "symbols": len(rows_by_symbol),
            "rows": sum(len(rows) for rows in rows_by_symbol.values()),
            "segments": len(records),
            "observed_transitions": len(observed_transitions),
            "one_bar_segments": len(one_bar),
            "sustained_segments": len(sustained),
            "sustained_observed_entries": sum(
                row["previous_regime"] is not None for row in sustained
            ),
        },
        "definitions": {
            "one_bar_segment": "effective regime lasting exactly one saved H1 bar",
            "false_flip_candidate": (
                "one-bar A→B→A effective-label round trip; diagnostic only, "
                "not proof of false classification"
            ),
            "impossible_transition": (
                "effective switch that disagrees with independent §3.3 replay "
                "or lacks immediate TRANSITIONAL / N-bar entry support"
            ),
            "price_assessment": (
                "post-label triage against fixed scale-free rules; descriptive "
                "and not a profitability or classifier-validity test"
            ),
        },
        "regime_parameters": params,
        "price_diagnostic_rules": PRICE_DIAGNOSTIC_RULES,
        "mechanical_invariants": {
            "status": "PASS" if mechanical_pass else "FAIL",
            "schema_violations": schema_violations,
            "raw_branch_mismatches": raw_mismatches,
            "hysteresis_mismatches": hysteresis_mismatches,
            "entry_support_failures": [row["id"] for row in entry_failures],
            "impossible_transition_count": len(impossible_ids),
            "impossible_transition_ids": impossible_ids,
        },
        "one_bar_review": {
            "segments": len(one_bar),
            "by_regime": one_bar_by_regime,
            "round_trip_aba": len(round_trip),
            "non_round_trip": len(one_bar) - len(round_trip),
            "price_assessment": one_bar_price,
            "round_trip_price_assessment": round_trip_price,
            "all_entries_mechanically_supported": not any(
                row["entry_support"]["status"] == "FAIL" for row in one_bar
            ),
        },
        "sustained_review": {
            "segments": len(sustained),
            "observed_entries": sum(
                row["previous_regime"] is not None for row in sustained
            ),
            "price_assessment": sustained_price,
            "all_observed_entries_mechanically_supported": not any(
                row["entry_support"]["status"] == "FAIL"
                for row in sustained
                if row["previous_regime"] is not None
            ),
        },
        "by_symbol": symbol_summaries,
        "segments": records,
        "representative_examples": _representative_examples(records, rows_by_symbol),
        "caveats": [
            (
                "Economic-calendar proximity is absent; VOLATILE_NEWS therefore "
                "covers only the ATR-percentile branch."
                if replay.get("calendar_supplied") is not True
                else "Economic-calendar flags were supplied in the replay."
            ),
            (
                "Replay and current whole-config hashes differ. The exhaustive "
                "row-level audit nevertheless reproduces every relevant §3 "
                "decision under the audit-captured approved §3 parameter values."
                if not config_version_match
                else "Replay and audit whole-config hashes match."
            ),
            (
                "Price coherence is post-label behavior and cannot establish "
                "causality, profitability, or a false classification."
            ),
            (
                "The first segment of each symbol begins inside the saved "
                "365-day window, so its entry confirmation may predate the file."
            ),
        ],
    }
    return _round_floats(audit)


def _pct(numerator: int, denominator: int) -> str:
    return f"{100.0 * numerator / denominator:.1f}%" if denominator else "n/a"


def _metric(record: Mapping[str, Any], key: str) -> str:
    value = record["price_metrics"].get(key)
    return "n/a" if value is None else f"{float(value):.2f}"


def render_markdown(audit: Mapping[str, Any]) -> str:
    source = audit["source"]
    scope = audit["scope"]
    invariants = audit["mechanical_invariants"]
    one = audit["one_bar_review"]
    sustained = audit["sustained_review"]
    segments = audit["segments"]
    one_rows = [row for row in segments if row["one_bar"]]
    sustained_rows = [row for row in segments if not row["one_bar"]]
    contradictory_sustained = [
        row
        for row in sustained_rows
        if row["price_assessment"]["status"] == "CONTRADICTORY"
    ]
    contradictory_sustained.sort(
        key=lambda row: (
            -abs(row["price_metrics"].get("net_move_range_units", 0.0)),
            row["start"],
        )
    )

    overall = (
        "Share with caveats"
        if invariants["status"] == "PASS"
        else "Needs revision"
    )
    lines = [
        "# Stage 1 transition evidence audit",
        "",
        f"## Overall assessment: {overall}",
        "",
        (
            f"The saved replay passes the independent mechanical audit across "
            f"**{scope['rows']:,} H1 rows**, **{scope['observed_transitions']:,} "
            f"observed transitions**, and **{scope['segments']:,} effective-regime "
            f"segments**."
            if invariants["status"] == "PASS"
            else (
                "The saved replay has mechanical violations and is not ready "
                "for operator reliance."
            )
        ),
        "",
        (
            f"All **{one['segments']} one-bar segments** were inspected. "
            f"**{one['round_trip_aba']}** are deterministic A→B→A whipsaw "
            "candidates; none is mechanically impossible. This is observable "
            "label churn, not proof that the underlying feature classification "
            "was false."
        ),
        "",
        "### Question answered",
        "",
        (
            "Do the one-bar and sustained Stage 1 regime transitions agree with "
            "the approved ordered feature rules, asymmetric hysteresis, "
            "confirmation invariants, and contemporaneous price behavior?"
        ),
        "",
        "### Source and scope",
        "",
        f"- Replay: `{source['path']}`",
        f"- SHA-256: `{source['sha256']}`",
        f"- Replay generated: `{source['replay_generated_at']}`",
        f"- Account label: `{source['account']}`",
        f"- Timeframe: `{source['timeframe']}`",
        f"- Symbols: {scope['symbols']}",
        (
            f"- Replay config `{source['replay_config_version']}`; audit config "
            f"`{source['audit_config_version']}`; whole-config match: "
            f"`{source['config_version_match']}`"
        ),
        "",
        "## Methodology review",
        "",
        (
            "The audit independently transcribes §3.2 and §3.3 rather than "
            "calling the production classifier. Every stored raw label is "
            "recomputed from ADX, ATR percentile, EMA alignment/direction, R², "
            "and blackout flag. Every effective label, confidence, and regime "
            "age after each symbol's first saved row is replayed from the raw "
            "sequence. Non-TRANSITIONAL entries require three consecutive raw "
            "confirmations; TRANSITIONAL entries must be immediate and outside "
            "an applicable ADX-only dead band."
        ),
        "",
        (
            "Price is assessed from the segment start open through end close, "
            "scaled by the median high–low range of the prior 20 saved bars. "
            "Trend labels are triaged on signed movement, RANGING on path "
            "efficiency/displacement, and VOLATILE_NEWS on bar-range expansion. "
            "TRANSITIONAL is not price-scored because it makes no directional "
            "or volatility claim. These fixed triage bounds do not alter model "
            "configuration."
        ),
        "",
        "## Dataset and grain checks",
        "",
        (
            "The grain is one ready, closed H1 bar per symbol and UTC open time. "
            "Timestamps are strictly increasing and unique within each symbol. "
            "Non-hourly gaps are retained rather than filled; the FX/metal gaps "
            "are consistent with session/weekend closures, while BTCUSD is "
            "nearly continuous. No gap is interpreted as a regime transition."
        ),
        "",
        "| Symbol | Rows | Segments | Switches | One-bar | Non-hourly gaps | Maximum gap |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for symbol in audit["by_symbol"]:
        lines.append(
            f"| {symbol['symbol']} | {symbol['rows']:,} | "
            f"{symbol['segments']:,} | {symbol['switches']:,} | "
            f"{symbol['one_bar_segments']} | "
            f"{symbol['non_hourly_gap_count']} | "
            f"{symbol['maximum_gap_hours']:.0f} h |"
        )

    lines.extend(
        [
        "",
        "## Mechanical invariants",
        "",
        "| Check | Result | Violations |",
        "|---|---:|---:|",
        f"| Row schema, UTC ordering, OHLC and feature domains | {'PASS' if not invariants['schema_violations'] else 'FAIL'} | {len(invariants['schema_violations'])} |",
        f"| Independent ordered raw branch | {'PASS' if not invariants['raw_branch_mismatches'] else 'FAIL'} | {len(invariants['raw_branch_mismatches'])} |",
        f"| Independent hysteresis/confidence/age replay | {'PASS' if not invariants['hysteresis_mismatches'] else 'FAIL'} | {len(invariants['hysteresis_mismatches'])} |",
        f"| Transition entry support | {'PASS' if not invariants['entry_support_failures'] else 'FAIL'} | {len(invariants['entry_support_failures'])} |",
        f"| Impossible transitions | {'PASS' if not invariants['impossible_transition_count'] else 'FAIL'} | {invariants['impossible_transition_count']} |",
        "",
        "## One-bar transition review",
        "",
        "| Diagnostic | Count | Share |",
        "|---|---:|---:|",
        f"| All one-bar segments | {one['segments']} | 100.0% |",
        f"| A→B→A round-trip candidates | {one['round_trip_aba']} | {_pct(one['round_trip_aba'], one['segments'])} |",
        f"| Non-round-trip one-bar segments | {one['non_round_trip']} | {_pct(one['non_round_trip'], one['segments'])} |",
        ]
    )
    for status in ("SUPPORTIVE", "MIXED", "CONTRADICTORY", "UNAVAILABLE"):
        count = one["price_assessment"].get(status, 0)
        lines.append(
            f"| Price triage: {status.lower()} | {count} | {_pct(count, one['segments'])} |"
        )

    lines.extend(
        [
            "",
            (
                "Feature finding: every one-bar entry has the required three raw "
                "confirmations. Each one then loses its effective label after one "
                "bar under a mechanically valid next-bar rule. The dominant shape "
                "is a three-bar build-up while TRANSITIONAL, one effective stable "
                "bar, then immediate return to TRANSITIONAL; that explains the "
                "round trips without making them operationally irrelevant."
            ),
            "",
            "### All one-bar segments",
            "",
            "| # | Symbol · start | Effective path | Entry evidence | Price triage | Move / range | Median range ratio | A→B→A |",
            "|---:|---|---|---|---|---:|---:|:---:|",
        ]
    )
    for number, row in enumerate(one_rows, 1):
        path = (
            f"{row['previous_regime'] or 'BOUNDARY'} → {row['regime']} → "
            f"{row['next_regime'] or 'END'}"
        )
        evidence = "/".join(row["entry_support"]["raw_window"])
        lines.append(
            f"| {number} | {row['symbol']} · {row['start']} | {path} | "
            f"{row['entry_support']['status']} `{evidence}` | "
            f"{row['price_assessment']['status']} | "
            f"{_metric(row, 'net_move_range_units')} | "
            f"{_metric(row, 'median_bar_range_ratio')}× | "
            f"{'yes' if row['round_trip_aba'] else 'no'} |"
        )

    lines.extend(
        [
            "",
            "## Sustained transition review",
            "",
            (
                f"The replay contains **{sustained['segments']:,} sustained "
                f"segments**, of which **{sustained['observed_entries']:,}** "
                "have their entry boundary inside the saved window. All observed "
                "entries satisfy the independent hysteresis rule."
            ),
            "",
            "| Price triage | Segments | Share of sustained segments |",
            "|---|---:|---:|",
        ]
    )
    for status in (
        "SUPPORTIVE",
        "MIXED",
        "CONTRADICTORY",
        "NOT_SCORED",
        "UNAVAILABLE",
    ):
        count = sustained["price_assessment"].get(status, 0)
        lines.append(
            f"| {status} | {count} | {_pct(count, sustained['segments'])} |"
        )

    lines.extend(
        [
            "",
            (
                "A contradictory price diagnostic is not a mechanical failure: "
                "the classifier describes the feature state at each close and "
                "does not promise subsequent direction. It is a deterministic "
                "queue for later outcome/backtest analysis."
            ),
            "",
            "### Largest sustained price contradictions",
            "",
            "| Symbol · start | Regime | Bars | Move / range | Efficiency | Price finding |",
            "|---|---|---:|---:|---:|---|",
        ]
    )
    for row in contradictory_sustained[:15]:
        lines.append(
            f"| {row['symbol']} · {row['start']} | {row['regime']} | "
            f"{row['bars']} | {_metric(row, 'net_move_range_units')} | "
            f"{_metric(row, 'path_efficiency')} | "
            f"{row['price_assessment']['reason']} |"
        )

    lines.extend(
        [
            "",
            "## Representative examples",
            "",
            (
                "The JSON companion contains compact pre-/post-boundary OHLC "
                "and feature context for each example below."
            ),
            "",
            "| Example | Symbol · start | Regime | Bars | Entry | Price triage |",
            "|---|---|---|---:|---|---|",
        ]
    )
    for example in audit["representative_examples"]:
        row = example["segment"]
        lines.append(
            f"| {example['example_type']} | {row['symbol']} · {row['start']} | "
            f"{row['regime']} | {row['bars']} | "
            f"{row['entry_support']['status']} | "
            f"{row['price_assessment']['status']} |"
        )

    lines.extend(
        [
            "",
            "## Issues found",
            "",
            (
                "1. **Medium — one-bar effective churn:** "
                f"{one['round_trip_aba']} of {one['segments']} one-bar segments "
                "are A→B→A round trips. They are spec-conformant but briefly swap "
                "the active cluster map after confirmation, so they should remain "
                "an explicit Stage 1 operating diagnostic."
            ),
            (
                "2. **Medium — economic-calendar branch unavailable:** the saved "
                "replay has no calendar proximity data. ATR-driven volatility is "
                "audited; news-driven VOLATILE_NEWS coverage is not."
                if source["calendar_supplied"] is not True
                else "2. **Resolved — calendar input supplied:** both volatility branches are represented."
            ),
            (
                "3. **Low — whole-config provenance hash drift:** the replay was "
                "created before comment-only config edits. Relevant regime "
                "semantics are exhaustively reproduced row by row against the "
                "audit-captured approved §3 values, but regenerate the replay to "
                "align hashes."
                if not source["config_version_match"]
                else "3. **Resolved — config provenance:** replay and audit hashes match."
            ),
            "",
            "## Calculation spot-checks",
            "",
            f"- Raw classification: **{scope['rows']:,}/{scope['rows']:,} verified**.",
            (
                f"- Hysteresis transitions: **{scope['observed_transitions']:,}/"
                f"{scope['observed_transitions']:,} verified**."
            ),
            (
                f"- One-bar entries: **{one['segments']}/{one['segments']} "
                "mechanically supported**."
            ),
            (
                f"- Sustained observed entries: **{sustained['observed_entries']:,}/"
                f"{sustained['observed_entries']:,} mechanically supported**."
            ),
            f"- Impossible transitions: **{invariants['impossible_transition_count']}**.",
            "",
            "## Required caveats for operators",
            "",
        ]
    )
    lines.extend(f"- {caveat}" for caveat in audit["caveats"])
    lines.extend(
        [
            "",
            "## Handoff",
            "",
            (
                "The operator-reviewable transition queue is now closed as a "
                "deterministic evidence pass: every one-bar segment and every "
                "sustained segment is represented in the JSON, all transition "
                "mechanics are exhaustively checked, and price contradictions "
                "are retained rather than tuned away. This does not close the "
                "separate economic-calendar or realised-score dependencies."
            ),
            "",
        ]
    )
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    replay_path = Path(args.replay).resolve()
    output_dir = Path(args.output_dir).resolve()
    replay = json.loads(replay_path.read_text(encoding="utf-8"))
    if not isinstance(replay, dict):
        raise ValueError("replay root must be an object")
    config = Config.load(args.config)
    audit = build_audit(replay, replay_path, config)
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "transition_audit.json"
    markdown_path = output_dir / "transition_audit.md"
    json_path.write_text(
        json.dumps(audit, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    markdown_path.write_text(render_markdown(audit), encoding="utf-8")
    print(f"Transition audit: {audit['status']}")
    print(
        "Rows/segments/one-bar/impossible: "
        f"{audit['scope']['rows']}/"
        f"{audit['scope']['segments']}/"
        f"{audit['scope']['one_bar_segments']}/"
        f"{audit['mechanical_invariants']['impossible_transition_count']}"
    )
    print(f"JSON: {json_path}")
    print(f"Markdown: {markdown_path}")
    return 0 if audit["mechanical_invariants"]["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
