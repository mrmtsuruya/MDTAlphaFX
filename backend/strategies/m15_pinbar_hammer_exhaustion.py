"""Module 15 — Pinbar/Hammer Exhaustion."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ..contracts import Candle, Direction, StrategyResult, SymbolSpec
from .common import (
    Pivot,
    ProfiledStrategy,
    bar_range,
    body_size,
    candle_body,
    confirmed_pivot_highs,
    confirmed_pivot_lows,
    latest_atr,
    lower_wick,
    median_tick_volume,
    price,
    upper_wick,
    validate_bars,
)
from .configuration import ModuleProfile


class PinbarHammerExhaustion(ProfiledStrategy):
    module_id = 15
    module_name = "Pinbar/Hammer Exhaustion"
    cluster_id = "C"

    def __init__(self, profile: ModuleProfile):
        self.atr_period = profile.integer("atr_period", positive=True)
        self.volume_period = profile.integer("volume_median_bars", positive=True)
        self.pivot_left = profile.integer("pivot_left_bars", positive=True)
        self.pivot_right = profile.integer("pivot_right_bars", positive=True)
        self.lookback = profile.integer("key_level_lookback_bars", positive=True)
        min_bars = max(
            self.atr_period,
            self.volume_period + 1,
            self.lookback + self.pivot_left + self.pivot_right + 1,
        )
        super().__init__(profile, min_bars=min_bars)

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        validate_bars(bars)
        if len(bars) < self.min_bars:
            return self.flat()
        window = bars[-self.min_bars :]
        atr_value = latest_atr(window, self.atr_period)
        if atr_value is None:
            return self.flat()
        buy = self._candidate(window, atr_value, Direction.BUY)
        sell = self._candidate(window, atr_value, Direction.SELL)
        if (buy is None) == (sell is None):
            return self.flat()
        candidate = buy if buy is not None else sell
        assert candidate is not None
        direction = Direction.BUY if buy is not None else Direction.SELL
        current = window[-1]
        current_range = bar_range(current)
        volume_median = median_tick_volume(window[:-1], self.volume_period)
        low_volume_ratio = float(
            self.profile.number("low_volume_ratio", positive=True)
        )
        flags = (
            current_range
            >= float(self.profile.number("minimum_range_atr", positive=True))
            * atr_value,
            volume_median is not None
            and current.tick_volume <= low_volume_ratio * volume_median,
            candidate["support_count"] >= 2,
        )
        body_low, body_high = candle_body(current)
        zone_min, zone_max = (
            (float(current.low), body_low)
            if direction is Direction.BUY
            else (body_high, float(current.high))
        )
        key_level: Pivot = candidate["level"]
        wick = candidate["wick"]
        return self.result(
            bars=window,
            spec=spec,
            direction=direction,
            zone_min=zone_min,
            zone_max=zone_max,
            overlay_type="PINBAR_HAMMER",
            geometry=[
                {
                    "type": "line",
                    "role": "current_timeframe_key_level",
                    "start_time": key_level.time,
                    "end_time": current.time.isoformat(),
                    "price": price(key_level.price, spec),
                },
                {
                    "type": "wick",
                    "role": "rejection_wick",
                    "time": current.time.isoformat(),
                    "min": price(zone_min, spec),
                    "max": price(zone_max, spec),
                },
            ],
            stop_anchor={
                "time": current.time.isoformat(),
                "price": price(
                    current.low if direction is Direction.BUY else current.high,
                    spec,
                ),
                "role": "rejection_extreme",
            },
            opposing_structures=(),
            indicators={
                "atr": atr_value,
                "key_level": key_level.price,
                "key_level_support_count": candidate["support_count"],
                "wick_to_body_ratio": (
                    wick / body_size(current)
                    if body_size(current) > 0.0
                    else None
                ),
                "wick_atr": wick / atr_value,
                "body_range_fraction": body_size(current) / current_range,
                "range_atr": current_range / atr_value,
                "tick_volume_proxy": current.tick_volume,
                "volume_median": volume_median,
                "volume_ratio": (
                    current.tick_volume / volume_median
                    if volume_median is not None and volume_median > 0.0
                    else None
                ),
            },
            quality_flags=flags,
        )

    def _candidate(
        self,
        bars: Sequence[Candle],
        atr_value: float,
        direction: Direction,
    ) -> dict[str, Any] | None:
        current = bars[-1]
        history_start = max(0, len(bars) - 1 - self.lookback)
        history = bars[history_start:-1]
        pivots = (
            confirmed_pivot_lows(history, self.pivot_left, self.pivot_right)
            if direction is Direction.BUY
            else confirmed_pivot_highs(history, self.pivot_left, self.pivot_right)
        )
        if not pivots:
            return None
        tolerance = (
            float(self.profile.number("key_level_tolerance_atr", positive=True))
            * atr_value
        )
        wick = (
            lower_wick(current)
            if direction is Direction.BUY
            else upper_wick(current)
        )
        body = body_size(current)
        current_range = bar_range(current)
        if current_range <= 0.0:
            return None
        wick_ratio = float(self.profile.number("wick_to_body_ratio", positive=True))
        minimum_wick = (
            float(self.profile.number("minimum_rejection_wick_atr", positive=True))
            * atr_value
        )
        maximum_body_fraction = float(
            self.profile.number("maximum_body_range_fraction", positive=True)
        )
        close_fraction = float(
            self.profile.number("close_extreme_fraction", positive=True)
        )
        closes_at_rejection_side = (
            float(current.close) >= float(current.high) - close_fraction * current_range
            if direction is Direction.BUY
            else float(current.close) <= float(current.low) + close_fraction * current_range
        )
        if (
            wick < wick_ratio * body
            or wick < minimum_wick
            or body > maximum_body_fraction * current_range
            or not closes_at_rejection_side
        ):
            return None
        extreme = float(current.low if direction is Direction.BUY else current.high)
        nearby = [pivot for pivot in pivots if abs(pivot.price - extreme) <= tolerance]
        if not nearby:
            return None
        chosen = min(
            nearby,
            key=lambda pivot: (abs(pivot.price - extreme), -pivot.index),
        )
        support_count = sum(
            abs(pivot.price - chosen.price) <= tolerance for pivot in pivots
        )
        return {
            "level": Pivot(
                chosen.index + history_start,
                chosen.time,
                chosen.price,
            ),
            "support_count": support_count,
            "wick": wick,
        }


__all__ = ["PinbarHammerExhaustion"]
